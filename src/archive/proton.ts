import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { hashFile, writeJsonAtomic } from "../jobs/store";
import { validateJobId, validateMediaExtension } from "../jobs/types";
import { ProtonDriveClient, protonItemName, protonItemSize } from "../proton/upload";
import type { ArchiveMediaInput } from "./remote";

export type MediaBackupClient = Pick<ProtonDriveClient, "list" | "ensureFolder" | "uploadImmutable" | "download">;
export const getArchiveDataDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "media-archive");

export const protonMediaPath = (config: AppConfig, media: Pick<ArchiveMediaInput, "id" | "createdAt">): string => {
  validateJobId(media.id);
  if (!Number.isFinite(Date.parse(media.createdAt))) throw new Error("Invalid media backup identity");
  return `${config.proton.targetFolder}/media/${new Date(media.createdAt).toISOString().slice(0, 7).replace("-", "/")}/${media.id}`;
};

const verifyFile = async (path: string, media: Pick<ArchiveMediaInput, "source">): Promise<void> => {
  if (!/^source\.[a-z0-9]+$/.test(media.source.fileName) || !/^[a-f0-9]{64}$/.test(media.source.sha256) || !Number.isSafeInteger(media.source.size) || media.source.size <= 0) {
    throw new Error("Invalid media backup source");
  }
  validateMediaExtension(media.source.fileName);
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== media.source.size || await hashFile(path) !== media.source.sha256) {
    throw new Error("O vídeo restaurado do Proton não confere com o SHA-256 do original");
  }
};

export const restoreProtonMedia = async (
  config: AppConfig,
  media: ArchiveMediaInput,
  client: MediaBackupClient = new ProtonDriveClient(),
  dataDir = getArchiveDataDir()
): Promise<string> => {
  const remotePath = protonMediaPath(config, media);
  if (!/^source\.[a-z0-9]+$/.test(media.source.fileName)) throw new Error("Invalid media filename");
  const cache = join(dataDir, "restored", media.id);
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const finalPath = join(cache, media.source.fileName);
  try { await verifyFile(finalPath, media); return finalPath; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Preserve a damaged derived cache for inspection and allow a fresh verified restore.
      const stat = await fs.lstat(finalPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw error;
      await fs.rename(finalPath, join(cache, `.corrupt-${randomUUID()}`));
    }
  }
  const scratch = await fs.mkdtemp(join(cache, ".restore-"));
  try {
    await client.download([`${remotePath}/${media.source.fileName}`], scratch);
    const downloaded = join(scratch, media.source.fileName);
    await verifyFile(downloaded, media);
    // Hard link publishes without replacing a concurrently restored cache entry.
    try { await fs.link(downloaded, finalPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await verifyFile(finalPath, media); }
    return finalPath;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
};

/** A successful upload is verified by downloading the original and comparing SHA-256. */
export const archiveMediaToProton = async (
  config: AppConfig,
  media: ArchiveMediaInput,
  client: MediaBackupClient = new ProtonDriveClient(),
  dataDir = getArchiveDataDir()
): Promise<{ path: string; verifiedAt: string }> => {
  await verifyFile(media.sourcePath, media);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const scratch = await fs.mkdtemp(join(dataDir, ".upload-"));
  const remotePath = protonMediaPath(config, media);
  try {
    const stagedMedia = join(scratch, media.source.fileName);
    await fs.copyFile(media.sourcePath, stagedMedia, constants.COPYFILE_EXCL);
    await verifyFile(stagedMedia, media);
    const manifest = join(scratch, "manifest.json");
    await writeJsonAtomic(manifest, { version: 1, id: media.id, createdAt: media.createdAt, source: media.source });
    await client.ensureFolder(remotePath);
    const existing = await client.list(remotePath);
    const original = existing.find((item) => protonItemName(item) === media.source.fileName);
    if (original && (original.type !== "file" || protonItemSize(original) !== media.source.size)) {
      throw new Error("Já existe uma mídia divergente no Proton; a cópia remota foi preservada");
    }
    await client.uploadImmutable([stagedMedia, manifest], remotePath);
    const restoreDir = join(scratch, "verification"); await fs.mkdir(restoreDir, { mode: 0o700 });
    await client.download([`${remotePath}/${media.source.fileName}`, `${remotePath}/manifest.json`], restoreDir);
    await verifyFile(join(restoreDir, media.source.fileName), media);
    const restoredManifest = JSON.parse(await fs.readFile(join(restoreDir, "manifest.json"), "utf8"));
    if (restoredManifest.id !== media.id || restoredManifest.source?.sha256 !== media.source.sha256 || restoredManifest.source?.size !== media.source.size || restoredManifest.source?.fileName !== media.source.fileName) {
      throw new Error("O manifesto restaurado do Proton não confere com o original");
    }
    await verifyFile(media.sourcePath, media);
    return { path: `${remotePath}/${media.source.fileName}`, verifiedAt: new Date().toISOString() };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
};
