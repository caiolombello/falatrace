// KOrganizer's calendars, read from Akonadi's own database without changing it. KDE PIM keeps
// each event as an iCalendar payload in an SQLite file (the default Akonadi backend); bigger
// payloads live in files beside it. Only the calendars checked in KOrganizer are read, and the
// occurrences of recurring events are computed here (see ical.ts).
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallApplication } from "../calls/apps";
import type { MeetingContext } from "../jobs/types";
import { scoreCalendarEvent } from "./gnome";
import { expandEvent, type ICalEvent, icalTimeToMs, parseICalEvents } from "./ical";

export type KdeCalendarEvent = {
  /** "akonadi:<calendar>\n<uid>" for a single event, plus "\n<original start>" for an occurrence of a series. */
  id: string;
  seriesId?: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  recurring: boolean;
  /** Names from the invitation; `self` marks the calendar's own account. */
  attendees: Array<{ name: string; self: boolean }>;
  /** The calendar's own account declined the invitation. */
  selfDeclined?: boolean;
};

export type AkonadiSource = {
  /** Akonadi's SQLite database. */
  database: string;
  /** Where Akonadi keeps payloads too big for the database. */
  fileStore: string;
  /** Collection ids checked in KOrganizer; undefined reads every enabled calendar. */
  selection?: ReadonlySet<number>;
  /** Accounts of the calendars (Google resource accounts), to find the user among the invited. */
  ownEmails: ReadonlySet<string>;
};

export const KDE_CALENDAR_LIMITS = { maxItems: 50_000, maxPayloadBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxWindowMs: 24 * 60 * 60 * 1000 } as const;

const EVENT_MIME = "application/x-vnd.akonadi.calendar.event";
const EXTERNAL_NAME = /^(\d+)_r\d+$/;

/** Groups of a KDE config file; "Key[$e]" values have $HOME and ${VAR} expanded. */
export const parseKdeConfig = (text: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, Record<string, string>> => {
  const groups: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const group = /^\[(.+)\]$/.exec(line);
    if (group) {
      const name = group[1] as string;
      groups[name] ??= {};
      current = groups[name];
      continue;
    }
    const equals = line.indexOf("=");
    if (!current || equals <= 0) continue;
    const rawKey = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    const expand = rawKey.endsWith("[$e]");
    const key = rawKey.replace(/\[\$[a-z]+\]$/, "");
    if (expand) value = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_match, name: string) => (name === "HOME" ? env.HOME || home : env[name] ?? ""));
    current[key] = value;
  }
  return groups;
};

const readText = (path: string): Promise<string> => fs.readFile(path, "utf8").catch(() => "");

/**
 * Where KOrganizer's events are: Akonadi's settings (`akonadi/akonadiserverrc`), the calendars
 * checked in KOrganizer (`korganizerrc`) and the Google accounts of the Akonadi resources.
 */
