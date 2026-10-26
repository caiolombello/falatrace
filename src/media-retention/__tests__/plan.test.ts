import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DiarizationStore } from "../../diarization/store";
import { acquireSingleton } from "../../runtime/singleton";
import { SpeakerSuggestionStore } from "../../speakers/store";
import { reviewedSummaryLeaseName } from "../../summary/reviewed";
import { type MediaRetentionBlockerCode, type MediaRetentionPlan, defaultLeaseHeld, diarizationUnitName, planMediaRetention, processLeaseName, speakersUnitName } from "../plan";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionStore, serializeTombstone, tombstonePathOf } from "../store";
import { DAY, THREE_TRACKS, archiveRecord, createFixture, fakeRunner, sha, treeHashes, writeDerivedCopies, writeSpeakerWork, type Fixture } from "./fixture";

const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });
const setup = async (options?: Parameters<typeof createFixture>[0]): Promise<Fixture> => {
  const fixture = await createFixture(options);
  fixtures.push(fixture);
  return fixture;
};
const plan = (fixture: Fixture, options: Parameters<typeof planMediaRetention>[2] = {}): Promise<MediaRetentionPlan> =>
  planMediaRetention(fixture.config, fixture.entry, { deps: fixture.deps, ...options });
const codes = (value: MediaRetentionPlan): MediaRetentionBlockerCode[] => value.blockers.map((blocker) => blocker.code);
/** The condition alone blocks: the plan has exactly this blocker. */
const blockedOnlyBy = async (fixture: Fixture, code: MediaRetentionBlockerCode, options?: Parameters<typeof planMediaRetention>[2]): Promise<MediaRetentionPlan> => {
  const value = await plan(fixture, options);
  expect(codes(value)).toEqual([code]);
  expect(value.eligible).toBe(false);
  return value;
};

describe("eligible recording", () => {
  test("verifies everything, records the evidence and writes nothing", async () => {
    const fixture = await setup();
    const before = await treeHashes(fixture.root);
    const value = await plan(fixture);
    expect(value.blockers).toEqual([]);
    expect(value.eligible).toBe(true);
    expect(value.action).toBe("remove");
    expect(value.mode).toBe("transcript-only");
    expect(value.media).toMatchObject({ exists: true, verified: true, sha256: fixture.job.source.sha256, size: fixture.job.source.size });
    expect(value.verified).toMatchObject({ jobId: fixture.job.id, receipt: "verified", transcriptArtifactSha256: sha(fixture.transcriptRaw), microphone: "skipped", voices: "skipped" });
    expect(value.verified?.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.verified?.summarySha256).toBe(sha(await fs.readFile(join(fixture.job.artifactDir, "summary.json"))));
    expect(value.steps).toEqual({ diarization: "skipped", microphone: "skipped", voices: "not-applicable" });
    expect(value.scope).toMatchObject({ copiesElsewhere: "total", remoteCopies: "preserved-not-contacted", jobRecords: "preserved", artifacts: "preserved", trash: "not-used" });
    expect(value.purge.workDirs).toEqual([fixture.jobStore.getWorkDir(fixture.job.id)]);
    expect(await treeHashes(fixture.root)).toEqual(before);
  });

  test("the digest is stable across plans and ignores only the planning time", async () => {
    const fixture = await setup();
    const first = await plan(fixture);
    fixture.setNow(fixture.now + 60_000);
    const second = await plan(fixture);
    expect(second.plannedAt).not.toBe(first.plannedAt);
    expect(second.digest).toBe(first.digest);
    await fs.utimes(fixture.sourcePath, new Date(), new Date());
    expect((await plan(fixture)).digest).not.toBe(first.digest);
  });

  test("mode keep plans nothing", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "keep";
    const value = await blockedOnlyBy(fixture, "mode-keep");
    expect(value.action).toBe("none");
    expect(value.blockers[0]?.message).toBe(MEDIA_RETENTION_MESSAGES.modeKeep);
  });

  test("an explicit mode overrides the configured policy", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "keep";
    expect((await plan(fixture, { mode: "transcript-only", reason: "manual" })).eligible).toBe(true);
  });
});

