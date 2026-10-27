// The next meetings from the calendars the person connected (Google, the GNOME Shell calendar
// and/or KOrganizer), for reminders and pre-meeting briefs. Event ids never leave this module in clear:
// they are keyed with a per-installation salt, so stored files and links carry only hashes.
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { googleCalendarEnabled, listGoogleEvents, type GoogleCalendarEvent } from "../google/calendar";
import {
  createPrivateFile, ensurePrivateDirectory, PrivateFileError, readPrivateFile, recordingStateDir, singleLine
} from "../runtime/private-file";
import { queryGnomeCalendarEvents, type GnomeCalendarEvent } from "./gnome";
import { type KdeCalendarEvent, queryKdeCalendarEvents } from "./kde";

export type UpcomingEventSource = "google-calendar" | "gnome-calendar" | "kde-calendar";

export type UpcomingAttendee = { name: string; self: boolean };

export type UpcomingEvent = {
  source: UpcomingEventSource;
  /** HMAC-SHA256 of the calendar's event id with the installation salt (64 hex). */
  eventIdHash: string;
  /** Same, for the recurring series the event belongs to, when the calendar says. */
  seriesIdHash?: string;
  title: string;
  startAt: string;
  endAt: string;
  recurring: boolean;
  /** Names only (never e-mails); empty for the GNOME calendar. */
  attendees: UpcomingAttendee[];
};

export type UpcomingEventsDeps = {
  /** Google events in a window; defaults to the connected account through `listGoogleEvents`. */
  google?: (from: Date, to: Date, signal?: AbortSignal) => Promise<GoogleCalendarEvent[]>;
  /** GNOME Shell calendar events in a window; defaults to `queryGnomeCalendarEvents`. */
  gnome?: (from: Date, to: Date) => Promise<GnomeCalendarEvent[]>;
  /** KOrganizer (Akonadi) events in a window; defaults to `queryKdeCalendarEvents`. */
  kde?: (from: Date, to: Date) => Promise<KdeCalendarEvent[]>;
  /** The installation salt (64 hex); defaults to the salt file in the state directory. */
  salt?: () => Promise<string>;
  stateDir?: string;
  signal?: AbortSignal;
  /** Told when one calendar fails while another answered. */
  onSourceError?: (source: UpcomingEventSource, error: unknown) => void;
};

export const UPCOMING_LIMITS = {
  maxWindowMs: 12 * 60 * 60 * 1000,
  maxEvents: 200,
  maxAttendees: 50,
  titleLength: 160,
  nameLength: 120,
  maxIdLength: 4096
} as const;

export const UPCOMING_ERRORS = {
  invalidRange: "Intervalo de agenda inválido.",
  invalidId: "Identificador de evento da agenda inválido.",
  unavailable: "Não foi possível ler a agenda agora; tente de novo em alguns minutos.",
  invalidSalt: "O arquivo calendar-salt do FalaTrace é inválido; apague-o para criar outro.",
  unsafeSalt: "O arquivo calendar-salt do FalaTrace não é um arquivo comum; remova-o para criar outro."
} as const;

export const UPCOMING_KNOWN_ERRORS: readonly string[] = Object.values(UPCOMING_ERRORS);

const SALT_PATTERN = /^([0-9a-f]{64})\n?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DUPLICATE_START_MS = 60_000;

export const calendarSaltPath = (stateDir = recordingStateDir()): string => join(stateDir, "calendar-salt");

const saltCache = new Map<string, string>();

/** Forget salts read by this process (tests, or after the file was replaced on purpose). */
export const clearCalendarSaltCache = (): void => saltCache.clear();

const readSaltFile = async (path: string): Promise<string | undefined> => {
  try {
    return await readPrivateFile(path, 1024);
  } catch (error) {
    if (error instanceof PrivateFileError) throw new Error(error.problem === "unsafe" ? UPCOMING_ERRORS.unsafeSalt : UPCOMING_ERRORS.invalidSalt);
    throw error;
  }
};

/**
 * The installation salt: 32 random bytes as hex in `$XDG_STATE_HOME/recording-cli/calendar-salt` (0600).
 * Created on first use; when two processes race, the first file written wins and both read it.
 */
