import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { readAutomationState } from "../calls/control";
import { getCallStatusPath, readCallStatus, sanitizeError } from "../calls/status";
import { loadConfig } from "../config/load";
import { runCommand } from "../jobs/command";
import { JobStore } from "../jobs/store";
import { RecordingController } from "../recording/controller";
import { RecordingSessionStore } from "../recording/session";
import { acquireSingleton } from "../runtime/singleton";
import { readTimeEntryCounts } from "../timesheet/store";
import {
  presentTrayStatus,
  type CallMonitorState,
  type TrayActionFeedback,
  type TrayContext,
  type TrayPresentation,
  type TrayProcessingCounts
} from "./presentation";
import { INDICATOR_SCRIPT } from "./python";
import { getServiceLaunchCommand } from "../runtime/launcher";

const MONITOR_SERVICE = "recording-cli-calls.service";
const FALLBACK_REFRESH_MS = 15_000;

export type TrayAction =
  | "open-tui"
  | "open-timesheet"
  | "view-logs"
  | "restart-monitor"
  | "start-recording"
  | "stop-recording"
  | "pause-automation"
  | "resume-automation";

type CliTrayAction = Extract<
  TrayAction,
  "start-recording" | "stop-recording" | "pause-automation" | "resume-automation"
>;

type FeedbackTrayAction = CliTrayAction | "open-tui";

const cliActionCommand: Record<CliTrayAction, readonly [string, string]> = {
  "start-recording": ["record", "start"],
  "stop-recording": ["record", "stop"],
  "pause-automation": ["calls", "pause"],
  "resume-automation": ["calls", "resume"]
};

export const buildCliActionRunArgs = (
  action: CliTrayAction,
  launchCommand: string[],
  unitSuffix: string
): string[] => [
  "--user",
  "--quiet",
  "--collect",
  "--wait",
  "--pipe",
  `--unit=recording-cli-tray-action-${unitSuffix}`,
  "--",
  ...launchCommand,
  ...cliActionCommand[action]
];

const getLaunchCommand = (): string[] => getServiceLaunchCommand();

const terminalCandidates = [
  { path: "/usr/bin/konsole", args: ["-e"] },
  { path: "/usr/bin/ptyxis", args: ["--new-window", "--"] },
  { path: "/usr/bin/gnome-terminal", args: ["--"] },
  { path: "/usr/bin/x-terminal-emulator", args: ["-e"] }
];

const findTerminal = async (): Promise<(typeof terminalCandidates)[number]> => {
  for (const terminal of terminalCandidates) {
    try {
      await fs.access(terminal.path);
      return terminal;
    } catch {
      // Try the next supported terminal.
    }
  }
  throw new Error("No supported terminal found (Konsole, Ptyxis, GNOME Terminal, or x-terminal-emulator)");
};

export const buildTerminalLaunchArgs = (
  terminal: (typeof terminalCandidates)[number],
  command: string[],
  unitSuffix: string
): string[] => [
  "--user",
  "--quiet",
  "--collect",
  `--unit=recording-cli-terminal-${unitSuffix}`,
  "--",
  terminal.path,
  ...terminal.args,
  ...command
];

export const buildStudioLaunchArgs = (
  command: string,
  unitSuffix: string
): string[] => [
  "--user",
  "--quiet",
  "--collect",
  "--property=Type=exec",
  `--unit=recording-cli-studio-${unitSuffix}`,
  "--",
  command
];

export const launchRecordingStudio = async (
  command = join(homedir(), ".local", "bin", "recording-studio"),
  runner: (
    executable: string,
    args: string[],
    options: { timeoutMs: number }
  ) => Promise<unknown> = runCommand
): Promise<void> => {
  try {
    await fs.access(command, fsConstants.X_OK);
  } catch {
    throw new Error(
      `FalaTrace Studio não está instalado em ${command}. Execute novamente o instalador do FalaTrace ou, a partir do código-fonte, make install-studio.`
    );
  }

  try {
    await runner("/usr/bin/systemd-run", buildStudioLaunchArgs(
      command,
      `${process.pid}-${Date.now()}`
    ), { timeoutMs: 15_000 });
  } catch {
    throw new Error(
      "Não foi possível abrir o FalaTrace Studio. Verifique o journal do usuário para mais detalhes."
    );
  }
};