describe("1. jobs settled", () => {
  test("no job for the media", async () => {
    const fixture = await setup();
    await fixture.jobStore.remove(fixture.job.id);
    await blockedOnlyBy(fixture, "no-jobs");
  });

  for (const state of ["pending", "transferring", "queued", "processing"] as const) {
    test(`a ${state} job blocks`, async () => {
      const fixture = await setup();
      const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
      if (state !== "pending") await fixture.jobStore.update(other.id, state);
      const value = await plan(fixture);
      expect(value.blockers).toEqual([{ code: "job-not-settled", message: MEDIA_RETENTION_MESSAGES.jobNotSettled, jobId: other.id }]);
    });
  }

  test("a failed job is settled", async () => {
    const fixture = await setup();
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    await fixture.jobStore.update(other.id, "failed", { error: "boom" });
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.jobs.map((job) => job.id).sort()).toEqual([fixture.job.id, other.id].sort());
  });

  test("a job record that cannot be read blocks", async () => {
    const fixture = await setup();
    await fs.writeFile(join(fixture.root, "state/jobs", "33333333-3333-4333-8333-333333333333.json"), "{broken");
    await blockedOnlyBy(fixture, "jobs-unreadable");
  });

  test("jobs that disagree about the media identity block", async () => {
    const fixture = await setup();
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    await fixture.jobStore.update(other.id, "failed");
    const path = join(fixture.root, "state/jobs", `${other.id}.json`);
    const record = JSON.parse(await fs.readFile(path, "utf8"));
    record.source.sha256 = sha("older media");
    await fs.writeFile(path, JSON.stringify(record));
    await blockedOnlyBy(fixture, "media-identity-conflict");
  });

  test("a job whose artifact folder is outside the recording folder blocks", async () => {
    const fixture = await setup();
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    await fixture.jobStore.update(other.id, "failed");
    const path = join(fixture.root, "state/jobs", `${other.id}.json`);
    const record = JSON.parse(await fs.readFile(path, "utf8"));
    record.artifactDir = join(fixture.root, "elsewhere", other.id);
    await fs.writeFile(path, JSON.stringify(record));
    await blockedOnlyBy(fixture, "recording-root-unsafe");
  });

  test("a job being queued or processed blocks even before its state changes", async () => {
    const fixture = await setup();
    fixture.held.add(`job-queue-${fixture.job.id}`);
    await blockedOnlyBy(fixture, "job-not-settled");
    fixture.held.clear();
    fixture.held.add(processLeaseName(fixture.jobStore, fixture.job.id));
    await blockedOnlyBy(fixture, "job-not-settled");
  });
});

