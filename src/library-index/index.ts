import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import type { MeetingArtifacts } from "../knowledge/meetings";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { Bm25Index } from "./bm25";
import {
  buildFacts,
  buildJobIndex,
  type CalendarLinkReader,
  type ClientsReader,
  NO_USABLE_TRANSCRIPT,
  type NotesReader,
  notesDigestOf,
  probeJob,
  probePaths,
  readMeetingSource,
  readNotesInput,
  resolveClients
} from "./build";
import { decodeVector, dot, embeddingTarget, embedTexts, encodeVector, QUERY_TIMEOUT_MS, reciprocalRankFusion } from "./embeddings";
import { type FileSignature, IndexStore, INDEX_STORE_UNSAFE, INVALID_JOB_ID, isJobId, LIBRARY_INDEX_LIMITS, type SegmentInfo, type StoredJobIndex } from "./store";
import type { ChunkHit, IndexChunk, JobFacts, LibraryIndexReader } from "./types";

export const LIBRARY_INDEX_BUSY = "O índice da biblioteca já está sendo atualizado; tente de novo em instantes.";
export const LIBRARY_INDEX_CANCELLED = "A atualização do índice da biblioteca foi cancelada.";

/** Fixed Portuguese messages this module can throw (for the bridge whitelist and i18n). */
export const LIBRARY_INDEX_KNOWN_ERRORS = [LIBRARY_INDEX_BUSY, LIBRARY_INDEX_CANCELLED, INDEX_STORE_UNSAFE, INVALID_JOB_ID] as const;

/** A removed recording stays out of the index this long even if its job still exists (an aborted deletion comes back after it). */
const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

/** What the assistant needs beyond LibraryIndexReader: time and speaker of each segment, to render cited lines. */
export interface AssistantIndexReader extends LibraryIndexReader {
  segmentInfo(jobId: string): Promise<Map<string, SegmentInfo>>;
}

export type LibraryIndexDeps = {
  jobs?: Pick<JobStore, "list" | "getWorkDir">;
  store?: IndexStore;
  readArtifacts?: (job: JobRecord) => Promise<MeetingArtifacts>;
  /** Notes typed during the meeting (the notes module); none by default. */
  notes?: NotesReader;
  /** Clients of a recording (the clients module); none by default. */
  clients?: ClientsReader;
  calendarLink?: CalendarLinkReader;
  probePaths?: (job: JobRecord) => string[];
  fetch?: typeof fetch;
  acquireLock?: (name: string) => Promise<SingletonLease>;
  /** How long refresh waits for another refresh holding the lock. */
  lockWaitMs?: number;
  /** Reads trust the in-memory copy this long before re-checking the files (another process may have refreshed). */
  revalidateMs?: number;
  now?: () => number;
};

export type RefreshReport = {
  /** Recordings in the index after the refresh (or among the requested ones). */
  indexed: number;
  rebuilt: number;
  unchanged: number;
  removed: number;
  /** Recordings without a usable transcript yet (still processing, or empty). */
  skipped: number;
  failed: number;
  embedded: number;
  embeddings: "off" | "ready" | "unavailable";
};

type CachedJob = { signature: FileSignature; entry: StoredJobIndex };
type CachedVectors = { signature: FileSignature; model: string; fingerprint: string; vectors: Float32Array[] };
type EmbeddingsInfo = { signature: FileSignature; model: string; fingerprint: string; count: number };
type SearchState = { generation: number; bm25: Bm25Index; chunks: IndexChunk[] };

const sameSignature = (left: FileSignature, right: FileSignature): boolean =>
  left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(timer); reject(new Error(LIBRARY_INDEX_CANCELLED)); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

const aborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Error(LIBRARY_INDEX_CANCELLED); };

/** Re-reading the artifacts later can succeed: keep the previous entry meanwhile. */
const transient = (error: unknown): boolean => error instanceof Error && error.name === "RevisionConflictError";

