import type { AppConfig } from "../config/defaults";
import { readSecret } from "../config/secrets";
import { scoreCalendarEvent } from "../calendar/gnome";
import type { CallApplication } from "../calls/apps";
import type { MeetingContext } from "../jobs/types";
import { validSpeakerLabel } from "../diarization/store";
import { isGoogleClientId } from "./client-id";
import { GOOGLE_MESSAGES, GoogleTokenStore, refreshAccessToken } from "./oauth";

// The Google Calendar event a recording belongs to: its title (as the GNOME calendar
// gives it) and the names of the people invited. Read only while google.calendar is on
// and an account is connected; only the time window of the recording is sent.

export const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_WINDOW_MS = 12 * 60 * 60 * 1000;
const MIN_CONFIDENCE = 0.65;
const MAX_ATTENDEES = 50;

export type GoogleAttendee = { name: string; self: boolean };
export type GoogleCalendarEvent = {
  id: string; title: string; startAtMs: number; endAtMs: number; recurring: boolean; attendees: GoogleAttendee[];
  /** Id of the recurring series this occurrence belongs to (Google's recurringEventId). */
  seriesId?: string;
  /** The connected account declined this event (set only then). */
  selfDeclined?: boolean;
};
export type GoogleCalendarDependencies = {
  fetch?: typeof fetch;
  store?: GoogleTokenStore;
  clientSecret?: () => Promise<string | undefined>;
  signal?: AbortSignal;
};

const cleanTitle = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";

/** The display name, or one built from the e-mail ("ana.souza@…" → "Ana Souza"); never the e-mail itself. */
export const attendeeName = (attendee: { displayName?: unknown; email?: unknown }): string | undefined => {
  const display = typeof attendee.displayName === "string" ? attendee.displayName.replace(/\s+/g, " ").trim() : "";
  if (display && !display.includes("@") && validSpeakerLabel(display)) return display;
  if (typeof attendee.email !== "string") return undefined;
  const words = (attendee.email.split("@")[0] || "").split(/[._-]+/).filter((word) => /^\p{L}{2,}$/u.test(word));
  const name = words.map((word) => word[0]!.toLocaleUpperCase("pt-BR") + word.slice(1).toLocaleLowerCase("pt-BR")).join(" ");
  return name && validSpeakerLabel(name) ? name : undefined;
};

export const parseGoogleEvents = (body: unknown): GoogleCalendarEvent[] => {
  const items = body && typeof body === "object" ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) throw new Error(GOOGLE_MESSAGES.unreachable);
  return items.slice(0, 250).flatMap((value): GoogleCalendarEvent[] => {
    if (!value || typeof value !== "object") return [];
    const event = value as { id?: unknown; status?: unknown; summary?: unknown; start?: { dateTime?: unknown }; end?: { dateTime?: unknown }; recurringEventId?: unknown; attendees?: unknown };
    // All-day events carry only a date: they are not the meeting being recorded.
    const startAtMs = typeof event.start?.dateTime === "string" ? Date.parse(event.start.dateTime) : Number.NaN;
    const endAtMs = typeof event.end?.dateTime === "string" ? Date.parse(event.end.dateTime) : Number.NaN;
    const title = cleanTitle(event.summary);
    if (event.status === "cancelled" || !title || !Number.isFinite(startAtMs) || !Number.isFinite(endAtMs) || endAtMs <= startAtMs) return [];
    const seen = new Set<string>();
    const listed = (Array.isArray(event.attendees) ? event.attendees : []).slice(0, 500);
    const selfDeclined = listed.some((entry) => !!entry && typeof entry === "object" &&
      (entry as { self?: unknown }).self === true && (entry as { responseStatus?: unknown }).responseStatus === "declined");
    const attendees = listed.flatMap((entry): GoogleAttendee[] => {
      const attendee = entry && typeof entry === "object" ? entry as { resource?: unknown; responseStatus?: unknown; self?: unknown; displayName?: unknown; email?: unknown } : undefined;
      // Rooms and people who declined were not in the meeting.
      if (!attendee || attendee.resource === true || attendee.responseStatus === "declined") return [];
      const name = attendeeName(attendee);
      const key = name?.toLocaleLowerCase("pt-BR");
      if (!name || !key || seen.has(key)) return [];
      seen.add(key);
      return [{ name, self: attendee.self === true }];
    }).slice(0, MAX_ATTENDEES);
    const seriesId = typeof event.recurringEventId === "string" ? event.recurringEventId.slice(0, 200) : "";
    return [{ id: typeof event.id === "string" ? event.id.slice(0, 200) : "", title, startAtMs, endAtMs, recurring: typeof event.recurringEventId === "string", attendees,
      ...(seriesId ? { seriesId } : {}), ...(selfDeclined ? { selfDeclined: true } : {}) }];
  });
};

