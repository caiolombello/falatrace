import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { refreshAiContextIfEnabled } from "../knowledge/context";
import { reconcileTimeEntryForJob } from "../timesheet/reconcile";
import { acquireSingleton } from "../runtime/singleton";
import { processJob } from "./pipeline";
import { readBoundedArtifact } from "./transcript-access";
import { writePrivateArtifact } from "./artifacts";
import {
  pullRemoteArtifacts,
  readRemoteStatus,
  remoteJobIsQueued,
  requeueRemoteFailedJob,
  transferJob
} from "./remote";
import { hashFile, JobStore } from "./store";
import type { JobRecord } from "./types";
import { withRevisionLease, RevisionConflictError } from "../revisions";
import { hasSavedRevision } from "../revisions/service";

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

const publishLocalArtifacts = async (record: JobRecord, workDir: string): Promise<void> => withRevisionLease(record.id, async () => {
  if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; original artifact publication was refused. Use revision-bound summary regeneration.");
  await fs.mkdir(record.artifactDir, { recursive: true, mode: 0o700 });
  for (const name of [...ARTIFACT_NAMES, "transcript-receipt.json"]) {
    let raw: string;
    try { raw = await readBoundedArtifact(join(workDir, name), name === "transcript-receipt.json" ? 4096 : 20 * 1024 * 1024); }
    catch (error) { if (name === "transcript-receipt.json" && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await writePrivateArtifact(join(record.artifactDir, name), raw);
  }
});

const processLocalJobOwned = async (
  config: AppConfig,
  store: JobStore,
  record: JobRecord
): Promise<JobRecord> => {
  if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; original processing was refused before changing the job state.");
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
  return withHeavyAdmission('pipeline',current.id,async()=>{const fresh=await store.get(current.id);if(['completed','failed','processing'].includes(fresh.state)||fresh.target!=='local')return fresh;return processLocalJobOwned(config,store,fresh);},{onWait:cliAdmissionWait});
});

const syncRemoteJob = async (
  config: AppConfig,
  store: JobStore,
  record: JobRecord
): Promise<JobRecord> => {
  if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; remote synchronization was refused before contacting the remote.");
  if (record.state === "transferring") {
    record = await store.update(record.id, "pending");
  }
  if (record.state === "pending") {
    const existingStatus = await readRemoteStatus(config, record.id).catch(() => null);
    if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review changed during remote status read; further remote work was refused.");
    if (
      existingStatus?.state === "failed" &&
      await withRevisionLease(record.id, async () => {
        if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; remote requeue was refused.");
        return requeueRemoteFailedJob(config, record.id);
      })
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
    const queued = await remoteJobIsQueued(config, record.id);
    if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review changed during remote queue read; transfer was refused.");
    if (queued) {
      return store.update(record.id, "queued");
    }
    try {
      return await withRevisionLease(record.id, async () => {
        if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; remote transfer was refused.");
        await store.update(record.id, "transferring");
        await transferJob(config, record, join(store.getWorkDir(record.id), "manifest.json"));
        return store.update(record.id, "queued");
      });
    } catch (err) {
      if (err instanceof RevisionConflictError) throw err;
      return store.update(record.id, "pending", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const status = await readRemoteStatus(config, record.id);
  if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review changed during remote status read; further remote work was refused.");
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
  id: string,
  admissionSignal?: AbortSignal
): Promise<JobRecord> => withJobLease(store, id, async (job) => {
  if (["completed", "failed", "processing"].includes(job.state)) return job;
  try {
    return job.target === "local"
      ? await withHeavyAdmission('pipeline',job.id,async()=>{const fresh=await store.get(job.id);if(['completed','failed','processing'].includes(fresh.state)||fresh.target!=='local')return fresh;return processLocalJobOwned(config,store,fresh);},{onWait:cliAdmissionWait,signal:admissionSignal})
      : await syncRemoteJob(config, store, job);
  } catch (err) {
    const fresh=await store.get(job.id);if(fresh.state!==job.state||admissionSignal?.aborted)return fresh;
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
  // Keep remote transfers progressing before bounded local admission waits.
  for (const job of [...jobs.filter(j=>j.target!=="local"),...jobs.filter(j=>j.target==="local")]) {
    if (job.state === "completed") {
      await reconcileTimeEntryForJob(config, job).catch(() => undefined);
      continue;
    }
    if (job.state === "failed" || job.state === "processing") {
      continue;
    }
    updated.push(await syncJob(config, store, job.id,job.target==="local"?AbortSignal.timeout(1000):undefined));
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
