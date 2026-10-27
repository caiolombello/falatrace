import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { GOOGLE_EVENTS_URL, listGoogleEvents, parseGoogleEvents, type GoogleCalendarEvent } from "../../google/calendar";
import { GOOGLE_TOKEN_URL, GoogleTokenStore } from "../../google/oauth";
import type { GnomeCalendarEvent } from "../gnome";
import type { KdeCalendarEvent } from "../kde";
import {
  UPCOMING_ERRORS, UPCOMING_KNOWN_ERRORS, calendarSaltPath, clearCalendarSaltCache, gnomeAllDay, gnomeSeriesId, hashCalendarId, hashCalendarIdWithSalt,
  listUpcomingEvents, readCalendarSalt, upcomingEventSources, validateUpcomingEvent
} from "../upcoming";

const CLIENT = "123456789012-abcdefghij0123456789.apps.googleusercontent.com";
const SALT = "a".repeat(64);
const T0 = Date.parse("2026-10-25T12:00:00.000Z");
const at = (minutes: number): number => T0 + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();

const config = (options: { google?: boolean; gnome?: boolean; kde?: boolean } = {}): AppConfig => {
  const value = structuredClone(DEFAULT_CONFIG);
  value.google = { clientId: options.google ? CLIENT : "", calendar: options.google === true };
  value.calendar = { enabled: options.gnome === true, kde: options.kde === true };
  return value;
};
const kdeEvent = (id: string, title: string, start: number, end: number, extra: Partial<KdeCalendarEvent> = {}): KdeCalendarEvent =>
  ({ id, title, startAtMs: at(start), endAtMs: at(end), recurring: false, attendees: [], ...extra });
const googleEvent = (id: string, start: number, end: number, extra: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent =>
  ({ id, title: `Reunião ${id}`, startAtMs: at(start), endAtMs: at(end), recurring: false, attendees: [], ...extra });
const gnomeEvent = (id: string, title: string, start: number, end: number): GnomeCalendarEvent =>
  ({ id, title, startAtMs: at(start), endAtMs: at(end), recurring: id.includes("\n") });

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-upcoming-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  clearCalendarSaltCache();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("installation salt", () => {
  test("is created once as 32 random bytes in a private file and reused", async () => {
    const stateDir = join(await tempDir(), "state", "recording-cli");
    const salt = await readCalendarSalt({ stateDir });
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    const stat = await fs.stat(calendarSaltPath(stateDir));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(calendarSaltPath(stateDir), "utf8")).toBe(`${salt}\n`);
    clearCalendarSaltCache();
    expect(await readCalendarSalt({ stateDir })).toBe(salt);
    // Another installation gets another salt.
    expect(await readCalendarSalt({ stateDir: join(await tempDir(), "other") })).not.toBe(salt);
  });

  test("processes racing to create it all end up with the first file written", async () => {
    const stateDir = await tempDir();
    const salts = await Promise.all(Array.from({ length: 8 }, () => readCalendarSalt({ stateDir })));
    expect(new Set(salts).size).toBe(1);
    expect((await fs.readdir(stateDir)).sort()).toEqual(["calendar-salt"]);
  });

  test("a damaged, oversized or linked salt file is refused rather than silently replaced", async () => {
    const stateDir = await tempDir();
    await fs.writeFile(calendarSaltPath(stateDir), "not-hex\n", { mode: 0o600 });
    await expect(readCalendarSalt({ stateDir })).rejects.toThrow(UPCOMING_ERRORS.invalidSalt);
    await fs.writeFile(calendarSaltPath(stateDir), "a".repeat(4096), { mode: 0o600 });
    await expect(readCalendarSalt({ stateDir })).rejects.toThrow(UPCOMING_ERRORS.invalidSalt);
    await fs.rm(calendarSaltPath(stateDir));
    const target = join(stateDir, "elsewhere");
    await fs.writeFile(target, `${SALT}\n`);
    await fs.symlink(target, calendarSaltPath(stateDir));
    await expect(readCalendarSalt({ stateDir })).rejects.toThrow(UPCOMING_ERRORS.unsafeSalt);
    expect(await fs.readFile(target, "utf8")).toBe(`${SALT}\n`);
  });

  test("a state directory that is a symlink is refused before any salt is written", async () => {
    const root = await tempDir();
    await fs.mkdir(join(root, "real"));
    await fs.symlink(join(root, "real"), join(root, "linked"));
    await expect(readCalendarSalt({ stateDir: join(root, "linked") })).rejects.toThrow(UPCOMING_ERRORS.unsafeSalt);
    expect(await fs.readdir(join(root, "real"))).toEqual([]);
  });

  test("calendar ids are keyed with the salt: stable, never the id itself, different per installation", async () => {
    const one = hashCalendarIdWithSalt("event-1", SALT);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCalendarIdWithSalt("event-1", SALT)).toBe(one);
    expect(hashCalendarIdWithSalt("event-2", SALT)).not.toBe(one);
    expect(hashCalendarIdWithSalt("event-1", "b".repeat(64))).not.toBe(one);
    expect(() => hashCalendarIdWithSalt("", SALT)).toThrow(UPCOMING_ERRORS.invalidId);
    expect(() => hashCalendarIdWithSalt("x".repeat(5000), SALT)).toThrow(UPCOMING_ERRORS.invalidId);
    expect(() => hashCalendarIdWithSalt("event-1", "short")).toThrow(UPCOMING_ERRORS.invalidSalt);
    const stateDir = await tempDir();
    const salt = await readCalendarSalt({ stateDir });
    expect(await hashCalendarId("event-1", { stateDir })).toBe(hashCalendarIdWithSalt("event-1", salt));
    await expect(hashCalendarId("", { stateDir })).rejects.toThrow(UPCOMING_ERRORS.invalidId);
  });
});

