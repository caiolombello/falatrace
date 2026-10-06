import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
/** Asynchronous playback worker for the desktop application. */
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { loadConfig } from "../../src/config/load";
import { buildLibrary, type LibraryEntry } from "../../src/tui/library";
import { playLibraryEntry } from "../../src/tui/media";
import { runCommand } from "../../src/jobs/command";
import { writeJsonAtomic } from "../../src/jobs/store";
import { validateJobId } from "../../src/jobs/types";
import { acquireSingleton } from "../../src/runtime/singleton";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { transientUnitEnvironment } from "../runtime/systemd-units";

type State = { state: "running" | "completed" | "failed"; operationId: string; key: string; path?: string; location?: "local" | "vaio" | "proton"; message?: string };
type Playback = State;
const stateDir = (): string => join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "recording-cli", "desktop");
const statePath = (id: string): string => join(stateDir(), `${validateJobId(id)}.json`);
const safeMessage = (message: string): string => message.includes("SSHFS") || message.includes("Proton") ? "Não foi possível resolver a origem da reprodução" : "Não foi possível abrir a reprodução";

const ensureStateDir = async (): Promise<string> => {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(dir) !== resolve(dir)) throw new Error("Diretório de estado inseguro");
  return dir;
};
const validateKey = (key: string): string => {
  if (typeof key !== "string" || !key.startsWith("/") || resolve(key) !== key || /[\0\r\n]/.test(key)) throw new Error("A gravação selecionada é inválida");
  return key;
};
const lookup = async (key: string): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>["config"]; entry: LibraryEntry }> => {
  const { config } = await loadConfig();
  const entry = (await buildLibrary(config)).find((item) => item.sourcePath === key);
  if (!entry) throw new Error("A gravação selecionada não foi encontrada");
  return { config, entry };
};
const writeState = async (state: State): Promise<void> => { await ensureStateDir(); await writeJsonAtomic(statePath(state.operationId), state); };

/** The playback unit finds the recording in the configuration this process reads: same PATH and XDG directories. */
export const playbackRunArgs = (unit: string, launch: string[], operationId: string, source: string, env: NodeJS.ProcessEnv = process.env): string[] => [
  "--user", `--unit=${unit}`, "--collect", "--property=Type=exec", "--property=Nice=10", "--property=RuntimeMaxSec=1800", "--property=TimeoutStopSec=30",
  "--property=UMask=0077", ...transientUnitEnvironment(env), "--", ...launch, "desktop", "playback", operationId, source
];

const active = new Map<string, string>();
export const queuePlayback = async (key: string): Promise<State> => {
  const source = validateKey(key);
  const lease = await acquireSingleton(`desktop-open-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`);
  try {
  const previous = active.get(source);
  if (previous) { const state = await readPlayback(previous); if (state.state === "running") return state; }
  const directory = await ensureStateDir();
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
    const candidate = await readState(name.slice(0, -5)).catch(() => null);
    if (candidate?.key === source && candidate.state === "running") {
      const running = await readPlayback(candidate.operationId);
      if (running.state === "running") { active.set(source, running.operationId); return running; }
    }
  }
  await lookup(source);
  const operationId = randomUUID();
  await writeState({ state: "running", operationId, key: source });
  const unit = `recording-studio-playback-${operationId}`;
  try {
    const launch = getServiceLaunchCommand();
    await runCommand("systemd-run", playbackRunArgs(unit, launch, operationId, source), { timeoutMs: 15_000 });
  } catch { const state: State = { state: "failed", operationId, key: source, message: "Não foi possível iniciar a reprodução" }; await writeState(state); return state; }
  active.set(source, operationId);
  return { state: "running", operationId, key: source };
  } finally { await lease.release(); }
};

const readState = async (id: string): Promise<State> => {
  const path = statePath(id);
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Estado inválido");
  const value = JSON.parse(await fs.readFile(path, "utf8")) as State;
  if (value.operationId !== id || !["running", "completed", "failed"].includes(value.state)) throw new Error("Estado inválido");
  validateKey(value.key);
  if (value.state === "completed") {
    validateKey(value.path!);
    if (!["local", "vaio", "proton"].includes(value.location || "")) throw new Error("Estado inválido");
  }
  return { state: value.state, operationId: id, key: value.key, path: value.path, location: value.location,
    ...(value.state === "failed" ? { message: "Não foi possível recuperar a gravação. Verifique a conexão e tente novamente." } : {}) };
};
export const readPlayback = async (operationId: string): Promise<Playback> => {
  let id: string;
  try { id = validateJobId(operationId); } catch { return { state: "failed", operationId, key: "", message: "Operação de reprodução inválida" }; }
  try {
    const state = await readState(id);
    if (state.state !== "running") return state;
    const unit = `recording-studio-playback-${id}.service`;
    const result = await runCommand("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState"], { timeoutMs: 5_000 });
    if (!/^ActiveState=(active|activating)$/m.test(result.stdout)) {
      const final = await readState(id); // Completion can race the unit disappearing after --collect.
      return final.state !== "running" ? final : { state: "failed", operationId: id, key: state.key, message: "A recuperação terminou sem resultado. Tente novamente." };
    }
    return state;
  } catch { return { state: "failed", operationId: id, key: "", message: "Estado da reprodução indisponível" }; }
};

export const runPlaybackWorker = async (id: string, key: string): Promise<void> => {
  process.once("SIGTERM", () => undefined);
  try {
    const source = validateKey(key);
    const { config, entry } = await lookup(source);
    const result = await withHeavyAdmission('playback', id, () => playLibraryEntry(config, entry, undefined, { launch: async () => undefined }), { onWait: cliAdmissionWait });
    await writeState({ state: "completed", operationId: id, key: source, path: result.path, location: result.location });
  } catch (error) {
    await writeState({ state: "failed", operationId: id, key, message: safeMessage(error instanceof Error ? error.message : String(error)) });
  }
};

if (import.meta.main && process.argv[2] === "--worker") void runPlaybackWorker(process.argv[3] || "", process.argv[4] || "");