const launchInTerminal = async (command: string[]): Promise<void> => {
  const terminal = await findTerminal();
  // The tray runs with ProtectHome=read-only. Ask the user manager to create
  // the terminal outside that mount namespace so the TUI can safely update
  // its own state and Konsole can write its normal configuration.
  const child = spawn("/usr/bin/systemd-run", buildTerminalLaunchArgs(
    terminal,
    command,
    `${process.pid}-${Date.now()}`
  ), {
    detached: true,
    stdio: "ignore"
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
};

export const monitorStateFromSystemdProperties = (
  loadState: string,
  activeState: string,
  unitFileState: string
): CallMonitorState => {
  if (activeState === "active") return "active";

  // The call monitor is optional. A missing unit or one explicitly disabled
  // locally is not a fault in the tray indicator.
  if (
    loadState === "not-found" ||
    ["disabled", "masked", "masked-runtime"].includes(unitFileState)
  ) {
    return "disabled";
  }

  // A loaded/enabled service that is inactive or failed needs attention.
  return "unhealthy";
};

const readMonitorState = async (): Promise<CallMonitorState> => {
  try {
    const { stdout } = await runCommand("systemctl", [
      "--user",
      "show",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=UnitFileState",
      "--value",
      MONITOR_SERVICE
    ], {
      timeoutMs: 3_000
    });
    const [loadState = "", activeState = "", unitFileState = ""] = stdout
      .split(/\r?\n/)
      .map((value) => value.trim());
    return monitorStateFromSystemdProperties(loadState, activeState, unitFileState);
  } catch {
    // A broken systemd user session is different from intentionally opting out.
    return "unhealthy";
  }
};

const readProcessingCounts = async (): Promise<TrayProcessingCounts> => {
  const counts: TrayProcessingCounts = {
    pending: 0,
    transferring: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0
  };
  for (const job of await new JobStore().list()) counts[job.state] += 1;
  return counts;
};

const readRecordingContext = async (): Promise<Pick<TrayContext, "recording" | "recordingError">> => {
  try {
    const store = new RecordingSessionStore();
    const session = await store.read();
    if (!session) return {};
    if (session.phase !== "recording") {
      return { recording: { session, active: false } };
    }
    const { config } = await loadConfig();
    const health = await new RecordingController(config, session.owner, store).health();
    return { recording: { session, active: health.active, warning: health.warning } };
  } catch (err) {
    return { recordingError: sanitizeError(err) };
  }
};

const readTrayContext = async (action?: TrayActionFeedback): Promise<TrayContext> => {
  const [automation, recording] = await Promise.all([
    readAutomationState()
      .then((state) => ({ paused: state.paused }))
      .catch((err) => ({ error: sanitizeError(err) })),
    readRecordingContext()
  ]);
  return { automation, ...recording, action };
};

const readPresentation = async (action?: TrayActionFeedback): Promise<TrayPresentation> => {
  const monitorState = await readMonitorState();
  const [status, counts, processingCounts, context] = await Promise.all([
    monitorState === "active" ? readCallStatus().catch(() => null) : Promise.resolve(null),
    readTimeEntryCounts().catch(() => ({
      capturing: 0,
      draft: 0,
      ready: 0,
      synced: 0
    })),
    readProcessingCounts().catch(() => ({
      pending: 0,
      transferring: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0
    })),
    readTrayContext(action)
  ]);
  return presentTrayStatus(status, monitorState, counts, processingCounts, context);
};

export const trayActionIsAllowed = (
  action: TrayAction,
  monitorState: CallMonitorState
): boolean => action !== "restart-monitor" || monitorState !== "disabled";

const handleAction = async (action: TrayAction): Promise<void> => {
  if (action in cliActionCommand) {
    await runCommand("/usr/bin/systemd-run", buildCliActionRunArgs(
      action as CliTrayAction,
      getLaunchCommand(),
      `${process.pid}-${Date.now()}`
    ), { timeoutMs: 300_000 });
    return;
  }
  if (action === "open-tui") {
    await launchRecordingStudio();
    return;
  }
  if (action === "open-timesheet") {
    await launchInTerminal([
      ...getLaunchCommand(),
      "tui",
      "--section",
      "timesheet"
    ]);
    return;
  }
  if (action === "view-logs") {
    await launchInTerminal([
      "/usr/bin/journalctl",
      "--user",
      "-u",
      MONITOR_SERVICE,
      "-f"
    ]);
    return;
  }
  // The item is disabled in the view, but re-check here in case a stale or
  // forged helper message tries to restart an intentionally disabled monitor.
  if (!trayActionIsAllowed(action, await readMonitorState())) return;
  await runCommand("systemctl", ["--user", "restart", MONITOR_SERVICE], { timeoutMs: 15_000 });
};

const actionFeedback = (
  action: FeedbackTrayAction,
  kind: TrayActionFeedback["kind"],
  error?: unknown
): TrayActionFeedback => {
  const verb = {
    "open-tui": ["Abrindo biblioteca…", "Biblioteca aberta"],
    "start-recording": ["Iniciando gravação manual…", "Gravação manual iniciada"],
    "stop-recording": ["Parando e finalizando gravação…", "Gravação finalizada"],
    "pause-automation": ["Suspendendo captura automática…", "Captura automática suspensa"],
    "resume-automation": ["Retomando captura automática…", "Captura automática retomada"]
  }[action];
  return {
    action,
    kind,
    text: kind === "busy"
      ? verb[0]
      : kind === "success"
        ? verb[1]
        : `Falha: ${sanitizeError(error)}`
  };
};

const startIndicator = (): ChildProcessWithoutNullStreams =>
  spawn("python3", ["-c", INDICATOR_SCRIPT], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });

export const checkTrayDependencies = async (): Promise<void> => {
  const probe = [
    "import gi",
    'gi.require_version("Gtk", "3.0")',
    'gi.require_version("AyatanaAppIndicator3", "0.1")',
    "from gi.repository import Gtk, AyatanaAppIndicator3"
  ].join("; ");
  try {
    await runCommand("python3", ["-c", probe], { timeoutMs: 5_000 });
  } catch {
    throw new Error(
      "Tray dependencies are missing. Install python3-gi and gir1.2-ayatanaappindicator3-0.1, then use a StatusNotifier-compatible desktop tray."
    );
  }
  try {
    await runCommand("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.kde.StatusNotifierWatcher",
      "--object-path",
      "/StatusNotifierWatcher",
      "--method",
      "org.freedesktop.DBus.Peer.Ping"
    ], { timeoutMs: 5_000 });
  } catch {
    throw new Error(
      "No StatusNotifier host is available. Start the desktop notification area or another StatusNotifier-compatible tray."
    );
  }
};