export const readCalendarSalt = async (options: { stateDir?: string } = {}): Promise<string> => {
  const stateDir = options.stateDir ?? recordingStateDir();
  const path = calendarSaltPath(stateDir);
  const cached = saltCache.get(path);
  if (cached) return cached;
  let text = await readSaltFile(path);
  if (text === undefined) {
    try {
      await ensurePrivateDirectory(stateDir);
      await createPrivateFile(path, `${randomBytes(32).toString("hex")}\n`, 1024);
    } catch (error) {
      if (error instanceof PrivateFileError) throw new Error(UPCOMING_ERRORS.unsafeSalt);
      throw error;
    }
    text = await readSaltFile(path);
  }
  const match = SALT_PATTERN.exec(text ?? "");
  if (!match) throw new Error(UPCOMING_ERRORS.invalidSalt);
  saltCache.set(path, match[1]);
  return match[1];
};

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= UPCOMING_LIMITS.maxIdLength;

/** HMAC-SHA256 of a calendar id with a known salt (64 hex). */
export const hashCalendarIdWithSalt = (id: string, salt: string): string => {
  if (!validId(id)) throw new Error(UPCOMING_ERRORS.invalidId);
  if (!HASH_PATTERN.test(salt)) throw new Error(UPCOMING_ERRORS.invalidSalt);
  return createHmac("sha256", Buffer.from(salt, "hex")).update(id, "utf8").digest("hex");
};

/** The stored form of a calendar event or series id: keyed with this installation's salt. */
export const hashCalendarId = async (id: string, options: { stateDir?: string } = {}): Promise<string> => {
  if (!validId(id)) throw new Error(UPCOMING_ERRORS.invalidId);
  return hashCalendarIdWithSalt(id, await readCalendarSalt(options));
};

/** Calendars that can list upcoming events with this configuration. */
export const upcomingEventSources = (config: AppConfig): UpcomingEventSource[] => [
  ...(googleCalendarEnabled(config) ? ["google-calendar" as const] : []),
  ...(config.calendar.enabled ? ["gnome-calendar" as const] : []),
  ...(config.calendar.kde ? ["kde-calendar" as const] : [])
];

/**
 * GNOME Shell event ids are "<source>\n<uid>\n<recurrence id>" (older shells: "<uid>\n<rid>").
 * The series is everything before a non-empty recurrence id.
 */
export const gnomeSeriesId = (id: string): string | undefined => {
  const cut = id.lastIndexOf("\n");
  if (cut <= 0 || cut === id.length - 1) return undefined;
  const series = id.slice(0, cut).replace(/\n+$/, "");
  return series || undefined;
};

const isLocalMidnight = (ms: number): boolean => {
  const date = new Date(ms);
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
};

/**
 * The GNOME Shell calendar has no all-day flag: holidays and birthdays arrive as local midnight to
 * midnight, and the shell itself treats an event covering whole days as all-day. They are not
 * meetings (Google's all-day events are left out too), so they get no reminder at 23:58.
 */
export const gnomeAllDay = (startAtMs: number, endAtMs: number): boolean =>
  Number.isFinite(startAtMs) && Number.isFinite(endAtMs) && endAtMs - startAtMs >= 23 * 60 * 60_000 &&
  isLocalMidnight(startAtMs) && isLocalMidnight(endAtMs);

/** Accent-free lowercase title, for spotting the same meeting in two calendars. */
const titleKey = (title: string): string =>
  title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

type RawEvent = {
  source: UpcomingEventSource; id: string; seriesId?: string; title: string; startAtMs: number; endAtMs: number;
  recurring: boolean; attendees: UpcomingAttendee[];
  /** Declined by the connected account: never listed, but still hides its copy in the other calendar. */
  declined?: boolean;
};

