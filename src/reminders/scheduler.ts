// Calendar reminders: a little before each meeting, a notification with what will happen to the
// recording and buttons to change it for that one meeting. The loop polls the calendars every few
// minutes, sleeps until the next reminder is due, re-reads the calendar right before firing (so a
// cancelled or moved meeting is not announced) and records each reminder in a small ledger, so a
// restart never repeats one.
import { join } from "node:path";
import { listUpcomingEvents, type UpcomingEvent, type UpcomingEventSource, validateUpcomingEvent } from "../calendar/upcoming";
import type { AppConfig } from "../config/defaults";
import { type NotificationAction, type NotificationLanguage, notificationLanguage } from "../notify/actions";
import {
  ensurePrivateDirectory, isIsoTime, isRecord, type LockOptions, parseJson, PrivateFileError, readPrivateFile, recordingStateDir,
  singleLine, withPrivateLock, writePrivateFile
} from "../runtime/private-file";

export const REMINDER_ERRORS = {
  invalidLead: "Antecedência do lembrete inválida.",
  invalidLedger: "O arquivo reminders-sent.json do FalaTrace é inválido; apague-o para continuar.",
  unsafeLedger: "O arquivo reminders-sent.json do FalaTrace não é um arquivo comum; remova-o para continuar.",
  busy: "Outro processo está registrando lembretes; tente de novo."
} as const;

export const REMINDER_KNOWN_ERRORS: readonly string[] = Object.values(REMINDER_ERRORS);

/** Whether reminders run with this configuration. */
export type EffectiveReminderMode = "on" | "off";
/** What happens to a meeting's recording without any decision: nothing, a notification, or a recording. */
export type RecordingMode = "off" | "notify-only" | "record" | "obs";
/** The recording mode as a reminder presents it; "paused" is record/obs with automation paused. */
export type ReminderRecordingMode = RecordingMode | "paused";

/**
 * The automatic recording mode in effect. Call detection off, or in dry run (which only logs),
 * records nothing on its own.
 */
export const effectiveRecordingMode = (config: Pick<AppConfig, "callDetection">): RecordingMode => {
  const detection = config.callDetection;
  if (!detection.enabled || detection.dryRun) return "off";
  return detection.mode === "record" || detection.mode === "obs" ? detection.mode : "notify-only";
};

/** "auto" reminds when meetings are not recorded automatically (no call detection, or notify-only). */
export const effectiveReminderMode = (config: Pick<AppConfig, "callDetection" | "reminders">): EffectiveReminderMode => {
  const mode = config.reminders.mode;
  if (mode === "on" || mode === "off") return mode;
  const recording = effectiveRecordingMode(config);
  return recording === "off" || recording === "notify-only" ? "on" : "off";
};

export const reminderRecordingMode = (config: Pick<AppConfig, "callDetection">, automationPaused: boolean): ReminderRecordingMode => {
  const mode = effectiveRecordingMode(config);
  return automationPaused && (mode === "record" || mode === "obs") ? "paused" : mode;
};

export const REMINDER_ACTION_IDS = ["record", "later", "brief", "skip", "ok"] as const;
export type ReminderActionId = (typeof REMINDER_ACTION_IDS)[number];

const TEXT = {
  "pt-BR": {
    soon: (minutes: number, title: string) => `Em ${minutes} min: ${title}`,
    now: (title: string) => `Começando agora: ${title}`,
    started: (title: string) => `Já começou: ${title}`,
    mode: {
      off: "A gravação automática está desligada.",
      "notify-only": "Esta reunião não será gravada automaticamente.",
      record: "Esta reunião será gravada automaticamente.",
      obs: "Esta reunião será gravada automaticamente pelo OBS.",
      paused: "A gravação automática está pausada."
    },
    actions: { record: "Gravar", later: "Agora não", brief: "Ver resumo anterior", skip: "Pular esta gravação", ok: "OK" }
  },
  en: {
    soon: (minutes: number, title: string) => `In ${minutes} min: ${title}`,
    now: (title: string) => `Starting now: ${title}`,
    started: (title: string) => `Already started: ${title}`,
    mode: {
      off: "Automatic recording is off.",
      "notify-only": "This meeting will not be recorded automatically.",
      record: "This meeting will be recorded automatically.",
      obs: "This meeting will be recorded automatically by OBS.",
      paused: "Automatic recording is paused."
    },
    actions: { record: "Record", later: "Not now", brief: "See previous summary", skip: "Skip this recording", ok: "OK" }
  }
} as const;

