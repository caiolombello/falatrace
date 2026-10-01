import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { acquireSingleton } from "../runtime/singleton";
import { processJob } from "./pipeline";
import { cleanupRemoteServer, getServerRoot, retentionTotal } from "./retention";
import { hashFile, writeJsonAtomic } from "./store";
import {
  JOB_VERSION,
  type JobManifest,
  type JobStatus,
  validateJobId,
  validateJobManifest,
  validateJobStatus
} from "./types";

const SERVER_ROOT = getServerRoot();
const ARTIFACT_NAMES = ["transcript.json", "transcript.md", "summary.json", "summary.md"];
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const serverPath = (name: string): string => join(SERVER_ROOT, name);

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);

const writeStatus = async (status: JobStatus): Promise<void> => {
  await fs.mkdir(serverPath("status"), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(serverPath(`status/${status.id}.json`), status);
};

const statusFor = (
  manifest: JobManifest,
  state: JobStatus["state"],
  extra: Pick<JobStatus, "error" | "archiveRelative"> = {}
): JobStatus => ({
  version: JOB_VERSION,
  id: manifest.id,
  state,
  updatedAt: new Date().toISOString(),
  ...extra
});

const moveIfPresent = async (source: string, destination: string): Promise<void> => {
  try {
    await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await fs.rename(source, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      await fs.rename(destination, `${destination}-${Date.now()}`);
      await fs.rename(source, destination);
    } else if (code !== "ENOENT") {
      throw err;
    }
  }
};

export const archiveDirectory = async (source: string, destination: string): Promise<void> => {
  await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.access(destination);
    return;
  } catch {
    // Archive is not present yet.
  }
  const partialDestination = `${destination}.partial`;
  await fs.rm(partialDestination, { recursive: true, force: true });
  await fs.cp(source, partialDestination, { recursive: true, errorOnExist: true, force: false });
  await fs.rename(partialDestination, destination);
};

const recoverProcessingJobs = async (): Promise<void> => {
  await fs.mkdir(serverPath("processing"), { recursive: true, mode: 0o700 });
  await fs.mkdir(serverPath("queue"), { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(serverPath("processing"), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      validateJobId(entry.name);
    } catch {
      continue;
    }
    const source = serverPath(`processing/${entry.name}`);
    try {
      const status = validateJobStatus(
        JSON.parse(await fs.readFile(serverPath(`status/${entry.name}.json`), "utf-8"))
      );
      if (status.state === "completed") {
        await fs.rm(source, { recursive: true, force: true });
        continue;
      }
    } catch {
      // Missing or incomplete status should be retried.
    }
    const destination = serverPath(`queue/${entry.name}`);
    let destinationExists = true;
    try {
      await fs.access(destination);
    } catch {
      destinationExists = false;
    }
    if (destinationExists) {
      await fs.rm(destination, { recursive: true, force: true });
    }
    await fs.rename(source, destination);
  }
};

const processQueuedJob = async (config: AppConfig, jobId: string): Promise<void> => {
  const queueDir = serverPath(`queue/${jobId}`);
  const processingDir = serverPath(`processing/${jobId}`);
  let manifest: JobManifest | undefined;
  let claimed = false;
  try {
    await fs.mkdir(serverPath("processing"), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(queueDir, processingDir);
      claimed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    manifest = validateJobManifest(
      JSON.parse(await fs.readFile(join(processingDir, "manifest.json"), "utf-8"))
    );
    if (manifest.id !== jobId) {
      throw new Error("Manifest id does not match queue directory");
    }
    await writeStatus(statusFor(manifest, "processing"));
    const mediaPath = join(processingDir, manifest.source.mediaFile);
    const mediaStat = await fs.stat(mediaPath);
    if (!mediaStat.isFile() || mediaStat.size !== manifest.source.size) {
      throw new Error("Transferred media size does not match manifest");
    }
    if ((await hashFile(mediaPath)) !== manifest.source.sha256) {
      throw new Error("Transferred media checksum does not match manifest");
    }

    await processJob(config, manifest, mediaPath, processingDir);
    const created = new Date(manifest.createdAt);
    if (Number.isNaN(created.getTime())) {
      throw new Error("Manifest createdAt is invalid");
    }
    const archiveRelative = `${created.getUTCFullYear()}/${String(created.getUTCMonth() + 1).padStart(2, "0")}/${jobId}`;
    const archiveDir = join(expandHome(config.remote.archiveDir), archiveRelative);
    await archiveDirectory(processingDir, archiveDir);

    const resultDir = serverPath(`results/${jobId}`);
    await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
    for (const name of ARTIFACT_NAMES) {
      await fs.copyFile(join(archiveDir, name), join(resultDir, name));
    }
    await writeStatus(statusFor(manifest, "completed", { archiveRelative }));
    await fs.rm(processingDir, { recursive: true, force: true }).catch(() => undefined);
  } catch (err) {
    if (!claimed) throw err;
    const error = err instanceof Error ? err.message : String(err);
    await moveIfPresent(processingDir, serverPath(`failed/${jobId}`));
    await writeStatus(
      manifest
        ? statusFor(manifest, "failed", { error: error.slice(0, 5000) })
        : {
            version: JOB_VERSION,
            id: jobId,
            state: "failed",
            updatedAt: new Date().toISOString(),
            error: error.slice(0, 5000)
          }
    );
  }
};

const runWorkerCycle = async (config: AppConfig, runRetention = true): Promise<number> => {
  await recoverProcessingJobs();
  await fs.mkdir(serverPath("queue"), { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(serverPath("queue"), { withFileTypes: true });
  const jobs = entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        validateJobId(entry.name);
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
  for (const jobId of jobs) {
    await processQueuedJob(config, jobId);
  }
  if (runRetention) {
    try {
      const report = await cleanupRemoteServer(config, { serverRoot: SERVER_ROOT });
      if (retentionTotal(report) > 0) {
        console.log(JSON.stringify({ event: "worker.retention", ...report }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        event: "worker.retention-error",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500)
      }));
    }
  }
  return jobs.length;
};

export const runWorkerOnce = async (config: AppConfig): Promise<number> => {
  const lease = await acquireSingleton("processing-worker");
  try {
    return await runWorkerCycle(config);
  } finally {
    await lease.release();
  }
};

export const runWorker = async (config: AppConfig): Promise<void> => {
  const lease = await acquireSingleton("processing-worker");
  let stopped = false;
  let nextRetentionAt = 0;
  process.once("SIGINT", () => {
    stopped = true;
  });
  process.once("SIGTERM", () => {
    stopped = true;
  });
  try {
    while (!stopped) {
      const now = Date.now();
      const runRetention = now >= nextRetentionAt;
      await runWorkerCycle(config, runRetention);
      if (runRetention) nextRetentionAt = now + RETENTION_INTERVAL_MS;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
    }
  } finally {
    await lease.release();
  }
};
