import { runCommand } from "../jobs/command";
import { transientCommand } from "../runtime/systemd-units";
import { callApplicationLabel } from "./apps";
import type { CallApplication } from "./types";

const appLabel = (app?: CallApplication): string => callApplicationLabel(app) || "aplicativo";

let notificationSequence = 0;

const notify = async (args: string[]): Promise<void> => {
  // The call monitor keeps ProtectHome=read-only. Delegate the desktop
  // notification to the user manager so notify-send can access the normal
  // Plasma session without weakening the monitor sandbox.
  const unitSuffix = `${process.pid}-${Date.now()}-${notificationSequence++}`;
  await runCommand(
    "/usr/bin/systemd-run",
    [
      "--user",
      "--quiet",
      "--wait",
      "--collect",
      `--unit=recording-cli-notify-${unitSuffix}`,
      "--",
      ...transientCommand(["/usr/bin/notify-send", ...args])
    ],
    { timeoutMs: 5_000 }
  );
};

export const notifyCallStarted = async (app?: CallApplication): Promise<void> => {
  await notify([
    "--app-name",
    "recording-cli",
    "--urgency",
    "normal",
    "Possível chamada detectada",
    appLabel(app)
  ]);
};

export const notifyCallEnded = async (app?: CallApplication): Promise<void> => {
  await notify([
    "--app-name",
    "recording-cli",
    "--urgency",
    "low",
    "Chamada encerrada",
    appLabel(app)
  ]);
};

export const notifyRecordingUnavailable = async (): Promise<void> => {
  await notify([
    "--app-name",
    "recording-cli",
    "--urgency",
    "normal",
    "Gravador indisponível",
    "A chamada continuará sem gravação automática."
  ]);
};

export const notifyRecordingWarning = async (message: string): Promise<void> => {
  await notify(["--app-name", "recording-cli", "--urgency", "normal", "Verifique a gravação", message]);
};

export const notifyRecordingStarted = async (app?: CallApplication): Promise<void> => {
  await notify([
    "--app-name",
    "recording-cli",
    "--urgency",
    "normal",
    "Gravação iniciada",
    appLabel(app)
  ]);
};

export const notifyRecordingStopped = async (app?: CallApplication): Promise<void> => {
  await notify([
    "--app-name",
    "recording-cli",
    "--urgency",
    "low",
    "Gravação encerrada",
    appLabel(app)
  ]);
};
