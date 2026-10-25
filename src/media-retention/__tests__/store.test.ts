import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEDIA_RETENTION_MESSAGES, MediaRetentionStore, RETAINED_AUDIO_FILE, recordingRootOf, retainedAudioPathOf, serializeTombstone, tombstonePathOf,
  validateTombstone, type MediaRetentionTombstone, type RetainedAudio
} from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const H = (char: string): string => char.repeat(64);

const setup = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "media-retention-store-"));
  roots.push(root);
  const sourcePath = join(root, "Reuniao semanal.mkv");
  await fs.mkdir(recordingRootOf(sourcePath), { mode: 0o700 });
  const tombstone: MediaRetentionTombstone = {
    version: 1, sourcePath, source: { fileName: "Reuniao semanal.mkv", size: 1234, sha256: H("a"), mtimeMs: 1_700_000_000_000 },
    jobs: [JOB], mode: "transcript-only", reason: "policy", state: "removing", startedAt: "2026-10-02T10:00:00.000Z",
    verified: { jobId: JOB, receipt: "verified", transcriptArtifactSha256: H("b"), receiptSha256: H("c"), microphone: "skipped", voices: "skipped", backups: {} },
    purged: []
  };
  return { root, sourcePath, tombstone, store: new MediaRetentionStore() };
};

describe("tombstone paths", () => {
  test("live in the recording folder beside the media", () => {
    expect(recordingRootOf("/r/2026/Reunião.mkv")).toBe("/r/2026/Reunião.recording");
    expect(tombstonePathOf("/r/2026/Reunião.mkv")).toBe("/r/2026/Reunião.recording/media-retention.json");
    expect(retainedAudioPathOf("/r/a.b.mp4")).toBe(`/r/a.b.recording/${RETAINED_AUDIO_FILE}`);
  });
});