describe("2. no capture or in-flight media work", () => {
  const session = (fixture: Fixture, phase: "starting" | "recording" | "stopped") => ({
    version: 1 as const, id: "44444444-4444-4444-8444-444444444444", owner: "manual" as const, backend: "audio" as const, phase,
    outputPath: fixture.sourcePath, startedAt: "2026-10-01T10:00:00.000Z"
  });

  test("an active capture of this file blocks; a stopped one or another file does not", async () => {
    const fixture = await setup();
    fixture.setSession(session(fixture, "recording"));
    await blockedOnlyBy(fixture, "capture-active");
    fixture.setSession(session(fixture, "starting"));
    await blockedOnlyBy(fixture, "capture-active");
    fixture.setSession(session(fixture, "stopped"));
    expect((await plan(fixture)).eligible).toBe(true);
    fixture.setSession({ ...session(fixture, "recording"), outputPath: join(fixture.recordingsDir, "other.mkv") });
    expect((await plan(fixture)).eligible).toBe(true);
  });

  test("an unreadable capture state blocks", async () => {
    const fixture = await setup();
    fixture.failSessions();
    await blockedOnlyBy(fixture, "capture-unreadable");
  });

  test("a diarization in progress blocks (lease or active unit); a stale operation does not", async () => {
    const fixture = await setup();
    fixture.held.add(`diarization-create-${fixture.job.id}`);
    await blockedOnlyBy(fixture, "diarization-running");
    fixture.held.clear();
    fixture.held.add(`diarization-queue-${fixture.job.id}`);
    await blockedOnlyBy(fixture, "diarization-running");
    fixture.held.clear();
    const store = new DiarizationStore(join(fixture.root, "data/diarization"));
    await store.writeOperation({ version: 1, jobId: fixture.job.id, state: "running", startedAt: "2026-10-01T10:00:00.000Z" });
    expect((await plan(fixture)).eligible).toBe(true);
    fixture.unitsActive.add(diarizationUnitName(fixture.job.id));
    await blockedOnlyBy(fixture, "diarization-running");
  });

  test("speaker suggestions in progress block", async () => {
    const fixture = await setup();
    fixture.held.add(`speakers-${fixture.job.id}`);
    await blockedOnlyBy(fixture, "speakers-running");
    fixture.held.clear();
    const store = new SpeakerSuggestionStore(new DiarizationStore(join(fixture.root, "data/diarization")));
    await store.writeOperation({ version: 1, jobId: fixture.job.id, state: "running", startedAt: "2026-10-01T10:00:00.000Z", conversation: false });
    expect((await plan(fixture)).eligible).toBe(true);
    fixture.unitsActive.add(speakersUnitName(fixture.job.id));
    await blockedOnlyBy(fixture, "speakers-running");
  });

  test("a running reviewed summary blocks; an unreadable index blocks too", async () => {
    const fixture = await setup();
    const index = join(fixture.root, "data/reviewed-summaries", fixture.job.id, "index.json");
    await fs.mkdir(join(index, ".."), { recursive: true, mode: 0o700 });
    await fs.writeFile(index, JSON.stringify({ version: 1, jobId: fixture.job.id, sequence: 0, requests: [{ requestId: "r1", planSha256: sha("p"), status: "running", requestsSpent: 1 }] }));
    fixture.held.add(reviewedSummaryLeaseName(join(fixture.root, "data/reviewed-summaries"), fixture.job.id, "r1"));
    await blockedOnlyBy(fixture, "summary-running");
    // A failed, abandoned or crashed regeneration leaves "running" behind without its request lease: no live work.
    fixture.held.clear();
    expect((await plan(fixture)).eligible).toBe(true);
    expect((await plan(fixture, { reason: "manual" })).eligible).toBe(true);
    await fs.writeFile(index, JSON.stringify({ version: 1, jobId: fixture.job.id, sequence: 0, requests: [{ requestId: "../r1", planSha256: sha("p"), status: "running", requestsSpent: 1 }] }));
    await blockedOnlyBy(fixture, "summary-state-unreadable");
    await fs.writeFile(index, JSON.stringify({ version: 1, jobId: fixture.job.id, sequence: 0, requests: [{ requestId: "r1", planSha256: sha("p"), status: "cancelled", requestsSpent: 1 }] }));
    expect((await plan(fixture)).eligible).toBe(true);
    await fs.writeFile(index, "{broken");
    await blockedOnlyBy(fixture, "summary-state-unreadable");
  });

  test("a visual session on this media blocks while its lease is held; other media does not", async () => {
    const fixture = await setup();
    await writeDerivedCopies(fixture);
    fixture.held.add(`visual-session-${sha("other-session").slice(0, 32)}`);
    expect((await plan(fixture)).eligible).toBe(true);
    fixture.held.add(`visual-session-${sha("visual-session").slice(0, 32)}`);
    await blockedOnlyBy(fixture, "visual-running");
  });

  test("the default lease probe sees a real holder without taking the lease", async () => {
    const fixture = await setup();
    const name = `diarization-create-${fixture.job.id}`;
    expect(await defaultLeaseHeld(name)).toBe(false);
    const lease = await acquireSingleton(name);
    try {
      expect(await defaultLeaseHeld(name)).toBe(true);
      const { leaseHeld: _fake, ...deps } = fixture.deps;
      const value = await planMediaRetention(fixture.config, fixture.entry, { deps });
      expect(codes(value)).toEqual(["diarization-running"]);
    } finally { await lease.release(); }
    expect(await defaultLeaseHeld(name)).toBe(false);
  });
});

