import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { applyMediaRetention } from "../apply";
import { requireMediaEvidence, resolveMediaEvidence } from "../evidence";
import { planMediaRetention } from "../plan";
import { mediaStateOf } from "../state";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionStore, RETAINED_AUDIO_FILE, tombstonePathOf } from "../store";
import { archiveRecord, createFixture, sha, type Fixture } from "./fixture";

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

describe("resolveMediaEvidence", () => {
  test("returns the original while it is present and unchanged", async () => {
    const fixture = await setup();
    for (const needs of ["audio", "video"] as const) {
      expect(await resolveMediaEvidence(fixture.job, { needs, config: fixture.config })).toEqual({ ok: true, kind: "original", path: fixture.sourcePath, mediaSha256: fixture.job.source.sha256 });
    }
  });

  test("refuses a changed original instead of falling back to the tombstone", async () => {
    const fixture = await setup();
    const content = await fs.readFile(fixture.sourcePath);
    content[3] = content[3]! ^ 0xff;
    await fs.writeFile(fixture.sourcePath, content);
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toEqual({ ok: false, reason: "changed", message: MEDIA_RETENTION_MESSAGES.evidenceChanged });
    expect((await resolveMediaEvidence(fixture.job, { needs: "audio", verifyHash: false })).ok).toBe(true);
    await fs.appendFile(fixture.sourcePath, "x");
    expect((await resolveMediaEvidence(fixture.job, { needs: "audio", verifyHash: false })).ok).toBe(false);
  });

  test("refuses a symlinked original and one outside the recordings folder", async () => {
    const fixture = await setup();
    const outside = await setup();
    outside.config.recordingsDir = join(outside.root, "elsewhere");
    await fs.mkdir(outside.config.recordingsDir);
    expect(await resolveMediaEvidence(outside.job, { needs: "audio", config: outside.config })).toMatchObject({ ok: false, reason: "changed" });
    const target = join(fixture.root, "target.mkv");
    await fs.rename(fixture.sourcePath, target);
    await fs.symlink(target, fixture.sourcePath);
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toMatchObject({ ok: false, reason: "changed" });
  });

  test("missing media without a tombstone is a plain refusal", async () => {
    const fixture = await setup();
    await fs.rm(fixture.sourcePath);
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toEqual({ ok: false, reason: "missing", message: MEDIA_RETENTION_MESSAGES.mediaMissing });
    await expect(requireMediaEvidence(fixture.job, { needs: "audio" })).rejects.toThrow(MEDIA_RETENTION_MESSAGES.mediaMissing);
  });

  test("transcript-only: every media need is refused with the retention message", async () => {
    const fixture = await setup();
    await remove(fixture);
    for (const needs of ["audio", "video"] as const) {
      expect(await resolveMediaEvidence(fixture.job, { needs })).toEqual({ ok: false, reason: "removed-by-retention", message: MEDIA_RETENTION_MESSAGES.evidenceRemoved, mode: "transcript-only" });
    }
  });

  test("audio-only: audio comes from the retained file bound to the original hash; video is refused", async () => {
    const fixture = await setup();
    await remove(fixture, "audio-only");
    const retained = join(fixture.recordingRoot, RETAINED_AUDIO_FILE);
    const evidence = await requireMediaEvidence(fixture.job, { needs: "audio" });
    expect(evidence).toMatchObject({ kind: "retained-audio", path: retained, mediaSha256: fixture.job.source.sha256, audioSha256: sha(await fs.readFile(retained)), durationSeconds: 119.98 });
    expect(await resolveMediaEvidence(fixture.job, { needs: "video" })).toMatchObject({ ok: false, reason: "video-removed", message: MEDIA_RETENTION_MESSAGES.evidenceVideoRemoved });
  });

  test("audio-only: an altered or replaced retained file is refused", async () => {
    const fixture = await setup();
    await remove(fixture, "audio-only");
    const retained = join(fixture.recordingRoot, RETAINED_AUDIO_FILE);
    const original = await fs.readFile(retained);
    const flipped = Buffer.from(original);
    flipped[0] = flipped[0]! ^ 0xff;
    await fs.writeFile(retained, flipped);
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toMatchObject({ ok: false, reason: "retained-audio-invalid" });
    await fs.rm(retained);
    await fs.writeFile(join(fixture.root, "decoy.mka"), original);
    await fs.symlink(join(fixture.root, "decoy.mka"), retained);
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toMatchObject({ ok: false, reason: "retained-audio-invalid" });
  });

  test("a tombstone for other media or an invalid one is never trusted", async () => {
    const fixture = await setup();
    await remove(fixture);
    expect(await resolveMediaEvidence({ ...fixture.job, source: { ...fixture.job.source, sha256: sha("other") } }, { needs: "audio" }))
      .toMatchObject({ ok: false, reason: "changed" });
    await fs.writeFile(tombstonePathOf(fixture.sourcePath), "{\"version\":1}");
    expect(await resolveMediaEvidence(fixture.job, { needs: "audio" })).toEqual({ ok: false, reason: "tombstone-invalid", message: MEDIA_RETENTION_MESSAGES.tombstoneInvalid });
  });
});

