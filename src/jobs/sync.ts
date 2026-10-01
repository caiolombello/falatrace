import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { refreshAiContextIfEnabled } from "../knowledge/context";
import { reconcileTimeEntryForJob } from "../timesheet/reconcile";
import { acquireSingleton } from "../runtime/singleton";
import { processJob } from "./pipeline";
import {
  pullRemoteArtifacts,
  readRemoteStatus,
  remoteJobIsQueued,
  requeueRemoteFailedJob,
  transferJob
} from "./remote";
import { hashFile, JobStore } from "./store";
import type { JobRecord } from "./types";

const ARTIFACT_NAMES = ["transcript.json", "transcript.md", "summary.json", "summary.md"];

const verifyLocalSource = async (record: JobRecord): Promise<void> => {
  const stat = await fs.stat(record.sourcePath);
  if (!stat.isFile() || stat.size !== record.source.size) {
    throw new Error("Recording source size no longer matches the queued job");
  }
  if ((await hashFile(record.sourcePath)) !== record.source.sha256) {
    throw new Error("Recording source checksum no longer matches the queued job");
  }
};

const publishLocalArtifacts = async (record: JobRecord, workDir: string): Promise<void> => {
  await fs.mkdir(record.artifactDir, { recursive: true, mode: 0o700 });
  for (const name of ARTIFACT_NAMES) {
    await fs.copyFile(join(workDir, name), join(record.artifactDir, name));
  }
};

const processLocalJobOwned = async (
  config: AppConfig,
  store: JobStore,
  record: JobRecord
): Promise<JobRecord> => {
  await store.update(record.id, "processing");
  try {
    const workDir = store.getWorkDir(record.id);
    await verifyLocalSource(record);
    await processJob(config, store.toManifest(record), record.sourcePath, workDir);
    await publishLocalArtifacts(record, workDir);
    const completed = await store.update(record.id, "completed");
    await reconcileTimeEntryForJob(config, completed).catch((err) =>
      console.error(JSON.stringify({
        event: "timesheet.reconcile-error",
        jobId: completed.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500)
      }))
    );
    await refreshAiContextIfEnabled(config);
    return completed;
  } catch (err) {
    return store.update(record.id, "failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
};

const withJobLease = async (
  store: JobStore, id: string, action: (record: JobRecord) => Promise<JobRecord>
): Promise<JobRecord> => {
  const key = createHash("sha256").update(`${resolve(store.stateDir)}:${id}`).digest("hex").slice(0, 32);
  const name = `process-${key}`;
  const lease = await acquireSingleton(name).catch((err) => {
    if (err instanceof Error && err.message === `${name} is already running`) return null;
    throw err;
  });
  if (!lease) return store.get(id);
  try { return await action(await store.get(id)); }
  finally { await lease.release(); }
};

export const processLocalJob = async (
  config: AppConfig, store: JobStore, record: JobRecord
): Promise<JobRecord> => withJobLease(store, record.id, async (current) => {
  if (["completed", "failed", "processing"].includes(current.state)) return current;
  return processLocalJobOwned(config, store, current);
});

const syncRemoteJob = async (
  config: AppConfig,
  store: JobStore,
  record: JobRecord
): Promise<JobRecord> => {
  if (record.state === "transferring") {
    record = await store.update(record.id, "pending");
  }
  if (record.state === "pending") {
    const existingStatus = await readRemoteStatus(config, record.id).catch(() => null);
    if (
      existingStatus?.state === "failed" &&
      await requeueRemoteFailedJob(config, record.id)
    ) {
      return store.update(record.id, "queued");
    }
    if (existingStatus && existingStatus.state !== "failed") {
      if (existingStatus.state === "completed") {
        await pullRemoteArtifacts(config, record, existingStatus.archiveRelative);
      }
      const updated = await store.update(record.id, existingStatus.state, {
        error: existingStatus.error
      });
      if (updated.state === "completed") {
        await reconcileTimeEntryForJob(config, updated).catch(() => undefined);
        await refreshAiContextIfEnabled(config);
      }
      return updated;
    }
    if (await remoteJobIsQueued(config, record.id)) {
      return store.update(record.id, "queued");
    }
    await store.update(record.id, "transferring");
    try {
      await transferJob(config, record, join(store.getWorkDir(record.id), "manifest.json"));
      return await store.update(record.id, "queued");
    } catch (err) {
      return store.update(record.id, "pending", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const status = await readRemoteStatus(config, record.id);
  if (!status) {
    return record;
  }
  if (status.state === "completed") {
    await pullRemoteArtifacts(config, record, status.archiveRelative);
    const completed = await store.update(record.id, "completed");
    await reconcileTimeEntryForJob(config, completed).catch(() => undefined);
    await refreshAiContextIfEnabled(config);
    return completed;
  }
  return store.update(record.id, status.state, { error: status.error });
};

export const syncJob = async (
  config: AppConfig,
  store: JobStore,
  id: string
): Promise<JobRecord> => withJobLease(store, id, async (job) => {
  if (["completed", "failed", "processing"].includes(job.state)) return job;
  try {
    return job.target === "local"
      ? await processLocalJobOwned(config, store, job)
      : await syncRemoteJob(config, store, job);
  } catch (err) {
    return store.update(job.id, job.state === "transferring" ? "pending" : job.state, {
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

export const syncJobs = async (
  config: AppConfig,
  store = new JobStore()
): Promise<JobRecord[]> => {
  const jobs = await store.list();
  const updated: JobRecord[] = [];
  for (const job of jobs) {
    if (job.state === "completed") {
      await reconcileTimeEntryForJob(config, job).catch(() => undefined);
      continue;
    }
    if (job.state === "failed" || job.state === "processing") {
      continue;
    }
    updated.push(await syncJob(config, store, job.id));
  }
  return updated;
};

export const retryJob = async (store: JobStore, id: string): Promise<JobRecord> => {
  const record = await store.get(id);
  if (record.state !== "failed") {
    throw new Error("Only failed jobs can be retried");
  }
  return store.update(id, "pending");
};