describe("3–4. verified transcript and summary", () => {
  test("no transcript blocks", async () => {
    const fixture = await setup();
    await fs.rm(join(fixture.job.artifactDir, "transcript.json"));
    await blockedOnlyBy(fixture, "transcript-missing");
  });

  test("an empty transcript blocks", async () => {
    const fixture = await setup({ transcriptText: "" });
    await blockedOnlyBy(fixture, "transcript-missing");
  });

  test("a receipt that does not match the transcript blocks", async () => {
    const fixture = await setup();
    await fs.writeFile(join(fixture.job.artifactDir, "transcript-receipt.json"), JSON.stringify({ version: 1, identity: sha("x"), transcriptSha256: sha(fixture.transcriptRaw) }));
    await blockedOnlyBy(fixture, "transcript-missing");
  });

  test("a transcript without a receipt is not eligible for the policy, only for a confirmed manual removal", async () => {
    const fixture = await setup({ receipt: false });
    await blockedOnlyBy(fixture, "transcript-legacy");
    await blockedOnlyBy(fixture, "transcript-legacy", { reason: "manual" });
    await blockedOnlyBy(fixture, "transcript-legacy", { reason: "policy", allowLegacyTranscript: true });
    const manual = await plan(fixture, { reason: "manual", allowLegacyTranscript: true });
    expect(manual.eligible).toBe(true);
    expect(manual.verified).toMatchObject({ receipt: "legacy-unverified" });
    expect(manual.verified?.receiptSha256).toBeUndefined();
  });

  test("a transcript only in the work folder does not qualify", async () => {
    const fixture = await setup();
    const deps = { ...fixture.deps, readTranscript: async () => ({ transcript: fixture.transcript, raw: fixture.transcriptRaw, path: "/work/transcript.json",
      provenance: { origin: "work" as const, receipt: "verified" as const, mediaSha256: fixture.job.source.sha256, transcriptSha256: sha(fixture.transcriptRaw), receiptSha256: sha("r") } }) };
    const value = await planMediaRetention(fixture.config, fixture.entry, { deps });
    expect(codes(value)).toEqual(["transcript-missing"]);
  });

  test("a summary that does not match the transcript blocks; a missing summary does not", async () => {
    const stale = await setup({ summary: "stale" });
    await blockedOnlyBy(stale, "summary-invalid");
    const none = await setup({ summary: "none" });
    const value = await plan(none);
    expect(value.eligible).toBe(true);
    expect(value.verified?.summarySha256).toBeUndefined();
  });
});