describe("mediaStateOf", () => {
  test("present media keeps every feature", async () => {
    const fixture = await setup();
    expect(await mediaStateOf(fixture.entry)).toEqual({ state: "present", copies: { vaio: false, proton: false },
      features: { playback: true, frames: true, diarize: true, speakersMic: true, voices: true, subtitles: true, reprocess: true } });
  });

  test("transcript-only without copies elsewhere disables media features", async () => {
    const fixture = await setup();
    const result = await remove(fixture);
    expect(await mediaStateOf(fixture.entry)).toEqual({ state: "removed", removedAt: result.tombstone.removedAt, reason: "policy", mode: "transcript-only",
      copies: { vaio: false, proton: false },
      features: { playback: false, frames: false, diarize: false, speakersMic: false, voices: false, subtitles: false, reprocess: false } });
  });

  test("verified archive copies keep playback and speaker work, never frames or reprocessing", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.config.archive.proton = false;
    fixture.archives.push(archiveRecord(fixture, { proton: { state: "pending" } }));
    await remove(fixture);
    const state = await mediaStateOf({ sourcePath: fixture.sourcePath, jobs: [fixture.job] });
    expect(state.copies).toEqual({ vaio: true, proton: false });
    expect(state.features).toEqual({ playback: true, frames: false, diarize: true, speakersMic: true, voices: true, subtitles: true, reprocess: false });
  });

  test("audio-only keeps playback and speaker work; a vanished retained file reads as removed", async () => {
    const fixture = await setup();
    await remove(fixture, "audio-only");
    const state = await mediaStateOf(fixture.entry);
    expect(state.state).toBe("audio-only");
    expect(state.features).toEqual({ playback: true, frames: false, diarize: true, speakersMic: true, voices: true, subtitles: false, reprocess: false });
    await fs.rm(join(fixture.recordingRoot, RETAINED_AUDIO_FILE));
    expect((await mediaStateOf(fixture.entry)).state).toBe("removed");
  });

  test("missing media without a valid, matching tombstone is missing", async () => {
    const fixture = await setup();
    await fs.rm(fixture.sourcePath);
    expect((await mediaStateOf(fixture.entry)).state).toBe("missing");
    const archived = await mediaStateOf({ ...fixture.entry, archive: archiveRecord(fixture) });
    expect(archived).toMatchObject({ state: "missing", copies: { vaio: true, proton: true } });
    expect(archived.features.playback).toBe(true);
    expect(archived.features.frames).toBe(false);
    await fs.writeFile(tombstonePathOf(fixture.sourcePath), "garbage");
    expect((await mediaStateOf(fixture.entry)).state).toBe("missing");
  });

  test("a tombstone that names other media is ignored", async () => {
    const fixture = await setup();
    await remove(fixture);
    const state = await mediaStateOf({ sourcePath: fixture.sourcePath, jobs: [{ source: { ...fixture.job.source, sha256: sha("other") } }] });
    expect(state.state).toBe("missing");
  });

  test("an unfinished removal with the media gone already reads as removed", async () => {
    const fixture = await setup();
    const store = new MediaRetentionStore();
    await store.write({ version: 1, sourcePath: fixture.sourcePath, source: { fileName: fixture.sourcePath.split("/").pop()!, size: fixture.job.source.size, sha256: fixture.job.source.sha256, mtimeMs: 1 },
      jobs: [fixture.job.id], mode: "transcript-only", reason: "manual", state: "removing", startedAt: "2026-10-02T10:00:00.000Z",
      verified: { jobId: fixture.job.id, receipt: "verified", transcriptArtifactSha256: sha("t"), receiptSha256: sha("r"), microphone: "skipped", voices: "skipped", backups: {} }, purged: [] }, null);
    expect((await mediaStateOf(fixture.entry)).state).toBe("present");
    await fs.rm(fixture.sourcePath);
    expect(await mediaStateOf(fixture.entry)).toMatchObject({ state: "removed", removedAt: "2026-10-02T10:00:00.000Z", reason: "manual" });
  });
});
