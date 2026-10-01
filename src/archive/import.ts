import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { inspectRemoteArchivedSource } from "../jobs/remote";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { validateJobId, validateMediaExtension } from "../jobs/types";
import { ArchiveStore, type ArchiveRecord } from "./store";

export type RemoteLibraryImportReport = {
  imported: number;
  missing: number;
  errors: Array<{ id: string; error: string }>;
};

export type RemoteLibraryImportDependencies = {
  inspect?: typeof inspectRemoteArchivedSource;
  now?: () => Date;
};

const CONCURRENCY = 3;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const LEGACY_OR_MEDIA_RELATIVE =
  /^(?:media\/)?\d{4}\/(?:0[1-9]|1[0-2])\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;

const isInside = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith("../") && !isAbsolute(child);
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000);

const isMissingError = (error: unknown): boolean =>
  /No such file|não foi localizado|não possui|não existe|inexistente|not found|missing/i.test(errorText(error));

const assertJobIdentity = (job: JobRecord): void => {
  validateJobId(job.id);
  validateMediaExtension(job.source.mediaFile);
  if (!/^source\.[a-z0-9]+$/.test(job.source.mediaFile)) {
    throw new Error("Nome de mídia remota inválido.");
  }
  if (!SHA256_PATTERN.test(job.source.sha256)) {
    throw new Error("SHA-256 inválido no job remoto concluído.");
  }
  if (!Number.isSafeInteger(job.source.size) || job.source.size <= 0) {
    throw new Error("Tamanho inválido no job remoto concluído.");
  }
  if (!Number.isFinite(Date.parse(job.createdAt))) {
    throw new Error("createdAt inválido no job remoto concluído.");
  }
};

const validateRemoteResult = (
  job: JobRecord,
  result: Awaited<ReturnType<typeof inspectRemoteArchivedSource>>
): void => {
  if (result.size !== job.source.size) {
    throw new Error("O tamanho da cópia remota diverge do job.");
  }
  if (!result.sha256 || result.sha256.toLowerCase() !== job.source.sha256.toLowerCase()) {
    throw new Error("O SHA-256 da cópia remota diverge do job.");
  }
  const relativeMatch = result.archiveRelative.match(LEGACY_OR_MEDIA_RELATIVE);
  if (!relativeMatch || relativeMatch[1].toLowerCase() !== job.id.toLowerCase()) {
    throw new Error("O caminho relativo da cópia remota diverge do job.");
  }
  if (
    !isAbsolute(result.archiveDir) ||
    resolve(result.archiveDir) !== result.archiveDir ||
    !isAbsolute(result.sourcePath) ||
    resolve(result.sourcePath) !== result.sourcePath ||
    /[\0\r\n]/.test(result.sourcePath)
  ) {
    throw new Error("A cópia remota retornou caminho inválido.");
  }
  const expectedPath = `${result.archiveDir.replace(/\/+$/, "")}/${result.archiveRelative}/${job.source.mediaFile}`;
  if (result.sourcePath !== expectedPath) {
    throw new Error("O caminho da cópia remota não confere com o catálogo.");
  }
};

type ImportOutcome = {
  imported: number;
  missing: number;
  error?: { id: string; error: string };
};

const processGroup = async (
  config: AppConfig,
  jobs: JobRecord[],
  store: ArchiveStore,
  dependencies: RemoteLibraryImportDependencies
): Promise<ImportOutcome> => {
  const inspect = dependencies.inspect || inspectRemoteArchivedSource;
  const failures: Array<{ id: string; error: unknown }> = [];
  for (const job of jobs) {
    try {
      const remote = await inspect(config, job, { verifyHash: true });
      validateRemoteResult(job, remote);
      const checkedAt = dependencies.now ? dependencies.now() : new Date();
      if (Number.isNaN(checkedAt.getTime())) throw new Error("Relógio inválido durante importação.");
      const record: ArchiveRecord = {
        version: 1,
        id: job.id,
        createdAt: job.createdAt,
        sourcePath: job.sourcePath,
        source: {
          fileName: job.source.mediaFile,
          size: job.source.size,
          sha256: job.source.sha256.toLowerCase(),
          mtimeMs: Date.parse(job.createdAt)
        },
        vaio: {
          state: "completed",
          path: remote.sourcePath,
          archiveDir: remote.archiveDir,
          archiveRelative: remote.archiveRelative,
          verifiedAt: checkedAt.toISOString()
        },
        proton: { state: "pending" }
      };
      await store.save(record);
      return { imported: 1, missing: 0 };
    } catch (error) {
      failures.push({ id: job.id, error });
    }
  }
  const allMissing = failures.length > 0 && failures.every(({ error }) => isMissingError(error));
  return {
    imported: 0,
    missing: allMissing ? 1 : 0,
    error: {
      id: jobs[0].id,
      error: failures.map(({ id, error }) => `${id}: ${errorText(error)}`).join("; ").slice(0, 1000)
    }
  };
};

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
};

export const importRemoteLibraryMedia = async (
  config: AppConfig,
  options: { limit?: number; includeCatalogSources?: boolean } = {},
  archiveStore = new ArchiveStore(),
  jobStore = new JobStore(),
  dependencies: RemoteLibraryImportDependencies = {}
): Promise<RemoteLibraryImportReport> => {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit <= 0)
  ) {
    throw new Error("limit deve ser um inteiro positivo.");
  }
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  const report: RemoteLibraryImportReport = { imported: 0, missing: 0, errors: [] };
  const groups = new Map<string, JobRecord[]>();
  for (const job of await jobStore.list()) {
    if (job.target !== "remote" || job.state !== "completed") continue;
    try {
      assertJobIdentity(job);
      if (resolve(job.sourcePath) !== job.sourcePath || (!options.includeCatalogSources && !isInside(recordingsDir, job.sourcePath))) {
        throw new Error("sourcePath está fora de recordingsDir.");
      }
      const group = groups.get(job.sourcePath) || [];
      group.push(job);
      groups.set(job.sourcePath, group);
    } catch (error) {
      report.errors.push({ id: job.id, error: errorText(error) });
    }
  }

  const catalog = await archiveStore.list();
  const candidates: JobRecord[][] = [];
  for (const group of groups.values()) {
    const newest = group[0];
    try {
      try {
        await fs.lstat(newest.sourcePath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const identities = new Set(
        group.map((job) =>
          `${job.source.mediaFile}:${job.source.size}:${job.source.sha256.toLowerCase()}`
        )
      );
      if (identities.size !== 1) {
        throw new Error("Jobs do mesmo sourcePath possuem identidade de mídia divergente.");
      }
      const matching = catalog.find(
        (record) =>
          record.sourcePath === newest.sourcePath &&
          record.source.fileName === newest.source.mediaFile &&
          record.source.size === newest.source.size &&
          record.source.sha256?.toLowerCase() === newest.source.sha256.toLowerCase()
      );
      if (matching) continue;
      const conflicting = catalog.find(
        (record) => record.sourcePath === newest.sourcePath || group.some((job) => job.id === record.id)
      );
      if (conflicting) {
        throw new Error("Identidade divergente já existe no catálogo de backup.");
      }
      candidates.push(group);
    } catch (error) {
      report.errors.push({ id: newest.id, error: errorText(error) });
    }
  }

  const selected = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  const outcomes = await mapWithConcurrency(selected, CONCURRENCY, (group) =>
    processGroup(config, group, archiveStore, dependencies)
  );
  for (const outcome of outcomes) {
    report.imported += outcome.imported;
    report.missing += outcome.missing;
    if (outcome.error) report.errors.push(outcome.error);
  }
  return report;
};
