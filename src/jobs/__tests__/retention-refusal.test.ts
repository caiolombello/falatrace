import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { MEDIA_RETENTION_MESSAGES } from "../../media-retention/store";
import { writeRemovedTombstone } from "../../media-retention/__tests__/fixture";
import { planRecordingProcessing, type ManualProcessDeps } from "../manual";
import { processJob } from "../pipeline";
import { JobStore } from "../store";
import { processLocalJob } from "../sync";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "retention-refusal-"));
  roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = join(root, "recordings");
  config.processing.defaultTarget = "local";
  config.timesheet.enabled = false;
  await fs.mkdir(config.recordingsDir, { recursive: true });
  const sourcePath = join(config.recordingsDir, "meeting.mkv");
  await fs.writeFile(sourcePath, "synthetic media, not a recording");
  const store = new JobStore(join(root, "state/jobs"), join(root, "data/jobs"));
  const job = await store.enqueue(config, sourcePath);
  return { root, config, store, job, sourcePath };
};

test("processing a job whose media retention removed fails with a clear refusal, never ENOENT", async () => {
  const f = await fixture();
  await writeRemovedTombstone(f.job);
  await fs.rm(f.sourcePath);
  const result = await processLocalJob(f.config, f.store, f.job);
  expect(result.state).toBe("failed");
  expect(result.error).toBe(MEDIA_RETENTION_MESSAGES.reprocessRefused);
});

test("the pipeline refuses removed media before any provider request", async () => {
  const f = await fixture();
  await writeRemovedTombstone(f.job, { state: "removing", removedAt: undefined });
  await fs.rm(f.sourcePath);
  await expect(processJob(f.config, f.store.toManifest(f.job), f.sourcePath, join(f.root, "work"))).rejects.toThrow(MEDIA_RETENTION_MESSAGES.reprocessRefused);
});

test("missing media without a tombstone keeps the previous failure", async () => {
  const f = await fixture();
  await fs.rm(f.sourcePath);
  const result = await processLocalJob(f.config, f.store, f.job);
  expect(result.state).toBe("failed");
  expect(result.error).not.toBe(MEDIA_RETENTION_MESSAGES.reprocessRefused);
  expect(result.error).toContain("ENOENT");
});

test("the Studio's processing plan says why a removed recording cannot be retried", async () => {
  const f = await fixture();
  const failed = await f.store.update(f.job.id, "failed", { error: "Synthetic failure" });
  const deps: ManualProcessDeps = { store: { get: async () => failed, enqueue: async () => { throw new Error("unexpected"); } } as never,
    duration: async () => 1, queue: async () => { throw new Error("unexpected"); }, notes: async () => undefined };
  const entry = { sourcePath: f.sourcePath, sourceExists: false, jobs: [failed] };
  await fs.rm(f.sourcePath);
  expect(await planRecordingProcessing(f.config, entry, deps)).toMatchObject({ action: "none", reason: "O arquivo original não está neste computador." });
  await writeRemovedTombstone(f.job);
  expect(await planRecordingProcessing(f.config, entry, deps)).toMatchObject({ action: "none", reason: MEDIA_RETENTION_MESSAGES.reprocessRefused });
});