/**
 * Buttons for a reminder. Without automatic recording: record it, or not now. With automatic
 * recording: skip this one, or OK. "See previous summary" is added when a brief exists.
 */
export const reminderActions = (mode: ReminderRecordingMode, options: { brief?: boolean; language?: NotificationLanguage } = {}): NotificationAction[] => {
  const labels = (TEXT[options.language ?? "pt-BR"] ?? TEXT["pt-BR"]).actions;
  const ids: ReminderActionId[] = mode === "record" || mode === "obs" ? ["skip", "ok"] : ["record", "later"];
  if (options.brief) ids.push("brief");
  return ids.map((id) => ({ id, label: labels[id] }));
};

export const REMINDER_TIMING = {
  pollMs: 5 * 60_000,
  /** Events are listed from now to three hours ahead. */
  horizonMs: 3 * 60 * 60_000,
  /** A reminder still fires up to this long after the start (e.g. the computer was asleep or just started). */
  lateMs: 5 * 60_000,
  /** A meeting moved by less than this keeps its reminder; moved further, it gets a new one. */
  moveToleranceMs: 10 * 60_000,
  /** Last known events are used for this long while the calendar cannot be read. */
  staleEventsMs: 15 * 60_000,
  minSleepMs: 1_000,
  /** Timers may fire a little early; a reminder this close to its time is due. */
  earlyToleranceMs: 1_000,
  retryBaseMs: 30_000,
  briefTimeoutMs: 20_000
} as const;

export type ReminderKey = { eventIdHash: string; startAt: string };

export type DueReminder = {
  event: UpcomingEvent;
  /** startAt − lead time. */
  fireAt: string;
  /** Negative when the meeting already started. */
  startsInMs: number;
};

const toMs = (value: number | Date): number => (value instanceof Date ? value.getTime() : value);

const leadMs = (leadMinutes: number): number => {
  if (!Number.isFinite(leadMinutes) || leadMinutes < 0 || leadMinutes > 60) throw new Error(REMINDER_ERRORS.invalidLead);
  return Math.round(leadMinutes * 60_000);
};

/** Already reminded: the same event with a start within the move tolerance. */
export const alreadyReminded = (event: ReminderKey, sent: readonly ReminderKey[]): boolean => {
  const start = Date.parse(event.startAt);
  return sent.some((entry) => entry.eventIdHash === event.eventIdHash && Math.abs(Date.parse(entry.startAt) - start) < REMINDER_TIMING.moveToleranceMs);
};

type Timed = { event: UpcomingEvent; start: number; end: number; fireAt: number };

