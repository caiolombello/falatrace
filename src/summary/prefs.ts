// Per-recording summary choices (template and language), one private JSON file per capture
// session or job, keyed like the meeting notes so a later job for the same media finds them.
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SUMMARY_LANGUAGES, type SummaryLanguage } from "../config/defaults";
import type { JobRecord } from "../jobs/types";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";

export type SummaryPrefs = {
  version: 1;
  /** Capture session UUID (the job id when the capture is enqueued) or a job UUID. */
  id: string;
  rev: number;
  /** Template chosen for this recording (a built-in id or custom:<slug>); absent means automatic. */
  templateId?: string;
  /** Language chosen for this recording; absent means the setting. */
  language?: Exclude<SummaryLanguage, "auto">;
  updatedAt: string;
  /** Recording file, when known, so a job created later for the same file finds these choices. */
  sourcePath?: string;
};

export type SaveSummaryPrefsInput = {
  /** `rev` the choices were based on (0 when there were none). */
  expectedRev: number;
  /** "auto", empty or undefined: no template choice. */
  templateId?: string;
  /** "auto" or undefined: no language choice. */
  language?: SummaryLanguage;
  /** Undefined keeps the stored path. */
  sourcePath?: string;
  now?: Date;
};

export type SummaryPrefsStoreDeps = {
  now?: () => Date;
  lock?: (name: string) => Promise<SingletonLease>;
  sleep?: (ms: number) => Promise<void>;
  lockAttempts?: number;
};

export const SUMMARY_PREFS_ERRORS = Object.freeze({
  conflict: "As preferências do resumo mudaram em outra janela; recarregue antes de salvar.",
  invalidId: "Identificador inválido para as preferências do resumo.",
  invalidRev: "Revisão das preferências do resumo inválida.",
  invalidTemplate: "O modelo escolhido para o resumo é inválido.",
  invalidLanguage: "O idioma escolhido para o resumo é inválido.",
  invalidSourcePath: "Caminho da gravação inválido para as preferências do resumo.",
  invalidTime: "Horário inválido para as preferências do resumo.",
  corrupted: "As preferências do resumo desta reunião estão corrompidas; o arquivo foi mantido sem alterações.",
  unsafeDir: "A pasta das preferências do resumo não é segura; ela precisa ser privada e não pode ser um link.",
  unsafeFile: "O arquivo das preferências do resumo não é seguro; ele não pode ser um link nem um arquivo especial.",
  busy: "As preferências do resumo estão sendo salvas por outro processo; tente de novo em instantes."
});
export const SUMMARY_PREFS_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(SUMMARY_PREFS_ERRORS));

export class SummaryPrefsConflictError extends Error {
  constructor() {
    super(SUMMARY_PREFS_ERRORS.conflict);
    this.name = "SummaryPrefsConflictError";
  }
}

export const SUMMARY_PREFS_MAX_FILE_BYTES = 16 * 1024;
export const SUMMARY_PREFS_INDEX_MAX_FILES = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// Same grammar as the summary.template setting, without "auto".
const TEMPLATE_ID = /^([a-z][a-z0-9-]{0,40}|custom:[a-z0-9][a-z0-9-]{0,40})$/;
const MAX_PATH = 4096;
const MAX_LISTED_NAMES = 20_000;

export const defaultSummaryPrefsDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "recording-cli", "summary-prefs");

const fail = (message: string): never => { throw new Error(message); };
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code || "";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const hasControlChars = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
};
const validSourcePath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && isAbsolute(value) && !hasControlChars(value);
const validTemplate = (value: unknown): value is string => typeof value === "string" && TEMPLATE_ID.test(value);
const validLanguage = (value: unknown): value is Exclude<SummaryLanguage, "auto"> =>
  typeof value === "string" && value !== "auto" && (SUMMARY_LANGUAGES as readonly string[]).includes(value);

/** Lowercase UUID v4, or the "invalid id" error. */
export const normalizeSummaryPrefsId = (id: unknown): string => {
  const lower = typeof id === "string" ? id.toLowerCase() : "";
  return UUID.test(lower) ? lower : fail(SUMMARY_PREFS_ERRORS.invalidId);
};

/** Strict reader of a stored file: rebuilds every field and refuses anything unexpected. */
export const validateSummaryPrefs = (value: unknown, expectedId?: string): SummaryPrefs => {
  const corrupted = (): never => fail(SUMMARY_PREFS_ERRORS.corrupted);
  if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) || typeof value.rev !== "number" || !Number.isSafeInteger(value.rev) ||
    value.rev < 1 || !isTime(value.updatedAt) || Object.keys(value).some((key) => !["version", "id", "rev", "templateId", "language", "updatedAt", "sourcePath"].includes(key))) {
    return corrupted();
  }
  const { templateId, language, sourcePath } = value;
  if ((templateId !== undefined && !validTemplate(templateId)) || (language !== undefined && !validLanguage(language)) ||
    (sourcePath !== undefined && !validSourcePath(sourcePath))) return corrupted();
  return {
    version: 1, id: value.id, rev: value.rev,
    ...(validTemplate(templateId) ? { templateId } : {}),
    ...(validLanguage(language) ? { language } : {}),
    updatedAt: value.updatedAt,
    ...(validSourcePath(sourcePath) ? { sourcePath } : {})
  };
};

