import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../jobs/store";
import type {
  CallApplication,
  CallMonitorState,
  NetworkTelemetry
} from "./types";
import { redactResolvedSecrets } from "../config/secrets";

const getStateRoot = (): string =>
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

export const getCallStatusPath = (dryRun = false): string =>
  join(getStateRoot(), "recording-cli", dryRun ? "call-monitor-dry-run.json" : "call-monitor.json");

export type CallMonitorStatus = {
  version: 1;
  state: CallMonitorState;
  app?: CallApplication;
  confidence: number;
  reasons: string[];
  updatedAt: string;
  dryRun: boolean;
  recordingOwned: boolean;
  recordingBackend?: "obs" | "audio" | "gpu-screen-recorder";
  recordingWarning?: string;
  automationPaused?: boolean;
  network?: NetworkTelemetry;
};

export const writeCallStatus = async (status: CallMonitorStatus): Promise<void> => {
  const path = getCallStatusPath(status.dryRun);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, status);
};

export const readCallStatus = async (): Promise<CallMonitorStatus | null> => {
  try {
    const parsed = JSON.parse(await fs.readFile(getCallStatusPath(), "utf-8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as CallMonitorStatus).version !== 1 ||
      typeof (parsed as CallMonitorStatus).state !== "string" ||
      !["IDLE", "CANDIDATE", "IN_CALL", "ENDING"].includes(
        (parsed as CallMonitorStatus).state
      )
    ) {
      throw new Error("Invalid call monitor status");
    }
    return parsed as CallMonitorStatus;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export const logCallEvent = (event: string, details: Record<string, unknown> = {}): void => {
  const safeEvent = event.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 80);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: safeEvent,
    ...details
  }));
};

export const sanitizeError = (err: unknown): string =>
  (() => {
    let message = (err instanceof Error ? err.message : String(err))
      .replace(/[\r\n\0]+/g, " ");
    const obsPassword = process.env.RECORDING_CLI_OBS_PASSWORD;
    if (obsPassword) message = message.replaceAll(obsPassword, "[redacted]");
    message = redactResolvedSecrets(message);
    return message.slice(0, 500);
  })();
