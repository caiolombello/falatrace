import type { AppConfig } from "../config/defaults";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { acquireSingleton } from "../runtime/singleton";
import { ArchiveStore, type ArchiveRecord } from "./store";
import { archiveMediaToVaio, downloadArchivedMedia, type ArchiveMediaInput } from "./remote";
import { archiveMediaToProton, getArchiveDataDir } from "./proton";

export type ArchiveSyncDependencies = {
  vaio?: typeof archiveMediaToVaio;
  proton?: typeof archiveMediaToProton;
  downloadVaio?: typeof downloadArchivedMedia;
  dataDir?: string;
};

export const sealedArchiveMedia = (record: ArchiveRecord): ArchiveMediaInput => {
  if (!record.source.sha256) throw new Error("A gravação ainda aguarda o cálculo do checksum");
  return { id: record.id, createdAt: record.createdAt, sourcePath: record.sourcePath,
    source: { fileName: record.source.fileName, size: record.source.size, sha256: record.source.sha256 } };
};

export const syncMediaArchive = async (
  config: AppConfig,
  options: { id?: string; limit?: number } = {},
  store = new ArchiveStore(),
  dependencies: ArchiveSyncDependencies = {}
): Promise<ArchiveRecord[]> => {
  if (!config.archive.enabled) return [];
  const catalogKey = createHash("sha256").update(resolve(store.stateDir)).digest("hex").slice(0, 16);
  const lease = await acquireSingleton(`media-archive-sync-${catalogKey}`);
  try {
    let records = options.id ? [await store.get(options.id)].filter((record): record is ArchiveRecord => !!record) : await store.list();
    if (options.id && records.length === 0) throw new Error("Gravação não encontrada no catálogo de backup");
    records = records.filter((record) => (config.archive.vaio && record.vaio.state !== "completed") || (config.archive.proton && record.proton.state !== "completed"));
    // Try new captures first, then rotate retries so a failing batch cannot block the library.
    const pending = (record: ArchiveRecord) => (["vaio", "proton"] as const).some((target) => config.archive[target] && record[target].state === "pending");
    const attemptedAt = (record: ArchiveRecord) => Math.min(...(["vaio", "proton"] as const).flatMap((target) => {
      const copy = record[target];
      return config.archive[target] && copy.state === "failed" ? [Date.parse(copy.attemptedAt) || 0] : [];
    }));
    records.sort((a, b) => Number(pending(b)) - Number(pending(a)) ||
      (pending(a) ? b.createdAt.localeCompare(a.createdAt) : attemptedAt(a) - attemptedAt(b)) || a.id.localeCompare(b.id));
    if (options.limit !== undefined) records = records.slice(0, options.limit);
    const results: ArchiveRecord[] = [];
    for (let record of records) {
      let media: ArchiveMediaInput;
      let scratch: string | undefined;
      try {
      try {
        const local = await fs.lstat(record.sourcePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
        });
        if (!local && record.vaio.state === "completed" && record.vaio.archiveRelative && record.source.sha256) {
          const dataDir = dependencies.dataDir || getArchiveDataDir();
          await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
          scratch = await fs.mkdtemp(join(dataDir, ".from-vaio-"));
          const sourcePath = join(scratch, record.source.fileName);
          await (dependencies.downloadVaio || downloadArchivedMedia)(config, { archiveRelative: record.vaio.archiveRelative,
            fileName: record.source.fileName, size: record.source.size, sha256: record.source.sha256 }, sourcePath);
          media = { ...sealedArchiveMedia(record), sourcePath };
        } else {
          record = await store.seal(record.id); media = sealedArchiveMedia(record);
        }
      }
      catch (error) {
        const failed = { state: "failed" as const, error: error instanceof Error ? error.message : String(error), attemptedAt: new Date().toISOString() };
        if (config.archive.vaio && record.vaio.state !== "completed") record.vaio = failed;
        if (config.archive.proton && record.proton.state !== "completed") record.proton = failed;
        await store.save(record); results.push(record);
        continue;
      }
      // Each destination succeeds independently; an offline VAIO must not prevent the cloud backup.
      for (const target of ["vaio", "proton"] as const) {
        if (!config.archive[target] || record[target].state === "completed") continue;
        try {
          if (target === "vaio") {
            const result = await (dependencies.vaio || archiveMediaToVaio)(config, media);
            record.vaio = { state: "completed", path: result.sourcePath, archiveDir: result.archiveDir, archiveRelative: result.archiveRelative, verifiedAt: result.verifiedAt };
          } else {
            const result = await (dependencies.proton || archiveMediaToProton)(config, media);
            record.proton = { state: "completed", ...result };
          }
        } catch (error) {
          record[target] = { state: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 1000), attemptedAt: new Date().toISOString() };
        }
        await store.save(record);
      }
      results.push(record);
      } finally {
        if (scratch) await fs.rm(scratch, { recursive: true, force: true });
      }
    }
    return results;
  } finally { await lease.release(); }
};
