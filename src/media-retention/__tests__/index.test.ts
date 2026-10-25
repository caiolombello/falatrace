import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { JobStore } from "../../jobs/store";
import {
  MEDIA_RETENTION_KNOWN_ERRORS, MEDIA_RETENTION_MESSAGES, MEDIA_RETENTION_SYNC_LIMIT, MediaRetentionStore, formatMediaRetentionSync, runMediaRetentionAfterSync,
  runMediaRetentionPass
} from "../index";
import { DAY, createFixture, sha, type Fixture } from "./fixture";

const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())); });
const setup = async (): Promise<Fixture> => {
  const fixture = await createFixture();
  fixtures.push(fixture);
  return fixture;
};

describe("MEDIA_RETENTION_KNOWN_ERRORS", () => {
  test("lists every fixed message once, all in Portuguese and short", () => {
    const messages = Object.values(MEDIA_RETENTION_MESSAGES);
    expect([...MEDIA_RETENTION_KNOWN_ERRORS].sort()).toEqual([...messages].sort());
    expect(new Set(MEDIA_RETENTION_KNOWN_ERRORS).size).toBe(MEDIA_RETENTION_KNOWN_ERRORS.length);
    for (const message of MEDIA_RETENTION_KNOWN_ERRORS) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.length).toBeLessThanOrEqual(160);
      expect(message).toMatch(/[.]$/);
    }
    expect(Object.isFrozen(MEDIA_RETENTION_KNOWN_ERRORS)).toBe(true);
  });
});

describe("runMediaRetentionPass", () => {
  test("removes eligible recordings and reports the rest with reasons", async () => {
    const ready = await setup();
    const waiting = await setup();
    waiting.setNow(Date.parse(waiting.job.updatedAt) + DAY / 4);
    const [removed] = await runMediaRetentionPass(ready.config, { entries: [ready.entry], deps: ready.deps, now: ready.now });
    expect(removed).toMatchObject({ sourcePath: ready.sourcePath, outcome: "removed" });
    expect(removed?.result?.tombstone.state).toBe("removed");
    const [held] = await runMediaRetentionPass(waiting.config, { entries: [waiting.entry], deps: waiting.deps, now: waiting.now });
    expect(held).toMatchObject({ outcome: "waiting", blockers: ["steps-pending"] });
    expect(held?.waitUntil).toBe(new Date(Date.parse(waiting.job.updatedAt) + DAY).toISOString());
  });

  test("hashes at most `limit` recordings per pass and defers the rest", async () => {
    const fixture = await setup();
    let hashed = 0;
    fixture.deps.hashFile = async (path) => { hashed += 1; return sha(await fs.readFile(path)); };
    const items = await runMediaRetentionPass(fixture.config, { entries: [fixture.entry], deps: fixture.deps, now: fixture.now, limit: 0 });
    expect(items).toEqual([{ sourcePath: fixture.sourcePath, outcome: "deferred" }]);
    expect(hashed).toBe(0);
    expect((await fs.stat(fixture.sourcePath)).isFile()).toBe(true);
  });

  test("screens a whole library with one read of the job list", async () => {
    const fixture = await setup();
    const extra = [join(fixture.recordingsDir, "a.mkv"), join(fixture.recordingsDir, "b.mkv")];
    for (const path of extra) await fs.writeFile(path, "unprocessed");
    const original = JobStore.prototype.list;
    let calls = 0;
    JobStore.prototype.list = function (this: JobStore) { calls += 1; return original.call(this); };
    try {
      const items = await runMediaRetentionPass(fixture.config, { entries: [fixture.entry, ...extra.map((sourcePath) => ({ sourcePath }))], deps: fixture.deps, now: fixture.now, limit: 0 });
      expect(items.map((item) => item.outcome)).toEqual(["deferred", "blocked", "blocked"]);
      expect(items[1]?.blockers).toEqual(["no-jobs"]);
    } finally { JobStore.prototype.list = original; }
    expect(calls).toBe(1);
  });

  test("under keep nothing new is removed, but an unfinished removal is finished", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "keep";
    expect(await runMediaRetentionPass(fixture.config, { entries: [fixture.entry], deps: fixture.deps, now: fixture.now }))
      .toEqual([{ sourcePath: fixture.sourcePath, outcome: "blocked", blockers: ["mode-keep"] }]);
    await new MediaRetentionStore().write({ version: 1, sourcePath: fixture.sourcePath, source: { fileName: fixture.sourcePath.split("/").pop()!, size: fixture.job.source.size, sha256: fixture.job.source.sha256, mtimeMs: 1 },
      jobs: [fixture.job.id], mode: "transcript-only", reason: "policy", state: "removing", startedAt: "2026-10-02T10:00:00.000Z",
      verified: { jobId: fixture.job.id, receipt: "verified", transcriptArtifactSha256: sha("t"), receiptSha256: sha("r"), microphone: "skipped", voices: "skipped", backups: {} }, purged: [] }, null);
    await fs.rm(fixture.sourcePath);
    const [item] = await runMediaRetentionPass(fixture.config, { entries: [fixture.entry], deps: fixture.deps, now: fixture.now, limit: 0 });
    expect(item).toMatchObject({ outcome: "finalized" });
    expect(item?.result?.tombstone.state).toBe("removed");
  });

  test("one failing entry does not stop the pass", async () => {
    const broken = await setup();
    const ready = await setup();
    await fs.writeFile(`${broken.recordingRoot}/media-retention.json`, "{");
    const deps = { ...ready.deps, store: new MediaRetentionStore() };
    const items = await runMediaRetentionPass(ready.config, { entries: [broken.entry, ready.entry], deps, now: ready.now });
    expect(items.map((item) => item.outcome)).toEqual(["blocked", "removed"]);
    expect(items[0]?.blockers).toEqual(["tombstone-invalid"]);
  });
});