describe("listing upcoming events", () => {
  const range = { from: new Date(at(0)), to: new Date(at(180)) };

  test("no calendar turned on means no events and no calendar access", async () => {
    let called = false;
    const deps = { google: async () => { called = true; return []; }, gnome: async () => { called = true; return []; }, salt: async () => SALT };
    expect(upcomingEventSources(config())).toEqual([]);
    expect(await listUpcomingEvents(config(), { ...range, deps })).toEqual([]);
    expect(called).toBe(false);
    // google.calendar without a valid client id is not "connected".
    const halfway = config();
    halfway.google.calendar = true;
    expect(upcomingEventSources(halfway)).toEqual([]);
  });

  test("the window must be valid and at most 12 hours", async () => {
    const deps = { google: async () => [], salt: async () => SALT };
    for (const bad of [
      { from: new Date(at(10)), to: new Date(at(10)) },
      { from: new Date(at(10)), to: new Date(at(0)) },
      { from: new Date(at(0)), to: new Date(at(12 * 60 + 1)) },
      { from: new Date(Number.NaN), to: new Date(at(1)) },
      { from: "2026-10-25" as unknown as Date, to: new Date(at(1)) }
    ]) await expect(listUpcomingEvents(config({ google: true }), { ...bad, deps })).rejects.toThrow(UPCOMING_ERRORS.invalidRange);
  });

  test("Google events become hashed, sorted, cleaned events inside the window", async () => {
    const asked: Array<[string, string]> = [];
    const events = await listUpcomingEvents(config({ google: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        google: async (from, to) => {
          asked.push([from.toISOString(), to.toISOString()]);
          return [
            googleEvent("later", 120, 150),
            googleEvent("weekly_20261025T1230Z", 30, 60, { recurring: true, seriesId: "weekly", title: "Revisão\u0007 semanal\u202e\n  do time",
              attendees: [{ name: "Ana Souza", self: false }, { name: "ana souza", self: false }, { name: "x@example.com", self: false }, { name: "Caio", self: true }] }),
            googleEvent("finished", -60, -1),
            googleEvent("in-progress", -30, 15),
            googleEvent("too-late", 180, 200),
            googleEvent("bad-times", 50, 40),
            googleEvent("no-title", 50, 60, { title: " \u0000 " })
          ];
        }
      }
    });
    expect(asked).toEqual([[iso(0), iso(180)]]);
    expect(events.map((event) => event.title)).toEqual(["Reunião in-progress", "Revisão semanal do time", "Reunião later"]);
    const weekly = events[1];
    expect(weekly).toEqual({
      source: "google-calendar", eventIdHash: hashCalendarIdWithSalt("weekly_20261025T1230Z", SALT), seriesIdHash: hashCalendarIdWithSalt("weekly", SALT),
      title: "Revisão semanal do time", startAt: iso(30), endAt: iso(60), recurring: true,
      attendees: [{ name: "Ana Souza", self: false }, { name: "Caio", self: true }]
    });
    expect(JSON.stringify(events)).not.toContain("weekly_");
    expect(events[0].seriesIdHash).toBeUndefined();
  });

  test("GNOME events carry no attendees and get their series from the recurrence id", async () => {
    const events = await listUpcomingEvents(config({ gnome: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        gnome: async () => [gnomeEvent("cal\nuid-1\n20261025T130000Z", "Daily", 60, 75), gnomeEvent("single", "Avulsa", 90, 120)]
      }
    });
    expect(events.map((event) => [event.source, event.title, event.recurring, event.seriesIdHash, event.attendees])).toEqual([
      ["gnome-calendar", "Daily", true, hashCalendarIdWithSalt("cal\nuid-1", SALT), []],
      ["gnome-calendar", "Avulsa", false, undefined, []]
    ]);
    expect(gnomeSeriesId("cal\nuid\n20261025T130000Z")).toBe("cal\nuid");
    expect(gnomeSeriesId("calendar-id\nrecurrence-id")).toBe("calendar-id");
    expect(gnomeSeriesId("cal\nuid\n")).toBeUndefined();
    expect(gnomeSeriesId("plain")).toBeUndefined();
    expect(gnomeSeriesId("\nrid")).toBeUndefined();
  });

  test("a GNOME event without a recurrence id is not recurring, though every current GNOME id has a newline", async () => {
    const events = await listUpcomingEvents(config({ gnome: true }), {
      ...range,
      deps: { salt: async () => SALT, gnome: async () => [gnomeEvent("cal\nuid-2\n", "Avulsa", 30, 60), gnomeEvent("cal\nuid-3\n20261025T130000Z", "Série", 60, 90)] }
    });
    expect(events.map((event) => [event.title, event.recurring, event.seriesIdHash])).toEqual([
      ["Avulsa", false, undefined], ["Série", true, hashCalendarIdWithSalt("cal\nuid-3", SALT)]
    ]);
  });

  test("GNOME all-day entries (local midnight to midnight, one day or several) get no reminder; timed events of any length do", async () => {
    const day = new Date(2026, 9, 25).getTime();
    const local = (dayOffset: number, hours = 0): number => new Date(2026, 9, 25 + dayOffset, hours).getTime();
    const gnome = (id: string, title: string, start: number, end: number): GnomeCalendarEvent => ({ id, title, startAtMs: start, endAtMs: end, recurring: true });
    const events = await listUpcomingEvents(config({ gnome: true }), {
      from: new Date(local(0, 8)), to: new Date(local(0, 11)),
      deps: {
        salt: async () => SALT,
        gnome: async () => [
          gnome("cal\nholiday\n", "Feriado", day, local(1)),
          gnome("cal\nbirthday\n20261025", "Aniversário da Ana", day, local(1)),
          gnome("cal\ntrip\n", "Viagem", local(-1), local(2)),
          gnome("cal\nshift\n", "Plantão", local(0, 9), local(1, 9)),
          gnome("cal\nmeeting\n", "Reunião", local(0, 9), local(0, 10))
        ]
      }
    });
    expect(events.map((event) => event.title)).toEqual(["Reunião", "Plantão"]);
    expect(gnomeAllDay(day, local(1))).toBe(true);
    expect(gnomeAllDay(day, local(0, 1))).toBe(false);
    expect(gnomeAllDay(local(0, 9), local(1, 9))).toBe(false);
    expect(gnomeAllDay(Number.NaN, local(1))).toBe(false);
  });

  test("a meeting the account declined in Google is not listed, nor its copy in the GNOME calendar", async () => {
    const events = await listUpcomingEvents(config({ google: true, gnome: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        google: async () => [googleEvent("declined", 30, 60, { title: "Revisão", selfDeclined: true }), googleEvent("kept", 90, 120)],
        gnome: async () => [gnomeEvent("n1", "Revisão", 30, 60), gnomeEvent("n2", "Outra", 30, 60)]
      }
    });
    expect(events.map((event) => [event.source, event.title])).toEqual([["gnome-calendar", "Outra"], ["google-calendar", "Reunião kept"]]);
  });

  test("the same meeting in both calendars is kept once, from Google", async () => {
    const events = await listUpcomingEvents(config({ google: true, gnome: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        google: async () => [googleEvent("g1", 30, 60, { title: "Revisão Semanal", attendees: [{ name: "Ana", self: false }] })],
        gnome: async () => [gnomeEvent("n1", "revisao semanal", 30.5, 60), gnomeEvent("n2", "Revisão semanal", 45, 60), gnomeEvent("n3", "Outra", 30, 60)]
      }
    });
    // Same start and end sort by title; n2 starts 15 minutes later, so it is another meeting.
    expect(events.map((event) => [event.source, event.title])).toEqual([
      ["gnome-calendar", "Outra"], ["google-calendar", "Revisão Semanal"], ["gnome-calendar", "Revisão semanal"]
    ]);
  });

  test("KOrganizer events keep their series and invited names, drop declined ones, and give way to Google's copy", async () => {
    expect(upcomingEventSources(config({ kde: true }))).toEqual(["kde-calendar"]);
    const events = await listUpcomingEvents(config({ google: true, kde: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        google: async () => [googleEvent("g1", 30, 60, { title: "Revisão Semanal" })],
        kde: async () => [
          kdeEvent("akonadi:a@x\nuid1", "Revisão semanal", 30, 60),
          kdeEvent("akonadi:a@x\nuid2\n20261025T140000Z", "Daily", 120, 135, { recurring: true, seriesId: "akonadi:a@x\nuid2", attendees: [{ name: "Ana", self: false }, { name: "Caio", self: true }] }),
          kdeEvent("akonadi:a@x\nuid3", "Recusada", 90, 100, { selfDeclined: true })
        ]
      }
    });
    expect(events.map((event) => [event.source, event.title])).toEqual([["google-calendar", "Revisão Semanal"], ["kde-calendar", "Daily"]]);
    const daily = events[1]!;
    expect(daily.recurring).toBe(true);
    expect(daily.seriesIdHash).toBe(hashCalendarIdWithSalt("akonadi:a@x\nuid2", SALT));
    expect(daily.eventIdHash).toBe(hashCalendarIdWithSalt("akonadi:a@x\nuid2\n20261025T140000Z", SALT));
    expect(daily.attendees).toEqual([{ name: "Ana", self: false }, { name: "Caio", self: true }]);
    expect(validateUpcomingEvent(daily)).toEqual(daily);
  });

  test("one calendar failing is reported while the other still answers; all failing throws", async () => {
    const failures: string[] = [];
    const events = await listUpcomingEvents(config({ google: true, gnome: true }), {
      ...range,
      deps: {
        salt: async () => SALT,
        google: async () => { throw new Error("token expired"); },
        gnome: async () => [gnomeEvent("n1", "Daily", 30, 45)],
        onSourceError: (source, error) => failures.push(`${source}: ${(error as Error).message}`)
      }
    });
    expect(events.map((event) => event.title)).toEqual(["Daily"]);
    expect(failures).toEqual(["google-calendar: token expired"]);
    const error = await listUpcomingEvents(config({ google: true, gnome: true }), {
      ...range,
      deps: { salt: async () => SALT, google: async () => { throw new Error("a"); }, gnome: async () => { throw new Error("b"); } }
    }).then(() => new Error("listed"), (caught: unknown) => caught as Error & { cause?: unknown });
    expect(error.message).toBe(UPCOMING_ERRORS.unavailable);
    expect((error.cause as Error).message).toBe("a");
  });

  test("duplicates within one calendar collapse and the list is bounded", async () => {
    const many = Array.from({ length: 400 }, (_, index) => googleEvent(`e${index}`, index % 170, (index % 170) + 5));
    const events = await listUpcomingEvents(config({ google: true }), {
      ...range,
      deps: { salt: async () => SALT, google: async () => [googleEvent("dup", 10, 20), googleEvent("dup", 10, 20), ...many] }
    });
    expect(events.length).toBe(200);
    expect(events.filter((event) => event.eventIdHash === hashCalendarIdWithSalt("dup", SALT)).length).toBe(1);
  });

  test("an invalid salt from the dependency is refused", async () => {
    await expect(listUpcomingEvents(config({ google: true }), { ...range, deps: { salt: async () => "nope", google: async () => [googleEvent("a", 1, 2)] } }))
      .rejects.toThrow(UPCOMING_ERRORS.invalidSalt);
  });

  test("by default the salt comes from the state directory", async () => {
    const stateDir = await tempDir();
    const events = await listUpcomingEvents(config({ google: true }), { ...range, deps: { stateDir, google: async () => [googleEvent("a", 1, 2)] } });
    expect(events[0].eventIdHash).toBe(hashCalendarIdWithSalt("a", await readCalendarSalt({ stateDir })));
  });
});

