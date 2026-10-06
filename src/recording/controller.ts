import { assertCaptureProfile, verifyCallLightSupport, captureProfileNotice } from './profile';
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { probeMedia } from "../jobs/media";
import { validateJobId } from "../jobs/types";
import { acquireSingleton } from "../runtime/singleton";
import { buildCaptureCommand, inspectAudioSources, resolveGpuRecorder } from "./capture";
import { ManualObsController, ObsStartUncertain, RecordingStartCancelled } from "./obs-recording";
import { formatName } from "./naming";
import { capturedAudioConfig, RecordingSessionStore, type RecordingSession, type AudioSelection } from "./session";
import type { AudioSources } from "./capture";
import { readState } from "./state";
import { sharedControllerBackend } from "./capabilities";
import { captureProcessMatches, findFlatpakCapture } from "./flatpak-capture";
import { ArchiveStore } from "../archive/store";

export type RecordingStartOptions = {
  sessionId?: string;
  title?: string;
  app?: RecordingSession["app"];
  audioSource?: AppConfig["capture"]["audioSource"];
  signal?: AbortSignal;
  shouldContinue?: () => boolean | Promise<boolean>;
};

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const unitName = (id: string): string => `recording-cli-capture-${validateJobId(id)}.service`;
const hasMedia = async (path: string): Promise<boolean> =>
  fs.stat(path).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
const hasVolumeControl = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("value" in record) return hasVolumeControl(record.value);
  if ("value_percent" in record) return hasVolumeControl(record.value_percent);
  const values = Object.values(record);
  return values.length > 0 && values.every(hasVolumeControl);
};

/** Shared capture lifecycle for manual CLI commands and the call monitor. */
export class RecordingController {
  private session: RecordingSession | null = null;
  private obsStartedHere = false;

  constructor(
    private readonly config: AppConfig,
    private readonly owner: RecordingSession["owner"],
    readonly store = new RecordingSessionStore(),
    private readonly run = runCommand
  ) {}

  ownsRecording(): boolean { return this.session?.owner === this.owner; }
  getSession(): RecordingSession | null { return this.session; }

  async inspect(): Promise<{ session: RecordingSession | null; active: boolean }> {
    const session = await this.store.read();
    if (!session || session.phase === "stopped") return { session, active: false };
    const active = session.backend === "obs"
      ? await new ManualObsController(this.config.obs).matchesSession(dirname(session.outputPath), session.startedAt)
      : await this.isActive(session);
    return { session, active };
  }

