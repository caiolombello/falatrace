import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { planMediaRemoval, removeMediaNow, type MediaRemovalDeps } from "../manual";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionStore, RETAINED_AUDIO_FILE } from "../store";
import { DAY, createFixture, jobRecordRaw, sha, type Fixture } from "./fixture";

const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });
const setup = async (options: Parameters<typeof createFixture>[0] = {}): Promise<Fixture> => {
  const fixture = await createFixture(options);
  fixtures.push(fixture);
  return fixture;
};
const depsOf = (fixture: Fixture): MediaRemovalDeps => ({ ...fixture.deps, config: fixture.config });

describe("planMediaRemoval", () => {
  test("offers both modes with one hash of the media and a consent key, writing nothing", async () => {
    const fixture = await setup();
    let hashed = 0;
    fixture.deps.hashFile = async (path) => { hashed += 1; return sha(await fs.readFile(path)); };
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    expect(hashed).toBe(1);
    expect(plan).toMatchObject({ key: fixture.sourcePath, eligible: true, reasons: [], scope: "total", legacyTranscript: false });
    expect(plan.options).toEqual([
      { mode: "transcript-only", eligible: true, bytesFreed: fixture.job.source.size, reasons: [], blockers: [] },
      { mode: "audio-only", eligible: true, bytesFreed: null, reasons: [], blockers: [] }
    ]);
    expect(plan.consentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await new MediaRetentionStore().read(fixture.sourcePath)).toBeNull();
    expect((await fs.stat(fixture.sourcePath)).isFile()).toBe(true);
    // The same state gives the same key; a manual plan ignores the automatic policy and its grace period.
    fixture.config.media.retention = "keep";
    fixture.setNow(Date.parse(fixture.job.updatedAt) + DAY / 4);
    expect((await planMediaRemoval(fixture.entry, depsOf(fixture))).consentKey).toBe(plan.consentKey);
  });

  test("explains what blocks every option", async () => {
    const fixture = await setup();
    fixture.setSession({ outputPath: fixture.sourcePath, phase: "recording" } as never);
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    expect(plan.eligible).toBe(false);
    expect(plan.reasons).toEqual([MEDIA_RETENTION_MESSAGES.captureActive]);
    expect(plan.options.map((option) => option.blockers)).toEqual([["capture-active"], ["capture-active"]]);
  });

  test("audio-only is refused for media without video, transcript-only stays possible", async () => {
    const fixture = await setup();
    const { fakeRunner, THREE_TRACKS } = await import("./fixture");
    fixture.setRunner(fakeRunner({ source: { audio: THREE_TRACKS, video: 0, duration: "120.000000" } }));
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    expect(plan.eligible).toBe(true);
    expect(plan.options[1]).toMatchObject({ mode: "audio-only", eligible: false, blockers: ["no-video"], reasons: [MEDIA_RETENTION_MESSAGES.noVideo] });
  });

  test("a transcript without a receipt is eligible only for this explicit action, and says so", async () => {
    const fixture = await setup({ receipt: false });
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    expect(plan).toMatchObject({ eligible: true, legacyTranscript: true });
  });
});

describe("removeMediaNow", () => {
  test("removes with the consent key, keeps the job record and records a manual removal", async () => {
    const fixture = await setup();
    const before = await jobRecordRaw(fixture);
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    const result = await removeMediaNow(fixture.entry, "transcript-only", plan.consentKey, depsOf(fixture));
    expect(result).toMatchObject({ status: "removed", mode: "transcript-only", bytesFreed: fixture.job.source.size });
    expect(result.tombstone).toMatchObject({ state: "removed", reason: "manual", mode: "transcript-only" });
    expect(await fs.stat(fixture.sourcePath).catch(() => null)).toBeNull();
    expect(await jobRecordRaw(fixture)).toBe(before);
    const again = await planMediaRemoval(fixture.entry, depsOf(fixture));
    expect(again).toMatchObject({ eligible: false, reasons: [MEDIA_RETENTION_MESSAGES.alreadyRemoved] });
  });

  test("audio-only keeps the retained audio", async () => {
    const fixture = await setup();
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    const result = await removeMediaNow(fixture.entry, "audio-only", plan.consentKey, depsOf(fixture));
    expect(result.mode).toBe("audio-only");
    expect((await fs.stat(join(fixture.recordingRoot, RETAINED_AUDIO_FILE))).isFile()).toBe(true);
  });

  test("refuses a stale key, a changed recording, an unknown mode and a missing key without touching the media", async () => {
    const fixture = await setup();
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    await expect(removeMediaNow(fixture.entry, "transcript-only", sha("other"), depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    await expect(removeMediaNow(fixture.entry, "keep" as never, plan.consentKey, depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.modeInvalid);
    await expect(removeMediaNow(fixture.entry, "transcript-only", "", depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.consentRequired);
    // A capture starting after the plan changes what the person approved.
    fixture.setSession({ outputPath: fixture.sourcePath, phase: "recording" } as never);
    await expect(removeMediaNow(fixture.entry, "transcript-only", plan.consentKey, depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    fixture.setSession(null);
    await fs.appendFile(fixture.sourcePath, "x");
    await expect(removeMediaNow(fixture.entry, "transcript-only", plan.consentKey, depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.planChanged);
    expect((await fs.stat(fixture.sourcePath)).isFile()).toBe(true);
    expect(await new MediaRetentionStore().read(fixture.sourcePath)).toBeNull();
  });

  test("an ineligible option is refused with its reason", async () => {
    const fixture = await setup();
    const { fakeRunner, THREE_TRACKS } = await import("./fixture");
    fixture.setRunner(fakeRunner({ source: { audio: THREE_TRACKS, video: 0, duration: "120.000000" } }));
    const plan = await planMediaRemoval(fixture.entry, depsOf(fixture));
    await expect(removeMediaNow(fixture.entry, "audio-only", plan.consentKey, depsOf(fixture))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.noVideo);
    expect((await fs.stat(fixture.sourcePath)).isFile()).toBe(true);
  });
});