const timed = (events: readonly UpcomingEvent[], lead: number): Timed[] => {
  const seen = new Set<string>();
  const result: Timed[] = [];
  for (const event of events) {
    const start = Date.parse(event?.startAt), end = Date.parse(event?.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || typeof event.eventIdHash !== "string") continue;
    const key = `${event.eventIdHash}@${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ event, start, end, fireAt: start - lead });
  }
  return result;
};

/**
 * Reminders due at `now`: lead time reached, the meeting started at most 5 minutes ago and has not
 * ended, and no reminder was sent for it yet. Soonest meeting first.
 */
export const planReminders = (
  events: readonly UpcomingEvent[], now: number | Date, leadMinutes: number, sent: readonly ReminderKey[]
): DueReminder[] => {
  const at = toMs(now);
  return timed(events, leadMs(leadMinutes))
    .filter((item) => item.fireAt <= at && at <= item.start + REMINDER_TIMING.lateMs && at < item.end && !alreadyReminded(item.event, sent))
    .sort((a, b) => a.start - b.start || (a.event.eventIdHash < b.event.eventIdHash ? -1 : 1))
    .map((item) => ({ event: item.event, fireAt: new Date(item.fireAt).toISOString(), startsInMs: item.start - at }));
};

/** When the next reminder after `now` falls due, or null when none is pending. */
export const nextReminderAt = (
  events: readonly UpcomingEvent[], now: number | Date, leadMinutes: number, sent: readonly ReminderKey[]
): number | null => {
  const at = toMs(now);
  const times = timed(events, leadMs(leadMinutes))
    .filter((item) => item.fireAt > at && item.fireAt < item.end && !alreadyReminded(item.event, sent))
    .map((item) => item.fireAt);
  return times.length ? Math.min(...times) : null;
};

export type ReminderNotification = { title: string; body: string; actions: NotificationAction[] };

const cleanBriefLines = (lines: unknown): string[] =>
  Array.isArray(lines) ? lines.flatMap((line) => (typeof line === "string" ? [singleLine(line, 160)] : [])).filter(Boolean).slice(0, 3) : [];

const timeFormat = (language: NotificationLanguage, timeZone?: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" });
  }
};

/** Title, body (time, what happens to the recording, up to three brief lines) and buttons. */
export const buildReminderNotification = (input: {
  event: UpcomingEvent;
  now: number;
  mode: ReminderRecordingMode;
  briefLines?: readonly string[];
  language?: NotificationLanguage;
  timeZone?: string;
}): ReminderNotification => {
  const language = input.language === "en" ? "en" : "pt-BR";
  const text = TEXT[language];
  const start = Date.parse(input.event.startAt), end = Date.parse(input.event.endAt);
  const startsIn = start - input.now;
  const name = singleLine(input.event.title, 120);
  const title = startsIn > 30_000 ? text.soon(Math.max(1, Math.round(startsIn / 60_000)), name)
    : startsIn >= -60_000 ? text.now(name) : text.started(name);
  const format = timeFormat(language, input.timeZone);
  const brief = cleanBriefLines(input.briefLines);
  // Intl may use narrow no-break spaces ("2:00 PM"); every line is normalised like stored text is.
  const body = [`${format.format(start)}–${format.format(end)}`, text.mode[input.mode], ...brief].map((line) => singleLine(line, 240)).filter(Boolean).join("\n");
  return { title: singleLine(title, 200), body, actions: reminderActions(input.mode, { brief: brief.length > 0, language }) };
};

// ---- Ledger of reminders already shown -----------------------------------------------------

export const REMINDERS_SENT_FILE = "reminders-sent.json";

export type SentReminder = {
  eventIdHash: string;
  startAt: string;
  endAt: string;
  title: string;
  source: UpcomingEventSource;
  seriesIdHash?: string;
  recurring: boolean;
  sentAt: string;
  recordingMode: ReminderRecordingMode;
  /** What the notification shows; the detached helper displays exactly this. */
  notification: ReminderNotification;
};

export type RemindersSentFile = { version: 1; entries: SentReminder[] };

export const REMINDER_LIMITS = {
  maxEntries: 200,
  maxBytes: 1024 * 1024,
  /** Entries for meetings that started longer ago than this are pruned. */
  keepMs: 24 * 60 * 60_000
} as const;

const HASH = /^[0-9a-f]{64}$/;
const RECORDING_MODES: readonly string[] = ["off", "notify-only", "record", "obs", "paused"];
const LEDGER_LOCK = "reminders-sent";

export const remindersSentPath = (stateDir = recordingStateDir()): string => join(stateDir, REMINDERS_SENT_FILE);

const validNotification = (value: unknown): ReminderNotification | undefined => {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.body !== "string" || !Array.isArray(value.actions) || value.actions.length > 4) return undefined;
  const title = singleLine(value.title, 200);
  const body = value.body.split("\n").map((line) => singleLine(line, 240)).join("\n");
  if (!title || title !== value.title || body !== value.body || body.length > 1_200) return undefined;
  const ids = new Set<string>();
  const actions: NotificationAction[] = [];
  for (const action of value.actions) {
    if (!isRecord(action) || typeof action.id !== "string" || !(REMINDER_ACTION_IDS as readonly string[]).includes(action.id) || ids.has(action.id) ||
      typeof action.label !== "string" || !action.label || singleLine(action.label, 48) !== action.label) return undefined;
    ids.add(action.id);
    actions.push({ id: action.id, label: action.label });
  }
  return { title, body, actions };
};

const validSent = (value: unknown): SentReminder | undefined => {
  if (!isRecord(value)) return undefined;
  const { eventIdHash, startAt, endAt, title, source, seriesIdHash, recurring, sentAt, recordingMode } = value;
  if (typeof eventIdHash !== "string" || !HASH.test(eventIdHash) || (seriesIdHash !== undefined && (typeof seriesIdHash !== "string" || !HASH.test(seriesIdHash)))) return undefined;
  if (!isIsoTime(startAt) || !isIsoTime(endAt) || !isIsoTime(sentAt) || Date.parse(endAt) <= Date.parse(startAt)) return undefined;
  if (typeof title !== "string" || !title || singleLine(title, 160) !== title) return undefined;
  if ((source !== "google-calendar" && source !== "gnome-calendar") || typeof recurring !== "boolean") return undefined;
  if (typeof recordingMode !== "string" || !RECORDING_MODES.includes(recordingMode)) return undefined;
  const notification = validNotification(value.notification);
  if (!notification) return undefined;
  return {
    eventIdHash, startAt: new Date(Date.parse(startAt)).toISOString(), endAt: new Date(Date.parse(endAt)).toISOString(), title, source,
    ...(typeof seriesIdHash === "string" ? { seriesIdHash } : {}), recurring, sentAt: new Date(Date.parse(sentAt)).toISOString(),
    recordingMode: recordingMode as ReminderRecordingMode, notification
  };
};

/** Strict check of the whole ledger; one bad entry makes it invalid. */
export const validateRemindersSentFile = (value: unknown): RemindersSentFile => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > REMINDER_LIMITS.maxEntries) {
    throw new Error(REMINDER_ERRORS.invalidLedger);
  }
  return {
    version: 1,
    entries: value.entries.map((raw) => {
      const entry = validSent(raw);
      if (!entry) throw new Error(REMINDER_ERRORS.invalidLedger);
      return entry;
    })
  };
};

const readLedgerText = async (path: string): Promise<string | undefined> => {
  try {
    return await readPrivateFile(path, REMINDER_LIMITS.maxBytes);
  } catch (error) {
    if (error instanceof PrivateFileError) throw new Error(error.problem === "unsafe" ? REMINDER_ERRORS.unsafeLedger : REMINDER_ERRORS.invalidLedger);
    throw error;
  }
};

const fresh = (entries: SentReminder[], now: number): SentReminder[] =>
  entries.filter((entry) => Date.parse(entry.startAt) >= now - REMINDER_LIMITS.keepMs);

export type LedgerOptions = { stateDir?: string; now?: number; lockOptions?: LockOptions };

/** Reminders sent for meetings of the last 24 hours and later. */
export const readSentReminders = async (options: LedgerOptions = {}): Promise<SentReminder[]> => {
  const text = await readLedgerText(remindersSentPath(options.stateDir));
  if (text === undefined) return [];
  return fresh(validateRemindersSentFile(parseJson(text)).entries, options.now ?? Date.now());
};

/** The latest reminder sent for an event, if any. */
export const findSentReminder = async (eventIdHash: string, options: LedgerOptions = {}): Promise<SentReminder | undefined> => {
  if (typeof eventIdHash !== "string" || !HASH.test(eventIdHash)) return undefined;
  const entries = (await readSentReminders(options)).filter((entry) => entry.eventIdHash === eventIdHash);
  return entries.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
};

/**
 * Add a sent reminder (replacing one for the same event and start), pruning old entries. A damaged
 * ledger is replaced: it only prevents repeats, and keeping it would stop every reminder.
 */
export const recordSentReminder = async (entry: SentReminder, options: LedgerOptions = {}): Promise<void> => {
  const valid = validSent(entry);
  if (!valid) throw new Error(REMINDER_ERRORS.invalidLedger);
  const stateDir = options.stateDir ?? recordingStateDir();
  const path = remindersSentPath(stateDir);
  await withPrivateLock(LEDGER_LOCK, REMINDER_ERRORS.busy, async () => {
    const now = options.now ?? Date.now();
    const text = await readLedgerText(path);
    let entries: SentReminder[] = [];
    if (text !== undefined) {
      try { entries = validateRemindersSentFile(parseJson(text)).entries; } catch { entries = []; }
    }
    entries = fresh(entries, now).filter((existing) => !(existing.eventIdHash === valid.eventIdHash && existing.startAt === valid.startAt));
    entries.push(valid);
    entries.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
    const kept = entries.slice(-REMINDER_LIMITS.maxEntries);
    try {
      await ensurePrivateDirectory(stateDir);
      await writePrivateFile(path, `${JSON.stringify({ version: 1, entries: kept } satisfies RemindersSentFile)}\n`, REMINDER_LIMITS.maxBytes);
    } catch (error) {
      if (error instanceof PrivateFileError) throw new Error(REMINDER_ERRORS.unsafeLedger);
      throw error;
    }
  }, options.lockOptions);
};

// ---- The loop ---------------------------------------------------------------------------------

export type Reminder = DueReminder & {
  recordingMode: ReminderRecordingMode;
  briefLines: string[];
  notification: ReminderNotification;
};

export type ReminderErrorStage = "calendar" | "ledger" | "brief" | "notify" | "automation";

export type ReminderLoopDeps = {
  /** Upcoming events in a window; defaults to listUpcomingEvents with this configuration. */
  listEvents?: (from: Date, to: Date, signal: AbortSignal) => Promise<UpcomingEvent[]>;
  /** Shows the reminder; in the service, starts the detached notification helper. */
  notify: (reminder: Reminder) => Promise<unknown>;
  /** Up to three short lines about earlier meetings with the same people or series; null when none. */
  brief?: (event: UpcomingEvent) => Promise<readonly string[] | null | undefined>;
  /** How long to wait for `brief` before sending the reminder without it. */
  briefTimeoutMs?: number;
  /** Whether automatic recording is paused (an unreadable state counts as paused, like the call monitor). */
  automationPaused?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  stateDir?: string;
  language?: NotificationLanguage;
  timeZone?: string;
  lockOptions?: LockOptions;
  onError?: (stage: ReminderErrorStage, error: unknown) => void;
  log?: (event: { type: string } & Record<string, unknown>) => void;
};

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const done = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })
  ]);
};

/**
 * Remind before each meeting until `signal` aborts. Returns at once when reminders are off for this
 * configuration. Calendar, ledger, brief and notification failures are reported through `onError`
 * and never stop the loop.
 */
export const runReminderLoop = async (options: { config: AppConfig; signal: AbortSignal; deps: ReminderLoopDeps }): Promise<void> => {
  const { config, signal, deps } = options;
  const log = deps.log ?? (() => undefined);
  const report = (stage: ReminderErrorStage, error: unknown): void => { deps.onError?.(stage, error); };
  if (effectiveReminderMode(config) === "off") {
    log({ type: "reminders.off" });
    return;
  }
  const leadMinutes = config.reminders.leadMinutes;
  leadMs(leadMinutes);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const listEvents = deps.listEvents ?? ((from: Date, to: Date, abort: AbortSignal) => listUpcomingEvents(config, { from, to, deps: { signal: abort } }));
  const language = deps.language ?? notificationLanguage(config);
  const ledgerOptions = (at: number): LedgerOptions => ({ stateDir: deps.stateDir, now: at, lockOptions: deps.lockOptions });

  let events: UpcomingEvent[] = [];
  let eventsAt = Number.NEGATIVE_INFINITY;
  let nextPollAt = Number.NEGATIVE_INFINITY;
  let failures = 0;
  let sent: ReminderKey[] = [];
  // Kept in memory too, so an unwritable ledger still never repeats a reminder in this process.
  const fired: ReminderKey[] = [];
  const known = (): ReminderKey[] => [...sent, ...fired];
  const current = (at: number): UpcomingEvent[] => (at - eventsAt <= REMINDER_TIMING.staleEventsMs ? events : []);

  const refresh = async (at: number): Promise<void> => {
    try {
      const listed = await listEvents(new Date(at), new Date(at + REMINDER_TIMING.horizonMs), signal);
      events = (Array.isArray(listed) ? listed : []).slice(0, 500).flatMap((event) => {
        const valid = validateUpcomingEvent(event);
        return valid ? [valid] : [];
      });
      eventsAt = at;
      failures = 0;
      nextPollAt = at + REMINDER_TIMING.pollMs;
    } catch (error) {
      if (signal.aborted) return;
      failures++;
      report("calendar", error);
      nextPollAt = at + Math.min(REMINDER_TIMING.pollMs, REMINDER_TIMING.retryBaseMs * 2 ** Math.min(failures - 1, 10));
    }
  };

  const fire = async (due: DueReminder, at: number): Promise<void> => {
    const { event } = due;
    fired.push({ eventIdHash: event.eventIdHash, startAt: event.startAt });
    let paused = false;
    if (deps.automationPaused) paused = await deps.automationPaused().catch((error) => { report("automation", error); return true; });
    const mode = reminderRecordingMode(config, paused);
    let briefLines: string[] = [];
    if (config.reminders.brief && deps.brief) {
      try {
        briefLines = cleanBriefLines(await withTimeout(Promise.resolve(deps.brief(event)), deps.briefTimeoutMs ?? REMINDER_TIMING.briefTimeoutMs));
      } catch (error) {
        report("brief", error);
      }
    }
    const notification = buildReminderNotification({ event, now: at, mode, briefLines, language, timeZone: deps.timeZone });
    const entry: SentReminder = {
      eventIdHash: event.eventIdHash, startAt: event.startAt, endAt: event.endAt, title: event.title, source: event.source,
      ...(event.seriesIdHash ? { seriesIdHash: event.seriesIdHash } : {}), recurring: event.recurring,
      sentAt: new Date(at).toISOString(), recordingMode: mode, notification
    };
    // Recorded before showing: a crash right after must not show it twice.
    try {
      await recordSentReminder(entry, ledgerOptions(at));
    } catch (error) {
      report("ledger", error);
    }
    try {
      await deps.notify({ ...due, recordingMode: mode, briefLines, notification });
      log({ type: "reminder.sent", eventIdHash: event.eventIdHash, startAt: event.startAt, recordingMode: mode });
    } catch (error) {
      report("notify", error);
    }
  };

  log({ type: "reminders.started", leadMinutes });
  while (!signal.aborted) {
    let at = now();
    const dueSoon = planReminders(current(at), at + REMINDER_TIMING.earlyToleranceMs, leadMinutes, known()).length > 0;
    // Each poll, and right before a reminder, the calendar is read again.
    if (at >= nextPollAt || dueSoon) await refresh(at);
    if (signal.aborted) break;
    try {
      sent = await readSentReminders(ledgerOptions(at));
    } catch (error) {
      report("ledger", error);
    }
    at = now();
    for (const due of planReminders(current(at), at + REMINDER_TIMING.earlyToleranceMs, leadMinutes, known())) {
      if (signal.aborted) break;
      await fire(due, at);
    }
    if (signal.aborted) break;
    at = now();
    const next = nextReminderAt(current(at), at, leadMinutes, known());
    const wakeAt = Math.min(nextPollAt, next ?? Number.POSITIVE_INFINITY);
    await sleep(Math.min(REMINDER_TIMING.pollMs, Math.max(REMINDER_TIMING.minSleepMs, wakeAt - at)), signal);
  }
  log({ type: "reminders.stopped" });
};