export const locateAkonadi = async (env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<AkonadiSource> => {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || join(home, ".local/share");
  const server = parseKdeConfig(await readText(join(configHome, "akonadi", "akonadiserverrc")), env, home);
  const driver = server["%General"]?.Driver ?? "QSQLITE";
  if (driver !== "QSQLITE") throw new Error(`KOrganizer calendar: Akonadi uses ${driver.slice(0, 20)}, only its SQLite database can be read`);
  const database = server.QSQLITE?.Name || join(dataHome, "akonadi", "akonadi.db");
  const korganizer = parseKdeConfig(await readText(join(configHome, "korganizerrc")), env, home);
  const ids = (korganizer.GlobalCollectionSelection?.Selection ?? "").split(",").map((item) => /^c(\d+)$/.exec(item.trim())?.[1]).filter((id): id is string => !!id).map(Number);
  const ownEmails = new Set<string>();
  const entries = await fs.readdir(configHome).catch(() => [] as string[]);
  for (const name of entries.filter((entry) => /^akonadi_google_resource_\d+rc$/.test(entry)).slice(0, 20)) {
    const account = parseKdeConfig(await readText(join(configHome, name)), env, home).General?.Account?.trim().toLowerCase();
    if (account && /^[^\s@]{1,128}@[^\s@]{1,253}$/.test(account)) ownEmails.add(account);
  }
  return { database, fileStore: join(dataHome, "akonadi", "file_db_data"), ...(ids.length ? { selection: new Set(ids) } : {}), ownEmails };
};

type ItemRow = { collectionId: number; collectionName: string | null; collectionRemoteId: string | null; partId: number; storage: number; data: Uint8Array | string | null };

/** The iCalendar text of a part: in the database, or in Akonadi's file store for big ones. */
const payloadOf = async (row: ItemRow, fileStore: string): Promise<string | undefined> => {
  if (row.data === null) return undefined;
  const bytes = typeof row.data === "string" ? Buffer.from(row.data) : Buffer.from(row.data);
  if (row.storage === 0) return bytes.length <= KDE_CALENDAR_LIMITS.maxPayloadBytes ? bytes.toString("utf8") : undefined;
  if (row.storage !== 1) return undefined;
  // Akonadi names the file "<part id>_r<revision>" in a folder named by the id's last two digits.
  const name = bytes.toString("utf8");
  const match = EXTERNAL_NAME.exec(name);
  if (!match || Number(match[1]) !== row.partId) return undefined;
  for (const path of [join(fileStore, (match[1] as string).padStart(2, "0").slice(-2), name), join(fileStore, name)]) {
    try {
      const handle = await fs.open(path, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > KDE_CALENDAR_LIMITS.maxPayloadBytes) return undefined;
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // Try the next place.
    }
  }
  return undefined;
};

/** Every VEVENT of the selected calendars, with the calendar each belongs to. */
export const readAkonadiEvents = async (source: AkonadiSource): Promise<Array<{ calendar: string; owner?: string; event: ICalEvent }>> => {
  try {
    await fs.access(source.database);
  } catch {
    throw new Error("KOrganizer calendar: Akonadi's database was not found");
  }
  let rows: ItemRow[];
  const db = new Database(source.database, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    rows = db.query(`
      SELECT p.collectionId AS collectionId, c.name AS collectionName, c.remoteId AS collectionRemoteId, pt.id AS partId, pt.storage AS storage, pt.data AS data
      FROM PimItemTable p
      JOIN MimeTypeTable m ON m.id = p.mimeTypeId
      JOIN CollectionTable c ON c.id = p.collectionId
      JOIN PartTable pt ON pt.pimItemId = p.id
      JOIN PartTypeTable t ON t.id = pt.partTypeId
      WHERE m.name = ?1 AND t.ns = 'PLD' AND t.name = 'RFC822' AND c.enabled = 1
      LIMIT ?2`).all(EVENT_MIME, KDE_CALENDAR_LIMITS.maxItems) as ItemRow[];
  } finally {
    db.close();
  }
  const events: Array<{ calendar: string; owner?: string; event: ICalEvent }> = [];
  let total = 0;
  for (const row of rows) {
    if (source.selection && !source.selection.has(row.collectionId)) continue;
    const text = await payloadOf(row, source.fileStore);
    if (!text) continue;
    total += text.length;
    if (total > KDE_CALENDAR_LIMITS.maxTotalBytes) break;
    const calendar = `akonadi:${row.collectionRemoteId || `c${row.collectionId}`}`;
    // A Google calendar's name is the account's address for its main calendar.
    const name = (row.collectionName ?? "").trim().toLowerCase();
    const owner = /^[^\s@]{1,128}@[^\s@]{1,253}$/.test(name) && !name.endsWith(".calendar.google.com") ? name : undefined;
    for (const event of parseICalEvents(text)) events.push({ calendar, ...(owner ? { owner } : {}), event });
  }
  return events;
};

const compactUtc = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const attendeesOf = (event: ICalEvent, own: ReadonlySet<string>): { attendees: KdeCalendarEvent["attendees"]; declined: boolean } => {
  const attendees: KdeCalendarEvent["attendees"] = [];
  let declined = false;
  for (const attendee of event.attendees) {
    const self = !!attendee.email && own.has(attendee.email);
    if (self && attendee.partstat === "DECLINED") declined = true;
    if (attendee.name) attendees.push({ name: attendee.name, self });
  }
  return { attendees, declined };
};

/**
 * Events of KOrganizer's checked calendars overlapping [since, until) (at most 24 hours), each
 * occurrence of a series on its own. All-day entries, cancelled events and untitled ones are
 * left out.
 */
export const queryKdeCalendarEvents = async (
  since: Date, until: Date, options: { source?: AkonadiSource; env?: NodeJS.ProcessEnv } = {}
): Promise<KdeCalendarEvent[]> => {
  const fromMs = since.getTime();
  const toMs = until.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > KDE_CALENDAR_LIMITS.maxWindowMs) {
    throw new Error("KOrganizer calendar query range is invalid");
  }
  const source = options.source ?? await locateAkonadi(options.env);
  const items = await readAkonadiEvents(source);
  type Series = { calendar: string; owner?: string; master?: ICalEvent; exceptions: ICalEvent[] };
  const series = new Map<string, Series>();
  for (const { calendar, owner, event } of items) {
    const key = `${calendar}\n${event.uid}`;
    const entry = series.get(key) ?? { calendar, ...(owner ? { owner } : {}), exceptions: [] };
    if (event.recurrenceId) entry.exceptions.push(event);
    else entry.master ??= event;
    series.set(key, entry);
  }
  const results: KdeCalendarEvent[] = [];
  const seen = new Set<string>();
  const push = (event: KdeCalendarEvent) => {
    const key = `${event.id}@${event.startAtMs}`;
    if (seen.has(key) || results.length >= 1_000) return;
    seen.add(key);
    results.push(event);
  };
  const timed = (event: ICalEvent) => event.start.kind !== "date" && event.durationMs > 0;
  for (const [seriesKey, entry] of series) {
    const own = new Set([...source.ownEmails, ...(entry.owner ? [entry.owner] : [])]);
    const master = entry.master;
    if (master?.cancelled) continue;
    const recurring = !!master?.rrule || entry.exceptions.length > 0;
    const replaced = new Set(entry.exceptions.flatMap((exception) => (exception.recurrenceId ? [icalTimeToMs(exception.recurrenceId)] : [])));
    if (master && timed(master) && master.summary.trim()) {
      const { attendees, declined } = attendeesOf(master, own);
      for (const occurrence of expandEvent(master, fromMs, toMs, replaced)) {
        push({
          id: recurring ? `${seriesKey}\n${compactUtc(occurrence.originalStartMs)}` : seriesKey,
          ...(recurring ? { seriesId: seriesKey } : {}),
          title: master.summary, startAtMs: occurrence.startMs, endAtMs: occurrence.endMs, recurring, attendees,
          ...(declined ? { selfDeclined: true } : {})
        });
      }
    }
    for (const exception of entry.exceptions) {
      if (exception.cancelled || !timed(exception) || !exception.recurrenceId) continue;
      const startAtMs = icalTimeToMs(exception.start);
      const endAtMs = startAtMs + exception.durationMs;
      if (startAtMs >= toMs || endAtMs <= fromMs) continue;
      const title = exception.summary.trim() ? exception.summary : master?.summary ?? "";
      if (!title.trim()) continue;
      const { attendees, declined } = attendeesOf(exception, own);
      push({
        id: `${seriesKey}\n${compactUtc(icalTimeToMs(exception.recurrenceId))}`, seriesId: seriesKey,
        title, startAtMs, endAtMs, recurring: true, attendees, ...(declined ? { selfDeclined: true } : {})
      });
    }
  }
  return results.sort((a, b) => a.startAtMs - b.startAtMs || a.endAtMs - b.endAtMs);
};

