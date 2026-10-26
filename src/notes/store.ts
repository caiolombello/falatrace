// Meeting notes typed in the notepad: one private JSON file per capture session or job,
// saved as a whole text with a revision check, so two windows never overwrite each other.
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { JobRecord } from "../jobs/types";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import {
  NOTE_LIMITS, NOTES_ERRORS, type NoteEntry, isCanonicalNoteLine, isNoteEntryId, noteEntryNumber, noteLinesWithinLimits,
  rebaseNoteOffsets, reconcileNoteEntries, splitNoteLines
} from "./lines";

export type MeetingNotes = {
  version: 1;
  /** Capture session UUID (the job id when the capture is enqueued) or a job UUID. */
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 1 after the first save; 0 only on the unsaved value `save` returns for an empty new notepad. */
  rev: number;
  /** Media time reference: capture mediaStartedAt (or startedAt) when typed during a capture. */
  mediaStartedAt?: string;
  /** When the capture stopped; notes typed well after it are not placed on the media timeline. */
  mediaEndedAt?: string;
  /** Recording file of the capture, recorded when known, so a later job for the same media finds these notes. */
  sourcePath?: string;
  title?: string;
  /** Highest entry number ever issued; ids are never reused, even after a line is deleted. */
  seq?: number;
  entries: NoteEntry[];
};

export type SaveNotesInput = {
  /** The whole notepad text. */
  text: string;
  /** `rev` of the notes the text was based on (0 when there were none). */
  expectedRev: number;
  now?: Date;
  mediaStartedAt?: string;
  mediaEndedAt?: string;
  sourcePath?: string;
  /** An empty string clears the title; undefined keeps it. */
  title?: string;
};

export type NotesStoreDeps = {
  now?: () => Date;
  lock?: (name: string) => Promise<SingletonLease>;
  sleep?: (ms: number) => Promise<void>;
  /** Lock attempts, 50 ms apart, before giving up with the "busy" error. */
  lockAttempts?: number;
};

export const NOTES_MAX_FILE_BYTES = 1024 * 1024;
export const NOTES_INDEX_MAX_FILES = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TITLE = 200;
const MAX_PATH = 4096;
const MAX_LISTED_NAMES = 20_000;
const MAX_CACHED_ROOTS = 16;
/** `by-source/<sha256 of the recording path>.json` names the notes last saved for that recording. */
const SOURCE_LINKS_DIR = "by-source";
const sourceLinkName = (sourcePath: string): string => `${createHash("sha256").update(resolve(sourcePath)).digest("hex")}.json`;

export const defaultNotesDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "recording-cli", "notes");

export class NotesConflictError extends Error {
  constructor() {
    super(NOTES_ERRORS.conflict);
    this.name = "NotesConflictError";
  }
}

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
const validTitle = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TITLE && !hasControlChars(value) && value === value.trim();
const validOffset = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= NOTE_LIMITS.maxOffsetSeconds);

/** Lowercase UUID v4 of a notes file, or the "invalid id" error. */
export const normalizeNotesId = (id: unknown): string => {
  const lower = typeof id === "string" ? id.toLowerCase() : "";
  return UUID.test(lower) ? lower : fail(NOTES_ERRORS.invalidId);
};

