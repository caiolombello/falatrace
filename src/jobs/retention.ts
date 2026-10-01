import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { hashFile, JobStore } from "./store";
import { validateJobId, validateJobStatus } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_ENTRIES = 100_000;
const ARTIFACT_NAMES = ["transcript.json", "transcript.md", "summary.json", "summary.md"];

export type RetentionReport = {
  localCompletedWork: number;
  remoteIncoming: number;
  remoteResults: number;
  remoteFailures: number;
};

const emptyReport = (): RetentionReport => ({
  localCompletedWork: 0,
  remoteIncoming: 0,
  remoteResults: 0,
  remoteFailures: 0
});

export const getServerRoot = (): string =>
  join(homedir(), ".local", "share", "recording-cli", "server");

const isExpired = (modifiedAt: number, days: number, now: number): boolean =>
  days > 0 && modifiedAt <= now - days * DAY_MS;

export const cleanupLocalCompletedWork = async (
  store: JobStore,
  days: number,
  options: { dryRun?: boolean; now?: number } = {}
): Promise<RetentionReport> => {
  const report = emptyReport();
  if (days === 0) return report;
  const now = options.now ?? Date.now();
  for (const job of await store.list()) {
    const updatedAt = Date.parse(job.updatedAt);
    if (job.state !== "completed" || !Number.isFinite(updatedAt) || !isExpired(updatedAt, days, now)) {
      continue;
    }
    const workDir = store.getWorkDir(job.id);
    try {
      const stat = await fs.lstat(workDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      report.localCompletedWork += 1;
      if (!options.dryRun) await store.removeWorkData(job.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return report;
};

const cleanupDirectoryEntries = async (
  root: string,
  days: number,
  matches: (name: string) => boolean,
  now: number,
  dryRun: boolean,
  options: {
    includeDirectChildMtime?: boolean;
    canRemove?: (name: string) => Promise<boolean>;
  } = {}
): Promise<number> => {
  if (days === 0) return 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  if (entries.length > MAX_RETENTION_ENTRIES) {
    throw new Error(`Retention directory exceeds ${MAX_RETENTION_ENTRIES} entries: ${root}`);
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !matches(entry.name)) continue;
    const path = join(root, entry.name);
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) continue;
    let modifiedAt = stat.mtimeMs;
    if (options.includeDirectChildMtime) {
      const children = await fs.readdir(path, { withFileTypes: true });
      for (const child of children) {
        const childStat = await fs.lstat(join(path, child.name));
        modifiedAt = Math.max(modifiedAt, childStat.mtimeMs);
      }
    }
    if (!isExpired(modifiedAt, days, now)) continue;
    if (options.canRemove && !(await options.canRemove(entry.name))) continue;
    removed += 1;
    if (!dryRun) await fs.rm(path, { recursive: true, force: false });
  }
  return removed;
};

const isJobId = (name: string): boolean => {
  try {
    validateJobId(name);
    return true;
  } catch {
    return false;
  }
};

const isPartialJob = (name: string): boolean =>
  name.endsWith(".partial") && isJobId(name.slice(0, -8));

const isFailedJob = (name: string): boolean =>
  isJobId(name) || (/^[0-9a-f-]{36}-\d{10,}$/.test(name) && isJobId(name.slice(0, 36)));

const containsOnlyDisposableFailureData = async (path: string): Promise<boolean> => {
  const names = new Set([...ARTIFACT_NAMES, "manifest.json", "status.json"]);
  try {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      if (!names.has(entry.name) || !entry.isFile()) return false;
      const stat = await fs.lstat(join(path, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    // Unknown or unreadable content may be the only recoverable original.
    return false;
  }
};

const expandHome = (path: string): string =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const hasDurableArchive = async (
  config: AppConfig,
  serverRoot: string,
  jobId: string
): Promise<boolean> => {
  try {
    const status = validateJobStatus(
      JSON.parse(await fs.readFile(join(serverRoot, "status", `${jobId}.json`), "utf-8"))
    );
    if (status.state !== "completed" || !status.archiveRelative) return false;
    const archiveDir = join(expandHome(config.remote.archiveDir), status.archiveRelative);
    const archiveStat = await fs.lstat(archiveDir);
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) return false;
    for (const name of ARTIFACT_NAMES) {
      const artifactStat = await fs.lstat(join(archiveDir, name));
      if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) return false;
    }
    // Presence alone is insufficient: preserve unknown data and mismatched artifacts.
    const resultsDir = join(serverRoot, "results", jobId);
    for (const entry of await fs.readdir(resultsDir, {withFileTypes:true})) {
      if (!ARTIFACT_NAMES.includes(entry.name) || !entry.isFile()) return false;
      const path = join(resultsDir,entry.name);
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await hashFile(path) !== await hashFile(join(archiveDir,entry.name))) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const cleanupRemoteServer = async (
  config: AppConfig,
  options: { dryRun?: boolean; now?: number; serverRoot?: string } = {}
): Promise<RetentionReport> => {
  const report = emptyReport();
  const now = options.now ?? Date.now();
  const root = options.serverRoot || getServerRoot();
  const dryRun = options.dryRun === true;
  report.remoteIncoming = await cleanupDirectoryEntries(
    join(root, "incoming"),
    config.retention.remoteIncomingDays,
    isPartialJob,
    now,
    dryRun,
    { includeDirectChildMtime: true }
  );
  report.remoteResults = await cleanupDirectoryEntries(
    join(root, "results"),
    config.retention.remoteResultsDays,
    isJobId,
    now,
    dryRun,
    { canRemove: (jobId) => hasDurableArchive(config, root, jobId) }
  );
  report.remoteFailures = await cleanupDirectoryEntries(
    join(root, "failed"),
    config.retention.remoteFailuresDays,
    isFailedJob,
    now,
    dryRun,
    { canRemove: (name) => containsOnlyDisposableFailureData(join(root, "failed", name)) }
  );
  return report;
};

export const retentionTotal = (report: RetentionReport): number =>
  Object.values(report).reduce((total, value) => total + value, 0);
