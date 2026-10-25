// Entry points for the CLI: `reminders run` (the service loop) and `notify reminder --event <hash>`
// (the detached helper that shows one reminder and applies the button pressed).
import { listUpcomingEvents } from "../calendar/upcoming";
import { readAutomationState } from "../calls/control";
import type { AppConfig } from "../config/defaults";
import { type NotifyWithActionsOptions, notifyWithActions, spawnDetachedNotify } from "../notify/actions";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { type MeetingOverride, OVERRIDE_KNOWN_ERRORS, setMeetingOverride } from "./overrides";
import {
  findSentReminder, REMINDER_KNOWN_ERRORS, type ReminderActionId, type ReminderErrorStage, type ReminderLoopDeps, runReminderLoop
} from "./scheduler";
import { REMINDERS_UNIT_KNOWN_ERRORS, remindersServiceProblem } from "./unit";

export * from "./overrides";
export * from "./scheduler";
export * from "./unit";

export const REMINDERS_SERVICE_ERRORS = {
  alreadyRunning: "Os lembretes já estão em execução.",
  invalidEvent: "Lembrete inválido."
} as const;

/** Every fixed message the reminders module can throw (overrides, ledger, unit and service). */
export const REMINDERS_KNOWN_ERRORS: readonly string[] = [...new Set([
  ...OVERRIDE_KNOWN_ERRORS, ...REMINDER_KNOWN_ERRORS, ...REMINDERS_UNIT_KNOWN_ERRORS, ...Object.values(REMINDERS_SERVICE_ERRORS)
])];

const SERVICE_LOCK = "reminders";
const HASH = /^[0-9a-f]{64}$/;

export type RemindersRunDeps = Partial<ReminderLoopDeps> & {
  lock?: (name: string) => Promise<SingletonLease>;
};

/**
 * `reminders run`: one loop per user (abstract-socket lock), until `signal` aborts. Returns
 * `{ ran: false, reason }` without waiting when reminders are off or no calendar is connected.
 */
export const runRemindersService = async (options: { config: AppConfig; signal: AbortSignal; deps?: RemindersRunDeps }): Promise<{ ran: boolean; reason?: string }> => {
  const { config, signal } = options;
  const deps = options.deps ?? {};
  const problem = remindersServiceProblem(config);
  if (problem) return { ran: false, reason: problem };
  let lease: SingletonLease;
  try {
    lease = await (deps.lock ?? acquireSingleton)(SERVICE_LOCK);
  } catch (error) {
    if (/already running/.test(error instanceof Error ? error.message : String(error))) throw new Error(REMINDERS_SERVICE_ERRORS.alreadyRunning);
    throw error;
  }
  const report = (stage: ReminderErrorStage, error: unknown): void => deps.onError?.(stage, error);
  try {
    await runReminderLoop({
      config,
      signal,
      deps: {
        ...deps,
        listEvents: deps.listEvents ?? ((from, to, abort) => listUpcomingEvents(config, {
          from, to, deps: { signal: abort, onSourceError: (_source, error) => report("calendar", error) }
        })),
        notify: deps.notify ?? (async (reminder) => spawnDetachedNotify("reminder", { event: reminder.event.eventIdHash })),
        automationPaused: deps.automationPaused ?? (async () => (await readAutomationState()).paused)
      }
    });
    return { ran: true };
  } finally {
    await lease.release();
  }
};

export type ReminderNotificationDeps = {
  stateDir?: string;
  now?: () => number;
  notify?: (options: NotifyWithActionsOptions) => Promise<string | null>;
  /** Opens a falatrace:// link in the Studio; defaults to openInStudio. */
  open?: (uri: string) => Promise<unknown>;
  signal?: AbortSignal;
};

export type ReminderNotificationResult = {
  shown: boolean;
  choice: ReminderActionId | null;
  override?: MeetingOverride;
  opened?: string;
};

const REMINDER_WAIT = { minMs: 60_000, maxMs: 30 * 60_000, afterStartMs: 10 * 60_000 } as const;

/**
 * `notify reminder --event <hash>`: show the reminder the service recorded for this event and apply
 * the button: "record"/"skip" save a decision for this meeting ("record" opens the capture page
 * instead when nothing watches calls), "brief" opens the event in the Studio. Nothing is shown for
 * an unknown event or a meeting that already ended.
 */
export const handleReminderNotification = async (eventIdHash: string, deps: ReminderNotificationDeps = {}): Promise<ReminderNotificationResult> => {
  if (typeof eventIdHash !== "string" || !HASH.test(eventIdHash)) throw new Error(REMINDERS_SERVICE_ERRORS.invalidEvent);
  const now = deps.now ?? Date.now;
  const entry = await findSentReminder(eventIdHash, { stateDir: deps.stateDir, now: now() });
  const at = now();
  if (!entry || at >= Date.parse(entry.endAt)) return { shown: false, choice: null };
  const timeoutMs = Math.round(Math.min(REMINDER_WAIT.maxMs, Math.max(REMINDER_WAIT.minMs, Date.parse(entry.startAt) + REMINDER_WAIT.afterStartMs - at)));
  const notify = deps.notify ?? ((options: NotifyWithActionsOptions) => notifyWithActions(options));
  const raw = await notify({ ...entry.notification, timeoutMs, signal: deps.signal });
  const choice = entry.notification.actions.find((action) => action.id === raw)?.id as ReminderActionId | undefined;
  if (!choice) return { shown: true, choice: null };
  const open = deps.open ?? (async (uri: string) => (await import("../desktop/open-request")).openInStudio(uri));
  if (choice === "brief" || (choice === "record" && entry.recordingMode === "off")) {
    const uri = choice === "brief" ? `falatrace://event/${eventIdHash}` : "falatrace://capture";
    await open(uri);
    return { shown: true, choice, opened: uri };
  }
  if (choice === "record" || choice === "skip") {
    const override = await setMeetingOverride(
      { eventIdHash, title: entry.title, startAt: entry.startAt, endAt: entry.endAt, decision: choice },
      { stateDir: deps.stateDir, now: new Date(now()) }
    );
    return { shown: true, choice, override };
  }
  return { shown: true, choice };
};
