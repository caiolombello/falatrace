import { randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FactAction, FactAttendee, FactClient, FactDecision, FactSpeaker, IndexChunk, JobFacts } from "./types";

/**
 * Files of the library index: `<root>/jobs/<jobId>.json`, `<root>/embeddings/<jobId>.json` and
 * `<root>/tombstones/<jobId>` (a recording removed from the index, see LibraryIndex.removeJob).
 * The index is derived data (rebuildable at any time), but it holds meeting text, so it is kept
 * private: directories 0700, files 0600, atomic writes, no symbolic links, strict validation.
 */

export const LIBRARY_INDEX_LIMITS = Object.freeze({
  jobs: 2_000,
  chunksPerJob: 6_000,
  segmentsPerJob: 100_000,
  chunkCharacters: 4_000,
  segmentIdsPerChunk: 400,
  indexFileBytes: 32 * 1024 * 1024,
  embeddingsFileBytes: 64 * 1024 * 1024,
  embeddingDimensions: 8_192
});

export const INDEX_STORE_UNSAFE = "O índice da biblioteca está em uma pasta insegura; verifique as permissões.";
export const INVALID_JOB_ID = "Identificador de gravação inválido.";
const INVALID_FILE = "Arquivo do índice da biblioteca inválido";

/** Where a segment sits in time and who spoke, for rendering `[s000123 12:03 Ana]` lines. */
export type SegmentInfo = { id: string; start: number; end: number; speaker?: string };

/** One recording in the index. `probe` is a cheap signature of the files it was built from. */
export type StoredJobIndex = { version: 1; probe: string; facts: JobFacts; chunks: IndexChunk[]; segments: SegmentInfo[] };

/** Embedding vectors aligned with `chunks` of the job index whose fingerprint they carry. */
export type StoredEmbeddings = { version: 1; model: string; dims: number; fingerprint: string; vectors: string[] };

export type FileSignature = { mtimeMs: number; size: number; ino: number };

export const defaultIndexRoot = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "recording-cli", "knowledge-index");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT_ID = /^s\d{6}$/;
const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;
const CLIENT_SOURCES = ["entry-locked", "entry-confident", "entry-split", "content-match", "manual"] as const;

export const isJobId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const fail = (): never => { throw new Error(INVALID_FILE); };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail();
};
const CONTROL = /\p{Cc}/u;
// Tabs and line breaks are allowed (chunk text keeps one segment per line); other control characters are not.
const text = (value: unknown, maximum: number, required = false): string =>
  typeof value === "string" && value.length <= maximum && (!required || value.length > 0) && !CONTROL.test(value.replace(/[\t\n]/g, "")) ? value : fail();
const optionalText = (value: unknown, maximum: number): string | undefined => value === undefined ? undefined : text(value, maximum);
const flag = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const seconds = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e7 ? value : fail();
const integer = (value: unknown, maximum: number): number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum ? value as number : fail();
const sha = (value: unknown): string => typeof value === "string" && SHA256.test(value) ? value : fail();
const optionalSha = (value: unknown): string | undefined => value === undefined ? undefined : sha(value);
const list = <T>(value: unknown, maximum: number, item: (entry: unknown, index: number) => T): T[] =>
  Array.isArray(value) && value.length <= maximum ? value.map(item) : fail();
const segmentIds = (value: unknown, maximum: number): string[] => list(value, maximum, (entry) => typeof entry === "string" && SEGMENT_ID.test(entry) ? entry : fail());
// File names may hold any character but NUL; the path is only displayed and compared.
const path = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\u0000") ? value : fail();
const isoDate = (value: unknown): string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fail();
const defined = <T extends Record<string, unknown>>(value: T): T => {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
};

