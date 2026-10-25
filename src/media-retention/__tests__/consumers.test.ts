import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ArchiveStore, validateArchiveRecord } from "../../archive/store";
import { locationOf, mediaDetail, statusOf } from "../../desktop/bridge";
import { recordingWindow } from "../../speakers/service";
import { formatLibraryEntryName, formatStorageLocation } from "../../tui/app";
import { buildLibrary, deleteRecording, type LibraryEntry } from "../../tui/library";
import { applyMediaRetention } from "../apply";
import { planMediaRetention } from "../plan";
import { mediaStateOf } from "../state";
import { archiveRecord, createFixture, writeRemovedTombstone, type Fixture } from "./fixture";

const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });
const setup = async (): Promise<Fixture> => {
  const fixture = await createFixture();
  fixtures.push(fixture);
  return fixture;
};
const remove = async (fixture: Fixture, mode: "transcript-only" | "audio-only" = "transcript-only") => {
  fixture.config.media.retention = mode;
  const plan = await planMediaRetention(fixture.config, fixture.entry, { deps: fixture.deps });
  return applyMediaRetention(fixture.entry, plan, { ...fixture.deps, config: fixture.config });
};

describe("library", () => {
  test("entries carry their media state and a removed recording keeps the original's date", async () => {
    const fixture = await setup();
    const [present] = await buildLibrary(fixture.config, fixture.jobStore, new ArchiveStore(join(fixture.root, "catalog")));
    expect(present).toMatchObject({ sourcePath: fixture.sourcePath, sourceExists: true, media: { state: "present" } });
    const originalDate = present!.modifiedAt;
    const result = await remove(fixture);
    const [removed] = await buildLibrary(fixture.config, fixture.jobStore, new ArchiveStore(join(fixture.root, "catalog")));
    expect(removed).toMatchObject({ sourcePath: fixture.sourcePath, sourceExists: false, media: { state: "removed", reason: "policy", removedAt: result.tombstone.removedAt } });
    expect(removed!.modifiedAt).toBe(originalDate);
    expect(removed!.modifiedAt).not.toBe(Date.parse(fixture.job.createdAt));
  });

  test("missing media without a tombstone still falls back to the job date", async () => {
    const fixture = await setup();
    await fs.rm(fixture.sourcePath);
    const [entry] = await buildLibrary(fixture.config, fixture.jobStore, new ArchiveStore(join(fixture.root, "catalog")));
    expect(entry).toMatchObject({ sourceExists: false, media: { state: "missing" }, modifiedAt: Date.parse(fixture.job.createdAt) });
  });
});

const entryOf = async (fixture: Fixture, overrides: Partial<LibraryEntry> = {}): Promise<LibraryEntry> => {
  const base = { sourcePath: fixture.sourcePath, relativePath: "2026-10-01_10-00_Reuniao.mkv", size: fixture.job.source.size, modifiedAt: 1, jobs: [fixture.job], ...overrides };
  const sourceExists = await fs.lstat(base.sourcePath).then(() => true, () => false);
  return { ...base, sourceExists, media: await mediaStateOf({ ...base }) };
};

describe("bridge read side", () => {
  test("location says transcript-only or audio-only before missing, and detail carries the media features", async () => {
    const fixture = await setup();
    expect(locationOf(await entryOf(fixture))).toBe("local");
    await fs.rm(fixture.sourcePath);
    expect(locationOf(await entryOf(fixture))).toBe("missing");
    await writeRemovedTombstone(fixture.job);
    const removed = await entryOf(fixture);
    expect(locationOf(removed)).toBe("transcript-only");
    expect(mediaDetail(removed.media!)).toEqual({ state: "removed", removedAt: "2026-10-05T09:00:01.000Z", reason: "policy",
      features: { playback: false, frames: false, diarize: false, speakersMic: false, voices: false, subtitles: false, reprocess: false } });
    // A verified copy elsewhere still plays from there.
    expect(locationOf(await entryOf(fixture, { archive: archiveRecord(fixture) }))).toBe("vaio");
  });

  test("audio-only reads as audio-only and keeps playback and speaker features", async () => {
    const fixture = await setup();
    await remove(fixture, "audio-only");
    const entry = await entryOf(fixture);
    expect(locationOf(entry)).toBe("audio-only");
    expect(mediaDetail(entry.media!)).toMatchObject({ state: "audio-only", features: { playback: true, frames: false, diarize: true, speakersMic: true, reprocess: false } });
  });

  test("a retired archive copy is settled, never pending", async () => {
    const fixture = await setup();
    const retired = { state: "retired" as const, reason: "media-retention" as const, at: "2026-10-05T09:00:00.000Z" };
    const entry = await entryOf(fixture, { jobs: [], archive: archiveRecord(fixture, { vaio: retired, proton: retired }) });
    expect(statusOf(entry)).toBe("unprocessed");
    expect(statusOf(await entryOf(fixture, { jobs: [], archive: archiveRecord(fixture, { vaio: retired, proton: { state: "pending" } }) }))).toBe("archive-pending");
  });
});