/** Connected means a saved refresh token for the configured client. */
export const googleCalendarEnabled = (config: AppConfig): boolean => config.google.calendar && isGoogleClientId(config.google.clientId);

/** A fresh access token for the connected account; the refresh writes nothing, so sandboxed units may call it. */
export const googleAccessToken = async (config: AppConfig, dependencies: GoogleCalendarDependencies = {}): Promise<string> => {
  const token = await (dependencies.store || new GoogleTokenStore()).read();
  if (!token || token.clientId !== config.google.clientId) throw new Error(GOOGLE_MESSAGES.notConnected);
  const secret = await (dependencies.clientSecret || (() => readSecret("GOOGLE_CLIENT_SECRET")))();
  return refreshAccessToken(token, secret, dependencies.fetch, dependencies.signal);
};

export const fetchGoogleEvents = async (token: string, from: Date, to: Date, dependencies: GoogleCalendarDependencies = {}): Promise<GoogleCalendarEvent[]> => {
  const url = new URL(GOOGLE_EVENTS_URL);
  for (const [key, value] of Object.entries({
    timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50",
    fields: "items(id,status,summary,start,end,recurringEventId,attendees(email,displayName,self,resource,responseStatus))"
  })) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await (dependencies.fetch || fetch)(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error",
      signal: dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw new Error(GOOGLE_MESSAGES.unreachable); }
  if (response.status === 401 || response.status === 403) throw new Error(GOOGLE_MESSAGES.expired);
  if (!response.ok) throw new Error(GOOGLE_MESSAGES.unreachable);
  return parseGoogleEvents(await response.json().catch(() => undefined));
};

/** Events of the primary calendar in a window of at most 12 hours, e.g. the next meetings for reminders. */
export const listGoogleEvents = async (config: AppConfig, from: Date, to: Date, dependencies: GoogleCalendarDependencies = {}): Promise<GoogleCalendarEvent[]> => {
  const start = from.getTime(), end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) throw new Error("Calendar time range is invalid");
  return fetchGoogleEvents(await googleAccessToken(config, dependencies), from, to, dependencies);
};

/** The event that best matches a recording, by the same overlap score as the GNOME calendar. */
export const findGoogleCalendarEvent = async (
  config: AppConfig, startAt: string, endAt: string, dependencies: GoogleCalendarDependencies = {}
): Promise<{ event: GoogleCalendarEvent; confidence: number } | undefined> => {
  const start = Date.parse(startAt), end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) throw new Error("Call time range is invalid");
  const events = await fetchGoogleEvents(await googleAccessToken(config, dependencies), new Date(start - 10 * 60_000), new Date(end + 15 * 60_000), dependencies);
  const best = events.map((event) => ({ event, confidence: scoreCalendarEvent(event, start, end) })).sort((a, b) => b.confidence - a.confidence)[0];
  return best && best.confidence >= MIN_CONFIDENCE ? { event: best.event, confidence: Number(best.confidence.toFixed(3)) } : undefined;
};

/**
 * The recording's meeting (title and times for the job, like the GNOME calendar) together with the
 * matched event's id, series and invited names, for the calendar link kept beside the job.
 */
export const findGoogleCalendarMatch = async (
  config: AppConfig, startAt: string, endAt: string, app?: CallApplication, dependencies: GoogleCalendarDependencies = {}
): Promise<{ meeting: MeetingContext; event: { id?: string; seriesId?: string; attendees: GoogleAttendee[] } } | undefined> => {
  const found = await findGoogleCalendarEvent(config, startAt, endAt, dependencies);
  if (!found) return undefined;
  const meeting: MeetingContext = { source: "google-calendar", title: found.event.title, startAt: new Date(found.event.startAtMs).toISOString(),
    endAt: new Date(found.event.endAtMs).toISOString(), recurring: found.event.recurring, confidence: found.confidence, ...(app ? { app } : {}) };
  return { meeting, event: { ...(found.event.id ? { id: found.event.id } : {}), ...(found.event.seriesId ? { seriesId: found.event.seriesId } : {}), attendees: found.event.attendees } };
};

/** Title for the summary, like the GNOME calendar. The invited names are not kept in the job. */
export const findGoogleCalendarMeeting = async (
  config: AppConfig, startAt: string, endAt: string, app?: CallApplication, dependencies: GoogleCalendarDependencies = {}
): Promise<MeetingContext | undefined> => (await findGoogleCalendarMatch(config, startAt, endAt, app, dependencies))?.meeting;

/** Names invited to the recording's event, for the name suggestions; empty when none matches. */
export const readGoogleAttendees = async (
  config: AppConfig, startAt: string, endAt: string, dependencies: GoogleCalendarDependencies = {}
): Promise<GoogleAttendee[]> => (await findGoogleCalendarEvent(config, startAt, endAt, dependencies))?.event.attendees || [];
