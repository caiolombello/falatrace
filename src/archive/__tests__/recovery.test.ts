import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { JobStore } from "../../jobs/store";
import type { JobRecord } from "../../jobs/types";
import { recoverRemoteOriginals } from "../recovery";
import { ArchiveStore } from "../store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const setup = async () => {
  const root = await fs.mkdtemp("/tmp/recording-cli-recovery-");
  roots.push(root);
  const recordingsDir = join(root, "recordings");
  const jobStateDir = join(root, "jobs-state");
  await fs.mkdir(recordingsDir, { recursive: true });
  await fs.mkdir(jobStateDir, { recursive: true });
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    recordingsDir,
    remote: { ...DEFAULT_CONFIG.remote, host: "vaio.test", archiveDir: "/srv/archive" }
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

const makeFailedJob = (sourcePath: string): JobRecord => {
  const id = randomUUID();
  return {
    version: 1,
    id,
    createdAt: "2026-08-21T12:34:56.000Z",
    source: {
      originalName: "call.mkv",
      mediaFile: "source.mkv",
      size: 456,
      sha256: "a".repeat(64)
    },
    transcription: { provider: "whisper-cpp", model: "fixture", language: "pt" },
    summary: { provider: "ollama", model: "fixture" },
    sourcePath,
    artifactDir: `${sourcePath}.recording/${id}`,
    target: "remote",
    state: "failed",
    updatedAt: "2026-08-22T00:00:00.000Z",
    error: "summary failed"
  };
};

const writeJob = async (stateDir: string, job: JobRecord): Promise<string> => {
  const raw = `${JSON.stringify(job, null, 2)}\n`;
  await fs.writeFile(join(stateDir, `${job.id}.json`), raw);
  return raw;
};

const runnerReturning = (
  response: "recovered" | "existing" | "missing" | "divergent",
  calls: Array<{ command: string; args: string[] }>
): typeof runCommand => async (command, args) => {
  calls.push({ command, args });
  return { stdout: `${response}\t/srv/archive\n`, stderr: "" };
};

test("copies one validated failed-job original into the archive and only writes the archive catalog", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const job = makeFailedJob(join(recordingsDir, "missing-call.mkv"));
  const jobSnapshot = await writeJob(jobStateDir, job);
  const calls: Array<{ command: string; args: string[] }> = [];

  const report = await recoverRemoteOriginals(config, archives, jobs, {
    run: runnerReturning("recovered", calls),
    now: () => new Date("2026-09-08T05:06:07.000Z")
  });

  expect(report).toEqual({ recovered: 1, missing: 0, errors: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe("ssh");
  const remoteCommand = calls[0].args[calls[0].args.length - 1];
  expect(remoteCommand).toContain("for bucket in failed processing queue incoming");
  expect(remoteCommand).toContain('candidate="$server_root/$bucket/$suffix/$file_name"');
  expect(remoteCommand).toContain("rsync");
  expect(remoteCommand).toContain("mv -T -n");
  expect(remoteCommand).not.toContain("jobs sync");
  expect(remoteCommand).not.toContain("rm -");
  expect(await fs.readFile(join(jobStateDir, `${job.id}.json`), "utf8")).toBe(jobSnapshot);
  expect(await archives.get(job.id)).toEqual({
    version: 1,
    id: job.id,
    createdAt: job.createdAt,
    sourcePath: job.sourcePath,
    source: {
      fileName: "source.mkv",
      size: 456,
      sha256: "a".repeat(64),
      mtimeMs: Date.parse(job.createdAt)
    },
    vaio: {
      state: "completed",
      path: `/srv/archive/media/2026/08/${job.id}/source.mkv`,
      archiveDir: "/srv/archive",
      archiveRelative: `media/2026/08/${job.id}`,
      verifiedAt: "2026-09-08T05:06:07.000Z"
    },
    proton: { state: "pending" }
  });
});

test("does not copy or catalog a checksum-divergent remote source", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const job = makeFailedJob(join(recordingsDir, "divergent.mkv"));
  await writeJob(jobStateDir, job);
  const calls: Array<{ command: string; args: string[] }> = [];

  const report = await recoverRemoteOriginals(config, archives, jobs, {
    run: runnerReturning("divergent", calls)
  });

  expect(report.recovered).toBe(0);
  expect(report.missing).toBe(0);
  expect(report.errors).toEqual([{ id: job.id, error: expect.stringContaining("SHA-256") }]);
  expect(await archives.list()).toEqual([]);
  expect(calls[0].args[calls[0].args.length - 1]).toContain("before_identity");
  expect(calls[0].args[calls[0].args.length - 1]).toContain("after_identity");
});