/** Strict reader of a stored notes file: rebuilds every field and refuses anything unexpected. */
export const validateMeetingNotes = (value: unknown, expectedId?: string): MeetingNotes => {
  const corrupted = (): never => fail(NOTES_ERRORS.corrupted);
  if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) || !isTime(value.createdAt) || !isTime(value.updatedAt) ||
    typeof value.rev !== "number" || !Number.isSafeInteger(value.rev) || value.rev < 1) return corrupted();
  const { mediaStartedAt, mediaEndedAt, sourcePath, title, seq } = value;
  if ((mediaStartedAt !== undefined && !isTime(mediaStartedAt)) || (mediaEndedAt !== undefined && !isTime(mediaEndedAt)) ||
    (isTime(mediaStartedAt) && isTime(mediaEndedAt) && Date.parse(mediaEndedAt) < Date.parse(mediaStartedAt)) ||
    (sourcePath !== undefined && !validSourcePath(sourcePath)) || (title !== undefined && !validTitle(title)) ||
    !Array.isArray(value.entries) || value.entries.length > NOTE_LIMITS.maxEntries) return corrupted();
  const ids = new Set<string>();
  let highest = 0;
  const entries = value.entries.map((raw: unknown): NoteEntry => {
    if (!object(raw) || !isNoteEntryId(raw.id) || ids.has(raw.id) || !isTime(raw.createdAt) || !validOffset(raw.offsetSeconds) ||
      !isCanonicalNoteLine(raw.text)) return corrupted();
    ids.add(raw.id);
    highest = Math.max(highest, noteEntryNumber(raw.id));
    return { id: raw.id, createdAt: raw.createdAt, offsetSeconds: raw.offsetSeconds, text: raw.text };
  });
  if (!noteLinesWithinLimits(entries.map((entry) => entry.text))) return corrupted();
  if (seq !== undefined && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < highest || seq > NOTE_LIMITS.maxSeq)) return corrupted();
  return {
    version: 1, id: value.id, createdAt: value.createdAt, updatedAt: value.updatedAt, rev: value.rev,
    ...(isTime(mediaStartedAt) ? { mediaStartedAt } : {}),
    ...(isTime(mediaEndedAt) ? { mediaEndedAt } : {}),
    ...(validSourcePath(sourcePath) ? { sourcePath } : {}),
    ...(validTitle(title) ? { title } : {}),
    seq: typeof seq === "number" ? seq : highest,
    entries
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
    // ELOOP: a symlink (O_NOFOLLOW); ENXIO: a socket, which open() cannot read.
    if (["ELOOP", "ENXIO"].includes(errorCode(error))) throw new Error(NOTES_ERRORS.unsafeFile);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(NOTES_ERRORS.unsafeFile);
    if (stat.size > NOTES_MAX_FILE_BYTES) throw new Error(NOTES_ERRORS.corrupted);
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > NOTES_MAX_FILE_BYTES) throw new Error(NOTES_ERRORS.corrupted);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    try { return decoder.decode(Buffer.concat(chunks)); } catch { throw new Error(NOTES_ERRORS.corrupted); }
  } finally {
    await handle.close();
  }
};

// Private atomic replace: exclusive 0600 temp file, fsync, rename over a regular file only.
const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > NOTES_MAX_FILE_BYTES) throw new Error(NOTES_ERRORS.tooLarge);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const target = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
    if (target && !target.isFile()) throw new Error(NOTES_ERRORS.unsafeFile);
    await fs.rename(temporary, path);
    const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY).catch(() => undefined);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

// A time that still reads back once normalized: toISOString() writes years past 9999 as
// "+010000-…", which the stored-file validator (rightly) refuses.
const storableTime = (time: number): string | undefined => {
  const iso = new Date(time).toISOString();
  return isTime(iso) ? iso : undefined;
};
const optionalTime = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return (isTime(value) ? storableTime(Date.parse(value)) : undefined) ?? fail(NOTES_ERRORS.invalidMediaTime);
};
const optionalSourcePath = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return validSourcePath(value) ? resolve(value) : fail(NOTES_ERRORS.invalidSourcePath);
};
// Titles come from calendars and window titles: flatten them to one short line.
const optionalTitle = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_PATH) return fail(NOTES_ERRORS.invalidTitle);
  let flat = "";
  for (let index = 0; index < value.length; index++) flat += hasControlChars(value[index]) ? " " : value[index];
  let title = flat.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const last = title.charCodeAt(title.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) title = title.slice(0, -1);
  return title.trim();
};

/** The notes id a source link names, or undefined when the link is damaged. */
const linkedId = (raw: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return object(value) && value.version === 1 && typeof value.id === "string" && UUID.test(value.id) ? value.id : undefined;
  } catch { return undefined; }
};

