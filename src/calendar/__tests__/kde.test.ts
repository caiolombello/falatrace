import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKdeCalendarMatch, locateAkonadi, parseKdeConfig, queryKdeCalendarEvents } from "../kde";

const withHome = async (run: (paths: { home: string; config: string; data: string }) => Promise<void>) => {
  const home = await fs.mkdtemp(join(tmpdir(), "falatrace-akonadi-"));
  try {
    const config = join(home, ".config");
    const data = join(home, ".local/share");
    await fs.mkdir(join(config, "akonadi"), { recursive: true });
    await fs.mkdir(join(data, "akonadi", "file_db_data"), { recursive: true });
    await run({ home, config, data });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
};

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

/** The part of Akonadi's schema (version 42) that FalaTrace reads, with a few items. */
const createAkonadi = (path: string, items: Array<{ collection: number; payload: string; external?: string; mime?: string }>) => {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE MimeTypeTable (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE PartTypeTable (id INTEGER PRIMARY KEY, name TEXT, ns TEXT);
    CREATE TABLE CollectionTable (id INTEGER PRIMARY KEY, remoteId TEXT, name TEXT, enabled BOOLEAN);
    CREATE TABLE PimItemTable (id INTEGER PRIMARY KEY, collectionId INTEGER, mimeTypeId INTEGER);
    CREATE TABLE PartTable (id INTEGER PRIMARY KEY, pimItemId INTEGER, partTypeId INTEGER, data BLOB, storage INTEGER);
    INSERT INTO MimeTypeTable VALUES (3, 'application/x-vnd.akonadi.calendar.event'), (4, 'application/x-vnd.akonadi.calendar.todo');
    INSERT INTO PartTypeTable VALUES (1, 'HIDDEN', 'ATR'), (2, 'RFC822', 'PLD');
    INSERT INTO CollectionTable VALUES (11, 'pt-br.brazilian#holiday@group.v.calendar.google.com', 'pt-br.brazilian#holiday@group.v.calendar.google.com', 1),
      (12, 'caio@ops.team', 'caio@ops.team', 1), (13, 'hidden-cal', 'Hidden', 1), (14, 'off', 'Off', 0);
  `);
  items.forEach((item, index) => {
    const id = index + 1;
    db.query("INSERT INTO PimItemTable VALUES (?1, ?2, ?3)").run(id, item.collection, item.mime === "todo" ? 4 : 3);
    const partId = 200 + id;
    db.query("INSERT INTO PartTable VALUES (?1, ?2, 2, ?3, ?4)").run(partId, id, item.external ? Buffer.from(`${partId}_r0`) : Buffer.from(item.payload), item.external ? 1 : 0);
  });
  db.close();
};

const T = (iso: string) => new Date(iso);

test("KDE config files: groups, keys and $HOME expansion", () => {
  const parsed = parseKdeConfig("[%General]\nDriver=QSQLITE\n\n[QSQLITE]\nName[$e]=$HOME/db.sqlite\n# comment\n", { HOME: "/h" }, "/h");
  expect(parsed).toEqual({ "%General": { Driver: "QSQLITE" }, QSQLITE: { Name: "/h/db.sqlite" } });
});

test("only KOrganizer's checked calendars are read; series, exceptions, big payloads and declines come out right", async () => {
  await withHome(async ({ home, config, data }) => {
    const database = join(data, "akonadi", "akonadi.db");
    await fs.writeFile(join(config, "akonadi", "akonadiserverrc"), `[%General]\nDriver=QSQLITE\n\n[QSQLITE]\nName=${database}\n`);
    await fs.writeFile(join(config, "korganizerrc"), "[GlobalCollectionSelection]\nSelection=c11,c12,c14\n");
    await fs.writeFile(join(config, "akonadi_google_resource_0rc"), "[General]\nAccount=Caio@Ops.Team\n");
    const weekly = ics("UID:weekly@google.com", "SUMMARY:Daily do time", "DTSTART;TZID=America/Sao_Paulo:20261001T093000", "DTEND;TZID=America/Sao_Paulo:20261001T094500",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", 'ATTENDEE;CN="Ana";PARTSTAT=ACCEPTED:mailto:ana@x.com', "ATTENDEE;CN=Caio;PARTSTAT=ACCEPTED:mailto:caio@ops.team");
    createAkonadi(database, [
      { collection: 12, payload: weekly },
      // Tuesday's daily moved to 10:00.
      { collection: 12, payload: ics("UID:weekly@google.com", "RECURRENCE-ID;TZID=America/Sao_Paulo:20261027T093000", "SUMMARY:Daily do time (adiada)",
        "DTSTART;TZID=America/Sao_Paulo:20261027T100000", "DTEND;TZID=America/Sao_Paulo:20261027T101500") },
      // Stored outside the database, as Akonadi does for big payloads.
      { collection: 12, external: "yes", payload: ics("UID:big@google.com", "SUMMARY:Planejamento financeiro", "DTSTART:20261027T223200Z", "DTEND:20261027T230700Z", `DESCRIPTION:${"x".repeat(5000)}`) },
      { collection: 12, payload: ics("UID:declined@google.com", "SUMMARY:Recusada", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z", "ATTENDEE;CN=Caio;PARTSTAT=DECLINED:mailto:caio@ops.team") },
      { collection: 12, payload: ics("UID:cancelled@google.com", "SUMMARY:Cancelada", "STATUS:CANCELLED", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z") },
      { collection: 11, payload: ics("UID:holiday", "SUMMARY:Feriado", "DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261028") },
      // Not checked in KOrganizer, or a disabled calendar, or a task: never read.
      { collection: 13, payload: ics("UID:hidden", "SUMMARY:Escondida", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z") },
      { collection: 14, payload: ics("UID:off", "SUMMARY:Desligada", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z") },
      { collection: 12, mime: "todo", payload: ics("UID:todo", "SUMMARY:Tarefa", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z") }
    ]);
    // Akonadi keeps "<part id>_r<rev>" in a folder named by the id's last two digits.
    await fs.mkdir(join(data, "akonadi", "file_db_data", "03"), { recursive: true });
    const big = ics("UID:big@google.com", "SUMMARY:Planejamento financeiro", "DTSTART:20261027T223200Z", "DTEND:20261027T230700Z", `DESCRIPTION:${"x".repeat(5000)}`);
    await fs.writeFile(join(data, "akonadi", "file_db_data", "03", "203_r0"), big);

    const env = { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data };
    const source = await locateAkonadi(env, home);
    expect(source.database).toBe(database);
    expect([...(source.selection ?? [])]).toEqual([11, 12, 14]);
    expect([...source.ownEmails]).toEqual(["caio@ops.team"]);

    const [monday] = await queryKdeCalendarEvents(T("2026-10-26T12:00:00Z"), T("2026-10-26T13:00:00Z"), { source });
    const events = await queryKdeCalendarEvents(T("2026-10-27T00:00:00Z"), T("2026-10-27T23:59:00Z"), { source });
    expect(new Date(monday!.startAtMs).toISOString()).toBe("2026-10-26T12:30:00.000Z");
    expect(events.map((event) => [new Date(event.startAtMs).toISOString(), event.title, event.recurring])).toEqual([
      ["2026-10-27T13:00:00.000Z", "Daily do time (adiada)", true],
      ["2026-10-27T15:00:00.000Z", "Recusada", false],
      ["2026-10-27T22:32:00.000Z", "Planejamento financeiro", false]
    ]);
    const [moved, declined, big_] = events;
    expect(monday!.id).toBe("akonadi:caio@ops.team\nweekly@google.com\n20261026T123000Z");
    expect(monday!.seriesId).toBe("akonadi:caio@ops.team\nweekly@google.com");
    expect(monday!.attendees).toEqual([{ name: "Ana", self: false }, { name: "Caio", self: true }]);
    // The moved occurrence keeps the id of the occurrence it replaces.
    expect(moved!.id).toBe("akonadi:caio@ops.team\nweekly@google.com\n20261027T123000Z");
    expect(moved!.attendees).toEqual([{ name: "Ana", self: false }, { name: "Caio", self: true }]);
    expect(declined!.selfDeclined).toBe(true);
    expect(big_!.id).toBe("akonadi:caio@ops.team\nbig@google.com");
    expect(big_!.seriesId).toBeUndefined();

    // A recording made during the moved daily is named after it.
    const match = await findKdeCalendarMatch("2026-10-27T13:01:00Z", "2026-10-27T13:14:00Z", undefined, (since, until) => queryKdeCalendarEvents(since, until, { source }));
    expect(match?.meeting).toMatchObject({ source: "kde-calendar", title: "Daily do time (adiada)", recurring: true });
    expect(match?.event.seriesId).toBe("akonadi:caio@ops.team\nweekly@google.com");
    // A declined meeting never names a recording.
    expect(await findKdeCalendarMatch("2026-10-27T15:00:00Z", "2026-10-27T16:00:00Z", undefined, (since, until) => queryKdeCalendarEvents(since, until, { source }))).toBeUndefined();
  });
});

test("an explicitly empty KOrganizer selection reads no calendars", async () => {
  await withHome(async ({ home, config, data }) => {
    const database = join(data, "akonadi", "akonadi.db");
    createAkonadi(database, [{ collection: 12, payload: ics("UID:private", "SUMMARY:Not selected", "DTSTART:20261027T150000Z", "DTEND:20261027T160000Z") }]);
    await fs.writeFile(join(config, "korganizerrc"), "[GlobalCollectionSelection]\nSelection=\n");
    const source = await locateAkonadi({ HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, home);
    expect(await queryKdeCalendarEvents(T("2026-10-27T00:00:00Z"), T("2026-10-27T23:59:00Z"), { source })).toEqual([]);
  });
});

test("moved occurrences inherit attendees and declines unless they supply their own attendees", async () => {
  await withHome(async ({ home, config, data }) => {
    const database = join(data, "akonadi", "akonadi.db");
    createAkonadi(database, [
      { collection: 12, payload: ics("UID:declined-series", "SUMMARY:Declined series", "DTSTART:20261026T150000Z", "DTEND:20261026T160000Z", "RRULE:FREQ=DAILY;COUNT=3",
        "ATTENDEE;CN=Ana;PARTSTAT=ACCEPTED:mailto:ana@x.com", "ATTENDEE;CN=Caio;PARTSTAT=DECLINED:mailto:caio@ops.team") },
      { collection: 12, payload: ics("UID:declined-series", "RECURRENCE-ID:20261027T150000Z", "DTSTART:20261027T160000Z", "DTEND:20261027T170000Z") },
      { collection: 12, payload: ics("UID:declined-series", "RECURRENCE-ID:20261028T150000Z", "DTSTART:20261028T170000Z", "DTEND:20261028T180000Z",
        "ATTENDEE;CN=Caio;PARTSTAT=ACCEPTED:mailto:caio@ops.team") }
    ]);
    const source = await locateAkonadi({ HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }, home);
    const query = (since: Date, until: Date) => queryKdeCalendarEvents(since, until, { source });
    const [declined] = await query(T("2026-10-27T00:00:00Z"), T("2026-10-28T00:00:00Z"));
    expect(declined?.attendees).toEqual([{ name: "Ana", self: false }, { name: "Caio", self: true }]);
    expect(declined?.selfDeclined).toBe(true);
    expect(await findKdeCalendarMatch("2026-10-27T16:00:00Z", "2026-10-27T17:00:00Z", undefined, query)).toBeUndefined();
    const [accepted] = await query(T("2026-10-28T00:00:00Z"), T("2026-10-29T00:00:00Z"));
    expect(accepted?.attendees).toEqual([{ name: "Caio", self: true }]);
    expect(accepted?.selfDeclined).toBeUndefined();
    expect(await findKdeCalendarMatch("2026-10-28T17:00:00Z", "2026-10-28T18:00:00Z", undefined, query)).toBeDefined();
  });
});

test("other Akonadi backends, a missing database and bad windows fail clearly", async () => {
  await withHome(async ({ home, config, data }) => {
    const env = { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data };
    const source = await locateAkonadi(env, home);
    expect(source.database).toBe(join(data, "akonadi", "akonadi.db"));
    expect(source.selection).toBeUndefined();
    await expect(queryKdeCalendarEvents(T("2026-10-27T00:00:00Z"), T("2026-10-27T01:00:00Z"), { source })).rejects.toThrow("Akonadi's database was not found");
    await expect(queryKdeCalendarEvents(T("2026-10-27T00:00:00Z"), T("2026-10-29T01:00:00Z"), { source })).rejects.toThrow("range is invalid");
    await fs.writeFile(join(config, "akonadi", "akonadiserverrc"), "[%General]\nDriver=QMYSQL\n");
    await expect(locateAkonadi(env, home)).rejects.toThrow("only its SQLite database can be read");
  });
});