export const runTray = async (signal: AbortSignal): Promise<void> => {
  const lease = await acquireSingleton("tray-indicator");
  const statusDirectory = dirname(getCallStatusPath());
  await fs.mkdir(statusDirectory, { recursive: true, mode: 0o700 });
  const indicator = startIndicator();
  indicator.stdin.on("error", () => undefined);
  let stderr = "";
  indicator.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-5_000);
  });

  let stopped = false;
  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastView = "";
  let publishQueue: Promise<void> = Promise.resolve();
  let currentAction: TrayActionFeedback | undefined;
  let cliActionRunning = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = async (): Promise<void> => {
    if (stopped || !indicator.stdin.writable) return;
    const view = JSON.stringify({ type: "view", ...await readPresentation(currentAction) });
    if (view === lastView) return;
    lastView = view;
    indicator.stdin.write(`${view}\n`);
  };
  const queuePublish = (): void => {
    publishQueue = publishQueue
      .then(publish)
      .catch((err) => console.error(`Tray state update failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const schedulePublish = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(queuePublish, 100);
  };

  const runFeedbackAction = async (action: FeedbackTrayAction): Promise<void> => {
    if (cliActionRunning) return;
    cliActionRunning = true;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    currentAction = actionFeedback(action, "busy");
    queuePublish();
    try {
      await handleAction(action);
      currentAction = actionFeedback(action, "success");
      feedbackTimer = setTimeout(() => {
        currentAction = undefined;
        queuePublish();
      }, 10_000);
    } catch (err) {
      currentAction = actionFeedback(action, "error", err);
      console.error(`Tray action failed: ${sanitizeError(err)}`);
    } finally {
      cliActionRunning = false;
      queuePublish();
    }
  };

  const output = createInterface({ input: indicator.stdout });
  output.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { action?: TrayAction; event?: string };
      if (message.event === "ready") {
        console.log(JSON.stringify({ event: "tray.ready" }));
        queuePublish();
      }
      if (
        message.action &&
        [
          "open-tui",
          "open-timesheet",
          "view-logs",
          "restart-monitor",
          "start-recording",
          "stop-recording",
          "pause-automation",
          "resume-automation"
        ].includes(message.action)
      ) {
        if (message.action === "open-tui" || message.action in cliActionCommand) {
          void runFeedbackAction(message.action as FeedbackTrayAction);
        } else if (!cliActionRunning) {
          void handleAction(message.action).then(schedulePublish).catch((err) => {
            console.error(`Tray action failed: ${sanitizeError(err)}`);
          });
        }
      }
    } catch {
      // Ignore malformed helper output.
    }
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    indicator.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    indicator.once("error", (err) => {
      stderr = `${stderr}${err.message}`.slice(-5_000);
    });
  });

  const abort = (): void => {
    stopped = true;
    indicator.kill("SIGTERM");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    watcher = watch(statusDirectory, schedulePublish);
    const refreshTimer = setInterval(queuePublish, FALLBACK_REFRESH_MS);
    try {
      const result = await exited;
      if (!signal.aborted && result.code !== 0) {
        throw new Error(`Tray helper exited with code ${result.code}: ${stderr.trim() || "unknown error"}`);
      }
    } finally {
      clearInterval(refreshTimer);
    }
  } finally {
    stopped = true;
    signal.removeEventListener("abort", abort);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    watcher?.close();
    output.close();
    indicator.stdin.end();
    if (indicator.exitCode === null && indicator.signalCode === null) indicator.kill("SIGTERM");
    await publishQueue;
    await lease.release();
  }
};