const validateSpeaker = (value: unknown): FactSpeaker => {
  const item = record(value); onlyKeys(item, ["speakerId", "label", "confirmed"]);
  return { speakerId: text(item.speakerId, 20, true), label: text(item.label, 80, true), confirmed: flag(item.confirmed) };
};
const validateAttendee = (value: unknown): FactAttendee => {
  const item = record(value); onlyKeys(item, ["name", "self"]);
  return { name: text(item.name, 200, true), self: flag(item.self) };
};
export const validateFactClient = (value: unknown): FactClient => {
  const item = record(value); onlyKeys(item, ["code", "name", "source", "confidence"]);
  const code = text(item.code, 20, true);
  if (!CLIENT_CODE.test(code)) fail();
  const source = CLIENT_SOURCES.find((entry) => entry === item.source) ?? fail();
  const confidence = typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : fail();
  return { code, name: text(item.name, 200), source, confidence };
};
const validateDecision = (value: unknown): FactDecision => {
  const item = record(value); onlyKeys(item, ["index", "text", "segmentIds"]);
  return { index: integer(item.index, 10_000), text: text(item.text, 1_000, true), segmentIds: segmentIds(item.segmentIds, 64) };
};
const validateAction = (value: unknown): FactAction => {
  const item = record(value); onlyKeys(item, ["index", "text", "owner", "dueDate", "segmentIds", "origin"]);
  const origin = item.origin === "model" || item.origin === "note" ? item.origin : fail();
  return { index: integer(item.index, 10_000), text: text(item.text, 1_000, true), owner: text(item.owner, 500), dueDate: text(item.dueDate, 100),
    segmentIds: segmentIds(item.segmentIds, 64), origin };
};

export const validateJobFacts = (value: unknown): JobFacts => {
  const item = record(value);
  onlyKeys(item, ["version", "jobId", "mediaSha256", "sourcePath", "title", "date", "durationSeconds", "fingerprint", "transcriptArtifactSha256",
    "summaryArtifactSha256", "revision", "template", "language", "speakers", "attendees", "calendar", "clients", "overview", "topics", "decisions",
    "actions", "noteCount"]);
  if (item.version !== 1 || !isJobId(item.jobId)) fail();
  let template: JobFacts["template"];
  if (item.template !== undefined) {
    const value = record(item.template); onlyKeys(value, ["id", "source"]);
    template = { id: text(value.id, 100, true), source: text(value.source, 40, true) };
  }
  let calendar: JobFacts["calendar"];
  if (item.calendar !== undefined) {
    const value = record(item.calendar); onlyKeys(value, ["title", "eventIdHash", "seriesIdHash", "recurring"]);
    calendar = defined({ title: text(value.title, 200), eventIdHash: optionalSha(value.eventIdHash), seriesIdHash: optionalSha(value.seriesIdHash),
      recurring: flag(value.recurring) });
  }
  return defined({
    version: 1 as const,
    jobId: item.jobId as string,
    mediaSha256: sha(item.mediaSha256),
    sourcePath: path(item.sourcePath),
    title: text(item.title, 200, true),
    date: isoDate(item.date),
    durationSeconds: item.durationSeconds === undefined ? undefined : seconds(item.durationSeconds),
    fingerprint: sha(item.fingerprint),
    transcriptArtifactSha256: optionalSha(item.transcriptArtifactSha256),
    summaryArtifactSha256: optionalSha(item.summaryArtifactSha256),
    revision: integer(item.revision, 1_000_000),
    template,
    language: optionalText(item.language, 20),
    speakers: list(item.speakers, 100, validateSpeaker),
    attendees: list(item.attendees, 50, validateAttendee),
    calendar,
    clients: list(item.clients, 50, validateFactClient),
    overview: text(item.overview, 4_000),
    topics: list(item.topics, 50, (entry) => text(entry, 300, true)),
    decisions: list(item.decisions, 200, validateDecision),
    actions: list(item.actions, 300, validateAction),
    noteCount: integer(item.noteCount, 10_000)
  });
};

const validateChunk = (value: unknown, jobId: string): IndexChunk => {
  const item = record(value); onlyKeys(item, ["chunkId", "jobId", "kind", "segmentIds", "start", "end", "speakers", "text"]);
  const chunkId = text(item.chunkId, 200, true);
  if (item.jobId !== jobId || !chunkId.startsWith(`${jobId}:`)) fail();
  const kind = item.kind === "segments" || item.kind === "summary" || item.kind === "note" ? item.kind : fail();
  return defined({
    chunkId, jobId, kind,
    segmentIds: segmentIds(item.segmentIds, LIBRARY_INDEX_LIMITS.segmentIdsPerChunk),
    start: item.start === undefined ? undefined : seconds(item.start),
    end: item.end === undefined ? undefined : seconds(item.end),
    speakers: item.speakers === undefined ? undefined : list(item.speakers, 50, (entry) => text(entry, 80, true)),
    text: text(item.text, LIBRARY_INDEX_LIMITS.chunkCharacters, true)
  });
};

