import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AppConfig, ProtonBackupPolicy } from "../config/defaults";
import { acquireSingleton } from "../runtime/singleton";
import {
  hashFile,
  JobStore,
  writeJsonAtomic
} from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { validateJobId } from "../jobs/types";
import {
  ProtonDriveClient,
  protonItemName,
  protonItemSize
} from "./upload";

const BACKUP_VERSION = 1 as const;
const ARTIFACT_NAMES = [
  "transcript.json",
  "transcript.md",
  "summary.json",
  "summary.md"
];

export type ProtonBackupState = "pending" | "uploading" | "completed" | "failed";

export type ProtonBackupFile = {
  name: string;
  size: number;
};

export type ProtonBackupRecord = {
  version: typeof BACKUP_VERSION;
  jobId: string;
  state: ProtonBackupState;
  policy: ProtonBackupPolicy;
  remotePath: string;
  updatedAt: string;
  files: ProtonBackupFile[];
  error?: string;
};

type LocalBackupFile = ProtonBackupFile & {
  path: string;
};

const getXdgPath = (environmentName: string, fallback: string): string =>
  process.env[environmentName] || join(homedir(), fallback);

export const getDefaultProtonBackupStateDir = (): string =>
  join(getXdgPath("XDG_STATE_HOME", ".local/state"), "recording-cli", "proton-backups");

export const getDefaultProtonBackupDataDir = (): string =>
  join(getXdgPath("XDG_DATA_HOME", ".local/share"), "recording-cli", "proton-backups");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateBackupRecord = (value: unknown): ProtonBackupRecord => {
  if (!isObject(value) || value.version !== BACKUP_VERSION) {
    throw new Error("Unsupported Proton backup record version");
  }
  const state = String(value.state);
  const policy = String(value.policy);
  if (!["pending", "uploading", "completed", "failed"].includes(state)) {
    throw new Error("Invalid Proton backup state");
  }
  if (!["artifacts", "full"].includes(policy)) {
    throw new Error("Invalid Proton backup policy");
  }
  if (
    typeof value.remotePath !== "string" ||
    !value.remotePath.startsWith("/my-files/") ||
    /[\r\n\0]/.test(value.remotePath)
  ) {
    throw new Error("Invalid Proton backup remote path");
  }
  if (!Array.isArray(value.files) || value.files.length > 10) {
    throw new Error("Invalid Proton backup file list");
  }
  const files = value.files.map((file) => {
    if (
      !isObject(file) ||
      typeof file.name !== "string" ||
      basename(file.name) !== file.name ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("Invalid Proton backup file");
    }
    return { name: file.name, size: file.size };
  });
  return {
    version: BACKUP_VERSION,
    jobId: validateJobId(String(value.jobId)),
    state: state as ProtonBackupState,
    policy: policy as ProtonBackupPolicy,
    remotePath: value.remotePath,
    updatedAt: String(value.updatedAt),
    files,
    error: typeof value.error === "string" ? value.error.slice(0, 5000) : undefined
  };
};

export class ProtonBackupStore {
  constructor(readonly stateDir = getDefaultProtonBackupStateDir()) {}

