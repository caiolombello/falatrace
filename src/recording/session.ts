import type { CallApplication } from "../calls/apps";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { writeJsonAtomic } from "../jobs/store";
import { validateJobId } from "../jobs/types";
import type { AudioSources, CaptureBackend } from "./capture";
import type { AppConfig } from "../config/defaults";

export type AudioSelection = Partial<Record<keyof AudioSources, "default" | "explicit">>;

/** Inspect the sources requested by this session, even when configured defaults have changed. */
export const capturedAudioConfig = (config: AppConfig["capture"], audio: AudioSources): AppConfig["capture"] => ({
  ...config,
  audioSource: audio.microphone && audio.desktop ? "both" : audio.microphone ? "microphone" : audio.desktop ? "desktop" : "none",
  microphone: audio.microphone || "default",
  desktop: audio.desktop || "default"
});

export type RecordingSession = {
  version: 1;
  id: string;
  owner: "manual" | "call";
  backend: CaptureBackend | "obs";
  phase: "starting" | "recording" | "stopped";
  outputPath: string;
  startedAt: string;
  endedAt?: string;
  audio?: AudioSources;
  audioSelection?: AudioSelection;
  /** Historical startup observations; current health checks refresh these observations. */
  audioWarnings?: string[];
  app?: CallApplication;
  flatpak?: boolean;
  captureProfile?: "standard"|"call-light";
};

export const getRecordingStateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "recording-cli");

export class RecordingSessionStore {
  constructor(readonly path = join(getRecordingStateDir(), "recording-session.json")) {}

  async read(): Promise<RecordingSession | null> {
    try {
      const session = JSON.parse(await fs.readFile(this.path, "utf8")) as RecordingSession;
      validateJobId(session.id);
      if (session.version !== 1 || !["manual", "call"].includes(session.owner) ||
        !["audio", "gpu-screen-recorder", "obs"].includes(session.backend) ||
        !["starting", "recording", "stopped"].includes(session.phase) ||
        (session.captureProfile !== undefined && !["standard","call-light"].includes(session.captureProfile)) ||
        (session.flatpak !== undefined && typeof session.flatpak !== "boolean") ||
        typeof session.outputPath !== "string" || !isAbsolute(session.outputPath) || /[\r\n\0]/.test(session.outputPath) ||
        !Number.isFinite(Date.parse(session.startedAt)) ||
        (session.audioSelection !== undefined && (!session.audioSelection || typeof session.audioSelection !== "object" ||
          Array.isArray(session.audioSelection) || Object.entries(session.audioSelection).some(([kind, mode]) =>
            !["microphone", "desktop"].includes(kind) || !["default", "explicit"].includes(mode)))) ||
        (session.audioWarnings !== undefined && (!Array.isArray(session.audioWarnings) || session.audioWarnings.length > 4 ||
          session.audioWarnings.some((warning) => typeof warning !== "string" || warning.length > 1_000)))) {
        throw new Error("Invalid recording session; state retained for recovery");
      }
      return session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(session: RecordingSession): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.path, session);
  }

  async clear(id: string): Promise<void> {
    const session = await this.read();
    if (session && session.id !== id) throw new Error("Recording session changed; refusing to clear it");
    await fs.rm(this.path, { force: true });
  }
}
