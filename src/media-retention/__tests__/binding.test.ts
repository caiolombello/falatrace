import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveAnalysisMedia } from "../analysis";
import { applyMediaRetention } from "../apply";
import { assertMediaNotRetired, jobMediaTombstone, retiredMediaTombstone } from "../binding";
import { planMediaRetention } from "../plan";
import { MEDIA_RETENTION_MESSAGES, RETAINED_AUDIO_FILE, tombstonePathOf } from "../store";
import { createFixture, sha, writeRemovedTombstone, type Fixture } from "./fixture";

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

describe("retiredMediaTombstone", () => {
  test("only a finished removal of exactly this media, with the file gone, counts", async () => {
    const fixture = await setup();
    expect(await jobMediaTombstone(fixture.job)).toBeUndefined();
    const result = await remove(fixture);
    expect(await jobMediaTombstone(fixture.job)).toEqual(result.tombstone);
    expect(await retiredMediaTombstone(fixture.sourcePath, { size: fixture.job.source.size })).toEqual(result.tombstone);
    expect(await retiredMediaTombstone(fixture.sourcePath, { sha256: sha("other") })).toBeUndefined();
    expect(await retiredMediaTombstone(fixture.sourcePath, { size: 1 })).toBeUndefined();
    expect(await retiredMediaTombstone(fixture.sourcePath, {})).toBeUndefined();
    // A file back at the path is the media again, whatever the tombstone says.
    await fs.writeFile(fixture.sourcePath, "restored");
    expect(await jobMediaTombstone(fixture.job)).toBeUndefined();
  });

  test("an unfinished removal counts only when asked; an invalid tombstone never", async () => {
    const fixture = await setup();
    await writeRemovedTombstone(fixture.job, { state: "removing", removedAt: undefined });
    await fs.rm(fixture.sourcePath);
    expect(await jobMediaTombstone(fixture.job)).toBeUndefined();
    expect((await jobMediaTombstone(fixture.job, { states: ["removing", "removed"] }))?.state).toBe("removing");
    await fs.writeFile(tombstonePathOf(fixture.sourcePath), "{");
    expect(await jobMediaTombstone(fixture.job, { states: ["removing", "removed"] })).toBeUndefined();
  });

  test("reprocessing refuses removed media clearly and leaves missing media to its usual error", async () => {
    const fixture = await setup();
    await assertMediaNotRetired(fixture.job);
    await fs.rm(fixture.sourcePath);
    await assertMediaNotRetired(fixture.job);
    await writeRemovedTombstone(fixture.job, { state: "removing", removedAt: undefined });
    await expect(assertMediaNotRetired(fixture.job)).rejects.toThrow(MEDIA_RETENTION_MESSAGES.reprocessRefused);
  });
});

describe("resolveAnalysisMedia", () => {
  test("present media keeps the existing lookup and the original identity", async () => {
    const fixture = await setup();
    let lookups = 0;
    const media = await resolveAnalysisMedia(fixture.job, { original: async () => { lookups += 1; return fixture.sourcePath; } });
    expect(media).toEqual({ path: fixture.sourcePath, kind: "original", size: fixture.job.source.size, sha256: fixture.job.source.sha256 });
    expect(lookups).toBe(1);
  });

  test("audio-only serves the retained audio bound through the tombstone, without the archive lookup", async () => {
    const fixture = await setup();
    const result = await remove(fixture, "audio-only");
    let lookups = 0;
    const media = await resolveAnalysisMedia(fixture.job, { original: async () => { lookups += 1; throw new Error("no copy"); } });
    const retained = join(fixture.recordingRoot, RETAINED_AUDIO_FILE);
    expect(media).toEqual({ path: retained, kind: "retained-audio", size: result.tombstone.audio!.size, sha256: sha(await fs.readFile(retained)) });
    expect(lookups).toBe(0);
  });

  test("transcript-only uses a verified copy elsewhere when there is one, otherwise refuses with the retention message", async () => {
    const fixture = await setup();
    await remove(fixture);
    const copy = join(fixture.root, "vaio-copy.mkv");
    expect(await resolveAnalysisMedia(fixture.job, { original: async () => copy })).toMatchObject({ path: copy, kind: "original", sha256: fixture.job.source.sha256 });
    await expect(resolveAnalysisMedia(fixture.job, { original: async () => { throw new Error("Esta gravação não possui uma cópia concluída no vaio."); } }))
      .rejects.toThrow(MEDIA_RETENTION_MESSAGES.evidenceRemoved);
  });

  test("missing media without a tombstone keeps the lookup's own error", async () => {
    const fixture = await setup();
    await fs.rm(fixture.sourcePath);
    await expect(resolveAnalysisMedia(fixture.job, { original: async () => { throw new Error("A gravação não está disponível na biblioteca"); } }))
      .rejects.toThrow("A gravação não está disponível na biblioteca");
  });
});
