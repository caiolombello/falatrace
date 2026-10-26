import type { AppConfig } from "../config/defaults";
import { type LiveTranscriptView, readLiveTranscript, runLiveSession, validateLiveSessionId } from "../live";
import { LIVE_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, clockText, defaultLoadConfig, type Interrupt, notice, oneLine, parseArgs, printJson, printLine, processInterrupt, processIO, sleep } from "./shared";

export { LIVE_HELP };

export type LiveCommand =
  | { action: "run"; sessionId: string }
  | { action: "show"; sessionId: string; follow: boolean; json: boolean };

/** `live run --session <uuid>` (the transient unit) or `live show <session> [--follow] [--json]`. */
export const parseLiveArgs = (args: readonly string[]): LiveCommand => {
  const [command, action, ...rest] = args;
  if (command !== "live") throw new Error(CLI_USAGE.live);
  if (action === "run") {
    const parsed = parseArgs(rest, { values: ["--session"] });
    const session = parsed.values["--session"];
    if (!session || parsed.positionals.length) throw new Error(CLI_MESSAGES.sessionRequired);
    return { action, sessionId: validateLiveSessionId(session) };
  }
  if (action === "show") {
    const parsed = parseArgs(rest, { flags: ["--follow", "--json"] });
    const [session, ...extra] = parsed.positionals;
    if (!session || extra.length) throw new Error(CLI_MESSAGES.liveSessionRequired);
    return { action, sessionId: validateLiveSessionId(session), follow: parsed.flags.has("--follow"), json: parsed.flags.has("--json") };
  }
  throw new Error(CLI_USAGE.live);
};

export type LiveCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  runSession: typeof runLiveSession;
  read: (sessionId: string, sinceSeq: number) => Promise<LiveTranscriptView>;
  sleep: (ms: number) => Promise<void>;
  interrupt: () => Interrupt;
  followPollMs?: number;
};

export const defaultLiveCliDeps = (): LiveCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  runSession: runLiveSession,
  read: (sessionId, sinceSeq) => readLiveTranscript(sessionId, sinceSeq),
  sleep,
  interrupt: processInterrupt
});

const finished = (view: LiveTranscriptView): boolean =>
  view.stale || view.status?.state === "stopped" || view.status?.state === "failed";

export const runLiveCli = async (args: string[], deps: LiveCliDeps = defaultLiveCliDeps()): Promise<void> => {
  const { io } = deps;
  if (args[1] === "help" || args[1] === "--help") { io.out(LIVE_HELP); return; }
  const command = parseLiveArgs(args);
  if (command.action === "run") {
    const config = await deps.loadConfig();
    const interrupt = deps.interrupt();
    try {
      const result = await deps.runSession({ config, sessionId: command.sessionId, signal: interrupt.signal });
      printJson(io, result);
      if (result.state === "failed") throw new Error(result.error || CLI_MESSAGES.liveFailed);
    } finally {
      interrupt.dispose();
    }
    return;
  }
  let since = 0;
  let view = await deps.read(command.sessionId, since);
  if (command.json && !command.follow) { printJson(io, view); return; }
  const interrupt = command.follow ? deps.interrupt() : undefined;
  try {
    for (;;) {
      for (const line of view.lines) {
        since = Math.max(since, line.seq);
        printLine(io, command.json ? JSON.stringify(line) : `[${clockText(line.start)}] ${oneLine(line.text, 2_000)}`);
      }
      // More stored lines come at once; a following reader waits only when it is caught up.
      if (view.hasMore) { view = await deps.read(command.sessionId, since); continue; }
      if (!command.follow || interrupt?.signal.aborted || finished(view)) break;
      await deps.sleep(deps.followPollMs ?? 1_500);
      if (interrupt?.signal.aborted) break;
      view = await deps.read(command.sessionId, since);
    }
  } finally {
    interrupt?.dispose();
  }
  if (!command.follow) return;
  if (view.status?.state === "failed") throw new Error(view.status.error || CLI_MESSAGES.liveStale);
  if (view.stale) notice(io, CLI_MESSAGES.liveStale);
  else if (view.status?.state === "stopped") notice(io, CLI_MESSAGES.liveStopped);
};