describe("5. media-derived steps and the grace period", () => {
  test("within the grace period pending speaker work waits, then is recorded as skipped", async () => {
    const fixture = await setup();
    fixture.setNow(Date.parse(fixture.job.updatedAt) + DAY / 2);
    const waiting = await blockedOnlyBy(fixture, "steps-pending");
    expect(waiting.waitUntil).toBe(new Date(Date.parse(fixture.job.updatedAt) + DAY).toISOString());
    expect(waiting.steps).toEqual({ diarization: "pending", microphone: "pending", voices: "not-applicable" });
    fixture.setNow(Date.parse(fixture.job.updatedAt) + DAY);
    const due = await plan(fixture);
    expect(due.eligible).toBe(true);
    expect(due.waitUntil).toBeUndefined();
    expect(due.steps).toEqual({ diarization: "skipped", microphone: "skipped", voices: "not-applicable" });
  });

  test("grace days 0 removes as soon as everything else holds", async () => {
    const fixture = await setup();
    fixture.config.media.graceDays = 0;
    fixture.setNow(Date.parse(fixture.job.updatedAt));
    expect((await plan(fixture)).eligible).toBe(true);
  });

  test("finished speaker work needs no wait and is recorded", async () => {
    const fixture = await setup();
    const diarizationSha256 = await writeSpeakerWork(fixture, "ready");
    fixture.setNow(Date.parse(fixture.job.updatedAt) + 60_000);
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.steps).toEqual({ diarization: "ready", microphone: "ready", voices: "not-applicable" });
    expect(value.verified).toMatchObject({ diarizationSha256, microphone: "ready", voices: "skipped" });
  });

  test("a failed microphone analysis is final; a missing one waits", async () => {
    const failed = await setup();
    await writeSpeakerWork(failed, "failed");
    failed.setNow(Date.parse(failed.job.updatedAt) + 60_000);
    const value = await plan(failed);
    expect(value.eligible).toBe(true);
    expect(value.verified?.microphone).toBe("failed");
    const none = await setup();
    await writeSpeakerWork(none, "none");
    none.setNow(Date.parse(none.job.updatedAt) + 60_000);
    expect(codes(await plan(none))).toEqual(["steps-pending"]);
  });

  test("voice learning waits only when it is on and the model is installed", async () => {
    const fixture = await setup();
    await writeSpeakerWork(fixture, "ready");
    fixture.setNow(Date.parse(fixture.job.updatedAt) + 60_000);
    fixture.config.speakers.voices = true;
    expect((await plan(fixture)).steps.voices).toBe("not-applicable");
    fixture.setVoiceInstalled(true);
    const waiting = await blockedOnlyBy(fixture, "steps-pending");
    expect(waiting.steps.voices).toBe("pending");
  });

  test("a manual removal does not wait for the grace period", async () => {
    const fixture = await setup();
    fixture.setNow(Date.parse(fixture.job.updatedAt) + 60_000);
    await blockedOnlyBy(fixture, "steps-pending");
    const manual = await plan(fixture, { reason: "manual" });
    expect(manual.eligible).toBe(true);
    expect(manual.steps.diarization).toBe("skipped");
  });

  test("the grace period counts from the most recently settled job", async () => {
    const fixture = await setup();
    const other = await fixture.jobStore.enqueue(fixture.config, fixture.sourcePath);
    const failed = await fixture.jobStore.update(other.id, "failed");
    fixture.setNow(Date.parse(failed.updatedAt) + DAY - 1);
    await blockedOnlyBy(fixture, "steps-pending");
  });
});

