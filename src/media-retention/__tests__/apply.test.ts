import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { acquireSingleton } from "../../runtime/singleton";
import { type ApplyStep, applyMediaRetention, recordingLeaseName } from "../apply";
import { resolveMediaEvidence } from "../evidence";
import { type MediaRetentionPlan, planMediaRetention } from "../plan";
import { mediaStateOf } from "../state";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionError, MediaRetentionStore, RETAINED_AUDIO_FILE, tombstonePathOf } from "../store";
import { THREE_TRACKS, archiveRecord, createFixture, fakeRunner, jobRecordRaw, sha, treeHashes, writeDerivedCopies, type Fixture, type FakeMedia } from "./fixture";

const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });
const setup = async (options?: Parameters<typeof createFixture>[0]): Promise<Fixture> => {
  const fixture = await createFixture(options);
  fixtures.push(fixture);
  return fixture;
};
const plan = (fixture: Fixture, options: Parameters<typeof planMediaRetention>[2] = {}): Promise<MediaRetentionPlan> =>
  planMediaRetention(fixture.config, fixture.entry, { deps: fixture.deps, ...options });
const apply = (fixture: Fixture, value: MediaRetentionPlan, extra: Partial<Parameters<typeof applyMediaRetention>[2]> = {}) =>
  applyMediaRetention(fixture.entry, value, { ...fixture.deps, config: fixture.config, ...extra });
const exists = (path: string): Promise<boolean> => fs.lstat(path).then(() => true, () => false);
const store = new MediaRetentionStore();

/** Everything except the media, the new retention files and the derived copies that are purged. */
const untouched = (fixture: Fixture) => (path: string): boolean =>
  path === fixture.sourcePath || path === tombstonePathOf(fixture.sourcePath) || path === join(fixture.recordingRoot, RETAINED_AUDIO_FILE) ||
  path.startsWith(join(fixture.root, "data/media-archive/restored")) || path === join(fixture.root, "state/visual-review/sessions", sha("visual-session"), "frames") ||
  /\/data\/jobs\/[^/]+\/(audio\.(mp3|wav)|chunk-\d+\.mp3|\.transcription-[^/]+)$/.test(path);

describe("transcript-only", () => {
  test("removes the media, purges derived copies and leaves every text artifact byte-identical", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture));
    const copies = await writeDerivedCopies(fixture);
    const jobRaw = await jobRecordRaw(fixture);
    const before = await treeHashes(fixture.root, untouched(fixture));
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);

    const result = await apply(fixture, value);
    expect(result.status).toBe("removed");
    expect(result.bytesFreed).toBe(fixture.job.source.size);
    expect(result.purged).toEqual(["proton-restore-cache", "visual-frames", "work-temp-audio"]);
    expect(result.scope).toMatchObject({ copiesElsewhere: "local-only", remoteCopies: "preserved-not-contacted", artifacts: "preserved", revisions: "preserved", managedExports: "preserved" });
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect(await exists(fixture.recordingRoot)).toBe(true);

    const tombstone = (await store.read(fixture.sourcePath))!.tombstone;
    expect(tombstone).toMatchObject({ state: "removed", mode: "transcript-only", reason: "policy", jobs: [fixture.job.id], removedAt: new Date(fixture.now).toISOString(),
      source: { size: fixture.job.source.size, sha256: fixture.job.source.sha256 }, purged: ["proton-restore-cache", "visual-frames", "work-temp-audio"] });
    expect(tombstone.verified).toEqual(value.verified!);
    expect((await fs.stat(tombstonePathOf(fixture.sourcePath))).mode & 0o777).toBe(0o600);

    // Derived copies are gone; the visual ledger and other media's frames stay.
    expect(await exists(copies.restored)).toBe(false);
    expect(await exists(copies.frames)).toBe(false);
    expect(await exists(copies.ledger)).toBe(true);
    expect(await exists(copies.otherFrames)).toBe(true);
    for (const path of copies.workAudio) expect(await exists(path)).toBe(false);

    expect(await jobRecordRaw(fixture)).toBe(jobRaw);
    expect(await treeHashes(fixture.root, untouched(fixture))).toEqual(before);
  });

  test("purges the restore cache of every catalog record of the media, and nothing named by a malformed id", async () => {
    const fixture = await setup();
    const archiveDir = join(fixture.root, "data/media-archive");
    const first = archiveRecord(fixture);
    const second = archiveRecord(fixture, { id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d" });
    fixture.archives.push(first, second);
    for (const id of [first.id, second.id]) {
      await fs.mkdir(join(archiveDir, "restored", id), { recursive: true });
      await fs.writeFile(join(archiveDir, "restored", id, "source.mkv"), "full-restored-copy");
    }
    await fs.writeFile(join(archiveDir, "keep.txt"), "catalog data outside restored/");
    // A caller's entry with a malformed id must never turn into a recursive removal outside restored/.
    fixture.entry.archive = archiveRecord(fixture, { id: ".." });
    const result = await apply(fixture, await plan(fixture));
    expect(result.purged).toContain("proton-restore-cache");
    expect(await exists(join(archiveDir, "restored", first.id))).toBe(false);
    expect(await exists(join(archiveDir, "restored", second.id))).toBe(false);
    expect(await fs.readFile(join(archiveDir, "keep.txt"), "utf8")).toBe("catalog data outside restored/");
    expect(await exists(join(archiveDir, "restored"))).toBe(true);
  });

  test("applying again reports the removal without doing anything", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    await apply(fixture, value);
    const raw = await fs.readFile(tombstonePathOf(fixture.sourcePath), "utf8");
    const again = await apply(fixture, value);
    expect(again.status).toBe("already-removed");
    expect(again.bytesFreed).toBe(0);
    expect(await fs.readFile(tombstonePathOf(fixture.sourcePath), "utf8")).toBe(raw);
    expect((await plan(fixture)).blockers.map((item) => item.code)).toEqual(["already-removed"]);
  });

  test("a confirmed manual removal of a transcript without receipt records it as such", async () => {
    const fixture = await setup({ receipt: false });
    const value = await plan(fixture, { reason: "manual", allowLegacyTranscript: true });
    const result = await apply(fixture, value);
    expect(result.tombstone.reason).toBe("manual");
    expect(result.tombstone.verified.receipt).toBe("legacy-unverified");
  });
});