const cleanAttendees = (attendees: unknown): UpcomingAttendee[] => {
  if (!Array.isArray(attendees)) return [];
  const seen = new Set<string>();
  const result: UpcomingAttendee[] = [];
  for (const entry of attendees.slice(0, 500)) {
    if (result.length >= UPCOMING_LIMITS.maxAttendees) break;
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry as { name?: unknown }).name;
    const name = typeof raw === "string" ? singleLine(raw, UPCOMING_LIMITS.nameLength) : "";
    const key = name.toLocaleLowerCase("pt-BR");
    if (!name || name.includes("@") || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, self: (entry as { self?: unknown }).self === true });
  }
  return result;
};

const fromGoogle = (event: GoogleCalendarEvent): RawEvent => ({
  source: "google-calendar",
  id: validId(event.id) ? event.id : `untitled:${event.startAtMs}:${event.title}`,
  ...(validId(event.seriesId) ? { seriesId: event.seriesId } : {}),
  title: event.title, startAtMs: event.startAtMs, endAtMs: event.endAtMs, recurring: event.recurring === true,
  attendees: cleanAttendees(event.attendees),
  ...(event.selfDeclined === true ? { declined: true } : {})
});

/**
 * Every id from current GNOME Shells has a newline ("<source>\n<uid>\n<rid>"), so the shell's
 * `recurring` guess is always true; an occurrence of a series is one with a recurrence id.
 */
const fromGnome = (event: GnomeCalendarEvent): RawEvent[] => {
  if (gnomeAllDay(event.startAtMs, event.endAtMs)) return [];
  const id = validId(event.id) ? event.id : `untitled:${event.startAtMs}:${event.title}`;
  const series = gnomeSeriesId(id);
  const seriesId = series && validId(series) ? series : undefined;
  return [{
    source: "gnome-calendar", id, ...(seriesId ? { seriesId } : {}),
    title: event.title, startAtMs: event.startAtMs, endAtMs: event.endAtMs, recurring: seriesId !== undefined, attendees: []
  }];
};

/** KOrganizer gives ids, series and invited names; all-day and cancelled events are already left out. */
const fromKde = (event: KdeCalendarEvent): RawEvent => ({
  source: "kde-calendar",
  id: validId(event.id) ? event.id : `untitled:${event.startAtMs}:${event.title}`,
  ...(validId(event.seriesId) ? { seriesId: event.seriesId } : {}),
  title: event.title, startAtMs: event.startAtMs, endAtMs: event.endAtMs, recurring: event.recurring === true,
  attendees: cleanAttendees(event.attendees),
  ...(event.selfDeclined === true ? { declined: true } : {})
});

const validTimes = (start: number, end: number): boolean =>
  Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start && Number.isFinite(new Date(start).getTime()) && Number.isFinite(new Date(end).getTime());

/**
 * Events overlapping [from, to) (at most 12 hours) from every calendar turned on: Google when
 * connected, the GNOME Shell calendar when `calendar.enabled`, KOrganizer when `calendar.kde`.
 * One calendar failing is reported through `onSourceError`; all of them failing throws. The same
 * meeting seen in Google and a desktop calendar (same title, start within a minute) is kept once,
 * from Google. Meetings the account declined and all-day entries are not meetings to remind of.
 */
