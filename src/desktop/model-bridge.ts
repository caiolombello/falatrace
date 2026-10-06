import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { runCommand } from "../jobs/command";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { isMissingUnitError, transientCommand, transientUnitEnvironment } from "../runtime/systemd-units";
import {
  WHISPER_MODELS, WHISPER_SOURCE, findWhisperModel, isLoopbackOllama, isVerifiedWhisperModel, readDownloadState,
  validateOllamaModelName, whisperModelsDir, writeDownloadState, type DownloadKind
} from "../models/downloads";

/**
 * Studio side of model downloads. Starting one requires explicit consent in the payload;
 * the work runs in a transient user unit (`falatrace models …`) so closing the Studio does
 * not interrupt it, and progress is read back from a private state file.
 */
export const MODEL_OPERATIONS = ["settings-model-catalog", "settings-model-download", "settings-model-status", "settings-model-cancel"] as const;
export type ModelOperation = typeof MODEL_OPERATIONS[number];

export type ModelDeps = {
  loadConfig: typeof loadConfig;
  run: typeof runCommand;
  directory: () => string;
  ollamaModels: (baseUrl: string) => Promise<string[]>;
  launch: () => string[];
};

const ollamaTags = async (baseUrl: string): Promise<string[]> => {
  const response = await fetch(new URL("/api/tags", baseUrl), { redirect: "error", signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<{ name?: unknown }> };
  return (body.models || []).map((model) => model.name).filter((name): name is string => typeof name === "string").slice(0, 500);
};

export const defaultModelDeps: ModelDeps = {
  loadConfig,
  run: runCommand,
  directory: whisperModelsDir,
  ollamaModels: ollamaTags,
  launch: () => getServiceLaunchCommand()
};

export const modelUnitName = (kind: DownloadKind, id: string): string =>
  `recording-cli-model-${kind}-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

/** Whether the download unit runs; null when the user manager could not be asked. */
const unitActive = async (run: typeof runCommand, unit: string): Promise<boolean | null> => {
  const result = await run("systemctl", ["--user", "show", `${unit}.service`, "--property=ActiveState"], { timeoutMs: 5_000 }).catch(() => null);
  return result === null ? null : /^ActiveState=(active|activating)$/m.test(result.stdout);
};

export const UNIT_STATE_UNKNOWN = "Não foi possível consultar os serviços do usuário. Tente de novo.";

const parseTarget = (payload: Record<string, unknown>): { kind: DownloadKind; id: string } => {
  if (payload.kind === "whisper") return { kind: "whisper", id: findWhisperModel(payload.model).id };
  if (payload.kind === "ollama") return { kind: "ollama", id: validateOllamaModelName(payload.model) };
  throw new Error("Modelo desconhecido.");
};

export const handleModelOperation = async (
  op: ModelOperation,
  payload: Record<string, unknown>,
  deps: ModelDeps = defaultModelDeps
): Promise<unknown> => {
  if (op === "settings-model-catalog") {
    const { config } = await deps.loadConfig();
    const directory = deps.directory();
    const whisper = await Promise.all(WHISPER_MODELS.map(async (model) => {
      const path = join(directory, model.file);
      // "Download" on a present but unverified file only checks its SHA-256; nothing is fetched.
      return { ...model, path, installed: await isVerifiedWhisperModel(model, path), selected: config.transcription.whisperCpp.modelPath === path };
    }));
    const loopback = isLoopbackOllama(config.summary.ollamaUrl);
    const installed = loopback ? await deps.ollamaModels(config.summary.ollamaUrl).catch(() => null) : null;
    return {
      whisper: { directory, source: WHISPER_SOURCE, models: whisper },
      ollama: { url: config.summary.ollamaUrl, loopback, reachable: installed !== null, installed: installed || [], configured: config.summary.ollamaModel }
    };
  }
  // Status and cancel need only the model and its unit: a broken configuration never strands a download.
  const target = parseTarget(payload);
  const unit = modelUnitName(target.kind, target.id);
  if (op === "settings-model-status") {
    const [state, active] = await Promise.all([readDownloadState(target.kind, target.id), unitActive(deps.run, unit)]);
    // A unit that ended without a final state was interrupted; never report it as running forever.
    // When systemd cannot be asked, the last recorded state stands.
    if (state?.state === "running" && active === false) return { ...state, state: "failed", error: "O download foi interrompido. Tente novamente." };
    return state || { kind: target.kind, id: target.id, state: active ? "running" : "idle", receivedBytes: 0, totalBytes: null };
  }
  if (op === "settings-model-cancel") {
    // A unit that already ended counts as cancelled; any other failure leaves the download running and is reported.
    await deps.run("systemctl", ["--user", "stop", `${unit}.service`], { timeoutMs: 10_000 }).catch((error: unknown) => {
      if (!isMissingUnitError(error)) throw error;
    });
    return { kind: target.kind, id: target.id, cancelled: true };
  }
  if (payload.consent !== true) throw new Error("Confirme o download antes de começar.");
  const { config } = await deps.loadConfig();
  if (target.kind === "ollama" && !isLoopbackOllama(config.summary.ollamaUrl)) {
    throw new Error("O download pelo Ollama só é feito para um Ollama neste computador.");
  }
  const active = await unitActive(deps.run, unit);
  // Without an answer from systemd a second copy of a running download could start.
  if (active === null) throw new Error(UNIT_STATE_UNKNOWN);
  if (active) return { kind: target.kind, id: target.id, state: "running", unit: `${unit}.service` };
  const total = target.kind === "whisper" ? findWhisperModel(target.id).bytes : null;
  await writeDownloadState({ kind: target.kind, id: target.id, state: "running", receivedBytes: 0, totalBytes: total });
  const command = target.kind === "whisper" ? ["models", "download", target.id] : ["models", "ollama-pull", target.id];
  try {
    await deps.run("systemd-run", [
      "--user", `--unit=${unit}`, "--collect", "--property=Type=exec", "--property=Nice=10",
      "--property=TimeoutStartSec=infinity", "--property=UMask=0077",
      // The download reads the same configuration and writes the state this Studio polls.
      ...transientUnitEnvironment(),
      "--description=Download a FalaTrace model",
      "--", ...transientCommand([...deps.launch(), ...command])
    ], { timeoutMs: 15_000 });
  } catch (error) {
    await writeDownloadState({ kind: target.kind, id: target.id, state: "failed", receivedBytes: 0, totalBytes: total, error: "Não foi possível iniciar o download." });
    throw error;
  }
  return { kind: target.kind, id: target.id, state: "running", unit: `${unit}.service` };
};