  async health(): Promise<{ active: boolean; warning?: string }> {
    const { session, active } = await this.inspect();
    if (!session) return { active: false };
    if (!active) return { active: false, warning: "A captura terminou; a gravação precisa ser finalizada." };
    const warnings: string[] = [];
    if (session.backend !== "obs") {
      if (!session.audio) warnings.push("As origens capturadas desta sessão estão indisponíveis; os defaults atuais não validam esta captura.");
      const stat = await fs.stat(session.outputPath).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs > 30_000) {
        warnings.push("O arquivo de gravação está sem novos dados há mais de 30 segundos.");
      }
      if (Object.keys(session.audio || {}).length) {
        const defaults: AudioSources = {};
        let available: string[] | undefined;
        let sourceMetadata: Record<string, unknown>[] = [];
        const inspectRun: typeof runCommand = async (command, args, options) => {
          const result = await this.run(command, args, options);
          const value = result.stdout.trim();
          if (args[0] === "get-default-source" && value && !/[\r\n\0]/.test(value)) defaults.microphone = value;
          if (args[0] === "get-default-sink" && value && !/[\r\n\0]/.test(value)) defaults.desktop = `${value}.monitor`;
          if (args[0] === "--format=json") {
            try {
              const parsed: unknown = JSON.parse(result.stdout);
              if (Array.isArray(parsed)) {
                sourceMetadata = parsed.filter((source): source is Record<string, unknown> =>
                  source !== null && typeof source === "object" && !Array.isArray(source));
                available = sourceMetadata.flatMap((source) => typeof source.name === "string" ? [source.name] : []);
              }
            } catch { /* Invalid metadata is reported by the inspector below. */ }
          }
          return result;
        };
        try {
          const inspection = await inspectAudioSources(capturedAudioConfig(this.config.capture, session.audio!), inspectRun);
          warnings.push(...(inspection.warnings || []));
          for (const [kind, captured] of Object.entries(session.audio!)) {
            const metadata = sourceMetadata.find((source) => source.name === captured);
            if (typeof metadata?.mute !== "boolean" || !hasVolumeControl(metadata.volume)) {
              warnings.push(`Os metadados de mute/volume da origem ${kind} capturada estão indisponíveis; o sinal de áudio não foi confirmado.`);
            }
          }
        } catch (error) {
          if (available && Object.values(session.audio!).some((device) => !available!.includes(device))) {
            warnings.push("Um dispositivo de áudio da gravação foi desconectado.");
          } else if (error instanceof Error && error.message.startsWith("Todas as fontes de áudio selecionadas")) {
            warnings.push(error.message);
          } else {
            warnings.push("Não foi possível verificar os metadados das fontes capturadas; o sinal de áudio não foi confirmado.");
          }
          warnings.push(...(session.audioWarnings || []).map((warning) => `Na verificação inicial: ${warning}`));
        }
        for (const [kind, captured] of Object.entries(session.audio!) as [keyof AudioSources, string][]) {
          const current = defaults[kind];
          const selection = session.audioSelection?.[kind];
          if (!current || !available?.includes(current)) {
            warnings.push(`Não foi possível confirmar a origem padrão atual de ${kind}; a seleção da captura foi preservada.`);
          } else if (current !== captured) {
            const context = selection === "default" ? "selecionada pelo padrão no início" : selection === "explicit"
              ? "configurada explicitamente (fixada)" : "com modo de seleção inicial desconhecido";
            warnings.push(`A origem ${kind} da captura (${captured}, ${context}) difere do padrão atual (${current}). A rota efetiva do playback não foi verificada.`);
          } else if (!selection) {
            warnings.push(`O modo de seleção inicial de ${kind} está indisponível; não foi confirmado se a origem foi fixada ou escolhida pelo padrão.`);
          }
        }
      }
    }
    return { active, ...(warnings.length ? { warning: [...new Set(warnings)].join(" ") } : {}) };
  }

  private async isActive(session: RecordingSession): Promise<boolean> {
    if (session.flatpak && await findFlatpakCapture(session.outputPath, this.run)) return true;
    return this.isUnitActive(session);
  }

  private async isUnitActive(session: RecordingSession): Promise<boolean> {
    const { stdout } = await this.run("systemctl", ["--user", "show", unitName(session.id),
      "--property=ActiveState", "--property=MainPID"], { timeoutMs: 5_000 });
    return /ActiveState=(active|activating|deactivating)\b/.test(stdout);
  }

  async recover(): Promise<RecordingSession | null> {
    const lease = await acquireSingleton("capture-control");
    try { return await this.recoverLocked(); }
    finally { await lease.release(); }
  }

  private async recoverLocked(): Promise<RecordingSession | null> {
    const session = await this.store.read();
    if (!session || session.owner !== this.owner) { this.session = null; return null; }
    if (session.backend === "obs" && session.phase !== "stopped" && !this.obsStartedHere) {
      const obs = new ManualObsController(this.config.obs);
      if (!await obs.matchesSession(dirname(session.outputPath), session.startedAt)) {
        if (await obs.isRecording()) {
          throw new Error("OBS session needs manual verification after a restart; recording state was retained");
        }
        const folder = dirname(session.outputPath);
        const candidates = (await fs.readdir(folder, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /\.(mkv|mp4|mov|webm)$/i.test(entry.name));
        if (candidates.length !== 1) throw new Error("Cannot identify this OBS session's media unambiguously; state retained");
        session.outputPath = join(folder, candidates[0].name);
        session.phase = "stopped";
        session.endedAt = (await fs.stat(session.outputPath)).mtime.toISOString();
        await this.store.write(session);
      }
      this.obsStartedHere = true;
    }
    if (session.backend !== "obs" && session.phase !== "stopped" && !await this.isActive(session)) {
      if (!await hasMedia(session.outputPath)) {
        throw new Error("Capture exited without media; inspect the capture logs before resetting the session");
      }
      session.phase = "stopped";
      session.endedAt = (await fs.stat(session.outputPath)).mtime.toISOString();
      await this.store.write(session);
    }
    this.session = session;
    return session;
  }

  async start(options: RecordingStartOptions = {}): Promise<"started" | "already-recording" | "cancelled"> {
    const lease = await acquireSingleton("capture-control");
    try {
      if (await this.store.read() || await readState()) return "already-recording";
      if (options.signal?.aborted || await options.shouldContinue?.() === false) return "cancelled";
      const backend = sharedControllerBackend(this.config);
      if (!backend) throw new Error("This backend does not support the shared automatic recording controller");
      const id = validateJobId(options.sessionId || randomUUID());
      const baseName = formatName(this.config.features.namingTemplate, options.title);
      // Naming templates cannot escape the recordings directory or collide between sessions.
      const safeName = baseName.replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 160);
      const folder = join(this.config.recordingsDir, `${safeName}-${id.slice(0, 8)}`);
      const outputPath = join(folder, `recording.${backend === "audio" ? "mka" : "mkv"}`);
      const captureConfig = { ...this.config.capture, audioSource: options.audioSource || this.config.capture.audioSource };
      const profile = assertCaptureProfile(backend,captureConfig);
      const audioInspection = backend === "obs" || captureConfig.audioSource === "none"
        ? { selected: {}, warnings: [] } : await inspectAudioSources(captureConfig, this.run);
      const audio = audioInspection.selected;
      const audioSelection: AudioSelection = {};
      for (const kind of Object.keys(audio) as (keyof AudioSources)[]) {
        audioSelection[kind] = captureConfig[kind] === "default" ? "default" : "explicit";
      }
      const gpu = backend === "gpu-screen-recorder" ? await resolveGpuRecorder() : null;
      if (backend === "gpu-screen-recorder" && !gpu) throw new Error("GPU Screen Recorder is not installed (native or Flatpak)");
      if(profile === "call-light") { await verifyCallLightSupport(gpu!,this.run); console.error(captureProfileNotice(captureConfig)); }
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const session: RecordingSession = { version: 1, id, owner: this.owner, backend,
        phase: "starting", captureProfile: profile, outputPath, startedAt: new Date().toISOString(), audio, audioSelection,
        audioWarnings: audioInspection.warnings || [], app: options.app,
        ...(gpu?.args.includes("run") ? { flatpak: true } : {}) };
      await this.store.write(session);
      this.session = session;
      try {
        if (backend === "obs") {
          await new ManualObsController(this.config.obs).start(folder, options);
          this.obsStartedHere = true;
          session.startedAt = new Date().toISOString();
        } else {
          const capture = buildCaptureCommand(backend, captureConfig, audio, outputPath, join(dirname(this.store.path), "portal-token"));
          const command = gpu?.command || capture.command;
          const commandArgs = [...(gpu?.args || []), ...capture.args];
          const envArgs = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER"]
            .filter((key) => process.env[key]).map((key) => `--setenv=${key}=${process.env[key]}`);
          if (options.signal?.aborted || await options.shouldContinue?.() === false) throw new RecordingStartCancelled("Recording start cancelled");
          await this.run("systemd-run", ["--user", "--quiet", `--unit=${unitName(id)}`,
            "--property=Type=exec", "--property=KillSignal=SIGINT", "--property=TimeoutStopSec=30",
            "--property=UMask=0077", "--property=Restart=no", ...envArgs, "--", command, ...commandArgs], { timeoutMs: 15_000 });
          const deadline = Date.now() + this.config.capture.startupTimeoutSeconds * 1_000;
          while (true) {
            if (options.signal?.aborted || await options.shouldContinue?.() === false) {
              await this.stopCapture(session);
              if (await hasMedia(outputPath)) {
                session.phase = "stopped";
                session.endedAt = new Date().toISOString();
                await this.store.write(session);
              } else {
                await this.clearSession(id);
              }
              return "cancelled";
            }
            if (!await this.isActive(session)) throw new Error("Capture process exited before recording; inspect record logs");
            if (await hasMedia(outputPath)) {
              if (options.signal?.aborted || await options.shouldContinue?.() === false) throw new RecordingStartCancelled("Recording start cancelled");
              break;
            }
            if (Date.now() >= deadline) throw new Error("Capture did not start in time; select a source in the desktop portal");
            await wait(250);
          }
        }
        session.phase = "recording";
        await this.store.write(session);
        return "started";
      } catch (err) {
        if (backend !== "obs") {
          await this.stopCapture(session);
          if (await hasMedia(outputPath)) {
            session.phase = "stopped";
            session.endedAt = new Date().toISOString();
            await this.store.write(session);
          } else {
            await this.clearSession(id);
          }
        } else if (!this.obsStartedHere && !(err instanceof ObsStartUncertain)) {
          await this.clearSession(id);
        }
        if (err instanceof RecordingStartCancelled) return "cancelled";
        throw err;
      }
    } finally { await lease.release(); }
  }

  private async stopCapture(session: RecordingSession): Promise<void> {
    if (session.flatpak) {
      const capture = await findFlatpakCapture(session.outputPath, this.run);
      if (capture && await captureProcessMatches(capture, session.outputPath)) {
        await this.run("kill", ["-s", "INT", String(capture.pid)], { timeoutMs: 5_000 });
        const deadline = Date.now() + 30_000;
        while (await captureProcessMatches(capture, session.outputPath)) {
          if (Date.now() >= deadline) throw new Error("Flatpak capture did not finalize; recording state retained");
          await wait(100);
        }
      }
    }
    if (await this.isUnitActive(session)) {
      // The unit belongs to this UUID. SIGINT finalizes the container; systemd waits for exit.
      await this.run("systemctl", ["--user", "stop", unitName(session.id)], { timeoutMs: 40_000 });
    }
    if (session.flatpak && await findFlatpakCapture(session.outputPath, this.run)) {
      throw new Error("Flatpak capture is still active; recording state retained");
    }
  }

  async stop(id: string, endedAt = new Date().toISOString()): Promise<RecordingSession | null> {
    const lease = await acquireSingleton("capture-control");
    try {
      const session = await this.store.read();
      if (!session) { this.session = null; return null; }
      if (session.id !== id || session.owner !== this.owner) return null;
      if (session.phase !== "stopped") {
        if (session.backend === "obs") {
          // After a restart, do not infer that an unrelated OBS recording belongs to us.
          if (!await new ManualObsController(this.config.obs).matchesSession(dirname(session.outputPath), session.startedAt)) {
            throw new Error("OBS ownership cannot be verified; inspect the active recording in OBS");
          }
          const output = await new ManualObsController(this.config.obs).stop();
          if (!output || !isAbsolute(output) || dirname(resolve(output)) !== dirname(resolve(session.outputPath))) {
            throw new Error("OBS did not return this session's recording; state retained");
          }
          session.outputPath = output;
        } else {
          await this.stopCapture(session);
        }
        session.phase = "stopped";
        session.endedAt = endedAt;
        await this.store.write(session);
      }
      this.session = session;
      if (this.config.archive.enabled) {
        await new ArchiveStore().enqueue(session.outputPath, { id: session.id, createdAt: session.startedAt });
      }
      await probeMedia(session.outputPath);
      return session;
    } finally { await lease.release(); }
  }

  async acknowledge(id: string): Promise<void> {
    const lease = await acquireSingleton("capture-control");
    try { await this.clearSession(id); }
    finally { await lease.release(); }
  }

  private async clearSession(id: string): Promise<void> {
    await this.store.clear(id);
    this.session = null;
  }
}