test("reports a failed job whose original is absent from every bounded server path", async () => {
  const { recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const job = makeFailedJob(join(recordingsDir, "not-found.mkv"));
  await writeJob(jobStateDir, job);
  const calls: Array<{ command: string; args: string[] }> = [];

  const report = await recoverRemoteOriginals(config, archives, jobs, {
    run: runnerReturning("missing", calls)
  });

  expect(report.recovered).toBe(0);
  expect(report.missing).toBe(1);
  expect(report.errors).toEqual([{ id: job.id, error: expect.stringContaining("não foi localizado") }]);
  expect(await archives.list()).toEqual([]);
  const command = calls[0].args[calls[0].args.length - 1];
  expect(command).not.toContain("find ");
  expect(command).not.toContain("$HOME -");
});

test("ignores local, nonfailed, present, and out-of-scope recordings", async () => {
  const { root, recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const present = makeFailedJob(join(recordingsDir, "present.mkv"));
  await fs.writeFile(present.sourcePath, "still local");
  const local = { ...makeFailedJob(join(recordingsDir, "local.mkv")), target: "local" as const };
  const completed = { ...makeFailedJob(join(recordingsDir, "completed.mkv")), state: "completed" as const };
  const outside = makeFailedJob(join(root, "outside.mkv"));
  for (const job of [present, local, completed, outside]) await writeJob(jobStateDir, job);
  const calls: Array<{ command: string; args: string[] }> = [];

  const report = await recoverRemoteOriginals(config, archives, jobs, {
    run: runnerReturning("recovered", calls)
  });

  expect(report.recovered).toBe(0);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toEqual({ id: outside.id, error: expect.stringContaining("recordingsDir") });
  expect(calls).toHaveLength(0);
});

test("executes the generated recovery shell with a tilde archive in a temporary HOME", async () => {
  const { root, recordingsDir, jobStateDir, config, jobs, archives } = await setup();
  const remoteHome = join(root, "remote-home");
  const job = makeFailedJob(join(recordingsDir, "remote-only.mkv"));
  const content = "synthetic remote original";
  job.source.size = Buffer.byteLength(content);
  job.source.sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const remoteSource = join(
    remoteHome,
    ".local/share/recording-cli/server/failed",
    job.id,
    job.source.mediaFile
  );
  await fs.mkdir(join(remoteHome, "Videos/Archive"), { recursive: true });
  await fs.mkdir(join(remoteSource, ".."), { recursive: true });
  await fs.writeFile(remoteSource, content);
  await writeJob(jobStateDir, job);
  config.remote.archiveDir = "~/Videos/Archive";

  const localShellRunner: typeof runCommand = async (command, args) => {
    expect(command).toBe("ssh");
    return runCommand("sh", ["-c", args[args.length - 1].replaceAll("$HOME", "$RECORDING_RECOVERY_TEST_HOME")], {
      env: { ...process.env, RECORDING_RECOVERY_TEST_HOME: remoteHome },
      timeoutMs: 10_000
    });
  };

  const report = await recoverRemoteOriginals(config, archives, jobs, {
    run: localShellRunner,
    now: () => new Date("2026-09-08T06:07:08.000Z")
  });

  expect(report).toEqual({ recovered: 1, missing: 0, errors: [] });
  const archived = join(remoteHome, "Videos/Archive/media/2026/08", job.id, "source.mkv");
  expect(await fs.readFile(archived, "utf8")).toBe(content);
  expect(await fs.readFile(remoteSource, "utf8")).toBe(content);
});
