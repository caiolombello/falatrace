import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { findMeetingContext } from "../../jobs/enqueue";
import { GOOGLE_EVENTS_URL, attendeeName, findGoogleCalendarMeeting, parseGoogleEvents, readGoogleAttendees } from "../calendar";
import { GOOGLE_MESSAGES, GOOGLE_TOKEN_URL, GoogleTokenStore } from "../oauth";

const CLIENT = "123456789012-abcdefghij0123456789.apps.googleusercontent.com";
const configWith = (overrides: Partial<AppConfig["google"]> = {}): AppConfig => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.google = { clientId: CLIENT, calendar: true, ...overrides };
  return config;
};
const event = (id: string, start: string, end: string, extra: object = {}) => ({ id, status: "confirmed", summary: `Reunião ${id}`, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const withToken = async (run: (store: GoogleTokenStore) => Promise<void>, clientId = CLIENT) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-google-calendar-"));
  const store = new GoogleTokenStore(join(dir, "google"));
  await store.save({ version: 1, clientId, refreshToken: "long-lived", scopes: [], connectedAt: "2026-10-21T00:00:00.000Z" });
  try { await run(store); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};
/** Google stand-in: the token endpoint and the primary calendar's events. */
const google = (items: object[], seen: URL[] = [], status = 200) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  seen.push(url);
  if (url.toString() === GOOGLE_TOKEN_URL) return new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 });
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh");
  return new Response(JSON.stringify({ items }), { status });
}) as typeof fetch;

test("invited names come from display names or e-mails, never rooms, people who declined or the e-mail itself", () => {
  expect(attendeeName({ displayName: "Ana Souza", email: "ana@example.com" })).toBe("Ana Souza");
  expect(attendeeName({ email: "bruno.lima@example.com" })).toBe("Bruno Lima");
  expect(attendeeName({ displayName: "x@example.com", email: "joão_pedro@example.com" })).toBe("João Pedro");
  expect(attendeeName({ email: "1234@example.com" })).toBeUndefined();
  const events = parseGoogleEvents({ items: [
    event("a", "2026-10-21T13:00:00-03:00", "2026-10-21T14:00:00-03:00", { recurringEventId: "series", attendees: [
      { email: "caio@example.com", displayName: "Caio Barbieri", self: true, responseStatus: "accepted" },
      { email: "ana.souza@example.com", responseStatus: "accepted" },
      { email: "ANA.SOUZA@example.com" },
      { email: "sala-3@resource.calendar.google.com", displayName: "Sala 3", resource: true },
      { email: "bruno@example.com", displayName: "Bruno", responseStatus: "declined" }
    ] }),
    event("cancelled", "2026-10-21T13:00:00-03:00", "2026-10-21T14:00:00-03:00", { status: "cancelled" }),
    { id: "all-day", summary: "Feriado", start: { date: "2026-10-21" }, end: { date: "2026-10-22" } }
  ] });
  expect(events).toEqual([{ id: "a", title: "Reunião a", startAtMs: Date.parse("2026-10-21T16:00:00Z"), endAtMs: Date.parse("2026-10-21T17:00:00Z"), recurring: true,
    attendees: [{ name: "Caio Barbieri", self: true }, { name: "Ana Souza", self: false }], seriesId: "series" }]);
});

test("the recording's event is the best overlap in its window, read with a fresh access token", async () => withToken(async (store) => {
  const seen: URL[] = [];
  const items = [
    event("standup", "2026-10-21T12:00:00Z", "2026-10-21T12:15:00Z"),
    event("review", "2026-10-21T13:00:00Z", "2026-10-21T14:00:00Z", { attendees: [{ email: "ana.souza@example.com" }, { email: "caio@example.com", displayName: "Caio Barbieri", self: true }] })
  ];
  const dependencies = { store, fetch: google(items, seen), clientSecret: async () => "secret" };
  const meeting = await findGoogleCalendarMeeting(configWith(), "2026-10-21T13:02:00Z", "2026-10-21T13:58:00Z", "slack", dependencies);
  expect(meeting).toMatchObject({ source: "google-calendar", title: "Reunião review", startAt: "2026-10-21T13:00:00.000Z", endAt: "2026-10-21T14:00:00.000Z", recurring: false, app: "slack" });
  expect(meeting!.confidence).toBeGreaterThanOrEqual(0.65);
  const events = seen.find((url) => url.origin + url.pathname === GOOGLE_EVENTS_URL)!;
  // Only the window around the recording is asked for.
  expect([events.searchParams.get("timeMin"), events.searchParams.get("timeMax"), events.searchParams.get("singleEvents")]).toEqual(["2026-10-21T12:52:00.000Z", "2026-10-21T14:13:00.000Z", "true"]);
  expect((await readGoogleAttendees(configWith(), "2026-10-21T13:02:00Z", "2026-10-21T13:58:00Z", dependencies)).map((attendee) => attendee.name)).toEqual(["Ana Souza", "Caio Barbieri"]);
  // A call that matches no event well enough gets no meeting.
  expect(await findGoogleCalendarMeeting(configWith(), "2026-10-21T18:00:00Z", "2026-10-21T18:30:00Z", undefined, dependencies)).toBeUndefined();
}));

test("without a connected account for this client, or with a refused token, nothing is guessed", async () => {
  const dependencies = (store: GoogleTokenStore, status = 200) => ({ store, fetch: google([], [], status), clientSecret: async () => undefined });
  await withToken(async (store) => {
    await expect(findGoogleCalendarMeeting(configWith(), "2026-10-21T13:00:00Z", "2026-10-21T14:00:00Z", undefined, dependencies(store))).rejects.toThrow(GOOGLE_MESSAGES.notConnected);
  }, "999999999999-otherclient0000000000.apps.googleusercontent.com");
  await withToken(async (store) => {
    await expect(findGoogleCalendarMeeting(configWith(), "2026-10-21T13:00:00Z", "2026-10-21T14:00:00Z", undefined, dependencies(store, 401))).rejects.toThrow(GOOGLE_MESSAGES.expired);
  });
});

test("a call's meeting comes from Google when it is on, from GNOME otherwise, and from neither when both are off", async () => {
  const calls: string[] = [];
  const lookups = {
    google: async () => { calls.push("google"); return { source: "google-calendar" as const, title: "Google", startAt: "2026-10-21T13:00:00.000Z", endAt: "2026-10-21T14:00:00.000Z", recurring: false, confidence: 0.9 }; },
    gnome: async () => { calls.push("gnome"); return { source: "gnome-calendar" as const, title: "GNOME", startAt: "2026-10-21T13:00:00.000Z", endAt: "2026-10-21T14:00:00.000Z", recurring: false, confidence: 0.9 }; }
  };
  const window = { startedAt: "2026-10-21T13:00:00.000Z", endedAt: "2026-10-21T14:00:00.000Z" };
  const both = configWith();
  both.calendar.enabled = true;
  expect((await findMeetingContext(both, window, lookups))?.title).toBe("Google");
  expect((await findMeetingContext(both, window, { ...lookups, google: async () => { throw new Error(GOOGLE_MESSAGES.expired); } }))?.title).toBe("GNOME");
  const gnomeOnly = configWith({ calendar: false });
  gnomeOnly.calendar.enabled = true;
  expect((await findMeetingContext(gnomeOnly, window, lookups))?.title).toBe("GNOME");
  expect(await findMeetingContext(configWith({ calendar: false }), window, lookups)).toBeUndefined();
  expect(await findMeetingContext(both, {}, lookups)).toBeUndefined();
  expect(calls).toEqual(["google", "gnome", "gnome"]);
});
