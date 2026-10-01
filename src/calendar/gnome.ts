import { spawn, type ChildProcess } from "node:child_process";
import { runCommand } from "../jobs/command";
import type { MeetingContext } from "../jobs/types";

const CALENDAR_SERVICE = "org.gnome.Shell.CalendarServer";
const CALENDAR_PATH = "/org/gnome/Shell/CalendarServer";
const CALENDAR_INTERFACE = "org.gnome.Shell.CalendarServer";
const MAX_QUERY_WINDOW_MS = 12 * 60 * 60 * 1_000;
const MAX_MONITOR_OUTPUT = 250_000;

export type GnomeCalendarEvent = {
  id: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  recurring: boolean;
};

type CalendarQuery = (
  since: Date,
  until: Date
) => Promise<GnomeCalendarEvent[]>;

const decodeGVariantString = (value: string): string =>
  value.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });

const sanitizeTitle = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

export const parseGnomeCalendarEvents = (
  output: string
): GnomeCalendarEvent[] => {
  const events: GnomeCalendarEvent[] = [];
  const seen = new Set<string>();
  const eventPattern =
    /\(\s*'((?:\\.|[^'])*)'\s*,\s*'((?:\\.|[^'])*)'\s*,\s*(?:int64\s+)?(-?\d+)\s*,\s*(?:int64\s+)?(-?\d+)\s*,/g;
  for (const match of output.matchAll(eventPattern)) {
    if (events.length >= 1_000) break;
    const id = decodeGVariantString(match[1]);
    const title = sanitizeTitle(decodeGVariantString(match[2]));
    const startAtMs = Number(match[3]) * 1_000;
    const endAtMs = Number(match[4]) * 1_000;
    const key = `${id}\0${startAtMs}\0${endAtMs}`;
    if (
      !title ||
      !Number.isSafeInteger(startAtMs) ||
      !Number.isSafeInteger(endAtMs) ||
      endAtMs <= startAtMs ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    events.push({
      id,
      title,
      startAtMs,
      endAtMs,
      recurring: id.includes("\n")
    });
  }
  return events;
};

const waitForMonitorReady = (
  child: ChildProcess,
  getOutput: () => string
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void =>
      finish(new Error("GNOME Calendar monitor exited before becoming ready"));
    const check = (): void => {
      if (getOutput().includes("Monitoring signals")) finish();
      else if (!settled) setTimeout(check, 20);
    };
    const timer = setTimeout(
      () => finish(new Error("GNOME Calendar monitor did not become ready")),
      1_000
    );
    child.once("error", onError);
    child.once("exit", onExit);
    check();
  });

const stopMonitor = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 500);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
};

export const queryGnomeCalendarEvents: CalendarQuery = async (
  since,
  until
) => {
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  if (
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(untilMs) ||
    untilMs <= sinceMs ||
    untilMs - sinceMs > MAX_QUERY_WINDOW_MS
  ) {
    throw new Error("GNOME Calendar query range is invalid");
  }

  const monitor = spawn(
    "gdbus",
    [
      "monitor",
      "--session",
      "--dest",
      CALENDAR_SERVICE,
      "--object-path",
      CALENDAR_PATH
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  monitor.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-MAX_MONITOR_OUTPUT);
  });
  monitor.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
  });

  try {
    await waitForMonitorReady(monitor, () => stdout);
    await runCommand(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        CALENDAR_SERVICE,
        "--object-path",
        CALENDAR_PATH,
        "--timeout",
        "3",
        "--method",
        `${CALENDAR_INTERFACE}.SetTimeRange`,
        String(Math.floor(sinceMs / 1_000)),
        String(Math.ceil(untilMs / 1_000)),
        "true"
      ],
      { timeoutMs: 4_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    return parseGnomeCalendarEvents(stdout);
  } catch (error) {
    const detail = stderr.trim().replace(/[\r\n\0]+/g, " ").slice(0, 500);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `GNOME Calendar is unavailable: ${message}${detail ? `: ${detail}` : ""}`
    );
  } finally {
    await stopMonitor(monitor);
  }
};

const clamp = (value: number): number =>
  Math.max(0, Math.min(1, value));

const scoreEvent = (
  event: GnomeCalendarEvent,
  callStartMs: number,
  callEndMs: number
): number => {
  const overlap = Math.max(
    0,
    Math.min(event.endAtMs, callEndMs) -
      Math.max(event.startAtMs, callStartMs)
  );
  if (overlap < 60_000) return 0;
  const callDuration = Math.max(60_000, callEndMs - callStartMs);
  const eventDuration = Math.max(60_000, event.endAtMs - event.startAtMs);
  const callOverlap = overlap / callDuration;
  const eventOverlap = overlap / eventDuration;
  const startDeltaMinutes =
    Math.abs(event.startAtMs - callStartMs) / 60_000;
  const startProximity = clamp(1 - startDeltaMinutes / 15);
  return clamp(
    eventOverlap * 0.55 +
      callOverlap * 0.2 +
      startProximity * 0.25
  );
};

export const findGnomeCalendarMeeting = async (
  startAt: string,
  endAt: string,
  app?: "slack" | "zen" | "helium",
  query: CalendarQuery = queryGnomeCalendarEvents
): Promise<MeetingContext | undefined> => {
  const callStartMs = Date.parse(startAt);
  const callEndMs = Date.parse(endAt);
  if (
    !Number.isFinite(callStartMs) ||
    !Number.isFinite(callEndMs) ||
    callEndMs <= callStartMs ||
    callEndMs - callStartMs > MAX_QUERY_WINDOW_MS
  ) {
    throw new Error("Call time range is invalid");
  }
  const events = await query(
    new Date(callStartMs - 10 * 60_000),
    new Date(callEndMs + 15 * 60_000)
  );
  const ranked = events
    .map((event) => ({
      event,
      confidence: scoreEvent(event, callStartMs, callEndMs)
    }))
    .sort((left, right) => right.confidence - left.confidence);
  const best = ranked[0];
  if (!best || best.confidence < 0.65) return undefined;
  return {
    source: "gnome-calendar",
    title: best.event.title,
    startAt: new Date(best.event.startAtMs).toISOString(),
    endAt: new Date(best.event.endAtMs).toISOString(),
    recurring: best.event.recurring,
    confidence: Number(best.confidence.toFixed(3)),
    app
  };
};