const validateSegment = (value: unknown): SegmentInfo => {
  const item = record(value); onlyKeys(item, ["id", "start", "end", "speaker"]);
  const id = typeof item.id === "string" && SEGMENT_ID.test(item.id) ? item.id : fail();
  return defined({ id, start: seconds(item.start), end: seconds(item.end), speaker: optionalText(item.speaker, 80) });
};

export const validateStoredJobIndex = (value: unknown): StoredJobIndex => {
  const item = record(value); onlyKeys(item, ["version", "probe", "facts", "chunks", "segments"]);
  if (item.version !== 1) fail();
  const facts = validateJobFacts(item.facts);
  const chunks = list(item.chunks, LIBRARY_INDEX_LIMITS.chunksPerJob, (entry) => validateChunk(entry, facts.jobId));
  if (new Set(chunks.map((chunk) => chunk.chunkId)).size !== chunks.length) fail();
  return { version: 1, probe: sha(item.probe), facts, chunks, segments: list(item.segments, LIBRARY_INDEX_LIMITS.segmentsPerJob, validateSegment) };
};

export const validateStoredEmbeddings = (value: unknown): StoredEmbeddings => {
  const item = record(value); onlyKeys(item, ["version", "model", "dims", "fingerprint", "vectors"]);
  if (item.version !== 1) fail();
  const dims = integer(item.dims, LIBRARY_INDEX_LIMITS.embeddingDimensions);
  if (dims < 1) fail();
  const encodedLength = Math.ceil((dims * 4) / 3) * 4;
  const vectors = list(item.vectors, LIBRARY_INDEX_LIMITS.chunksPerJob, (entry) =>
    typeof entry === "string" && entry.length === encodedLength && /^[A-Za-z0-9+/]*={0,2}$/.test(entry) ? entry : fail());
  return { version: 1, model: text(item.model, 200, true), dims, fingerprint: sha(item.fingerprint), vectors };
};

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

const assertPrivateDirectory = async (path: string): Promise<boolean> => {
  let stat: Stats;
  try { stat = await fs.lstat(path); } catch (error) { if (missing(error)) return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(INDEX_STORE_UNSAFE);
  return true;
};

const readPrivateFile = async (path: string, maximumBytes: number): Promise<{ raw: string; signature: FileSignature } | undefined> => {
  let handle: FileHandle;
  try { handle = await fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (missing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(INDEX_STORE_UNSAFE);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(INDEX_STORE_UNSAFE);
    if (stat.size > maximumBytes) throw new Error(INVALID_FILE);
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error(INVALID_FILE);
    return { raw: buffer.subarray(0, size).toString("utf8"), signature: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino } };
  } finally {
    await handle.close();
  }
};

const fileSignature = async (path: string): Promise<FileSignature | undefined> => {
  try {
    const stat = await fs.lstat(path);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino } : undefined;
  } catch (error) { if (missing(error)) return undefined; throw error; }
};

export class IndexStore {
  readonly jobsDir: string;
  readonly embeddingsDir: string;
  readonly tombstonesDir: string;

  constructor(readonly root = defaultIndexRoot()) {
    this.jobsDir = join(root, "jobs");
    this.embeddingsDir = join(root, "embeddings");
    this.tombstonesDir = join(root, "tombstones");
  }

  private jobPath(jobId: string): string {
    if (!isJobId(jobId)) throw new Error(INVALID_JOB_ID);
    return join(this.jobsDir, `${jobId.toLowerCase()}.json`);
  }

  private embeddingsPath(jobId: string): string {
    if (!isJobId(jobId)) throw new Error(INVALID_JOB_ID);
    return join(this.embeddingsDir, `${jobId.toLowerCase()}.json`);
  }

  private tombstonePath(jobId: string): string {
    if (!isJobId(jobId)) throw new Error(INVALID_JOB_ID);
    return join(this.tombstonesDir, jobId.toLowerCase());
  }