export const listUpcomingEvents = async (
  config: AppConfig,
  options: { from: Date; to: Date; deps?: UpcomingEventsDeps }
): Promise<UpcomingEvent[]> => {
  const { from, to } = options;
  const deps = options.deps ?? {};
  const fromMs = from instanceof Date ? from.getTime() : Number.NaN;
  const toMs = to instanceof Date ? to.getTime() : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > UPCOMING_LIMITS.maxWindowMs) {
    throw new Error(UPCOMING_ERRORS.invalidRange);
  }
  const sources = upcomingEventSources(config);
  if (sources.length === 0) return [];
  const google = deps.google ?? ((start: Date, end: Date, signal?: AbortSignal) => listGoogleEvents(config, start, end, { signal }));
  const gnome = deps.gnome ?? queryGnomeCalendarEvents;
  const kde = deps.kde ?? ((start: Date, end: Date) => queryKdeCalendarEvents(start, end));
  const settled = await Promise.allSettled(sources.map(async (source): Promise<RawEvent[]> =>
    source === "google-calendar"
      ? (await google(new Date(fromMs), new Date(toMs), deps.signal)).map(fromGoogle)
      : source === "kde-calendar"
        ? (await kde(new Date(fromMs), new Date(toMs))).map(fromKde)
        : (await gnome(new Date(fromMs), new Date(toMs))).flatMap(fromGnome)));
  const raw: RawEvent[] = [];
  let failures = 0;
  let firstError: unknown;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (Array.isArray(result.value)) raw.push(...result.value.slice(0, 1000));
      return;
    }
    failures++;
    firstError ??= result.reason;
    deps.onSourceError?.(sources[index], result.reason);
  });
  if (failures === sources.length) {
    const error = new Error(UPCOMING_ERRORS.unavailable);
    (error as { cause?: unknown }).cause = firstError;
    throw error;
  }

  const candidates = raw.flatMap((event) => {
    const title = typeof event.title === "string" ? singleLine(event.title, UPCOMING_LIMITS.titleLength) : "";
    if (!title || !validTimes(event.startAtMs, event.endAtMs) || event.endAtMs <= fromMs || event.startAtMs >= toMs) return [];
    return [{ ...event, title }];
  });
  const googleKeys = candidates.filter((event) => event.source === "google-calendar").map((event) => ({ key: titleKey(event.title), start: event.startAtMs }));
  // A meeting declined in Google is dropped together with its copy in a desktop calendar (which may show it regardless).
  const unique = candidates.filter((event) => event.declined !== true && (event.source === "google-calendar" ||
    !googleKeys.some((other) => other.key === titleKey(event.title) && Math.abs(other.start - event.startAtMs) <= DUPLICATE_START_MS)));
  unique.sort((a, b) => a.startAtMs - b.startAtMs || a.endAtMs - b.endAtMs || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  const salt = deps.salt ? await deps.salt() : await readCalendarSalt({ stateDir: deps.stateDir });
  if (!HASH_PATTERN.test(salt)) throw new Error(UPCOMING_ERRORS.invalidSalt);
  const seen = new Set<string>();
  const events: UpcomingEvent[] = [];
  for (const event of unique) {
    if (events.length >= UPCOMING_LIMITS.maxEvents) break;
    const eventIdHash = hashCalendarIdWithSalt(event.id, salt);
    const key = `${eventIdHash}@${event.startAtMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      source: event.source,
      eventIdHash,
      ...(event.seriesId ? { seriesIdHash: hashCalendarIdWithSalt(event.seriesId, salt) } : {}),
      title: event.title,
      startAt: new Date(event.startAtMs).toISOString(),
      endAt: new Date(event.endAtMs).toISOString(),
      recurring: event.recurring,
      attendees: event.attendees
    });
  }
  return events;
};

/** Strict check of an UpcomingEvent read back from a file or received from another process. */
export const validateUpcomingEvent = (value: unknown): UpcomingEvent | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const startMs = typeof event.startAt === "string" ? Date.parse(event.startAt) : Number.NaN;
  const endMs = typeof event.endAt === "string" ? Date.parse(event.endAt) : Number.NaN;
  const title = typeof event.title === "string" ? singleLine(event.title, UPCOMING_LIMITS.titleLength) : "";
  if ((event.source !== "google-calendar" && event.source !== "gnome-calendar" && event.source !== "kde-calendar") || typeof event.eventIdHash !== "string" ||
    !HASH_PATTERN.test(event.eventIdHash) || (event.seriesIdHash !== undefined && (typeof event.seriesIdHash !== "string" || !HASH_PATTERN.test(event.seriesIdHash))) ||
    !title || title !== event.title || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
    typeof event.recurring !== "boolean" || !Array.isArray(event.attendees) || event.attendees.length > UPCOMING_LIMITS.maxAttendees) return undefined;
  const attendees = cleanAttendees(event.attendees);
  if (attendees.length !== event.attendees.length) return undefined;
  return {
    source: event.source, eventIdHash: event.eventIdHash,
    ...(typeof event.seriesIdHash === "string" ? { seriesIdHash: event.seriesIdHash } : {}),
    title, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(), recurring: event.recurring, attendees
  };
};
