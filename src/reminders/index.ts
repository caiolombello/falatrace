// Entry points for the CLI: `reminders run` (the service loop) and `notify reminder --event <hash>`
// (the detached helper that shows one reminder and applies the button pressed).
import type { BriefEvent, PreMeetingBrief } from "../brief/build";
import { listUpcomingEvents, type UpcomingEvent } from "../calendar/upcoming";
import { readAutomationState } from "../calls/control";
import type { AppConfig } from "../config/defaults";
import type { LibraryIndexReader } from "../library-index/types";
import { type NotificationLanguage, notificationLanguage, type NotifyWithActionsOptions, notifyWithActions, spawnDetachedNotify } from "../notify/actions";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { type MeetingOverride, OVERRIDE_KNOWN_ERRORS, setMeetingOverride } from "./overrides";
import {
  effectiveRecordingMode, findSentReminder, REMINDER_KNOWN_ERRORS, type ReminderActionId, type ReminderErrorStage, type ReminderLoopDeps,
  runReminderLoop
} from "./scheduler";
import { REMINDERS_UNIT_KNOWN_ERRORS, remindersServiceProblem } from "./unit";

export * from "./overrides";
export * from "./scheduler";
export * from "./unit";

export const REMINDERS_SERVICE_ERRORS = {
  alreadyRunning: "Os lembretes já estão em execução.",
  invalidEvent: "Lembrete inválido.",
  captureFailed: "Não foi possível começar a gravar esta reunião; abra o FalaTrace Studio para gravar."
} as const;

/** Every fixed message the reminders module can throw (overrides, ledger, unit and service). */
export const REMINDERS_KNOWN_ERRORS: readonly string[] = [...new Set([
  ...OVERRIDE_KNOWN_ERRORS, ...REMINDER_KNOWN_ERRORS, ...REMINDERS_UNIT_KNOWN_ERRORS, ...Object.values(REMINDERS_SERVICE_ERRORS)
])];

const SERVICE_LOCK = "reminders";
const HASH = /^[0-9a-f]{64}$/;

/** The library index as the brief needs it: read, and refreshed now and then. */
export type ReminderBriefIndex = LibraryIndexReader & { refresh?: (options: { signal?: AbortSignal }) => Promise<unknown> };

export type ReminderBriefDeps = {
  /** Defaults to the app's library index (created on first use). */
  index?: ReminderBriefIndex;
  build?: (reader: LibraryIndexReader, event: BriefEvent) => Promise<PreMeetingBrief | null>;
  lines?: (brief: PreMeetingBrief, language: string) => string[];
  language?: NotificationLanguage;
  now?: () => number;
  /** The index is refreshed before a brief at most this often. */
  refreshEveryMs?: number;
  /** A refresh is given up after this long; the brief then uses what the index already has. */
  refreshTimeoutMs?: number;
  onError?: (error: unknown) => void;
};

export const REMINDER_BRIEF_TIMING = { refreshEveryMs: 30 * 60_000, refreshTimeoutMs: 12_000 } as const;

/**
 * The reminder's brief lines (at most three): earlier meetings with the same series, people,
 * client or title, from the local library index. The index is refreshed lazily and for a bounded
 * time; nothing is written outside the state directory, so the sandboxed service can run it.
 */