type KdeQuery = (since: Date, until: Date) => Promise<KdeCalendarEvent[]>;

const matchKdeCalendarEvent = async (startAt: string, endAt: string, query: KdeQuery): Promise<{ event: KdeCalendarEvent; confidence: number } | undefined> => {
  const callStartMs = Date.parse(startAt);
  const callEndMs = Date.parse(endAt);
  if (!Number.isFinite(callStartMs) || !Number.isFinite(callEndMs) || callEndMs <= callStartMs || callEndMs - callStartMs > 12 * 60 * 60 * 1000) {
    throw new Error("Call time range is invalid");
  }
  const events = (await query(new Date(callStartMs - 10 * 60_000), new Date(callEndMs + 15 * 60_000))).filter((event) => event.selfDeclined !== true);
  const best = events.map((event) => ({ event, confidence: scoreCalendarEvent(event, callStartMs, callEndMs) })).sort((a, b) => b.confidence - a.confidence)[0];
  return best && best.confidence >= 0.65 ? best : undefined;
};

const kdeMeeting = (best: { event: KdeCalendarEvent; confidence: number }, app?: CallApplication): MeetingContext => ({
  source: "kde-calendar",
  title: best.event.title,
  startAt: new Date(best.event.startAtMs).toISOString(),
  endAt: new Date(best.event.endAtMs).toISOString(),
  recurring: best.event.recurring,
  confidence: Number(best.confidence.toFixed(3)),
  ...(app ? { app } : {})
});

const defaultQuery: KdeQuery = (since, until) => queryKdeCalendarEvents(since, until);

/** The recording's meeting in KOrganizer, with the event's id, series and invited names for its calendar link. */
export const findKdeCalendarMatch = async (
  startAt: string, endAt: string, app?: CallApplication, query: KdeQuery = defaultQuery
): Promise<{ meeting: MeetingContext; event: { id?: string; seriesId?: string; attendees: KdeCalendarEvent["attendees"] } } | undefined> => {
  const found = await matchKdeCalendarEvent(startAt, endAt, query);
  if (!found) return undefined;
  return {
    meeting: kdeMeeting(found, app),
    event: { id: found.event.id, ...(found.event.seriesId ? { seriesId: found.event.seriesId } : {}), attendees: found.event.attendees }
  };
};

export const findKdeCalendarMeeting = async (startAt: string, endAt: string, app?: CallApplication, query: KdeQuery = defaultQuery): Promise<MeetingContext | undefined> => {
  const found = await matchKdeCalendarEvent(startAt, endAt, query);
  return found ? kdeMeeting(found, app) : undefined;
};
