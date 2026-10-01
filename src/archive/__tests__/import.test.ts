import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import type { JobRecord } from "../../jobs/types";
import { importRemoteLibraryMedia } from "../import";
import { ArchiveStore, type ArchiveRecord } from "../store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const setup = async () => {
  const root = await fs.mkdtemp("/tmp/recording-cli-import-");
  roots.push(root);
  const recordingsDir = join(root, "recordings");
  const jobStateDir = join(root, "jobs-state");
  await fs.mkdir(recordingsDir, { recursive: true });
  await fs.mkdir(jobStateDir, { recursive: true });
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    recordingsDir,
    remote: { ...DEFAULT_CONFIG.remote, archiveDir: "/srv/archive" }
  };
  return {
    root,
    recordingsDir,
    jobStateDir,
    config,
    jobs: new JobStore(jobStateDir, join(root, "jobs-data")),
    archives: new ArchiveStore(join(root, "archive-state"))
  };
};

const makeJob = (
  sourcePath: string,
  overrides: Partial<JobRecord> = {}
): JobRecord => {
  const id = overrides.id || randomUUID();
  const createdAt = overrides.createdAt || "2026-08-20T12:00:00.000Z";
  return {
    version: 1,
    id,
    createdAt,
    source: {
      originalName: "daily.mkv",
      mediaFile: "source.mkv",
      size: 123,
      sha256: "a".repeat(64)
    },
    transcription: { provider: "whisper-cpp", model: "fixture", language: "pt" },
    summary: { provider: "ollama", model: "fixture" },
    sourcePath,
    artifactDir: `${sourcePath}.recording/${id}`,
    target: "remote",
    state: "completed",
    updatedAt: createdAt,
    ...overrides
  };
};

const writeJobs = async (stateDir: string, jobs: JobRecord[]): Promise<Map<string, string>> => {
  const snapshots = new Map<string, string>();
  for (const job of jobs) {
    const raw = `${JSON.stringify(job, null, 2)}\n`;
    await fs.writeFile(join(stateDir, `${job.id}.json`), raw);
    snapshots.set(job.id, raw);
  }
  return snapshots;
};

test("imports one verified legacy VAIO copy per missing local source without changing jobs", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const sourcePath = join(recordingsDir, "daily.mkv");
  const older = makeJob(sourcePath, { createdAt: "2026-08-19T12:00:00.000Z" });
  const newer = makeJob(sourcePath, { createdAt: "2026-08-20T12:00:00.000Z" });
  const snapshots = await writeJobs(jobStateDir, [older, newer]);
  const inspected: string[] = [];

  const report = await importRemoteLibraryMedia(config, {}, archives, jobs, {
    now: () => new Date("2026-09-08T03:04:05.000Z"),
    inspect: async (_config, job) => {
      inspected.push(job.id);
      if (job.id === newer.id) throw new Error("No such file");
      return {
        archiveDir: "/srv/archive",
        archiveRelative: `2026/08/${job.id}`,
        sourcePath: `/srv/archive/2026/08/${job.id}/source.mkv`,
        size: job.source.size,
        sha256: job.source.sha256
      };
    }
  });

  expect(report).toEqual({ imported: 1, missing: 0, errors: [] });
  expect(inspected).toEqual([newer.id, older.id]);
  const record = await archives.get(older.id);
  expect(record).toEqual({
    version: 1,
    id: older.id,
    createdAt: older.createdAt,
    sourcePath,
    source: {
      fileName: "source.mkv",
      size: 123,
      sha256: "a".repeat(64),
      mtimeMs: Date.parse(older.createdAt)
    },
    vaio: {
      state: "completed",
      path: `/srv/archive/2026/08/${older.id}/source.mkv`,
      archiveDir: "/srv/archive",
      archiveRelative: `2026/08/${older.id}`,
      verifiedAt: "2026-09-08T03:04:05.000Z"
    },
    proton: { state: "pending" }
  });
  for (const [id, raw] of snapshots) {
    expect(await fs.readFile(join(jobStateDir, `${id}.json`), "utf8")).toBe(raw);
  }
});