describe("MediaRetentionStore", () => {
  test("writes privately and atomically, and reads back the same tombstone", async () => {
    const { sourcePath, tombstone, store } = await setup();
    expect(await store.read(sourcePath)).toBeNull();
    const written = await store.write(tombstone, null);
    expect(written.tombstone).toEqual(tombstone);
    const stat = await fs.stat(tombstonePathOf(sourcePath));
    expect(stat.mode & 0o777).toBe(0o600);
    const read = await store.read(sourcePath);
    expect(read?.tombstone).toEqual(tombstone);
    expect(read?.raw).toBe(written.raw);
    expect(read?.raw).toBe(serializeTombstone(tombstone));
    // No temporary files are left behind.
    expect((await fs.readdir(recordingRootOf(sourcePath))).sort()).toEqual(["media-retention.json"]);
  });

  test("compare-and-swap refuses a stale expected value and a create over an existing file", async () => {
    const { sourcePath, tombstone, store } = await setup();
    const first = await store.write(tombstone, null);
    await expect(store.write({ ...tombstone, purged: ["visual-frames"] }, null)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneChanged);
    const second = await store.write({ ...tombstone, purged: ["visual-frames"] }, first.raw);
    await expect(store.write({ ...tombstone, state: "removed", removedAt: "2026-10-02T11:00:00.000Z" }, first.raw)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneChanged);
    expect((await store.read(sourcePath))?.raw).toBe(second.raw);
  });

  test("concurrent writers with the same expected value never corrupt the file", async () => {
    const { sourcePath, tombstone, store } = await setup();
    const base = await store.write(tombstone, null);
    const results = await Promise.allSettled([
      store.write({ ...tombstone, purged: ["visual-frames"] }, base.raw),
      store.write({ ...tombstone, purged: ["work-temp-audio"] }, base.raw),
      store.write({ ...tombstone, purged: ["proton-restore-cache"] }, base.raw)
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const current = await store.read(sourcePath);
    expect(current?.tombstone.purged.length).toBe(1);
  });

  test("an unreadable current file is preserved, never overwritten", async () => {
    const { sourcePath, tombstone, store } = await setup();
    await fs.writeFile(tombstonePathOf(sourcePath), "{not json", { mode: 0o600 });
    await expect(store.read(sourcePath)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    await expect(store.write(tombstone, null)).rejects.toThrow();
    expect(await fs.readFile(tombstonePathOf(sourcePath), "utf8")).toBe("{not json");
  });

  test("refuses a symlinked tombstone and a symlinked recording folder", async () => {
    const { root, sourcePath, tombstone, store } = await setup();
    const outside = join(root, "outside.json");
    await fs.writeFile(outside, serializeTombstone(tombstone));
    await fs.symlink(outside, tombstonePathOf(sourcePath));
    await expect(store.read(sourcePath)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    await fs.rm(tombstonePathOf(sourcePath));

    const elsewhere = join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.rm(recordingRootOf(sourcePath), { recursive: true });
    await fs.symlink(elsewhere, recordingRootOf(sourcePath));
    await expect(store.write(tombstone, null)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.recordingRootUnsafe);
    await expect(store.read(sourcePath)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.recordingRootUnsafe);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  test("refuses an oversized file and a tombstone that names other media", async () => {
    const { root, sourcePath, tombstone, store } = await setup();
    await fs.writeFile(tombstonePathOf(sourcePath), " ".repeat(70 * 1024));
    await expect(store.read(sourcePath)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    const otherSource = join(root, "Outra.mkv");
    await fs.writeFile(tombstonePathOf(sourcePath), serializeTombstone({ ...tombstone, sourcePath: otherSource, source: { ...tombstone.source, fileName: "Outra.mkv" } }));
    await expect(store.read(sourcePath)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
  });

  test("a missing recording folder reads as no tombstone", async () => {
    const { root, store } = await setup();
    expect(await store.read(join(root, "never-recorded.mkv"))).toBeNull();
  });
});

describe("validateTombstone", () => {
  const valid = async () => (await setup()).tombstone;
  const rejects = (value: unknown): void => { expect(() => validateTombstone(value)).toThrow(MEDIA_RETENTION_MESSAGES.tombstoneInvalid); };

  test("accepts complete removed and audio-only tombstones", async () => {
    const tombstone = await valid();
    const removed = { ...tombstone, state: "removed" as const, removedAt: "2026-10-02T11:00:00.000Z", purged: ["proton-restore-cache", "visual-frames", "work-temp-audio"] as MediaRetentionTombstone["purged"] };
    expect(validateTombstone(removed)).toEqual(removed);
    const audio: MediaRetentionTombstone = {
      ...removed, mode: "audio-only",
      audio: { fileName: RETAINED_AUDIO_FILE, size: 99, sha256: H("d"), durationSeconds: 119.98,
        streams: [{ index: 0, title: "Mixed", channels: 2, codec: "opus" }, { index: 1, channels: 1, codec: "opus" }] }
    };
    expect(validateTombstone(audio)).toEqual(audio);
  });

  test("rebuilds field by field and keeps purged kinds in a stable order", async () => {
    const tombstone = await valid();
    const value = validateTombstone({ ...tombstone, purged: ["work-temp-audio", "proton-restore-cache"] });
    expect(value.purged).toEqual(["proton-restore-cache", "work-temp-audio"]);
  });

  test("rejects unknown, missing and malformed fields", async () => {
    const tombstone = await valid();
    rejects(null);
    rejects([]);
    rejects({ ...tombstone, extra: true });
    rejects({ ...tombstone, version: 2 });
    rejects({ ...tombstone, sourcePath: "relative.mkv" });
    rejects({ ...tombstone, sourcePath: `${tombstone.sourcePath}\n` });
    rejects({ ...tombstone, source: { ...tombstone.source, fileName: "other.mkv" } });
    rejects({ ...tombstone, source: { ...tombstone.source, size: 0 } });
    rejects({ ...tombstone, source: { ...tombstone.source, sha256: "abc" } });
    rejects({ ...tombstone, source: { ...tombstone.source, extra: 1 } });
    rejects({ ...tombstone, jobs: [] });
    rejects({ ...tombstone, jobs: [JOB, JOB] });
    rejects({ ...tombstone, jobs: ["not-a-uuid"] });
    rejects({ ...tombstone, mode: "keep" });
    rejects({ ...tombstone, reason: "auto" });
    rejects({ ...tombstone, state: "done" });
    rejects({ ...tombstone, startedAt: "yesterday" });
    const { purged: _purged, ...withoutPurged } = tombstone;
    rejects(withoutPurged);
    rejects({ ...tombstone, purged: ["visual-frames", "visual-frames"] });
    rejects({ ...tombstone, purged: ["trash"] });
  });

  test("rejects inconsistent states", async () => {
    const tombstone = await valid();
    rejects({ ...tombstone, state: "removed" });
    rejects({ ...tombstone, removedAt: "2026-10-02T11:00:00.000Z" });
    rejects({ ...tombstone, audio: { fileName: RETAINED_AUDIO_FILE, size: 1, sha256: H("d"), durationSeconds: 1, streams: [{ index: 0, channels: 1, codec: "opus" }] } });
    rejects({ ...tombstone, mode: "audio-only", state: "removed", removedAt: "2026-10-02T11:00:00.000Z" });
    rejects({ ...tombstone, verified: { ...tombstone.verified, jobId: OTHER } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, receiptSha256: undefined } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, receipt: "legacy-unverified" } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, microphone: "pending" } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, voices: "failed" } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, backups: { vaio: "soon" } } });
    rejects({ ...tombstone, verified: { ...tombstone.verified, backups: { s3: "2026-10-02T11:00:00.000Z" } } });
    const legacy = { ...tombstone, verified: { jobId: JOB, receipt: "legacy-unverified", transcriptArtifactSha256: H("b"), microphone: "skipped", voices: "skipped", backups: {} } };
    expect(validateTombstone(legacy).verified.receipt).toBe("legacy-unverified");
  });

  test("rejects retained audio with unsafe streams", async () => {
    const tombstone = { ...(await valid()), mode: "audio-only" as const };
    const audio: RetainedAudio = { fileName: RETAINED_AUDIO_FILE, size: 10, sha256: H("d"), durationSeconds: 10, streams: [{ index: 0, title: "Mixed", channels: 2, codec: "opus" }] };
    expect(validateTombstone({ ...tombstone, audio }).audio).toEqual(audio);
    rejects({ ...tombstone, audio: { ...audio, fileName: "audio.mka" } });
    rejects({ ...tombstone, audio: { ...audio, streams: [] } });
    rejects({ ...tombstone, audio: { ...audio, streams: [{ index: 1, channels: 2, codec: "opus" }] } });
    rejects({ ...tombstone, audio: { ...audio, streams: [{ index: 0, title: "Mi\u0007xed", channels: 2, codec: "opus" }] } });
    rejects({ ...tombstone, audio: { ...audio, streams: [{ index: 0, title: "x".repeat(201), channels: 2, codec: "opus" }] } });
    rejects({ ...tombstone, audio: { ...audio, streams: [{ index: 0, channels: 0, codec: "opus" }] } });
    rejects({ ...tombstone, audio: { ...audio, streams: [{ index: 0, channels: 2, codec: "Opus!" }] } });
    rejects({ ...tombstone, audio: { ...audio, durationSeconds: 0 } });
    rejects({ ...tombstone, audio: { ...audio, extra: 1 } });
  });
});
