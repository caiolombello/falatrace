import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { hashFile, writeJsonAtomic } from "../jobs/store";
import { validateJobId, validateMediaExtension } from "../jobs/types";
import { acquireSingleton } from "../runtime/singleton";

export type ArchiveCopy =
  | { state: "pending" }
  | { state: "failed"; error: string; attemptedAt: string }
  | { state: "completed"; path: string; verifiedAt: string; archiveDir?: string; archiveRelative?: string };

export type ArchiveRecord = {
  version: 1;
  id: string;
  createdAt: string;
  sourcePath: string;
  source: { fileName: string; size: number; mtimeMs: number; sha256?: string };
  vaio: ArchiveCopy;
  proton: ArchiveCopy;
};

export const getArchiveStateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "recording-cli", "media-archive");

const validCopy = (copy: ArchiveCopy): boolean => {
  if (!copy || !["pending", "failed", "completed"].includes(copy.state)) return false;
  if (copy.state === "failed") return typeof copy.error === "string" && Number.isFinite(Date.parse(copy.attemptedAt));
  if (copy.state === "completed") return typeof copy.path === "string" && !/[\r\n\0]/.test(copy.path) && Number.isFinite(Date.parse(copy.verifiedAt));
  return true;
};

export const validateArchiveRecord = (record: ArchiveRecord): ArchiveRecord => {
  validateJobId(record.id);
  if (record.version !== 1 || typeof record.sourcePath !== "string" || !isAbsolute(record.sourcePath) || /[\r\n\0]/.test(record.sourcePath) ||
    !Number.isFinite(Date.parse(record.createdAt)) || !record.source ||
    !/^source\.[a-z0-9]+$/.test(record.source.fileName) ||
    !Number.isSafeInteger(record.source.size) || record.source.size <= 0 || !Number.isFinite(record.source.mtimeMs) ||
    (record.source.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.source.sha256)) ||
    !validCopy(record.vaio) || !validCopy(record.proton)) throw new Error("Invalid media archive record; state retained");
  validateMediaExtension(record.source.fileName);
  return record;
};

/** Durable outbox for original media. It has no dependency on transcription state. */
export class ArchiveStore {
  constructor(readonly stateDir = getArchiveStateDir()) {}
  private path(id: string): string { return join(this.stateDir, `${validateJobId(id)}.json`); }
  async get(id: string): Promise<ArchiveRecord | null> {
    try {
      const record = validateArchiveRecord(JSON.parse(await fs.readFile(this.path(id), "utf8")));
      if (record.id !== id) throw new Error("Media archive id mismatch");
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async list(): Promise<ArchiveRecord[]> {
    const names = await fs.readdir(this.stateDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const records: ArchiveRecord[] = [];
    for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try {
        const record = await this.get(name.slice(0, -5)); if (record) records.push(record);
      } catch {
        console.warn(`Catálogo de backup: registro ${name} inválido; arquivo preservado para recuperação.`);
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async save(record: ArchiveRecord): Promise<void> {
    validateArchiveRecord(record);
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.path(record.id), record);
  }
  async enqueue(filePath: string, options: { id?: string; createdAt?: string } = {}): Promise<ArchiveRecord> {
    const sourcePath = resolve(filePath);
    const key = createHash("sha256").update(`${this.stateDir}:${sourcePath}`).digest("hex").slice(0, 32);
    const lease = await acquireSingleton(`archive-enqueue-${key}`);
    try {
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error("Media archive requires a nonempty regular file");
      const extension = validateMediaExtension(sourcePath);
      const records = await this.list();
      const existing = (options.id ? await this.get(options.id) : null) || records.find((record) => record.sourcePath === sourcePath);
      if (existing) {
        if (existing.sourcePath !== sourcePath || existing.source.size !== stat.size || existing.source.mtimeMs !== stat.mtimeMs) {
          throw new Error("Archived recording identity changed; original catalog retained");
        }
        return existing;
      }
      const record: ArchiveRecord = { version: 1, id: options.id || randomUUID(), createdAt: options.createdAt || stat.mtime.toISOString(),
        sourcePath, source: { fileName: `source${extension}`, size: stat.size, mtimeMs: stat.mtimeMs }, vaio: { state: "pending" }, proton: { state: "pending" } };
      await this.save(record); return record;
    } finally { await lease.release(); }
  }
  async seal(id: string): Promise<ArchiveRecord> {
    const record = await this.get(id); if (!record) throw new Error("Media archive record not found");
    const before = await fs.lstat(record.sourcePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== record.source.size || before.mtimeMs !== record.source.mtimeMs) {
      throw new Error("Recording changed after finalization; pending archive retained");
    }
    const sha256 = await hashFile(record.sourcePath);
    const after = await fs.lstat(record.sourcePath);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      (record.source.sha256 && record.source.sha256 !== sha256)) throw new Error("Recording changed during checksum verification");
    record.source.sha256 = sha256; await this.save(record); return record;
  }
}