describe("6. backups", () => {
  test("with the archive on, every configured target must be complete", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture, { vaio: { state: "pending" } }));
    const pending = await blockedOnlyBy(fixture, "backup-pending");
    expect(pending.backups.archive).toBe("pending");
    fixture.archives[0] = archiveRecord(fixture, { proton: { state: "failed", error: "x", attemptedAt: "2026-10-01T12:00:00.000Z" } });
    await blockedOnlyBy(fixture, "backup-pending");
    fixture.config.archive.proton = false;
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.backups).toMatchObject({ archive: "completed", vaio: "2026-10-01T11:00:00.000Z" });
    expect(value.backups.proton).toBeUndefined();
    expect(value.scope.copiesElsewhere).toBe("local-only");
    expect(value.purge.protonRestoreCache).toBe(join(fixture.root, "data/media-archive/restored", fixture.archives[0]!.id));
  });

  test("completed copies make the removal local only", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture));
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.verified?.backups).toEqual({ vaio: "2026-10-01T11:00:00.000Z", proton: "2026-10-01T12:00:00.000Z" });
  });

  test("a backup of different media blocks", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture, { source: { fileName: "source.mkv", size: fixture.job.source.size, mtimeMs: 1, sha256: sha("other") } }));
    const value = await plan(fixture);
    expect(codes(value).sort()).toEqual(["backup-mismatch", "backup-pending"]);
  });

  test("with the archive on, the catalog decides even when the caller's entry says the copies are done", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    // A stale snapshot in the entry must not stand in for the catalog, in the plan or in the executor's re-plan.
    fixture.entry.archive = archiveRecord(fixture);
    fixture.archives.push(archiveRecord(fixture, { vaio: { state: "pending" } }));
    const value = await blockedOnlyBy(fixture, "backup-pending");
    expect(value.backups.archive).toBe("pending");
    fixture.archives.length = 0;
    // No catalog record: the snapshot does not invent verified copies either.
    await blockedOnlyBy(fixture, "backup-unregistered");
    const total = await plan(fixture, { reason: "manual" });
    expect(total.eligible).toBe(true);
    expect(total.verified?.backups).toEqual({});
    expect(total.scope.copiesElsewhere).toBe("total");
  });

  test("with the archive on, the policy never removes media the catalog never registered; a manual removal shows it as total", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    const policy = await blockedOnlyBy(fixture, "backup-unregistered");
    expect(policy.blockers[0]?.message).toBe(MEDIA_RETENTION_MESSAGES.backupUnregistered);
    expect(policy.backups.archive).toBe("none");
    expect(policy.scope.copiesElsewhere).toBe("total");
    const manual = await plan(fixture, { reason: "manual" });
    expect(manual.eligible).toBe(true);
    expect(manual.scope.copiesElsewhere).toBe("total");
    // Registered (and copied), the same recording follows the policy again.
    fixture.archives.push(archiveRecord(fixture));
    const registered = await plan(fixture);
    expect(registered.eligible).toBe(true);
    expect(registered.scope.copiesElsewhere).toBe("local-only");
    // An archive with no target configured makes no copies to wait for.
    fixture.archives.length = 0;
    fixture.config.archive.vaio = false;
    fixture.config.archive.proton = false;
    expect((await plan(fixture)).eligible).toBe(true);
  });

  test("an unreadable catalog keeps the media as pending, not as unregistered", async () => {
    const fixture = await setup();
    fixture.config.archive.enabled = true;
    fixture.deps.archives = { list: async () => { throw new Error("catalog unreadable"); } };
    await blockedOnlyBy(fixture, "backup-pending");
  });

  test("an archive id that is not a plain id never becomes a purge path", async () => {
    const fixture = await setup();
    fixture.entry.archive = archiveRecord(fixture, { id: "../.." });
    const off = await plan(fixture);
    expect(off.eligible).toBe(true);
    expect(off.purge.protonRestoreCache).toBeUndefined();
    fixture.entry.archive = undefined;
    fixture.config.archive.enabled = true;
    fixture.archives.push(archiveRecord(fixture, { id: "../.." }));
    await blockedOnlyBy(fixture, "backup-mismatch");
  });

  test("with the archive off a pending record does not block and the removal is total", async () => {
    const fixture = await setup();
    fixture.entry.archive = archiveRecord(fixture, { vaio: { state: "pending" }, proton: { state: "pending" } });
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.backups.archive).toBe("disabled");
    expect(value.scope.copiesElsewhere).toBe("total");
  });

  test("a full Proton job backup must be complete", async () => {
    const fixture = await setup();
    fixture.config.proton.enabled = true;
    fixture.config.proton.policy = "full";
    await blockedOnlyBy(fixture, "proton-backup-pending");
    const record = { version: 1 as const, jobId: fixture.job.id, state: "completed" as const, policy: "artifacts" as const, remotePath: "/my-files/x", updatedAt: "2026-10-01T13:00:00.000Z", files: [] };
    fixture.protonBackups.set(fixture.job.id, record);
    await blockedOnlyBy(fixture, "proton-backup-pending");
    fixture.protonBackups.set(fixture.job.id, { ...record, state: "uploading", policy: "full" });
    await blockedOnlyBy(fixture, "proton-backup-pending");
    fixture.protonBackups.set(fixture.job.id, { ...record, policy: "full" });
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.backups.protonJobBackup).toBe("2026-10-01T13:00:00.000Z");
    fixture.config.proton.policy = "artifacts";
    fixture.protonBackups.clear();
    expect((await plan(fixture)).eligible).toBe(true);
  });
});