const sameContent = (a: MeetingNotes, b: MeetingNotes): boolean =>
  JSON.stringify([a.mediaStartedAt, a.mediaEndedAt, a.sourcePath, a.title, a.seq, a.entries.map((e) => [e.id, e.createdAt, e.offsetSeconds, e.text])]) ===
  JSON.stringify([b.mediaStartedAt, b.mediaEndedAt, b.sourcePath, b.title, b.seq, b.entries.map((e) => [e.id, e.createdAt, e.offsetSeconds, e.text])]);

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export class NotesStore {
  private readonly clock: () => Date;

  constructor(readonly root: string = defaultNotesDir(), private readonly deps: NotesStoreDeps = {}) {
    this.clock = deps.now || (() => new Date());
  }

  pathFor(id: string): string {
    return join(this.root, `${normalizeNotesId(id)}.json`);
  }

  async read(id: string): Promise<MeetingNotes | undefined> {
    const safeId = normalizeNotesId(id);
    if (!await this.checkRoot(false)) return undefined;
    const raw = await readPrivateFile(join(this.root, `${safeId}.json`));
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail(NOTES_ERRORS.corrupted); }
    return validateMeetingNotes(parsed, safeId);
  }

  /**
   * Saves the whole notepad text. Lines keep their id and timestamp when unchanged, moved or
   * edited in place; `expectedRev` must equal the stored rev (0 when nothing is stored).
   * An unchanged save returns the stored notes without writing.
   */
  async save(id: string, input: SaveNotesInput): Promise<MeetingNotes> {
    const safeId = normalizeNotesId(id);
    const request = this.prepare(input);
    const lease = await this.lock(safeId);
    try {
      const current = await this.read(safeId);
      const currentRev = current ? current.rev : 0;
      if (request.expectedRev !== currentRev) throw new NotesConflictError();
      const mediaStartedAt = request.mediaStartedAt ?? current?.mediaStartedAt;
      const mediaEndedAt = request.mediaEndedAt ?? current?.mediaEndedAt;
      if (mediaStartedAt && mediaEndedAt && Date.parse(mediaEndedAt) < Date.parse(mediaStartedAt)) return fail(NOTES_ERRORS.invalidMediaTime);
      // A corrected media reference moves the timed notes with it (offsets are createdAt − start).
      const referenceChanged = !!current && (mediaStartedAt !== current.mediaStartedAt || mediaEndedAt !== current.mediaEndedAt);
      const previous = !current ? [] : referenceChanged ? rebaseNoteOffsets(current.entries, mediaStartedAt, mediaEndedAt) : current.entries;
      const { entries, seq } = reconcileNoteEntries(previous, request.lines, {
        now: request.now, mediaStartedAt, mediaEndedAt, seq: current?.seq ?? 0
      });
      const sourcePath = request.sourcePath ?? current?.sourcePath;
      const title = request.title === undefined ? current?.title : request.title || undefined;
      const now = request.now.toISOString();
      const next: MeetingNotes = {
        version: 1, id: safeId, createdAt: current?.createdAt ?? now, updatedAt: now, rev: currentRev + 1,
        ...(mediaStartedAt ? { mediaStartedAt } : {}),
        ...(mediaEndedAt ? { mediaEndedAt } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(title ? { title } : {}),
        seq, entries
      };
      if (current && sameContent(current, next)) return current;
      // An empty notepad that was never saved stays unsaved: no file for nothing.
      if (!current && !entries.length && !mediaStartedAt && !mediaEndedAt && !sourcePath && !title) return { ...next, rev: 0 };
      validateMeetingNotes(next, safeId);
      await this.checkRoot(true);
      // The link first: notes that name a recording are always reachable from it, however old.
      if (sourcePath) await this.linkSource(sourcePath, safeId);
      await writePrivateJson(join(this.root, `${safeId}.json`), next);
      return next;
    } finally {
      await lease.release();
    }
  }

  /** Deletes the notes; false when there were none. */
  async remove(id: string): Promise<boolean> {
    const safeId = normalizeNotesId(id);
    if (!await this.checkRoot(false)) return false;
    const lease = await this.lock(safeId);
    try {
      const path = join(this.root, `${safeId}.json`);
      const stat = await fs.lstat(path).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
      if (!stat) return false;
      // Unlinking a symlink removes the link itself; anything else that is not a file is left alone.
      if (!stat.isFile() && !stat.isSymbolicLink()) return fail(NOTES_ERRORS.unsafeFile);
      await fs.unlink(path);
      return true;
    } finally {
      await lease.release();
    }
  }

  /**
   * The notes last saved for this recording file, through its persistent link: no scan and no
   * recency limit. Undefined when there is no link or the notes it names no longer name the file.
   */
  async readLinked(sourcePath: string): Promise<MeetingNotes | undefined> {
    if (!validSourcePath(sourcePath)) return undefined;
    const target = resolve(sourcePath);
    if (!await this.checkRoot(false)) return undefined;
    const directory = join(this.root, SOURCE_LINKS_DIR);
    if (!await this.checkDirectory(directory, false)) return undefined;
    const raw = await readPrivateFile(join(directory, sourceLinkName(target)));
    if (raw === undefined) return undefined;
    const id = linkedId(raw);
    const notes = id ? await this.read(id) : undefined;
    return notes?.sourcePath === target ? notes : undefined;
  }

  private async linkSource(sourcePath: string, id: string): Promise<void> {
    const directory = join(this.root, SOURCE_LINKS_DIR);
    await this.checkDirectory(directory, true);
    const path = join(directory, sourceLinkName(sourcePath));
    const current = await readPrivateFile(path).catch(() => undefined);
    if (current !== undefined && linkedId(current) === id) return;
    await writePrivateJson(path, { version: 1, id });
  }

  /** Notes files for indexing, newest first, at most `limit`; `key` changes whenever a file is replaced. */
  async listFiles(limit = NOTES_INDEX_MAX_FILES): Promise<Array<{ id: string; key: string; mtimeMs: number }>> {
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

  private prepare(input: SaveNotesInput) {
    if (!object(input)) return fail(NOTES_ERRORS.invalidText);
    const lines = splitNoteLines(input.text);
    if (typeof input.expectedRev !== "number" || !Number.isSafeInteger(input.expectedRev) || input.expectedRev < 0) return fail(NOTES_ERRORS.invalidRev);
    const now = input.now === undefined ? this.clock() : input.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !storableTime(now.getTime())) return fail(NOTES_ERRORS.invalidTime);
    return {
      lines,
      expectedRev: input.expectedRev,
      now: new Date(now.getTime()),
      mediaStartedAt: optionalTime(input.mediaStartedAt),
      mediaEndedAt: optionalTime(input.mediaEndedAt),
      sourcePath: optionalSourcePath(input.sourcePath),
      title: optionalTitle(input.title)
    };
  }

  private checkRoot(create: boolean): Promise<boolean> {
    return this.checkDirectory(this.root, create);
  }

  // The folder must be a real private directory owned by this user.
  private async checkDirectory(path: string, create: boolean): Promise<boolean> {
    if (create) {
      try { await fs.mkdir(path, { recursive: true, mode: 0o700 }); }
      catch (error) { if (["EEXIST", "ENOTDIR"].includes(errorCode(error))) return fail(NOTES_ERRORS.unsafeDir); throw error; }
    }
    const stat = await fs.lstat(path).catch((error): undefined => {
      if (errorCode(error) === "ENOENT" && !create) return undefined;
      if (errorCode(error) === "ENOTDIR") return fail(NOTES_ERRORS.unsafeDir);
      throw error;
    });
    if (!stat) return false;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      return fail(NOTES_ERRORS.unsafeDir);
    }
    return true;
  }

  // One writer per notes file across the Studio, the CLI and background units.
  private async lock(id: string): Promise<SingletonLease> {
    const name = `notes-${createHash("sha256").update(JSON.stringify([resolve(this.root), id])).digest("hex").slice(0, 32)}`;
    const acquire = this.deps.lock || acquireSingleton;
    const sleep = this.deps.sleep || defaultSleep;
    const attempts = Math.max(1, this.deps.lockAttempts ?? 100);
    for (let attempt = 1; ; attempt++) {
      try {
        return await acquire(name);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("is already running")) throw error;
        if (attempt >= attempts) return fail(NOTES_ERRORS.busy);
        await sleep(50);
      }
    }
  }
}