const decoder = new TextDecoder("utf-8", { fatal: true });

// Never follows a symlink, never blocks on a FIFO, never reads more than the size limit.
const readPrivateFile = async (path: string): Promise<string | undefined> => {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (["ELOOP", "ENXIO"].includes(errorCode(error))) throw new Error(SUMMARY_PREFS_ERRORS.unsafeFile);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(SUMMARY_PREFS_ERRORS.unsafeFile);
    if (stat.size > SUMMARY_PREFS_MAX_FILE_BYTES) throw new Error(SUMMARY_PREFS_ERRORS.corrupted);
    const buffer = Buffer.alloc(SUMMARY_PREFS_MAX_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > SUMMARY_PREFS_MAX_FILE_BYTES) throw new Error(SUMMARY_PREFS_ERRORS.corrupted);
    }
    try { return decoder.decode(buffer.subarray(0, total)); } catch { throw new Error(SUMMARY_PREFS_ERRORS.corrupted); }
  } finally {
    await handle.close();
  }
};

// Private atomic replace: exclusive 0600 temp file, fsync, rename over a regular file only.
const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const target = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
    if (target && !target.isFile()) throw new Error(SUMMARY_PREFS_ERRORS.unsafeFile);
    await fs.rename(temporary, path);
    const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY).catch(() => undefined);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export class SummaryPrefsStore {
  private readonly clock: () => Date;

  constructor(readonly root: string = defaultSummaryPrefsDir(), private readonly deps: SummaryPrefsStoreDeps = {}) {
    this.clock = deps.now || (() => new Date());
  }

  pathFor(id: string): string {
    return join(this.root, `${normalizeSummaryPrefsId(id)}.json`);
  }

  async read(id: string): Promise<SummaryPrefs | undefined> {
    const safeId = normalizeSummaryPrefsId(id);
    if (!await this.checkRoot(false)) return undefined;
    const raw = await readPrivateFile(join(this.root, `${safeId}.json`));
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail(SUMMARY_PREFS_ERRORS.corrupted); }
    return validateSummaryPrefs(parsed, safeId);
  }

  /** Replaces the choices of one recording; `expectedRev` must equal the stored rev (0 when none). */
  async save(id: string, input: SaveSummaryPrefsInput): Promise<SummaryPrefs> {
    const safeId = normalizeSummaryPrefsId(id);
    if (!object(input) || typeof input.expectedRev !== "number" || !Number.isSafeInteger(input.expectedRev) || input.expectedRev < 0) {
      return fail(SUMMARY_PREFS_ERRORS.invalidRev);
    }
    const templateId = input.templateId === undefined || input.templateId === "" || input.templateId === "auto" ? undefined
      : validTemplate(input.templateId) ? input.templateId : fail(SUMMARY_PREFS_ERRORS.invalidTemplate);
    const language = input.language === undefined || input.language === "auto" ? undefined
      : validLanguage(input.language) ? input.language : fail(SUMMARY_PREFS_ERRORS.invalidLanguage);
    const sourcePath = input.sourcePath === undefined ? undefined
      : validSourcePath(input.sourcePath) ? resolve(input.sourcePath) : fail(SUMMARY_PREFS_ERRORS.invalidSourcePath);
    const now = input.now === undefined ? this.clock() : input.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !isTime(now.toISOString())) return fail(SUMMARY_PREFS_ERRORS.invalidTime);
    const lease = await this.lock(safeId);
    try {
      const current = await this.read(safeId);
      const currentRev = current ? current.rev : 0;
      if (input.expectedRev !== currentRev) throw new SummaryPrefsConflictError();
      const keptPath = sourcePath ?? current?.sourcePath;
      const next: SummaryPrefs = {
        version: 1, id: safeId, rev: currentRev + 1,
        ...(templateId ? { templateId } : {}),
        ...(language ? { language } : {}),
        updatedAt: now.toISOString(),
        ...(keptPath ? { sourcePath: keptPath } : {})
      };
      if (current && current.templateId === next.templateId && current.language === next.language && current.sourcePath === next.sourcePath) return current;
      // Nothing chosen and nothing stored: no file for nothing.
      if (!current && !templateId && !language && !keptPath) return { ...next, rev: 0 };
      validateSummaryPrefs(next, safeId);
      await this.checkRoot(true);
      await writePrivateJson(join(this.root, `${safeId}.json`), next);
      return next;
    } finally {
      await lease.release();
    }
  }

  /** Deletes the choices; false when there were none. */
  async remove(id: string): Promise<boolean> {
    const safeId = normalizeSummaryPrefsId(id);
    if (!await this.checkRoot(false)) return false;
    const lease = await this.lock(safeId);
    try {
      const path = join(this.root, `${safeId}.json`);
      const stat = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
      if (!stat) return false;
      if (!stat.isFile() && !stat.isSymbolicLink()) return fail(SUMMARY_PREFS_ERRORS.unsafeFile);
      await fs.unlink(path);
      return true;
    } finally {
      await lease.release();
    }
  }

  /** Stored files, newest first, at most `limit`; `key` changes whenever a file is replaced. */
  async listFiles(limit = SUMMARY_PREFS_INDEX_MAX_FILES): Promise<Array<{ id: string; key: string; mtimeMs: number }>> {
    if (!await this.checkRoot(false)) return [];
    const names = (await fs.readdir(this.root)).filter((name) => FILE_NAME.test(name)).slice(0, MAX_LISTED_NAMES);
    const files: Array<{ id: string; key: string; mtimeMs: number }> = [];
    for (const name of names) {
      const stat = await fs.lstat(join(this.root, name)).catch(() => undefined);
      if (!stat?.isFile()) continue;
      files.push({ id: name.slice(0, -5), key: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`, mtimeMs: stat.mtimeMs });
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1)).slice(0, Math.max(0, limit));
  }

  private async checkRoot(create: boolean): Promise<boolean> {
    if (create) {
      try { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); }
      catch (error) { if (["EEXIST", "ENOTDIR"].includes(errorCode(error))) return fail(SUMMARY_PREFS_ERRORS.unsafeDir); throw error; }
    }
    const stat = await fs.lstat(this.root).catch((error): undefined => {
      if (errorCode(error) === "ENOENT" && !create) return undefined;
      if (errorCode(error) === "ENOTDIR") return fail(SUMMARY_PREFS_ERRORS.unsafeDir);
      throw error;
    });
    if (!stat) return false;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      return fail(SUMMARY_PREFS_ERRORS.unsafeDir);
    }
    return true;
  }

  private async lock(id: string): Promise<SingletonLease> {
    const name = `summary-prefs-${createHash("sha256").update(JSON.stringify([resolve(this.root), id])).digest("hex").slice(0, 32)}`;
    const acquire = this.deps.lock || acquireSingleton;
    const sleep = this.deps.sleep || defaultSleep;
    const attempts = Math.max(1, this.deps.lockAttempts ?? 100);
    for (let attempt = 1; ; attempt++) {
      try {
        return await acquire(name);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("is already running")) throw error;
        if (attempt >= attempts) return fail(SUMMARY_PREFS_ERRORS.busy);
        await sleep(50);
      }
    }
  }
}

// Per-process cache of `sourcePath` per file, refreshed by file identity (size, mtime, inode).
const indexCache = new Map<string, Map<string, { key: string; sourcePath?: string; updatedAt?: string }>>();
export const clearSummaryPrefsIndexCache = (): void => indexCache.clear();

/**
 * The choices for a job: by job id (capture id == job id), else the newest stored choices whose
 * recording file is exactly the job's file. Errors reading the job's own file propagate; damaged
 * files of other recordings are skipped.
 */
export const findSummaryPrefsForJob = async (
  job: Pick<JobRecord, "id" | "sourcePath">,
  store: SummaryPrefsStore = new SummaryPrefsStore(),
  options: { maxFiles?: number } = {}
): Promise<SummaryPrefs | undefined> => {
  const byId = await store.read(job.id);
  if (byId) return byId;
  if (!validSourcePath(job.sourcePath)) return undefined;
  const jobId = normalizeSummaryPrefsId(job.id);
  const target = resolve(job.sourcePath);
  const files = await store.listFiles(options.maxFiles ?? SUMMARY_PREFS_INDEX_MAX_FILES);
  const root = resolve(store.root);
  let cache = indexCache.get(root);
  if (!cache) { cache = new Map(); indexCache.set(root, cache); }
  const seen = new Set<string>();
  const matches: Array<{ id: string; updatedAt: string }> = [];
  for (const file of files) {
    seen.add(file.id);
    let entry = cache.get(file.id);
    if (!entry || entry.key !== file.key) {
      const prefs = await store.read(file.id).catch(() => undefined);
      entry = { key: file.key, sourcePath: prefs?.sourcePath, updatedAt: prefs?.updatedAt };
      cache.set(file.id, entry);
    }
    if (file.id !== jobId && entry.sourcePath === target && entry.updatedAt) matches.push({ id: file.id, updatedAt: entry.updatedAt });
  }
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  matches.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const match of matches) {
    const prefs = await store.read(match.id).catch(() => undefined);
    if (prefs?.sourcePath === target) return prefs;
  }
  return undefined;
};