describe("7. media identity", () => {
  test("missing media", async () => {
    const fixture = await setup();
    await fs.rm(fixture.sourcePath);
    await blockedOnlyBy(fixture, "media-missing");
  });

  test("a symlink in place of the media is refused and never followed", async () => {
    const fixture = await setup();
    const target = join(fixture.root, "real-video.mkv");
    await fs.rename(fixture.sourcePath, target);
    await fs.symlink(target, fixture.sourcePath);
    const value = await plan(fixture);
    expect(codes(value)).toContain("media-unsafe");
    expect(value.eligible).toBe(false);
  });

  test("media outside the recordings folder is refused", async () => {
    const fixture = await setup();
    fixture.config.recordingsDir = join(fixture.root, "other-recordings");
    await fs.mkdir(fixture.config.recordingsDir);
    await blockedOnlyBy(fixture, "media-unsafe");
  });

  test("a recordings folder reached through a symlink that escapes is refused", async () => {
    const fixture = await setup();
    const link = join(fixture.root, "linked-recordings");
    await fs.symlink(join(fixture.root, "state"), link);
    fixture.config.recordingsDir = link;
    expect(codes(await plan(fixture))).toContain("media-unsafe");
  });

  test("a different size is refused without hashing", async () => {
    const fixture = await setup();
    let hashed = 0;
    fixture.deps.hashFile = async () => { hashed += 1; return fixture.job.source.sha256; };
    await fs.appendFile(fixture.sourcePath, "more");
    await blockedOnlyBy(fixture, "media-size-mismatch");
    expect(hashed).toBe(0);
  });

  test("the same size with different content is a hash mismatch", async () => {
    const fixture = await setup();
    const content = await fs.readFile(fixture.sourcePath);
    content[10] = content[10]! ^ 0xff;
    await fs.writeFile(fixture.sourcePath, content);
    await blockedOnlyBy(fixture, "media-hash-mismatch");
  });

  test("a file that changes while it is hashed is refused", async () => {
    const fixture = await setup();
    fixture.deps.hashFile = async (path) => {
      const later = new Date(Date.now() + 5_000);
      await fs.utimes(path, later, later);
      return fixture.job.source.sha256;
    };
    await blockedOnlyBy(fixture, "media-changed");
  });

  test("a symlinked recording folder is refused", async () => {
    const fixture = await setup();
    const moved = join(fixture.root, "moved.recording");
    await fs.rename(fixture.recordingRoot, moved);
    await fs.symlink(moved, fixture.recordingRoot);
    await blockedOnlyBy(fixture, "recording-root-unsafe");
  });

  test("nothing is hashed while another condition blocks, unless asked", async () => {
    const fixture = await setup();
    let hashed = 0;
    fixture.deps.hashFile = async () => { hashed += 1; return fixture.job.source.sha256; };
    fixture.setNow(Date.parse(fixture.job.updatedAt));
    await blockedOnlyBy(fixture, "steps-pending");
    expect(hashed).toBe(0);
    const always = await plan(fixture, { verifyMedia: "always" });
    expect(hashed).toBe(1);
    expect(always.media.verified).toBe(true);
    expect(always.eligible).toBe(false);
    fixture.setNow(Date.parse(fixture.job.updatedAt) + 2 * DAY);
    const never = await plan(fixture, { verifyMedia: "never" });
    expect(hashed).toBe(1);
    expect(never.blockers).toEqual([]);
    expect(never.eligible).toBe(false);
  });

  test("a known hash is reused only for the same inode, size, mtime and ctime", async () => {
    const fixture = await setup();
    let hashed = 0;
    const real = fixture.deps.hashFile;
    fixture.deps.hashFile = async (path) => { hashed += 1; return real ? real(path) : sha(await fs.readFile(path)); };
    const stat = await fs.lstat(fixture.sourcePath);
    const known = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256: fixture.job.source.sha256 };
    expect((await plan(fixture, { internal: { knownHash: known } })).eligible).toBe(true);
    expect(hashed).toBe(0);
    expect((await plan(fixture, { internal: { knownHash: { ...known, ctimeMs: known.ctimeMs - 1 } } })).eligible).toBe(true);
    expect(hashed).toBe(1);
  });
});