export const createReminderBrief = (config: AppConfig, deps: ReminderBriefDeps = {}): ((event: UpcomingEvent) => Promise<string[] | null>) => {
  const now = deps.now ?? Date.now;
  const language = deps.language ?? notificationLanguage(config);
  let index = deps.index;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | undefined;
  const reader = async (): Promise<ReminderBriefIndex> => {
    index ??= (await import("../app/context")).createLibraryIndex(config);
    return index;
  };
  const timeoutMs = deps.refreshTimeoutMs ?? REMINDER_BRIEF_TIMING.refreshTimeoutMs;
  const refresh = (current: ReminderBriefIndex): Promise<void> | undefined => {
    if (!current.refresh || now() - refreshedAt < (deps.refreshEveryMs ?? REMINDER_BRIEF_TIMING.refreshEveryMs)) return refreshing;
    refreshedAt = now();
    refreshing = Promise.resolve()
      .then(() => current.refresh?.({ signal: AbortSignal.timeout(timeoutMs) }))
      .then(() => undefined, (error: unknown) => { deps.onError?.(error); })
      .finally(() => { refreshing = undefined; });
    return refreshing;
  };
  /** Waits for a refresh at most `timeoutMs`, even one that ignores its signal. */
  const bounded = async (work: Promise<void> | undefined): Promise<void> => {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  return async (event) => {
    const current = await reader();
    await bounded(refresh(current));
    const build = deps.build ?? (await import("../brief/index")).buildBriefForEvent;
    const brief = await build(current, {
      title: event.title, startAt: event.startAt, endAt: event.endAt, recurring: event.recurring,
      attendees: event.attendees.map((attendee) => ({ name: attendee.name, self: attendee.self })),
      ...(event.seriesIdHash ? { seriesIdHash: event.seriesIdHash } : {}), eventIdHash: event.eventIdHash
    });
    if (!brief) return null;
    const lines = deps.lines ?? (await import("../brief/build")).briefLines;
    return lines(brief, language);
  };
};

export type RemindersRunDeps = Partial<ReminderLoopDeps> & {
  lock?: (name: string) => Promise<SingletonLease>;
};

/**
 * `reminders run`: one loop per user (abstract-socket lock), until `signal` aborts. Returns
 * `{ ran: false, reason }` without waiting when reminders are off or no calendar is connected
 * (the service then exits quietly). Events come from the connected calendars, briefs from the
 * library index, and each reminder is shown by a detached helper unit, so the loop never waits.
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
        brief: deps.brief ?? (config.reminders.brief ? createReminderBrief(config, { language: deps.language, onError: (error) => report("brief", error) }) : undefined),
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
  /** The configuration in effect when the button is pressed; loaded from disk when not given. */
  config?: AppConfig;
  loadConfig?: () => Promise<AppConfig>;
  notify?: (options: NotifyWithActionsOptions) => Promise<string | null>;
  /** Opens a falatrace:// link in the Studio; defaults to openInStudio. */
  open?: (uri: string) => Promise<unknown>;
  /** Starts a manual capture named after the meeting; defaults to the Studio's capture start. */
  startCapture?: (config: AppConfig, title: string) => Promise<unknown>;
  signal?: AbortSignal;
};

export type ReminderNotificationResult = {
  shown: boolean;
  choice: ReminderActionId | null;
  override?: MeetingOverride;
  opened?: string;
  /** "record" without a call monitor: a manual capture was started (or could not be). */
  capture?: "started" | "failed";
  error?: string;
};

const REMINDER_WAIT = { minMs: 60_000, maxMs: 30 * 60_000, afterStartMs: 10 * 60_000 } as const;

const CAPTURE_FAILED_TITLE: Record<NotificationLanguage, string> = { "pt-BR": "Gravação não iniciada", en: "Recording not started" };
const CAPTURE_FAILED_BODY: Record<NotificationLanguage, string> = {
  "pt-BR": REMINDERS_SERVICE_ERRORS.captureFailed,
  en: "Could not start recording this meeting; open FalaTrace Studio to record."
};

const defaultLoadConfig = async (): Promise<AppConfig> => (await (await import("../config/load")).loadConfig()).config;

const defaultStartCapture = async (config: AppConfig, title: string): Promise<unknown> =>
  (await import("../recording/application")).startCapture(config, { title });

/**
 * `notify reminder --event <hash>`: show the reminder the service recorded for this event and apply
 * the button. "skip" saves a decision for this meeting. "record" saves a decision when the call
 * monitor runs (it records the meeting's call); without call detection nothing would act on a
 * decision, so a manual capture named after the meeting starts right away and the Studio opens on
 * it. "brief" opens the event in the Studio. Nothing is shown for an unknown event or a meeting
 * that already ended.
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
  if (choice === "brief") {
    const uri = `falatrace://event/${eventIdHash}`;
    await open(uri);
    return { shown: true, choice, opened: uri };
  }
  if (choice === "record") {
    // The configuration now decides; the one the reminder was built with is the fallback.
    const config = deps.config ?? await (deps.loadConfig ?? defaultLoadConfig)().catch(() => undefined);
    const monitored = config ? effectiveRecordingMode(config) !== "off" : entry.recordingMode !== "off";
    if (!monitored) {
      if (!config) {
        await open("falatrace://capture");
        return { shown: true, choice, opened: "falatrace://capture" };
      }
      try {
        await (deps.startCapture ?? defaultStartCapture)(config, entry.title);
      } catch (error) {
        const language = notificationLanguage(config);
        await notify({ title: CAPTURE_FAILED_TITLE[language], body: CAPTURE_FAILED_BODY[language], actions: [], timeoutMs: 15_000, signal: deps.signal })
          .catch(() => null);
        return { shown: true, choice, capture: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      // The Studio shows the running capture (notes, stop); failing to open it does not undo the recording.
      const opened = await open("falatrace://capture").then(() => "falatrace://capture", () => undefined);
      return { shown: true, choice, capture: "started", ...(opened ? { opened } : {}) };
    }
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