test("reports a missing VAIO copy and hash mismatch without registering false records", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const missing = makeJob(join(recordingsDir, "missing.mkv"));
  const mismatched = makeJob(join(recordingsDir, "mismatch.mkv"));
  await writeJobs(jobStateDir, [missing, mismatched]);

  const report = await importRemoteLibraryMedia(config, {}, archives, jobs, {
    inspect: async (_config, job) => {
      if (job.id === missing.id) throw new Error("No such file");
      return {
        archiveDir: "/srv/archive",
        archiveRelative: `2026/08/${job.id}`,
        sourcePath: `/srv/archive/2026/08/${job.id}/source.mkv`,
        size: job.source.size,
        sha256: "b".repeat(64)
      };
    }
  });

  expect(report.imported).toBe(0);
  expect(report.missing).toBe(1);
  expect(report.errors).toHaveLength(2);
  expect(report.errors.find((entry) => entry.id === missing.id)?.error).toContain("No such file");
  expect(report.errors.find((entry) => entry.id === mismatched.id)?.error).toContain("SHA-256");
  expect(await archives.list()).toEqual([]);
});

test("skips a matching catalog record, existing local source, and nonremote jobs", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const alreadyImported = makeJob(join(recordingsDir, "imported.mkv"));
  const localExists = makeJob(join(recordingsDir, "present.mkv"));
  const localJob = makeJob(join(recordingsDir, "local-job.mkv"), { target: "local" });
  await fs.writeFile(localExists.sourcePath, "present");
  await writeJobs(jobStateDir, [alreadyImported, localExists, localJob]);
  const existing: ArchiveRecord = {
    version: 1,
    id: alreadyImported.id,
    createdAt: alreadyImported.createdAt,
    sourcePath: alreadyImported.sourcePath,
    source: {
      fileName: alreadyImported.source.mediaFile,
      size: alreadyImported.source.size,
      sha256: alreadyImported.source.sha256,
      mtimeMs: Date.parse(alreadyImported.createdAt)
    },
    vaio: {
      state: "completed",
      path: `/srv/archive/2026/08/${alreadyImported.id}/source.mkv`,
      archiveDir: "/srv/archive",
      archiveRelative: `2026/08/${alreadyImported.id}`,
      verifiedAt: "2026-09-01T00:00:00.000Z"
    },
    proton: { state: "pending" }
  };
  await archives.save(existing);
  let inspections = 0;

  const report = await importRemoteLibraryMedia(config, {}, archives, jobs, {
    inspect: async () => {
      inspections += 1;
      throw new Error("must not inspect");
    }
  });

  expect(report).toEqual({ imported: 0, missing: 0, errors: [] });
  expect(inspections).toBe(0);
  expect(await archives.list()).toEqual([existing]);
});

test("rejects paths outside recordingsDir and divergent identities already in the catalog", async () => {
  const { root, recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const outside = makeJob(join(root, "outside.mkv"));
  const divergent = makeJob(join(recordingsDir, "divergent.mkv"));
  await writeJobs(jobStateDir, [outside, divergent]);
  await archives.save({
    version: 1,
    id: randomUUID(),
    createdAt: divergent.createdAt,
    sourcePath: divergent.sourcePath,
    source: {
      fileName: "source.mkv",
      size: divergent.source.size,
      sha256: "b".repeat(64),
      mtimeMs: Date.parse(divergent.createdAt)
    },
    vaio: { state: "pending" },
    proton: { state: "pending" }
  });

  const report = await importRemoteLibraryMedia(config, {}, archives, jobs, {
    inspect: async () => { throw new Error("must not inspect"); }
  });

  expect(report.imported).toBe(0);
  expect(report.errors).toHaveLength(2);
  expect(report.errors.find((entry) => entry.id === outside.id)?.error).toContain("recordingsDir");
  expect(report.errors.find((entry) => entry.id === divergent.id)?.error).toContain("divergente");
});

test("bounds remote inspections to three concurrent source groups", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const candidates = Array.from({ length: 5 }, (_, index) =>
    makeJob(join(recordingsDir, `daily-${index}.mkv`), {
      createdAt: `2026-08-${String(index + 10).padStart(2, "0")}T12:00:00.000Z`
    })
  );
  await writeJobs(jobStateDir, candidates);
  let active = 0;
  let maximumActive = 0;

  const report = await importRemoteLibraryMedia(config, {}, archives, jobs, {
    inspect: async (_config, job) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      active -= 1;
      return {
        archiveDir: "/srv/archive",
        archiveRelative: `2026/08/${job.id}`,
        sourcePath: `/srv/archive/2026/08/${job.id}/source.mkv`,
        size: job.source.size,
        sha256: job.source.sha256
      };
    }
  });

  expect(report.imported).toBe(5);
  expect(maximumActive).toBe(3);
});