  /** Creates the private directories (or checks them) before a write. */
  async ensure(): Promise<void> {
    for (const path of [this.root, this.jobsDir, this.embeddingsDir, this.tombstonesDir]) {
      await fs.mkdir(path, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(path);
    }
  }

  /** Job ids with an index file; an absent index is empty. */
  async listJobIds(): Promise<string[]> {
    if (!await assertPrivateDirectory(this.root) || !await assertPrivateDirectory(this.jobsDir)) return [];
    const names = await fs.readdir(this.jobsDir);
    return names.filter((name) => name.endsWith(".json") && isJobId(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  }

  /** Job ids with an embeddings file (to find files left without their index entry). */
  async listEmbeddingIds(): Promise<string[]> {
    if (!await assertPrivateDirectory(this.root) || !await assertPrivateDirectory(this.embeddingsDir)) return [];
    const names = await fs.readdir(this.embeddingsDir);
    return names.filter((name) => name.endsWith(".json") && isJobId(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  }

  /** Cheap change check for the in-memory cache. */
  async signature(jobId: string): Promise<FileSignature | undefined> {
    return fileSignature(this.jobPath(jobId));
  }

  async embeddingsSignature(jobId: string): Promise<FileSignature | undefined> {
    return fileSignature(this.embeddingsPath(jobId));
  }

  /** The stored entry, or undefined when absent. Throws when the file is unsafe or invalid. */
  async readJob(jobId: string): Promise<{ entry: StoredJobIndex; signature: FileSignature } | undefined> {
    if (!await assertPrivateDirectory(this.root) || !await assertPrivateDirectory(this.jobsDir)) return undefined;
    const file = await readPrivateFile(this.jobPath(jobId), LIBRARY_INDEX_LIMITS.indexFileBytes);
    if (!file) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(file.raw); } catch { throw new Error(INVALID_FILE); }
    const entry = validateStoredJobIndex(parsed);
    if (entry.facts.jobId.toLowerCase() !== jobId.toLowerCase()) throw new Error(INVALID_FILE);
    return { entry, signature: file.signature };
  }

  async writeJob(entry: StoredJobIndex): Promise<void> {
    const checked = validateStoredJobIndex(entry);
    await this.ensure();
    await this.writeAtomic(this.jobPath(checked.facts.jobId), JSON.stringify(checked), LIBRARY_INDEX_LIMITS.indexFileBytes);
  }

  async removeJob(jobId: string): Promise<void> {
    await fs.rm(this.jobPath(jobId), { force: true });
    await fs.rm(this.embeddingsPath(jobId), { force: true });
  }

  async readEmbeddings(jobId: string): Promise<{ value: StoredEmbeddings; signature: FileSignature } | undefined> {
    if (!await assertPrivateDirectory(this.root) || !await assertPrivateDirectory(this.embeddingsDir)) return undefined;
    const file = await readPrivateFile(this.embeddingsPath(jobId), LIBRARY_INDEX_LIMITS.embeddingsFileBytes);
    if (!file) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(file.raw); } catch { throw new Error(INVALID_FILE); }
    return { value: validateStoredEmbeddings(parsed), signature: file.signature };
  }

  async writeEmbeddings(jobId: string, value: StoredEmbeddings): Promise<void> {
    const checked = validateStoredEmbeddings(value);
    await this.ensure();
    await this.writeAtomic(this.embeddingsPath(jobId), JSON.stringify(checked), LIBRARY_INDEX_LIMITS.embeddingsFileBytes);
  }

  async removeEmbeddings(jobId: string): Promise<void> {
    await fs.rm(this.embeddingsPath(jobId), { force: true });
  }

  /** Marks a recording as removed (empty private file; its mtime is the removal time). */
  async writeTombstone(jobId: string): Promise<void> {
    const path = this.tombstonePath(jobId);
    await this.ensure();
    await this.writeAtomic(path, "", 0);
  }

  /** Removal time (ms) of a tombstoned recording, or undefined. */
  async tombstone(jobId: string): Promise<number | undefined> {
    return (await fileSignature(this.tombstonePath(jobId)))?.mtimeMs;
  }

  /** Every tombstone, as job id → removal time (ms). */
  async listTombstones(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!await assertPrivateDirectory(this.root) || !await assertPrivateDirectory(this.tombstonesDir)) return result;
    for (const name of (await fs.readdir(this.tombstonesDir)).slice(0, 100_000)) {
      if (!isJobId(name)) continue;
      const signature = await fileSignature(join(this.tombstonesDir, name));
      if (signature) result.set(name.toLowerCase(), signature.mtimeMs);
    }
    return result;
  }

  async removeTombstone(jobId: string): Promise<void> {
    await fs.rm(this.tombstonePath(jobId), { force: true });
  }

  private async writeAtomic(path: string, raw: string, maximumBytes: number): Promise<void> {
    if (Buffer.byteLength(raw, "utf8") > maximumBytes) throw new Error(INVALID_FILE);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      // rename() replaces a symbolic link itself, never its target.
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
