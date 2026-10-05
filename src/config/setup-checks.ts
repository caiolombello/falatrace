import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./defaults";
import { runCommand } from "../jobs/command";
import { resolveExecutable } from "../recording/obsLauncher";
import { buildCallMonitorUnit } from "../calls/service";

/**
 * Read-only setup diagnostics for the Studio. Nothing here records, transcribes,
 * downloads models or contacts a non-loopback host; Ollama is queried only on loopback
 * and only for its installed model list.
 */
export type SetupCheckStatus = "ok" | "warning" | "missing" | "skipped";
export type SetupCheck = { id: string; label: string; status: SetupCheckStatus; detail: string };
export type CredentialStatus = { openai: string; gemini: string };

export type SetupProbe = {
  resolve: (name: string) => Promise<string | null>;
  isFile: (path: string) => Promise<boolean>;
  isExecutable: (path: string) => Promise<boolean>;
  ollamaModels: (baseUrl: string) => Promise<string[]>;
  run: typeof runCommand;
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};

const fetchOllamaModels = async (baseUrl: string): Promise<string[]> => {
  const response = await fetch(new URL("/api/tags", baseUrl), { redirect: "error", signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<{ name?: unknown }> };
  return (body.models || []).map((model) => model.name).filter((name): name is string => typeof name === "string").slice(0, 500);
};

export const defaultSetupProbe: SetupProbe = {
  resolve: (name) => resolveExecutable(name),
  isFile: (path) => fs.stat(path).then((stat) => stat.isFile(), () => false),
  isExecutable: (path) => fs.access(path, constants.X_OK).then(() => true, () => false),
  ollamaModels: fetchOllamaModels,
  run: runCommand
};

const credentialLabel = (source: string): string =>
  source === "environment" ? "definida no ambiente" : source === "calls.env" ? "definida em calls.env" : source === "config" ? "definida na configuração" : "não encontrada";

export const checkProcessing = async (
  config: AppConfig,
  credentials: CredentialStatus,
  probe: SetupProbe = defaultSetupProbe
): Promise<SetupCheck[]> => {
  const checks: SetupCheck[] = [];
  const ffmpeg = await probe.resolve("ffmpeg");
  checks.push({ id: "ffmpeg", label: "FFmpeg", status: ffmpeg ? "ok" : "missing",
    detail: ffmpeg ? "Encontrado." : "Necessário para gravar só áudio e para extrair o áudio antes da transcrição. Instale pelo gerenciador de pacotes." });

  const remote = config.processing.defaultTarget === "remote";
  const transcription = config.transcription.provider;
  if (transcription === "whisper-cpp") {
    if (remote) {
      checks.push({ id: "whisper", label: "Whisper.cpp", status: "skipped", detail: "A transcrição roda no worker remoto configurado; não verificado neste computador." });
    } else {
      const command = config.transcription.whisperCpp.command;
      const found = command.includes("/") ? (await probe.isExecutable(command) ? command : null) : await probe.resolve(command);
      checks.push({ id: "whisper", label: "Whisper.cpp", status: found ? "ok" : "missing",
        detail: found ? `Comando ${command} encontrado.` : `Comando ${command} não encontrado. Instale o whisper.cpp ou informe o caminho do executável.` });
      const model = await probe.isFile(config.transcription.whisperCpp.modelPath);
      checks.push({ id: "whisper-model", label: "Modelo do Whisper", status: model ? "ok" : "missing",
        detail: model ? "Arquivo do modelo encontrado." : "Arquivo do modelo não encontrado no caminho configurado. Baixe um modelo ggml e informe o caminho." });
    }
  } else {
    const source = transcription === "openai" ? credentials.openai : credentials.gemini;
    const variable = transcription === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    checks.push({ id: "transcription-key", label: `Transcrição · ${variable}`, status: source === "missing" ? "missing" : "ok",
      detail: source === "missing"
        ? `A transcrição usa ${transcription === "openai" ? "a OpenAI" : "o Gemini"}, mas ${variable} não foi encontrada. Defina-a no ambiente ou em ~/.config/recording-cli/calls.env.`
        : `Chave ${credentialLabel(source)}. O áudio é enviado para um serviço externo.` });
  }

  if (config.summary.provider === "ollama") {
    if (!isLoopbackUrl(config.summary.ollamaUrl)) {
      checks.push({ id: "ollama", label: "Ollama", status: "skipped", detail: "Endereço fora deste computador; não contatado pelo diagnóstico." });
    } else {
      const models = await probe.ollamaModels(config.summary.ollamaUrl).catch(() => null);
      const model = config.summary.ollamaModel;
      checks.push(models === null
        ? { id: "ollama", label: "Ollama", status: "missing", detail: "Ollama não respondeu neste computador. Instale e inicie o Ollama." }
        : models.includes(model) || models.includes(`${model}:latest`)
          ? { id: "ollama", label: "Ollama", status: "ok", detail: `Modelo ${model} instalado.` }
          : { id: "ollama", label: "Ollama", status: "warning", detail: `Ollama respondeu, mas o modelo ${model} não está instalado. Rode: ollama pull ${model}` });
    }
  } else {
    checks.push({ id: "summary-key", label: "Resumo · OPENAI_API_KEY", status: credentials.openai === "missing" ? "missing" : "ok",
      detail: credentials.openai === "missing"
        ? "O resumo usa a OpenAI, mas OPENAI_API_KEY não foi encontrada. Defina-a no ambiente ou em ~/.config/recording-cli/calls.env."
        : `Chave ${credentialLabel(credentials.openai)}. A transcrição é enviada para um serviço externo para resumir.` });
  }
  return checks;
};

export type AudioDevice = { name: string; description: string; monitor: boolean };

export const listAudioDevices = async (run: typeof runCommand = runCommand) => {
  const [sources, source, sink] = await Promise.all([
    run("pactl", ["--format=json", "list", "sources"], { timeoutMs: 5_000 }),
    run("pactl", ["get-default-source"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" })),
    run("pactl", ["get-default-sink"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }))
  ]);
  const parsed = JSON.parse(sources.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("pactl retornou fontes de áudio inválidas");
  const devices: AudioDevice[] = parsed.flatMap((value) => {
    const item = value as { name?: unknown; description?: unknown };
    if (typeof item.name !== "string" || !/^[A-Za-z0-9_.:@+-]{1,300}$/.test(item.name)) return [];
    const description = typeof item.description === "string" ? item.description.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) : item.name;
    return [{ name: item.name, description, monitor: item.name.endsWith(".monitor") }];
  }).slice(0, 100);
  const defaultSink = sink.stdout.trim();
  return { devices, defaultMicrophone: source.stdout.trim() || null, defaultDesktop: defaultSink ? `${defaultSink}.monitor` : null };
};

/** `outdated`: the unit's writable paths do not match the configured recordings folder.
 * `staleConfig`: the configuration file changed after the service started, so the running
 * monitor still uses the previous settings until it is restarted. */
export type ServiceStatus = { installed: boolean; enabled: boolean; active: boolean; outdated: boolean; staleConfig: boolean };

const unitState = async (run: typeof runCommand, verb: "is-enabled" | "is-active", unit: string): Promise<boolean> =>
  run("systemctl", ["--user", verb, unit], { timeoutMs: 5_000 }).then(({ stdout }) => ["enabled", "active"].includes(stdout.trim()), () => false);

const startedAtMs = async (run: typeof runCommand, unit: string): Promise<number | null> =>
  run("systemctl", ["--user", "show", unit, "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix"], { timeoutMs: 5_000 })
    .then(({ stdout }) => { const match = stdout.trim().match(/^@(\d+)$/); return match ? Number(match[1]) * 1000 : null; }, () => null);

export const readServiceStatus = async (
  config: AppConfig,
  configPath: string,
  run: typeof runCommand = runCommand,
  unitDir = join(homedir(), ".config", "systemd", "user")
): Promise<{ calls: ServiceStatus; tray: ServiceStatus }> => {
  const read = (name: string) => fs.readFile(join(unitDir, name), "utf8").catch(() => null);
  const [callsUnit, trayUnit] = await Promise.all([read("recording-cli-calls.service"), read("recording-cli-tray.service")]);
  const [callsEnabled, callsActive, trayEnabled, trayActive] = await Promise.all([
    unitState(run, "is-enabled", "recording-cli-calls.service"), unitState(run, "is-active", "recording-cli-calls.service"),
    unitState(run, "is-enabled", "recording-cli-tray.service"), unitState(run, "is-active", "recording-cli-tray.service")
  ]);
  // Only the parts the Studio controls are compared: the launch target is allowed to differ.
  const callsOutdated = callsUnit !== null && !callsUnit.includes(buildCallMonitorUnit(config, ["X"]).split("\n").find((line) => line.startsWith("ReadWritePaths="))!);
  const configChangedAt = await fs.stat(configPath).then((stat) => stat.mtimeMs, () => null);
  const callsStartedAt = callsActive ? await startedAtMs(run, "recording-cli-calls.service") : null;
  const staleConfig = callsStartedAt !== null && configChangedAt !== null && configChangedAt > callsStartedAt;
  return {
    calls: { installed: callsUnit !== null, enabled: callsEnabled, active: callsActive, outdated: callsOutdated, staleConfig },
    tray: { installed: trayUnit !== null, enabled: trayEnabled, active: trayActive, outdated: false, staleConfig: false }
  };
};
