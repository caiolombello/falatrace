import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { GoogleCalendarEvent } from "../../google/calendar";
import { enqueueRecording } from "../../jobs/enqueue";
import { JobStore } from "../../jobs/store";
import type { JobRecord, MeetingContext } from "../../jobs/types";
import { validateCalendarLink } from "../../library-index/build";
import { findGnomeCalendarMatch, findGnomeCalendarMeeting } from "../gnome";
import { buildCalendarLink, type CalendarMatch, calendarLinksDir, writeCalendarLink } from "../links";
import { clearCalendarSaltCache, hashCalendarIdWithSalt, listUpcomingEvents } from "../upcoming";

const SALT = "c".repeat(64);
const JOB = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: { sha256: "d".repeat(64) } } as Pick<JobRecord, "id" | "source">;
const meeting = (source: MeetingContext["source"] = "google-calendar"): MeetingContext => ({
  source, title: "Revisão semanal", startAt: "2026-10-25T13:00:00.000Z", endAt: "2026-10-25T14:00:00.000Z", recurring: true, confidence: 0.91
});
const hash = async (id: string) => hashCalendarIdWithSalt(id, SALT);

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-links-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  clearCalendarSaltCache();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

test("a link keeps hashed ids and invited names only, hashed exactly like the upcoming events of a reminder", async () => {
  const match: CalendarMatch = {
    meeting: meeting(),
    event: { id: "evt_123", seriesId: "series_9", attendees: [
      { name: "Ana Souza", self: false }, { name: "ana.souza@example.com", self: false }, { name: "Eu", self: true }, { name: "ana souza", self: false }
    ] }
  };
  const link = await buildCalendarLink(JOB, match, { hash, now: new Date("2026-10-25T14:05:00.000Z") });
  expect(link).toEqual({
    version: 1, jobId: JOB.id, mediaSha256: JOB.source.sha256, source: "google-calendar",
    eventIdHash: hashCalendarIdWithSalt("evt_123", SALT), seriesIdHash: hashCalendarIdWithSalt("series_9", SALT),
    title: "Revisão semanal", startAt: "2026-10-25T13:00:00.000Z", endAt: "2026-10-25T14:00:00.000Z", recurring: true,
    attendees: [{ name: "Ana Souza", self: false }, { name: "Eu", self: true }], capturedAt: "2026-10-25T14:05:00.000Z"
  });
  expect(JSON.stringify(link)).not.toContain("evt_123");
  expect(JSON.stringify(link)).not.toContain("@");
  // The next occurrence listed for a reminder carries the same series hash.
  const config = structuredClone(DEFAULT_CONFIG);
  config.google = { clientId: "123456789012-abcdefghij0123456789.apps.googleusercontent.com", calendar: true };
  const next: GoogleCalendarEvent = { id: "evt_456", seriesId: "series_9", title: "Revisão semanal", startAtMs: Date.parse("2026-11-01T13:00:00Z"), endAtMs: Date.parse("2026-11-01T14:00:00Z"), recurring: true, attendees: [] };
  const [upcoming] = await listUpcomingEvents(config, { from: new Date("2026-11-01T12:00:00Z"), to: new Date("2026-11-01T18:00:00Z"), deps: { google: async () => [next], salt: async () => SALT } });
  expect(upcoming.seriesIdHash).toBe(link.seriesIdHash);
  // The library index accepts the file as this job's.
  expect(validateCalendarLink(JSON.parse(JSON.stringify(link)), JOB)).toMatchObject({ eventIdHash: link.eventIdHash, attendees: link.attendees });
});