const unusable = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error instanceof Error && error.message === NO_USABLE_TRANSCRIPT);

/**
 * Like JobStore.list, but one job file that vanishes or is unreadable mid-listing is skipped
 * instead of turning the whole listing into "no jobs" (which would empty the index).
 */
export const listJobsTolerant = async (store: Pick<JobStore, "stateDir" | "get">): Promise<JobRecord[]> => {
  let names: string[];
  try { names = await fs.readdir(store.stateDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records = await Promise.all(names.filter((name) => name.endsWith(".json"))
    .map((name) => store.get(name.slice(0, -5)).catch(() => undefined)));
  return records.filter((record): record is JobRecord => record !== undefined);
};

/**
 * Derived, rebuildable index of the library: facts per recording plus BM25 (and optional local
 * embeddings) over transcript, summary and note chunks. Reads are cached in memory and revalidated
 * by file signature, so a refresh in another process is picked up by the next read.
 */
export class LibraryIndex implements AssistantIndexReader {
  private readonly jobs: Pick<JobStore, "list" | "getWorkDir">;
  private readonly store: IndexStore;
  private readonly cache = new Map<string, CachedJob>();
  private readonly vectors = new Map<string, CachedVectors>();
  private readonly embeddingsMeta = new Map<string, EmbeddingsInfo>();
  private generation = 0;
  private searchState?: SearchState;
  private loading?: Promise<void>;
  private loadedAt?: number;
  private fullRefresh?: Promise<RefreshReport>;
  private readonly now: () => number;

  constructor(private readonly config: AppConfig, private readonly deps: LibraryIndexDeps = {}) {
    if (deps.jobs) this.jobs = deps.jobs;
    else {
      const store = new JobStore();
      this.jobs = { list: () => listJobsTolerant(store), getWorkDir: (id) => store.getWorkDir(id) };
    }
    this.store = deps.store ?? new IndexStore();
    this.now = deps.now ?? Date.now;
  }

  /**
   * Brings the index up to date with the job store. Without `jobIds`, also drops recordings that
   * no longer exist. A full refresh already running in this process is shared (with its signal).
   */
  refresh(options: { signal?: AbortSignal; jobIds?: string[] } = {}): Promise<RefreshReport> {
    if (options.jobIds) {
      if (!Array.isArray(options.jobIds) || options.jobIds.length > LIBRARY_INDEX_LIMITS.jobs) return Promise.reject(new Error(INVALID_JOB_ID));
      for (const id of options.jobIds) if (!isJobId(id)) return Promise.reject(new Error(INVALID_JOB_ID));
      return this.locked(options.signal, () => this.refreshLocked(options.signal, new Set(options.jobIds!.map((id) => id.toLowerCase()))));
    }
    // Concurrent full refreshes in this process share one run.
    if (!this.fullRefresh) {
      this.fullRefresh = this.locked(options.signal, () => this.refreshLocked(options.signal)).finally(() => { this.fullRefresh = undefined; });
    }
    return this.fullRefresh;
  }

  async listFacts(): Promise<JobFacts[]> {
    await this.load();
    return [...this.cache.values()].map((item) => item.entry.facts)
      .sort((left, right) => right.date.localeCompare(left.date) || left.jobId.localeCompare(right.jobId));
  }

  async getFacts(jobId: string): Promise<JobFacts | undefined> {
    if (!isJobId(jobId)) return undefined;
    await this.load();
    return this.cache.get(jobId.toLowerCase())?.entry.facts;
  }

  async segmentInfo(jobId: string): Promise<Map<string, SegmentInfo>> {
    if (!isJobId(jobId)) return new Map();
    await this.load();
    return new Map((this.cache.get(jobId.toLowerCase())?.entry.segments || []).map((segment) => [segment.id, segment]));
  }

  /** Chunks of one recording, in stored order. */
  async chunksOf(jobId: string): Promise<IndexChunk[]> {
    if (!isJobId(jobId)) return [];
    await this.load();
    return [...(this.cache.get(jobId.toLowerCase())?.entry.chunks || [])];
  }

  async search(query: string, options: { jobIds?: string[]; limit?: number; signal?: AbortSignal } = {}): Promise<ChunkHit[]> {
    const limit = Math.max(1, Math.min(Number.isSafeInteger(options.limit) ? options.limit! : 20, 200));
    if (typeof query !== "string" || !query.trim()) return [];
    // A malformed filter matches nothing rather than everything.
    if (options.jobIds !== undefined && !Array.isArray(options.jobIds)) return [];
    const text = query.slice(0, 4_000);
    await this.load();
    const state = this.searchIndex();
    const allowed = options.jobIds
      ? new Set(options.jobIds.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase()))
      : undefined;
    const accept = allowed ? (index: number) => allowed.has(state.chunks[index]!.jobId.toLowerCase()) : undefined;
    const pool = Math.max(limit * 3, 50);
    const lexical = state.bm25.search(text, { limit: pool, accept });
    const semantic = await this.semanticSearch(text, state, accept, pool, options.signal);
    if (!semantic.length) return lexical.slice(0, limit).map((hit) => ({ chunk: state.chunks[hit.index]!, score: hit.score }));
    const fused = reciprocalRankFusion([lexical.map((hit) => String(hit.index)), semantic.map(String)]);
    return [...fused.entries()]
      .sort((left, right) => right[1] - left[1] || Number(left[0]) - Number(right[0]))
      .slice(0, limit)
      .map(([index, score]) => ({ chunk: state.chunks[Number(index)]!, score }));
  }

  /**
   * Forgets one recording (index entry and embeddings) at once, without waiting for a refresh
   * in progress: a tombstone keeps that refresh (in any process) from writing it back.
   * Call it before deleting the recording; after an aborted deletion, call restoreJob.
   */
  async removeJob(jobId: string): Promise<void> {
    if (!isJobId(jobId)) throw new Error(INVALID_JOB_ID);
    // Tombstone first: a refresh that writes after this point sees it and undoes its write.
    await this.store.writeTombstone(jobId);
    await this.store.removeJob(jobId);
    this.forget(jobId.toLowerCase());
  }

  /** Lets a removed recording back into the index (the next refresh rebuilds it). */
  async restoreJob(jobId: string): Promise<void> {
    if (!isJobId(jobId)) throw new Error(INVALID_JOB_ID);
    await this.store.removeTombstone(jobId);
  }

  private forget(jobId: string): void {
    if (this.cache.delete(jobId)) this.generation++;
    this.vectors.delete(jobId);
    this.embeddingsMeta.delete(jobId);
  }

  private async locked<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    aborted(signal);
    const name = `knowledge-index-${createHash("sha256").update(this.store.root).digest("hex").slice(0, 16)}`;
    const acquire = this.deps.acquireLock ?? acquireSingleton;
    const deadline = Date.now() + (this.deps.lockWaitMs ?? 30_000);
    let lease: SingletonLease;
    for (;;) {
      try { lease = await acquire(name); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("is already running")) throw error;
        if (Date.now() >= deadline) throw new Error(LIBRARY_INDEX_BUSY);
        await sleep(100, signal);
      }
    }
    try { return await action(); } finally { await lease.release(); }
  }

  private async refreshLocked(signal: AbortSignal | undefined, only?: Set<string>): Promise<RefreshReport> {
    const report: RefreshReport = { indexed: 0, rebuilt: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0, embedded: 0, embeddings: "off" };
    // An unsafe index folder stops the refresh with a clear message instead of failing every recording.
    await this.store.ensure();
    const all = await this.jobs.list();
    aborted(signal);
    const eligible = all
      .filter((job) => job.state === "completed" || job.target === "local")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, LIBRARY_INDEX_LIMITS.jobs);
    const tombstones = await this.liveTombstones(!only);
    const eligibleIds = new Set(eligible.map((job) => job.id.toLowerCase()).filter((id) => !tombstones.has(id)));
    const drop = async (id: string): Promise<boolean> => {
      const existed = (await this.store.signature(id)) !== undefined;
      await this.store.removeJob(id);
      this.forget(id.toLowerCase());
      return existed;
    };
    const storedIds = await this.store.listJobIds();
    for (const id of storedIds) {
      const key = id.toLowerCase();
      if (eligibleIds.has(key) || (only && !only.has(key))) continue;
      if (await drop(id)) report.removed++;
    }
    if (!only) {
      // Vectors whose index entry is gone (removed while they were being computed).
      const indexed = new Set(storedIds.map((id) => id.toLowerCase()));
      for (const id of await this.store.listEmbeddingIds()) if (!indexed.has(id.toLowerCase())) await this.store.removeEmbeddings(id);
    }
    const targets = eligible.filter((job) => eligibleIds.has(job.id.toLowerCase()) && (!only || only.has(job.id.toLowerCase())));
    const kept: StoredJobIndex[] = [];
    for (const job of targets) {
      aborted(signal);
      try {
        const result = await this.refreshJob(job);
        if (result.outcome === "removed") { report.removed++; continue; }
        report[result.outcome]++;
        kept.push(result.entry);
      } catch (error) {
        if (signal?.aborted) throw new Error(LIBRARY_INDEX_CANCELLED);
        if (error instanceof Error && error.message === INDEX_STORE_UNSAFE) throw error;
        if (unusable(error)) report.skipped++;
        else report.failed++;
        if (!transient(error) && await drop(job.id)) report.removed++;
      }
    }
    report.indexed = kept.length;
    await this.embedAll(kept, report, signal);
    return report;
  }

  /** Tombstones still in force; expired ones are deleted during a full refresh. */
  private async liveTombstones(prune: boolean): Promise<Set<string>> {
    const live = new Set<string>();
    for (const [id, removedAt] of await this.store.listTombstones()) {
      if (this.now() - removedAt < TOMBSTONE_TTL_MS) live.add(id);
      else if (prune) await this.store.removeTombstone(id);
    }
    return live;
  }

  private async tombstoned(jobId: string): Promise<boolean> {
    const removedAt = await this.store.tombstone(jobId);
    return removedAt !== undefined && this.now() - removedAt < TOMBSTONE_TTL_MS;
  }

  private async refreshJob(job: JobRecord): Promise<{ outcome: "rebuilt" | "unchanged" | "removed"; entry: StoredJobIndex }> {
    const notes = await readNotesInput(job, this.deps.notes);
    const probe = await probeJob(job, notesDigestOf(notes), this.deps.probePaths?.(job) ?? probePaths(job, this.jobs));
    const previous = await this.storedEntry(job.id);
    if (previous && previous.entry.probe === probe) {
      const clients = await resolveClients(job, { ...previous.entry.facts, clients: [] }, this.deps.clients);
      if (JSON.stringify(clients) === JSON.stringify(previous.entry.facts.clients)) {
        if (await this.tombstoned(job.id)) return this.undo(job.id, previous.entry);
        this.remember(job.id.toLowerCase(), previous.entry, previous.signature);
        return { outcome: "unchanged", entry: previous.entry };
      }
    }
    const source = await readMeetingSource(job, { readArtifacts: this.deps.readArtifacts, notes: async () => ({ entries: notes }), calendarLink: this.deps.calendarLink });
    const clients = await resolveClients(job, buildFacts(source), this.deps.clients);
    const entry = buildJobIndex(source, clients, probe);
    await this.store.writeJob(entry);
    // removeJob may have run while the artifacts were read: undo the write.
    if (await this.tombstoned(job.id)) return this.undo(job.id, entry);
    const signature = await this.store.signature(job.id);
    if (signature) this.remember(job.id.toLowerCase(), entry, signature);
    return { outcome: previous?.entry.facts.fingerprint === entry.facts.fingerprint ? "unchanged" : "rebuilt", entry };
  }

  /**
   * The stored entry of a recording, from memory when the file is the one already loaded:
   * an unchanged library is not re-read and re-validated file by file on every refresh.
   */
  private async storedEntry(jobId: string): Promise<{ entry: StoredJobIndex; signature: FileSignature } | undefined> {
    try {
      const signature = await this.store.signature(jobId);
      if (!signature) return undefined;
      const cached = this.cache.get(jobId.toLowerCase());
      if (cached && sameSignature(cached.signature, signature)) return { entry: cached.entry, signature };
      return await this.store.readJob(jobId);
    } catch {
      return undefined;
    }
  }

  /** Model, fingerprint and size of a recording's stored vectors, read once per file version. */
  private async embeddingsInfo(jobId: string): Promise<EmbeddingsInfo | undefined> {
    const key = jobId.toLowerCase();
    try {
      const signature = await this.store.embeddingsSignature(jobId);
      if (!signature) { this.embeddingsMeta.delete(key); return undefined; }
      const known = this.embeddingsMeta.get(key);
      if (known && sameSignature(known.signature, signature)) return known;
      const read = await this.store.readEmbeddings(jobId);
      if (!read) return undefined;
      const info = { signature: read.signature, model: read.value.model, fingerprint: read.value.fingerprint, count: read.value.vectors.length };
      this.embeddingsMeta.set(key, info);
      return info;
    } catch {
      return undefined;
    }
  }

  private async undo(jobId: string, entry: StoredJobIndex): Promise<{ outcome: "removed"; entry: StoredJobIndex }> {
    await this.store.removeJob(jobId);
    this.forget(jobId.toLowerCase());
    return { outcome: "removed", entry };
  }

  private remember(jobId: string, entry: StoredJobIndex, signature: FileSignature): void {
    const current = this.cache.get(jobId);
    if (current && sameSignature(current.signature, signature)) return;
    this.cache.set(jobId, { entry, signature });
    this.generation++;
  }

  private async embedAll(entries: ReadonlyArray<StoredJobIndex>, report: RefreshReport, signal?: AbortSignal): Promise<void> {
    const target = embeddingTarget(this.config);
    if (!target) return;
    report.embeddings = "ready";
    for (const entry of entries) {
      aborted(signal);
      const { jobId, fingerprint, title } = entry.facts;
      const current = await this.embeddingsInfo(jobId);
      if (current && current.model === target.model && current.fingerprint === fingerprint && current.count === entry.chunks.length) continue;
      if (!entry.chunks.length) continue;
      try {
        const vectors = await embedTexts(target, entry.chunks.map((chunk) => `${title}\n${chunk.text}`), { signal, deps: { fetch: this.deps.fetch } });
        await this.store.writeEmbeddings(jobId, { version: 1, model: target.model, dims: vectors[0]!.length, fingerprint, vectors: vectors.map(encodeVector) });
        this.vectors.delete(jobId.toLowerCase());
        // Writes happen under the refresh lock, so this signature is the file just written.
        const written = await this.store.embeddingsSignature(jobId);
        if (written) this.embeddingsMeta.set(jobId.toLowerCase(), { signature: written, model: target.model, fingerprint, count: vectors.length });
        if (await this.tombstoned(jobId)) { await this.store.removeJob(jobId); continue; }
        report.embedded++;
      } catch {
        if (signal?.aborted) throw new Error(LIBRARY_INDEX_CANCELLED);
        // Keyword search keeps working; the next refresh tries again.
        report.embeddings = "unavailable";
        return;
      }
    }
  }

  /** Revalidates the in-memory copy against the files (another process may have refreshed). */
  private load(): Promise<void> {
    const fresh = this.loadedAt !== undefined && this.now() - this.loadedAt < (this.deps.revalidateMs ?? 1_000);
    if (fresh) return Promise.resolve();
    if (!this.loading) {
      const run = this.reload()
        .then(() => { this.loadedAt = this.now(); })
        .finally(() => { if (this.loading === run) this.loading = undefined; });
      this.loading = run;
    }
    return this.loading;
  }

  private async reload(): Promise<void> {
    const tombstones = await this.liveTombstones(false);
    const ids = new Set((await this.store.listJobIds()).map((id) => id.toLowerCase()).filter((id) => !tombstones.has(id)));
    for (const id of [...this.cache.keys()]) if (!ids.has(id)) this.forget(id);
    for (const id of ids) {
      const signature = await this.store.signature(id);
      const current = this.cache.get(id);
      if (signature && current && sameSignature(signature, current.signature)) continue;
      try {
        const read = await this.store.readJob(id);
        if (read) this.remember(id, read.entry, read.signature);
        else this.forget(id);
      } catch {
        // An unreadable entry is left out until the next refresh rebuilds it.
        this.forget(id);
      }
    }
  }

  private searchIndex(): SearchState {
    if (this.searchState?.generation === this.generation) return this.searchState;
    const chunks: IndexChunk[] = [];
    const documents = [];
    for (const { entry } of this.cache.values()) {
      for (const chunk of entry.chunks) {
        chunks.push(chunk);
        documents.push({ fields: [
          { text: chunk.text, weight: chunk.kind === "summary" ? 1.5 : 1 },
          { text: entry.facts.title, weight: 0.5 },
          { text: (chunk.speakers || []).join(" "), weight: 0.5 }
        ] });
      }
    }
    this.searchState = { generation: this.generation, bm25: new Bm25Index(documents), chunks };
    return this.searchState;
  }

  private async semanticSearch(query: string, state: SearchState, accept: ((index: number) => boolean) | undefined, pool: number, signal?: AbortSignal): Promise<number[]> {
    const target = embeddingTarget(this.config);
    if (!target) return [];
    const byChunk = new Map<string, Float32Array>();
    for (const [jobId, { entry }] of this.cache) {
      const vectors = await this.vectorsFor(jobId, entry, target.model);
      for (const [index, vector] of (vectors || []).entries()) byChunk.set(entry.chunks[index]!.chunkId, vector);
    }
    if (!byChunk.size) return [];
    let question: Float32Array;
    try { [question] = await embedTexts(target, [query], { signal, timeoutMs: QUERY_TIMEOUT_MS, deps: { fetch: this.deps.fetch } }) as [Float32Array]; }
    catch {
      signal?.throwIfAborted();
      return [];
    }
    const scored: Array<{ index: number; score: number }> = [];
    state.chunks.forEach((chunk, index) => {
      if (accept && !accept(index)) return;
      const vector = byChunk.get(chunk.chunkId);
      if (vector && vector.length === question.length) scored.push({ index, score: dot(question, vector) });
    });
    return scored.sort((left, right) => right.score - left.score || left.index - right.index).slice(0, pool).map((item) => item.index);
  }

  private async vectorsFor(jobId: string, entry: StoredJobIndex, model: string): Promise<Float32Array[] | undefined> {
    try {
      const signature = await this.store.embeddingsSignature(jobId);
      if (!signature) { this.vectors.delete(jobId); return undefined; }
      const cached = this.vectors.get(jobId);
      if (cached && sameSignature(cached.signature, signature) && cached.model === model && cached.fingerprint === entry.facts.fingerprint) return cached.vectors;
      const read = await this.store.readEmbeddings(jobId);
      if (!read) return undefined;
      const { value } = read;
      if (value.model !== model || value.fingerprint !== entry.facts.fingerprint || value.vectors.length !== entry.chunks.length) return undefined;
      const vectors = value.vectors.map((encoded) => decodeVector(encoded, value.dims));
      this.vectors.set(jobId, { signature: read.signature, model, fingerprint: value.fingerprint, vectors });
      return vectors;
    } catch {
      return undefined;
    }
  }
}