describe("audio-only planning", () => {
  test("probes the source layout and needs video to drop", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    const value = await plan(fixture);
    expect(value.eligible).toBe(true);
    expect(value.audioStreams).toEqual(THREE_TRACKS.map((stream, index) => ({ index, ...stream })));
    expect(value.durationSeconds).toBe(120);
    fixture.setRunner(fakeRunner({ source: { audio: THREE_TRACKS, video: 0, duration: "120" } }));
    await blockedOnlyBy(fixture, "no-video");
    fixture.setRunner(fakeRunner({ source: { audio: [], video: 1, duration: "120" } }));
    await blockedOnlyBy(fixture, "no-audio");
    fixture.setRunner(fakeRunner({ ffprobeFails: true }));
    await blockedOnlyBy(fixture, "probe-failed");
  });

  test("malformed ffprobe output is refused", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "audio-only";
    const answers = ["not json", JSON.stringify({ streams: "x", format: {} }), JSON.stringify({ streams: [], format: { duration: "abc" } }),
      JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "opus", channels: 0 }], format: { duration: "1" } }),
      JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "opus", channels: 2, tags: { title: "a\u0000b" } }], format: { duration: "1" } })];
    for (const stdout of answers) {
      fixture.deps.run = async () => ({ stdout, stderr: "" });
      await blockedOnlyBy(fixture, "probe-failed");
    }
  });
});

describe("tombstone states", () => {
  test("an already removed recording plans nothing", async () => {
    const fixture = await setup();
    const store = new MediaRetentionStore();
    await store.write({ version: 1, sourcePath: fixture.sourcePath, source: { fileName: fixture.sourcePath.split("/").pop()!, size: fixture.job.source.size, sha256: fixture.job.source.sha256, mtimeMs: 1 },
      jobs: [fixture.job.id], mode: "transcript-only", reason: "policy", state: "removed", startedAt: "2026-10-02T10:00:00.000Z", removedAt: "2026-10-02T10:01:00.000Z",
      verified: { jobId: fixture.job.id, receipt: "verified", transcriptArtifactSha256: sha("t"), receiptSha256: sha("r"), microphone: "skipped", voices: "skipped", backups: {} }, purged: [] }, null);
    await blockedOnlyBy(fixture, "already-removed");
  });

  test("an invalid tombstone blocks and is preserved", async () => {
    const fixture = await setup();
    await fs.writeFile(tombstonePathOf(fixture.sourcePath), "{}");
    await blockedOnlyBy(fixture, "tombstone-invalid");
    expect(await fs.readFile(tombstonePathOf(fixture.sourcePath), "utf8")).toBe("{}");
  });

  test("a removing tombstone with the media gone plans a finalize, even under keep", async () => {
    const fixture = await setup();
    const tombstone = { version: 1 as const, sourcePath: fixture.sourcePath, source: { fileName: fixture.sourcePath.split("/").pop()!, size: fixture.job.source.size, sha256: fixture.job.source.sha256, mtimeMs: 1 },
      jobs: [fixture.job.id], mode: "transcript-only" as const, reason: "policy" as const, state: "removing" as const, startedAt: "2026-10-02T10:00:00.000Z",
      verified: { jobId: fixture.job.id, receipt: "verified" as const, transcriptArtifactSha256: sha("t"), receiptSha256: sha("r"), microphone: "skipped" as const, voices: "skipped" as const, backups: {} }, purged: [] };
    await new MediaRetentionStore().write(tombstone, null);
    const resume = await plan(fixture);
    expect(resume.action).toBe("remove");
    expect(resume.resume).toBe(true);
    expect(resume.eligible).toBe(true);
    await fs.rm(fixture.sourcePath);
    fixture.config.media.retention = "keep";
    const value = await plan(fixture);
    expect(value.action).toBe("finalize");
    expect(value.eligible).toBe(true);
    expect(value.tombstoneSha256).toBe(sha(serializeTombstone(tombstone)));
  });
});