type IndexedNotes = { key: string; sourcePath?: string; createdAt?: string; updatedAt?: string };
type IndexMatch = { id: string; sourcePath: string; createdAt: string; updatedAt: string };

// Per-process cache of `sourcePath` per notes file, refreshed by file identity (size, mtime, inode).
const indexCache = new Map<string, Map<string, IndexedNotes>>();

export const clearNotesIndexCache = (): void => indexCache.clear();

const scanNotesIndex = async (store: NotesStore, maxFiles: number): Promise<IndexMatch[]> => {
  const files = await store.listFiles(maxFiles);
  const root = resolve(store.root);
  let cache = indexCache.get(root);
  if (!cache) {
    cache = new Map();
    indexCache.set(root, cache);
    const oldest = indexCache.keys().next().value;
    if (indexCache.size > MAX_CACHED_ROOTS && oldest !== undefined) indexCache.delete(oldest);
  }
  const seen = new Set<string>();
  const matches: IndexMatch[] = [];
  for (const file of files) {
    seen.add(file.id);
    let entry = cache.get(file.id);
    if (!entry || entry.key !== file.key) {
      // A damaged file belongs to another meeting: skip it here; reading it by id reports it.
      const notes = await store.read(file.id).catch(() => undefined);
      entry = notes?.sourcePath
        ? { key: file.key, sourcePath: notes.sourcePath, createdAt: notes.createdAt, updatedAt: notes.updatedAt }
        : { key: file.key };
      cache.set(file.id, entry);
    }
    if (entry.sourcePath && entry.createdAt && entry.updatedAt) {
      matches.push({ id: file.id, sourcePath: entry.sourcePath, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
    }
  }
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  return matches;
};

const fileStem = (path: string): string => basename(path, extname(path));

const pathExists = async (path: string): Promise<boolean> => {
  try { await fs.lstat(path); return true; }
  catch (error) { return !["ENOENT", "ENOTDIR"].includes(errorCode(error)); }
};

export type FindNotesOptions = {
  /** Whether a recording file still exists (injectable for tests). */
  exists?: (path: string) => Promise<boolean>;
  maxFiles?: number;
};

/**
 * The notes of a job: by job id (capture id == job id), else by the recording file. A job created
 * later with a random id for the same file finds the capture's notes by `sourcePath` (in the scan of
 * recent files, else through the recording's link, however old the notes are); notes of the
 * same recording folder match only when they are the folder's only notes, their recorded file is
 * gone (renamed or converted) and the folder is the capture's own (or the name differs only by
 * extension), so notes never jump to another recording in a shared folder.
 * Errors reading the job's own notes propagate; damaged notes of other meetings are skipped.
 */
export const findNotesForJob = async (
  job: Pick<JobRecord, "id" | "sourcePath">,
  store: NotesStore = new NotesStore(),
  options: FindNotesOptions = {}
): Promise<MeetingNotes | undefined> => {
  const byId = await store.read(job.id);
  if (byId) return byId;
  if (!validSourcePath(job.sourcePath)) return undefined;
  const jobId = normalizeNotesId(job.id);
  const target = resolve(job.sourcePath);
  const index = (await scanNotesIndex(store, options.maxFiles ?? NOTES_INDEX_MAX_FILES)).filter((entry) => entry.id !== jobId);
  const exact = index.filter((entry) => entry.sourcePath === target)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const candidate of exact) {
    const notes = await store.read(candidate.id).catch(() => undefined);
    if (notes?.sourcePath === target) return notes;
  }
  // Older than the scan reaches: the recording's link still names its notes. Without this, a later
  // edit through the job id would create notes that hide the capture's for good.
  const linked = await store.readLinked(target).catch(() => undefined);
  if (linked && linked.id !== jobId) return linked;
  const folder = dirname(target);
  const sameFolder = index.filter((entry) => dirname(entry.sourcePath) === folder);
  if (sameFolder.length !== 1) return undefined;
  const [candidate] = sameFolder;
  // In a flat folder (legacy backends write every recording to one directory) a missing file is
  // no evidence: media retention deletes processed recordings. Only the capture's own folder
  // (named "<title>-<first 8 chars of the capture id>") or the same file name with another
  // extension (a conversion) ties these notes to this recording.
  const ownFolder = basename(folder).toLowerCase().endsWith(`-${candidate.id.slice(0, 8)}`);
  if (!ownFolder && fileStem(candidate.sourcePath) !== fileStem(target)) return undefined;
  if (await (options.exists || pathExists)(candidate.sourcePath)) return undefined;
  const notes = await store.read(candidate.id).catch(() => undefined);
  return notes?.sourcePath && dirname(notes.sourcePath) === folder ? notes : undefined;
};
