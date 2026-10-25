// Small private state files (reminders, overrides, calendar salt, Studio inbox, first-run
// metrics): 0700 directories, 0600 files, atomic replace, never following a symlink and
// never reading more than a fixed size.
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { acquireSingleton, type SingletonLease } from "./singleton";

export type PrivateFileProblem = "unsafe" | "too-large" | "invalid-text";

/** Low-level failure; callers turn it into their own Portuguese message. */
export class PrivateFileError extends Error {
  constructor(readonly problem: PrivateFileProblem, path: string) {
    super(`${problem}: ${basename(path)}`);
    this.name = "PrivateFileError";
  }
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code || "";

/** `$XDG_STATE_HOME/recording-cli`, resolved like the job store does. */
export const recordingStateDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  join(env.XDG_STATE_HOME || join(home, ".local", "state"), "recording-cli");

const ownUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * Create the directory (0700 for every part created) and check the last part is a real
 * directory owned by this user. With `tighten`, group/other bits on it are removed.
 */
export const ensurePrivateDirectory = async (path: string, options: { tighten?: boolean } = {}): Promise<void> => {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  const uid = ownUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) throw new PrivateFileError("unsafe", path);
  if (options.tighten && (stat.mode & 0o077) !== 0) await fs.chmod(path, 0o700);
};

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or undefined when it does not exist. Refuses symlinks, FIFOs and oversized files. */
export const readPrivateFile = async (path: string, maxBytes: number): Promise<string | undefined> => {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (errorCode(error) === "ELOOP") throw new PrivateFileError("unsafe", path);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PrivateFileError("unsafe", path);
    if (stat.size > maxBytes) throw new PrivateFileError("too-large", path);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new PrivateFileError("too-large", path);
    try { return decoder.decode(buffer.subarray(0, total)); } catch { throw new PrivateFileError("invalid-text", path); }
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const directory = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY).catch(() => undefined);
  await directory?.sync().catch(() => undefined);
  await directory?.close().catch(() => undefined);
};

/** Write a complete temporary 0600 file next to `path` and return its name. */
const writeTemporary = async (path: string, text: string, maxBytes: number): Promise<string> => {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new PrivateFileError("too-large", path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
};

/** Atomic replace. An existing symlink, directory or other non-file at `path` is refused, not replaced. */
export const writePrivateFile = async (path: string, text: string, maxBytes: number): Promise<void> => {
  const temporary = await writeTemporary(path, text, maxBytes);
  try {
    const target = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
    if (target && !target.isFile()) throw new PrivateFileError("unsafe", path);
    await fs.rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

/**
 * Atomic create-if-absent: the complete file appears at `path` or nothing changes.
 * Returns false when something already exists there (the first writer wins).
 */
export const createPrivateFile = async (path: string, text: string, maxBytes: number): Promise<boolean> => {
  const temporary = await writeTemporary(path, text, maxBytes);
  try {
    await fs.link(temporary, path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

/** Remove a regular file; a missing file is fine, anything that is not a regular file is left alone. */
export const removePrivateFile = async (path: string): Promise<boolean> => {
  const stat = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
  if (!stat) return false;
  if (!stat.isFile()) throw new PrivateFileError("unsafe", path);
  await fs.rm(path, { force: true });
  return true;
};

export type LockOptions = {
  lock?: (name: string) => Promise<SingletonLease>;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts, `delayMs` apart, before giving up with `busyMessage`. */
  attempts?: number;
  delayMs?: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Run `task` while holding the named abstract-socket lock, retrying briefly while another process holds it. */
export const withPrivateLock = async <T>(name: string, busyMessage: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> => {
  const lock = options.lock || acquireSingleton;
  const sleep = options.sleep || defaultSleep;
  const attempts = Math.max(1, options.attempts ?? 40);
  let lease: SingletonLease | undefined;
  for (let attempt = 0; attempt < attempts && !lease; attempt++) {
    try {
      lease = await lock(name);
    } catch (error) {
      if (!/already running/.test(error instanceof Error ? error.message : String(error))) throw error;
      if (attempt + 1 < attempts) await sleep(options.delayMs ?? 50);
    }
  }
  if (!lease) throw new Error(busyMessage);
  try {
    return await task();
  } finally {
    await lease.release();
  }
};

/** Parse JSON text, or undefined when it is not JSON. */
export const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 date-time with a zone, as stored by these modules. */
export const isIsoTime = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));

/** One printable line: control and separator characters become spaces, runs collapse, trimmed and cut at `max` code units. */
export const singleLine = (value: string, max: number): string => {
  let text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu, " ").replace(/\s+/g, " ").trim();
  if (text.length > max) {
    text = text.slice(0, max);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
};