test("a GNOME link derives its series from the event id; events without ids keep only times and title", async () => {
  const query = async () => [{ id: "source-1\nuid-7\n20261025T130000", title: "Daily", startAtMs: Date.parse("2026-10-25T13:00:00Z"), endAtMs: Date.parse("2026-10-25T13:15:00Z"), recurring: true }];
  const match = await findGnomeCalendarMatch("2026-10-25T13:00:30Z", "2026-10-25T13:14:00Z", undefined, query);
  expect(match?.meeting).toEqual(await findGnomeCalendarMeeting("2026-10-25T13:00:30Z", "2026-10-25T13:14:00Z", undefined, query));
  if (!match) throw new Error("no match");
  const link = await buildCalendarLink(JOB, match, { hash });
  expect(link.eventIdHash).toBe(hashCalendarIdWithSalt("source-1\nuid-7\n20261025T130000", SALT));
  expect(link.seriesIdHash).toBe(hashCalendarIdWithSalt("source-1\nuid-7", SALT));
  expect(link.attendees).toEqual([]);
  const bare = await buildCalendarLink(JOB, { meeting: meeting("gnome-calendar"), event: { attendees: [] } }, { hash });
  expect(bare.eventIdHash).toBeUndefined();
  expect(bare.seriesIdHash).toBeUndefined();
});

test("the link is a private file the library index reads; the first link of a job is kept", async () => {
  const root = await tempDir();
  const dir = join(root, "data", "recording-cli", "calendar-links");
  expect(calendarLinksDir({ XDG_DATA_HOME: join(root, "data") })).toBe(dir);
  const first = await writeCalendarLink(JOB, { meeting: meeting(), event: { id: "evt_1", attendees: [{ name: "Ana", self: false }] } }, { dir, stateDir: join(root, "state") });
  expect(first).toEqual({ path: join(dir, `${JOB.id}.json`), written: true });
  expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  const again = await writeCalendarLink(JOB, { meeting: { ...meeting(), title: "Outra" }, event: { attendees: [] } }, { dir, stateDir: join(root, "state") });
  expect(again.written).toBe(false);
  const stored = JSON.parse(await fs.readFile(first.path, "utf8"));
  expect(stored.title).toBe("Revisão semanal");
  expect(validateCalendarLink(stored, JOB)).toBeDefined();
  // The salt was created in the state directory, never next to the link.
  expect((await fs.readdir(join(root, "state"))).includes("calendar-salt")).toBe(true);
  await expect(writeCalendarLink({ ...JOB, id: "../escape" }, { meeting: meeting(), event: { attendees: [] } }, { dir, hash })).rejects.toThrow("Invalid job id");
});

test("a queued call recording gets its calendar link; the manifest keeps only the meeting context", async () => {
  const root = await tempDir();
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const source = join(root, "meeting.wav");
  await fs.writeFile(source, "fixture media");
  const config = structuredClone(DEFAULT_CONFIG);
  config.processing.autoEnqueue = true;
  config.processing.defaultTarget = "local";
  config.calendar.enabled = true;
  const written: Array<[string, CalendarMatch]> = [];
  const match: CalendarMatch = { meeting: meeting("gnome-calendar"), event: { id: "x\ny", attendees: [] } };
  const job = await enqueueRecording(config, source, { recordingId: JOB.id, startedAt: "2026-10-25T13:00:00Z", endedAt: "2026-10-25T14:00:00Z" }, store, {
    lookups: { google: async () => undefined, gnome: async () => match },
    writeLink: async (created, value) => { written.push([created.id, value]); }
  });
  expect(job?.id).toBe(JOB.id);
  expect(written).toEqual([[JOB.id, match]]);
  const manifest = JSON.parse(await fs.readFile(join(store.getWorkDir(JOB.id), "manifest.json"), "utf8"));
  expect(manifest.summary.context.meeting).toEqual(match.meeting);
  expect(JSON.stringify(manifest)).not.toContain("x\\ny");
  // A link that cannot be saved never stops the job.
  const other = join(root, "other.wav");
  await fs.writeFile(other, "other media");
  const second = await enqueueRecording(config, other, { recordingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", startedAt: "2026-10-25T13:00:00Z", endedAt: "2026-10-25T14:00:00Z" }, store, {
    lookups: { google: async () => undefined, gnome: async () => match },
    writeLink: async () => { throw new Error("EROFS: read-only file system"); }
  });
  expect(second?.state).toBe("pending");
  // No calendar match, no link.
  written.length = 0;
  const third = join(root, "third.wav");
  await fs.writeFile(third, "third media");
  await enqueueRecording(config, third, {}, store, { lookups: { google: async () => undefined, gnome: async () => match }, writeLink: async (created, value) => { written.push([created.id, value]); } });
  expect(written).toEqual([]);
});