describe("listGoogleEvents", () => {
  test("asks the primary calendar for exactly the window with a fresh token and keeps the series id", async () => {
    const dir = await tempDir();
    const store = new GoogleTokenStore(join(dir, "google"));
    await store.save({ version: 1, clientId: CLIENT, refreshToken: "long-lived", scopes: [], connectedAt: "2026-10-21T00:00:00.000Z" });
    const seen: URL[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.toString() === GOOGLE_TOKEN_URL) return new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh");
      return new Response(JSON.stringify({ items: [
        { id: "inst_1", status: "confirmed", summary: "Weekly", start: { dateTime: iso(30) }, end: { dateTime: iso(60) }, recurringEventId: "series-1" },
        { id: "one", status: "confirmed", summary: "Once", start: { dateTime: iso(90) }, end: { dateTime: iso(100) } }
      ] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const events = await listGoogleEvents(config({ google: true }), new Date(at(0)), new Date(at(180)), { store, fetch, clientSecret: async () => "secret" });
    expect(events.map((event) => [event.id, event.recurring, event.seriesId])).toEqual([["inst_1", true, "series-1"], ["one", false, undefined]]);
    const request = seen.find((url) => url.origin + url.pathname === GOOGLE_EVENTS_URL);
    expect([request?.searchParams.get("timeMin"), request?.searchParams.get("timeMax")]).toEqual([iso(0), iso(180)]);
    await expect(listGoogleEvents(config({ google: true }), new Date(at(0)), new Date(at(13 * 60)), { store, fetch })).rejects.toThrow("Calendar time range is invalid");
  });

  test("an event the connected account declined is marked; others, and other people declining, are not", () => {
    const item = (id: string, attendees: object[]) => ({ id, status: "confirmed", summary: id, start: { dateTime: iso(30) }, end: { dateTime: iso(60) }, attendees });
    const events = parseGoogleEvents({ items: [
      item("declined", [{ email: "me@example.com", displayName: "Eu Mesmo", self: true, responseStatus: "declined" }, { email: "ana@example.com", displayName: "Ana" }]),
      item("accepted", [{ email: "me@example.com", displayName: "Eu Mesmo", self: true, responseStatus: "accepted" }, { email: "bia@example.com", displayName: "Bia", responseStatus: "declined" }]),
      item("no-attendees", [])
    ] });
    expect(events.map((event) => [event.id, event.selfDeclined, event.attendees.map((attendee) => attendee.name)])).toEqual([
      ["declined", true, ["Ana"]], ["accepted", undefined, ["Eu Mesmo"]], ["no-attendees", undefined, []]
    ]);
    expect(Object.keys(events[1])).not.toContain("selfDeclined");
  });
});

describe("validateUpcomingEvent", () => {
  const valid = {
    source: "google-calendar", eventIdHash: "c".repeat(64), seriesIdHash: "d".repeat(64), title: "Daily", startAt: iso(0), endAt: iso(15),
    recurring: true, attendees: [{ name: "Ana", self: false }]
  };

  test("rebuilds a valid event and refuses anything off-contract", () => {
    expect(validateUpcomingEvent(valid)).toEqual(valid as never);
    expect(validateUpcomingEvent({ ...valid, extra: "ignored" })).toEqual(valid as never);
    for (const bad of [
      null, [], "x", { ...valid, source: "outlook" }, { ...valid, eventIdHash: "C".repeat(64) }, { ...valid, seriesIdHash: "short" },
      { ...valid, title: "" }, { ...valid, title: "two\nlines" }, { ...valid, startAt: "yesterday" }, { ...valid, endAt: iso(0) },
      { ...valid, recurring: "yes" }, { ...valid, attendees: [{ name: "a@b.c", self: false }] }, { ...valid, attendees: "Ana" },
      { ...valid, attendees: Array.from({ length: 51 }, (_, index) => ({ name: `P${index}`, self: false })) }
    ]) expect(validateUpcomingEvent(bad)).toBeUndefined();
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(UPCOMING_KNOWN_ERRORS).toEqual(Object.values(UPCOMING_ERRORS));
    for (const message of UPCOMING_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