describe("audio-only", () => {
  test("keeps every audio stream with titles in a private Matroska file before removing the original", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    const value = await plan(fixture);
    const result = await apply(fixture, value);
    const retained = join(fixture.recordingRoot, RETAINED_AUDIO_FILE);
    const content = await fs.readFile(retained);
    expect((await fs.stat(retained)).mode & 0o777).toBe(0o600);
    expect(result.retainedAudio).toEqual({ path: retained, size: content.length, sha256: sha(content) });
    expect(result.tombstone.audio).toEqual({ fileName: RETAINED_AUDIO_FILE, size: content.length, sha256: sha(content), durationSeconds: 119.98,
      streams: THREE_TRACKS.map((stream, index) => ({ index, ...stream })) });
    expect(await exists(fixture.sourcePath)).toBe(false);
    const ffmpeg = fixture.runner.calls.find((call) => call.command === "ffmpeg")!;
    expect(ffmpeg.args).toEqual(expect.arrayContaining(["-nostdin", "-n", "-i", fixture.sourcePath, "-map", "0:a", "-c", "copy", "-vn", "-map_metadata", "0", "-f", "matroska"]));
    expect(ffmpeg.args[ffmpeg.args.length - 1]).toContain(join(fixture.recordingRoot, ".retained-audio-"));
    expect((await fs.readdir(fixture.recordingRoot)).filter((name) => name.startsWith("."))).toEqual([]);
    expect((await mediaStateOf(fixture.entry)).state).toBe("audio-only");
    const evidence = await resolveMediaEvidence(fixture.job, { needs: "audio" });
    expect(evidence).toMatchObject({ ok: true, kind: "retained-audio", path: retained, mediaSha256: fixture.job.source.sha256 });
  });

  const mismatches: [string, Partial<FakeMedia> | "ffmpeg", string][] = [
    ["a missing stream", { audio: THREE_TRACKS.slice(0, 2) }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["a changed title", { audio: [THREE_TRACKS[0]!, { ...THREE_TRACKS[1]!, title: "Mic" }, THREE_TRACKS[2]!] }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["a dropped title", { audio: [THREE_TRACKS[0]!, { channels: 1, codec: "opus" }, THREE_TRACKS[2]!] }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["reordered streams", { audio: [THREE_TRACKS[0]!, THREE_TRACKS[2]!, THREE_TRACKS[1]!] }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["fewer channels", { audio: [{ ...THREE_TRACKS[0]!, channels: 1 }, THREE_TRACKS[1]!, THREE_TRACKS[2]!] }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["a re-encoded stream", { audio: [{ ...THREE_TRACKS[0]!, codec: "aac" }, THREE_TRACKS[1]!, THREE_TRACKS[2]!] }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["a video stream left in", { video: 1 }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["a much shorter duration", { duration: "60.0" }, MEDIA_RETENTION_MESSAGES.audioMismatch],
    ["an ffmpeg failure", "ffmpeg", MEDIA_RETENTION_MESSAGES.audioFailed]
  ];
  for (const [name, output, message] of mismatches) {
    test(`${name} keeps the original intact`, async () => {
      const fixture = await setup();
      fixture.config.media.retention = "audio-only";
      const value = await plan(fixture);
      const base = { audio: THREE_TRACKS, video: 0, duration: "119.98" };
      fixture.setRunner(output === "ffmpeg" ? fakeRunner({ ffmpegFails: true }) : fakeRunner({ output: { ...base, ...output } }));
      await expect(apply(fixture, value)).rejects.toThrow(message);
      expect(sha(await fs.readFile(fixture.sourcePath))).toBe(fixture.job.source.sha256);
      expect(await exists(join(fixture.recordingRoot, RETAINED_AUDIO_FILE))).toBe(false);
      expect((await fs.readdir(fixture.recordingRoot)).filter((entry) => entry.startsWith(".retained-audio-"))).toEqual([]);
      expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
      expect((await mediaStateOf(fixture.entry)).state).toBe("present");
      expect(await resolveMediaEvidence(fixture.job, { needs: "video" })).toMatchObject({ ok: true, kind: "original" });
    });
  }

  test("after a failed copy the next run retries and finishes", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    fixture.setRunner(fakeRunner({ output: { audio: THREE_TRACKS.slice(0, 1), video: 0, duration: "119.98" } }));
    await expect(apply(fixture, await plan(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.audioMismatch);
    fixture.setRunner(fakeRunner());
    const resumed = await plan(fixture);
    expect(resumed.resume).toBe(true);
    expect((await apply(fixture, resumed)).tombstone.state).toBe("removed");
  });
});

describe("compare-and-swap and refusals", () => {
  test("refuses a plan that is not eligible, with its first reason", async () => {
    const fixture = await setup();
    fixture.setNow(Date.parse(fixture.job.updatedAt));
    const value = await plan(fixture);
    await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.stepsPending);
    expect(await exists(tombstonePathOf(fixture.sourcePath))).toBe(false);
  });

  test("refuses a tampered plan", async () => {
    const fixture = await setup();
    const blocked = { ...(await plan(fixture, { verifyMedia: "never" })), eligible: true };
    await expect(apply(fixture, blocked)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    const eligible = await plan(fixture);
    await expect(apply(fixture, { ...eligible, mode: "audio-only" })).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    await expect(apply(fixture, { ...eligible, sourcePath: join(fixture.recordingsDir, "other.mkv") })).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    expect(sha(await fs.readFile(fixture.sourcePath))).toBe(fixture.job.source.sha256);
  });

  test("refuses when the situation changed after planning", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    await fixture.jobStore.update(other.id, "failed");
    await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    expect(await exists(fixture.sourcePath)).toBe(true);
    expect(await exists(tombstonePathOf(fixture.sourcePath))).toBe(false);
  });

  test("refuses media whose content changed after planning, even with the same size and mtime", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const before = await fs.stat(fixture.sourcePath);
    const content = await fs.readFile(fixture.sourcePath);
    content[0] = content[0]! ^ 0xff;
    await fs.writeFile(fixture.sourcePath, content);
    await fs.utimes(fixture.sourcePath, before.atime, before.mtime);
    await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.mediaHashMismatch);
    expect(await fs.readFile(fixture.sourcePath)).toEqual(content);
  });

  test("refuses a symlink swapped in after planning and leaves its target alone", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const target = join(fixture.root, "kept-original.mkv");
    await fs.rename(fixture.sourcePath, target);
    await fs.symlink(target, fixture.sourcePath);
    await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.mediaUnsafe);
    expect(sha(await fs.readFile(target))).toBe(fixture.job.source.sha256);
    expect((await fs.lstat(fixture.sourcePath)).isSymbolicLink()).toBe(true);
  });

  test("a second concurrent run is refused while the first holds the recording", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const results = await Promise.allSettled([apply(fixture, value), apply(fixture, value)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const failure of rejected) expect((failure.reason as Error).message).toBe(MEDIA_RETENTION_MESSAGES.busy);
    expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removed");
  });

  test("a held recording lease is reported as busy", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const lease = await acquireSingleton(recordingLeaseName(fixture.sourcePath));
    try { await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.busy); }
    finally { await lease.release(); }
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  test("media that share a name stem share the recording folder, so they share one lease", async () => {
    const fixture = await setup();
    const sibling = fixture.sourcePath.replace(/\.mkv$/, ".mp4");
    expect(recordingLeaseName(sibling)).toBe(recordingLeaseName(fixture.sourcePath));
    expect(recordingLeaseName(join(fixture.recordingsDir, "other.mkv"))).not.toBe(recordingLeaseName(fixture.sourcePath));
    const value = await plan(fixture);
    // A removal of the sibling owns the same tombstone, retained audio and temporary files.
    const lease = await acquireSingleton(recordingLeaseName(sibling));
    try { await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.busy); }
    finally { await lease.release(); }
    expect(await exists(tombstonePathOf(fixture.sourcePath))).toBe(false);
    expect(await exists(fixture.sourcePath)).toBe(true);
  });

  test("unexpected failures reach the person as fixed messages, before and after the original is gone", async () => {
    const fixture = await setup();
    class FailingStore extends MediaRetentionStore {
      constructor(readonly failOn: (tombstone: Parameters<MediaRetentionStore["write"]>[0]) => boolean) { super(); }
      override async write(...args: Parameters<MediaRetentionStore["write"]>) {
        if (this.failOn(args[0])) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        return super.write(...args);
      }
    }
    const before = new FailingStore((tombstone) => tombstone.state === "removing");
    await expect(apply(fixture, await plan(fixture), { store: before })).rejects.toThrow(MEDIA_RETENTION_MESSAGES.removeFailed);
    expect(await exists(fixture.sourcePath)).toBe(true);
    const after = new FailingStore((tombstone) => tombstone.state === "removed");
    const error = await apply(fixture, await plan(fixture), { store: after }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaRetentionError);
    expect((error as Error).message).toBe(MEDIA_RETENTION_MESSAGES.purgeFailed);
    expect(await exists(fixture.sourcePath)).toBe(false);
    expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
    expect((await apply(fixture, await plan(fixture))).tombstone.state).toBe("removed");
  });

  test("work that starts before the final check keeps the media; the next run finishes", async () => {
    const fixture = await setup();
    const value = await plan(fixture);
    const lease = await acquireSingleton(`diarization-create-${fixture.job.id}`);
    try { await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.workStarted); }
    finally { await lease.release(); }
    expect(sha(await fs.readFile(fixture.sourcePath))).toBe(fixture.job.source.sha256);
    expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
    const resumed = await plan(fixture);
    expect(resumed.resume).toBe(true);
    expect((await apply(fixture, resumed)).status).toBe("removed");
  });

  test("takes the revision lease of every job before removing", async () => {
    const fixture = await setup();
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    await fixture.jobStore.update(other.id, "failed");
    const leased: string[] = [];
    let removedInsideLease = false;
    const withRevisionLease = async <T>(jobId: string, action: () => Promise<T>): Promise<T> => {
      leased.push(jobId);
      const result = await action();
      removedInsideLease ||= !(await exists(fixture.sourcePath));
      return result;
    };
    await apply(fixture, await plan(fixture), { withRevisionLease });
    expect(leased.sort()).toEqual([fixture.job.id, other.id].sort());
    expect(removedInsideLease).toBe(true);
  });
});