describe("TUI labels", () => {
  test("removed and audio-only recordings say what is kept", async () => {
    const fixture = await setup();
    await writeRemovedTombstone(fixture.job);
    await fs.rm(fixture.sourcePath);
    const removed = await entryOf(fixture);
    expect(formatStorageLocation(removed)).toBe("somente transcrição");
    expect(formatLibraryEntryName(removed)).toBe("[só transcrição] 2026-10-01_10-00_Reuniao.mkv");
    expect(formatStorageLocation({ ...removed, archive: archiveRecord(fixture) })).toBe("vaio + Proton verificado");
    const audio = { ...removed, media: { ...removed.media!, state: "audio-only" as const } };
    expect(formatStorageLocation(audio)).toBe("somente áudio");
    expect(formatLibraryEntryName(audio)).toBe("[só áudio] 2026-10-01_10-00_Reuniao.mkv");
    expect(formatStorageLocation({ ...audio, archive: archiveRecord(fixture, { proton: { state: "pending" } }) })).toBe("áudio local + vaio");
    // Without a media state the labels are unchanged.
    expect(formatStorageLocation({ ...removed, media: undefined })).toBe("arquivo ausente");
    expect(formatLibraryEntryName({ ...removed, media: undefined })).toBe("[ausente] 2026-10-01_10-00_Reuniao.mkv");
  });
});

describe("archive catalog", () => {
  test("a retired copy validates; a malformed one does not", async () => {
    const fixture = await setup();
    const retired = { state: "retired" as const, reason: "media-retention" as const, at: "2026-10-05T09:00:00.000Z" };
    expect(validateArchiveRecord(archiveRecord(fixture, { vaio: retired })).vaio).toEqual(retired);
    expect(() => validateArchiveRecord(archiveRecord(fixture, { vaio: { ...retired, reason: "other" } as never }))).toThrow();
    expect(() => validateArchiveRecord(archiveRecord(fixture, { vaio: { ...retired, at: "never" } }))).toThrow();
  });
});

describe("speaker calendar window", () => {
  test("uses the file time, then the tombstone time once the media is removed, then the job date", async () => {
    const fixture = await setup();
    const stat = await fs.stat(fixture.sourcePath);
    expect((await recordingWindow(fixture.job, 60))?.endAt).toBe(new Date(stat.mtimeMs).toISOString());
    await fs.rm(fixture.sourcePath);
    expect((await recordingWindow(fixture.job, 60))?.endAt).toBe(new Date(Date.parse(fixture.job.createdAt)).toISOString());
    const tombstone = await writeRemovedTombstone(fixture.job);
    expect(await recordingWindow(fixture.job, 60)).toEqual({
      startAt: new Date(tombstone.source.mtimeMs - 60_000).toISOString(), endAt: new Date(tombstone.source.mtimeMs).toISOString()
    });
  });
});

describe("deletion", () => {
  test("deleting a recording whose media retention removed trashes its folder, tombstone included, and its jobs", async () => {
    const fixture = await setup();
    await remove(fixture);
    const [entry] = await buildLibrary(fixture.config, fixture.jobStore, new ArchiveStore(join(fixture.root, "catalog")));
    const result = await deleteRecording(fixture.config, entry!, fixture.jobStore, join(fixture.root, "trash"));
    expect(result.removedJobs).toBe(1);
    // Only the recording folder goes to Trash: the media was already gone.
    expect(result.trashedPaths).toHaveLength(1);
    expect(await fs.stat(fixture.recordingRoot).catch(() => null)).toBeNull();
    expect(await fixture.jobStore.list()).toEqual([]);
    expect(result.removalPlans[0]?.preserved.some((item) => item.path.endsWith("media-retention.json"))).toBe(true);
  });
});
