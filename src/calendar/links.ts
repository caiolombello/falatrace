// The calendar event a recording belongs to, kept next to its job when the job is created:
// event and series ids keyed with the installation salt (never the calendar's own ids) and the
// names of the people invited (never their e-mails). The library index reads these files for
// people, series and pre-meeting briefs; the job manifest keeps only its MeetingContext.
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobRecord, MeetingContext } from "../jobs/types";
import { validateJobId } from "../jobs/types";
import type { CalendarLink } from "../library-index/types";
import { createPrivateFile, ensurePrivateDirectory, singleLine } from "../runtime/private-file";
import { gnomeSeriesId, hashCalendarId } from "./upcoming";

/** `$XDG_DATA_HOME/recording-cli/calendar-links`, resolved like the job store's data directory. */
export const calendarLinksDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  join(env.XDG_DATA_HOME || join(home, ".local/share"), "recording-cli", "calendar-links");

/** What the calendar said about the matched event, besides the MeetingContext the job keeps. */
export type CalendarEventDetails = {
  /** The calendar's event id; hashed before it is stored. */
  id?: string;
  /** The recurring series id when the calendar gives one (Google); GNOME's is derived from its event id. */
  seriesId?: string;
  attendees: Array<{ name: string; self: boolean }>;
};

export type CalendarMatch = { meeting: MeetingContext; event: CalendarEventDetails };

export const CALENDAR_LINK_LIMITS = { maxAttendees: 50, nameLength: 120, titleLength: 160, maxIdLength: 4096, maxBytes: 64 * 1024 } as const;

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= CALENDAR_LINK_LIMITS.maxIdLength;

const iso = (value: string): string => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid calendar time");
  return new Date(ms).toISOString();
};

/** Names only: anything that looks like an e-mail address is left out, and repeats are folded. */
const attendeeNames = (attendees: unknown): CalendarLink["attendees"] => {
  if (!Array.isArray(attendees)) return [];
  const seen = new Set<string>();
  const names: CalendarLink["attendees"] = [];
  for (const entry of attendees.slice(0, 500)) {
    if (names.length >= CALENDAR_LINK_LIMITS.maxAttendees) break;
    const raw = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    const name = typeof raw === "string" ? singleLine(raw, CALENDAR_LINK_LIMITS.nameLength) : "";
    const key = name.toLocaleLowerCase("pt-BR");
    if (!name || name.includes("@") || seen.has(key)) continue;
    seen.add(key);
    names.push({ name, self: (entry as { self?: unknown }).self === true });
  }
  return names;
};

export type CalendarLinkOptions = {
  now?: Date;
  /** Where the installation salt lives (the state directory by default). */
  stateDir?: string;
  hash?: (id: string) => Promise<string>;
};

/**
 * The link for a job. Ids are hashed exactly as the upcoming-events list hashes them, so a
 * reminder's event and series find the recordings of earlier occurrences.
 */
export const buildCalendarLink = async (
  job: Pick<JobRecord, "id" | "source">, match: CalendarMatch, options: CalendarLinkOptions = {}
): Promise<CalendarLink> => {
  const hash = options.hash ?? ((id: string) => hashCalendarId(id, { stateDir: options.stateDir }));
  const { meeting, event } = match;
  const eventId = validId(event.id) ? event.id : undefined;
  const seriesId = validId(event.seriesId) ? event.seriesId
    : meeting.source === "gnome-calendar" && eventId ? gnomeSeriesId(eventId) : undefined;
  return {
    version: 1,
    jobId: validateJobId(job.id),
    mediaSha256: job.source.sha256,
    source: meeting.source,
    ...(eventId ? { eventIdHash: await hash(eventId) } : {}),
    ...(seriesId && validId(seriesId) ? { seriesIdHash: await hash(seriesId) } : {}),
    title: singleLine(meeting.title, CALENDAR_LINK_LIMITS.titleLength),
    startAt: iso(meeting.startAt),
    endAt: iso(meeting.endAt),
    recurring: meeting.recurring === true,
    attendees: attendeeNames(event.attendees),
    capturedAt: (options.now ?? new Date()).toISOString()
  };
};

/**
 * Save the link as `calendar-links/<jobId>.json` (0600 in a 0700 folder). The first link of a job
 * wins: queueing the same recording again does not rewrite it. Returns the file path, and whether
 * it was written now.
 */
export const writeCalendarLink = async (
  job: Pick<JobRecord, "id" | "source">, match: CalendarMatch, options: CalendarLinkOptions & { dir?: string } = {}
): Promise<{ path: string; written: boolean }> => {
  const link = await buildCalendarLink(job, match, options);
  const dir = options.dir ?? calendarLinksDir();
  await ensurePrivateDirectory(dir);
  const path = join(dir, `${link.jobId}.json`);
  const written = await createPrivateFile(path, `${JSON.stringify(link, null, 2)}\n`, CALENDAR_LINK_LIMITS.maxBytes);
  return { path, written };
};