describe("resumable after a crash", () => {
  const crashAt = (step: ApplyStep) => async (current: ApplyStep): Promise<void> => { if (current === step) throw new Error(`crash at ${step}`); };

  for (const step of ["tombstone-removing", "audio-retained"] as const) {
    test(`a crash at ${step} keeps the media and resumes`, async () => {
      const fixture = await setup();
      fixture.config.media.retention = "audio-only";
      await expect(apply(fixture, await plan(fixture), { checkpoint: crashAt(step) })).rejects.toThrow();
      expect(sha(await fs.readFile(fixture.sourcePath))).toBe(fixture.job.source.sha256);
      expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
      expect((await mediaStateOf(fixture.entry)).state).toBe("present");
      const resumed = await plan(fixture);
      expect(resumed).toMatchObject({ action: "remove", resume: true, eligible: true });
      const result = await apply(fixture, resumed);
      expect(result.status).toBe("removed");
      expect(result.tombstone.audio?.sha256).toBe(sha(await fs.readFile(join(fixture.recordingRoot, RETAINED_AUDIO_FILE))));
    });
  }

  for (const step of ["source-removed", "purged"] as const) {
    test(`a crash at ${step} finalizes on the next run without the media`, async () => {
      const fixture = await setup();
      const copies = await writeDerivedCopies(fixture);
      fixture.config.archive.enabled = true;
      fixture.archives.push(archiveRecord(fixture));
      await expect(apply(fixture, await plan(fixture), { checkpoint: crashAt(step) })).rejects.toThrow();
      expect(await exists(fixture.sourcePath)).toBe(false);
      expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
      expect((await mediaStateOf(fixture.entry)).state).toBe("removed");
      const finalize = await plan(fixture);
      expect(finalize).toMatchObject({ action: "finalize", eligible: true, resume: true });
      const result = await apply(fixture, finalize);
      expect(result.status).toBe("removed");
      expect(result.bytesFreed).toBe(0);
      expect(result.tombstone.purged).toEqual(["proton-restore-cache", "visual-frames", "work-temp-audio"]);
      expect(await exists(copies.restored)).toBe(false);
    });
  }

  test("switching from an interrupted audio-only attempt to transcript-only drops the retained copy", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    await expect(apply(fixture, await plan(fixture), { checkpoint: crashAt("audio-retained") })).rejects.toThrow();
    expect(await exists(join(fixture.recordingRoot, RETAINED_AUDIO_FILE))).toBe(true);
    fixture.config.media.retention = "transcript-only";
    const result = await apply(fixture, await plan(fixture));
    expect(result.tombstone.mode).toBe("transcript-only");
    expect(result.tombstone.audio).toBeUndefined();
    expect(await exists(join(fixture.recordingRoot, RETAINED_AUDIO_FILE))).toBe(false);
  });

  test("a finalize refuses an audio-only removal whose retained audio was altered", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    await expect(apply(fixture, await plan(fixture), { checkpoint: crashAt("source-removed") })).rejects.toThrow();
    await fs.appendFile(join(fixture.recordingRoot, RETAINED_AUDIO_FILE), "tampered");
    const finalize = await plan(fixture);
    await expect(apply(fixture, finalize)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.retainedAudioInvalid);
    expect((await store.read(fixture.sourcePath))?.tombstone.state).toBe("removing");
  });

  test("a purge that fails is recorded and retried; nothing outside is followed", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture));
    const copies = await writeDerivedCopies(fixture);
    // The restore cache folder replaced by a symlink to user data must never be followed.
    const userData = join(fixture.root, "user-data");
    await fs.mkdir(join(userData, fixture.archives[0]!.id), { recursive: true });
    await fs.writeFile(join(userData, fixture.archives[0]!.id, "keep.txt"), "precious");
    const restoredRoot = join(fixture.root, "data/media-archive/restored");
    await fs.rm(restoredRoot, { recursive: true });
    await fs.symlink(userData, restoredRoot);

    await expect(apply(fixture, await plan(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.purgeFailed);
    expect(await exists(fixture.sourcePath)).toBe(false);
    const partial = (await store.read(fixture.sourcePath))!.tombstone;
    expect(partial.state).toBe("removing");
    expect(partial.purged).toEqual(["visual-frames", "work-temp-audio"]);
    expect(await fs.readFile(join(userData, fixture.archives[0]!.id, "keep.txt"), "utf8")).toBe("precious");
    expect(await exists(copies.frames)).toBe(false);

    await fs.rm(restoredRoot);
    const result = await apply(fixture, await plan(fixture));
    expect(result.tombstone.state).toBe("removed");
    expect(result.purged).toEqual(["proton-restore-cache", "visual-frames", "work-temp-audio"]);
  });

  test("a visual session that is running blocks its frame purge until it ends", async () => {
    const fixture = await setup();
    const copies = await writeDerivedCopies(fixture);
    const value = await plan(fixture);
    const lease = await acquireSingleton(`visual-session-${sha("visual-session").slice(0, 32)}`);
    try { await expect(apply(fixture, value)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.purgeFailed); }
    finally { await lease.release(); }
    expect(await exists(copies.frames)).toBe(true);
    expect((await apply(fixture, await plan(fixture))).purged).toContain("visual-frames");
    expect(await exists(copies.frames)).toBe(false);
  });
});