  async get(jobId: string): Promise<ProtonBackupRecord | null> {
    try {
      const raw = await fs.readFile(
        join(this.stateDir, `${validateJobId(jobId)}.json`),
        "utf-8"
      );
      return validateBackupRecord(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<ProtonBackupRecord[]> {
    try {
      const names = (await fs.readdir(this.stateDir))
        .filter((name) => name.endsWith(".json"));
      const records = await Promise.all(
        names.map((name) => this.get(name.slice(0, -5)))
      );
      return records
        .filter((record): record is ProtonBackupRecord => record !== null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async write(record: ProtonBackupRecord): Promise<ProtonBackupRecord> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(
      join(this.stateDir, `${validateJobId(record.jobId)}.json`),
      record
    );
    return record;
  }
}

const remotePathFor = (config: AppConfig, job: JobRecord): string => {
  const createdAt = new Date(job.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("Job createdAt is invalid");
  }
  return [
    config.proton.targetFolder.replace(/\/$/, ""),
    String(createdAt.getUTCFullYear()),
    String(createdAt.getUTCMonth() + 1).padStart(2, "0"),
    job.id
  ].join("/");
};

const assertRegularFile = async (path: string): Promise<number> => {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Backup input is not a regular file: ${path}`);
  }
  return stat.size;
};

const prepareBackupFiles = async (
  config: AppConfig,
  jobStore: JobStore,
  job: JobRecord,
  dataDir: string
): Promise<LocalBackupFile[]> => {
  const stagingDir = join(dataDir, validateJobId(job.id));
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const sourceName = basename(job.sourcePath);
  if (
    sourceName.length === 0 ||
    sourceName.length > 255 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(sourceName)
  ) {
    throw new Error("Recording source name is unsafe for Proton Drive");
  }
  const manifestPath = join(stagingDir, "manifest.json");
  await writeJsonAtomic(manifestPath, {
    ...jobStore.toManifest(job),
    source: {
      ...job.source,
      mediaFile: sourceName
    },
    backup: {
      provider: "proton-drive",
      policy: config.proton.policy
    }
  });

  const files: LocalBackupFile[] = [
    {
      path: manifestPath,
      name: "manifest.json",
      size: await assertRegularFile(manifestPath)
    }
  ];
  for (const name of ARTIFACT_NAMES) {
    const path = join(job.artifactDir, name);
    files.push({ path, name, size: await assertRegularFile(path) });
  }
  if (config.proton.policy === "full") {
    const size = await assertRegularFile(job.sourcePath);
    if (size !== job.source.size || await hashFile(job.sourcePath) !== job.source.sha256) {
      throw new Error("Recording source no longer matches its SHA-256 manifest");
    }
    files.push({ path: job.sourcePath, name: sourceName, size });
  }
  return files;
};

const stateFor = (
  jobId: string,
  state: ProtonBackupState,
  policy: ProtonBackupPolicy,
  remotePath: string,
  files: ProtonBackupFile[],
  error?: string
): ProtonBackupRecord => ({
  version: BACKUP_VERSION,
  jobId,
  state,
  policy,
  remotePath,
  updatedAt: new Date().toISOString(),
  files,
  error
});

const backupFileRecords = (files: LocalBackupFile[]): ProtonBackupFile[] =>
  files.map(({ name, size }) => ({ name, size }));

const performBackup = async (
  config: AppConfig,
  jobStore: JobStore,
  backupStore: ProtonBackupStore,
  client: ProtonDriveClient,
  job: JobRecord,
  dataDir: string
): Promise<ProtonBackupRecord> => {
  if (!config.proton.enabled) {
    throw new Error("Proton backup is disabled");
  }
  if (job.state !== "completed") {
    throw new Error("Only completed jobs can be backed up");
  }
  const remotePath = remotePathFor(config, job);
  const existing = await backupStore.get(job.id);
  if (
    existing?.state === "completed" &&
    existing.policy === config.proton.policy &&
    existing.remotePath === remotePath
  ) {
    return existing;
  }

  await backupStore.write(
    stateFor(job.id, "pending", config.proton.policy, remotePath, [])
  );
  let files: LocalBackupFile[] = [];
  try {
    files = await prepareBackupFiles(config, jobStore, job, dataDir);
    await backupStore.write(
      stateFor(
        job.id,
        "uploading",
        config.proton.policy,
        remotePath,
        backupFileRecords(files)
      )
    );
    await client.ensureFolder(remotePath);
    const remoteBefore = await client.list(remotePath);
    const pending = files.filter((file) => {
      const remote = remoteBefore.find(
        (item) => item.type === "file" && protonItemName(item) === file.name
      );
      return !remote || protonItemSize(remote) !== file.size;
    });
    await client.upload(pending.map((file) => file.path), remotePath);

    const remoteAfter = await client.list(remotePath);
    for (const file of files) {
      const remote = remoteAfter.find(
        (item) => item.type === "file" && protonItemName(item) === file.name
      );
      if (!remote || protonItemSize(remote) !== file.size) {
        throw new Error(`Proton verification failed for ${file.name}`);
      }
    }
    return await backupStore.write(
      stateFor(
        job.id,
        "completed",
        config.proton.policy,
        remotePath,
        backupFileRecords(files)
      )
    );
  } catch (err) {
    return backupStore.write(
      stateFor(
        job.id,
        "failed",
        config.proton.policy,
        remotePath,
        backupFileRecords(files),
        (err instanceof Error ? err.message : String(err)).slice(0, 5000)
      )
    );
  } finally {
    await fs.rm(join(dataDir, job.id), { recursive: true, force: true })
      .catch(() => undefined);
  }
};

export const backupProtonJob = async (
  config: AppConfig,
  jobId: string,
  jobStore = new JobStore(),
  backupStore = new ProtonBackupStore(),
  client = new ProtonDriveClient(),
  dataDir = getDefaultProtonBackupDataDir(),
  singletonName = "proton-backup"
): Promise<ProtonBackupRecord> => {
  const lease = await acquireSingleton(singletonName);
  try {
    return await performBackup(
      config,
      jobStore,
      backupStore,
      client,
      await jobStore.get(jobId),
      dataDir
    );
  } finally {
    await lease.release();
  }
};

export const syncProtonBackups = async (
  config: AppConfig,
  jobStore = new JobStore(),
  backupStore = new ProtonBackupStore(),
  client = new ProtonDriveClient(),
  dataDir = getDefaultProtonBackupDataDir()
): Promise<ProtonBackupRecord[]> => {
  if (!config.proton.enabled) return [];
  const lease = await acquireSingleton("proton-backup");
  try {
    const results: ProtonBackupRecord[] = [];
    for (const job of await jobStore.list()) {
      if (job.state !== "completed") continue;
      results.push(
        await performBackup(
          config,
          jobStore,
          backupStore,
          client,
          job,
          dataDir
        )
      );
    }
    return results;
  } finally {
    await lease.release();
  }
};