describe("runMediaRetentionAfterSync", () => {
  test("under the default keep policy nothing is planned or read", async () => {
    const fixture = await setup();
    fixture.config.media.retention = "keep";
    let calls = 0;
    const report = await runMediaRetentionAfterSync(fixture.config, { pass: async () => { calls += 1; return []; } });
    expect(report).toEqual({ ran: false, items: [], counts: { removed: 0, finalized: 0, waiting: 0, blocked: 0, deferred: 0, failed: 0 } });
    expect(calls).toBe(0);
    expect(formatMediaRetentionSync(report)).toBe("");
  });

  test("applies the policy with the per-run bound and logs each removal", async () => {
    const fixture = await setup();
    const lines: string[] = [];
    let limit: number | undefined;
    const report = await runMediaRetentionAfterSync(fixture.config, {
      pass: (config, options) => { limit = options?.limit; return runMediaRetentionPass(config, options); },
      options: { entries: [fixture.entry], deps: fixture.deps, now: fixture.now }, log: (line) => lines.push(line)
    });
    expect(limit).toBe(MEDIA_RETENTION_SYNC_LIMIT);
    expect(report.ran).toBe(true);
    expect(report.counts.removed).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "media-retention.removed", file: fixture.sourcePath.split("/").pop(), mode: "transcript-only",
      bytesFreed: fixture.job.source.size, scope: "total" }]);
    expect(formatMediaRetentionSync(report)).toBe("Retenção de mídia: 1 removida(s), 0 aguardando, 0 mantida(s), 0 para a próxima execução, 0 com erro.");
    expect(await fs.stat(fixture.sourcePath).catch(() => null)).toBeNull();
  });

  test("never throws out of the sync run", async () => {
    const fixture = await setup();
    const lines: string[] = [];
    const report = await runMediaRetentionAfterSync(fixture.config, { pass: async () => { throw new Error("EACCES: synthetic library failure"); }, log: (line) => lines.push(line) });
    expect(report).toMatchObject({ ran: true, items: [], error: MEDIA_RETENTION_MESSAGES.passFailed });
    expect(lines).toEqual([JSON.stringify({ event: "media-retention.error", error: MEDIA_RETENTION_MESSAGES.passFailed })]);
    expect(formatMediaRetentionSync(report)).toBe(`Retenção de mídia: ${MEDIA_RETENTION_MESSAGES.passFailed}`);
    expect((await fs.stat(fixture.sourcePath)).isFile()).toBe(true);
  });

  test("a failed entry is logged with its fixed message and the rest of the pass carries on", async () => {
    const fixture = await setup();
    const lines: string[] = [];
    const report = await runMediaRetentionAfterSync(fixture.config, {
      pass: async () => [{ sourcePath: fixture.sourcePath, outcome: "failed", error: MEDIA_RETENTION_MESSAGES.removeFailed }, { sourcePath: "/x/y.mkv", outcome: "waiting", blockers: ["steps-pending"] }],
      log: (line) => lines.push(line)
    });
    expect(report.counts).toMatchObject({ failed: 1, waiting: 1 });
    expect(lines).toEqual([JSON.stringify({ event: "media-retention.failed", file: fixture.sourcePath.split("/").pop(), error: MEDIA_RETENTION_MESSAGES.removeFailed })]);
  });
});
