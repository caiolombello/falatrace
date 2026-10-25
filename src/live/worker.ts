import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig, LiveProvider } from "../config/defaults";
import type { SecretName } from "../config/secrets";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import {
  LIVE_MESSAGES,
  LIVE_STATUS_HEARTBEAT_MS,
  LiveError,
  type LiveLine,
  LiveStore,
  type LiveStatus,
  normalizeLiveText,
  validateLiveSessionId
} from "./store";
import {
  buildLiveTapCommand,
  clearChunkDir,
  type LiveProcess,
  type LiveProcessExit,
  type LiveSessionInput,
  type LiveSpawn,
  readSegmentList,
  resolveLiveSources,
  type SegmentListEntry,
  spawnLiveProcess,
  stopLiveProcess
} from "./tap";
import {
  type ChunkLevel,
  isSilentChunk,
  type LiveChunkInput,
  liveChunkSeconds,
  liveProviderKey,
  type LiveSegment,
  LiveTranscribeError,
  type LiveTranscribeDeps,
  measureWavLevel,
  transcribeLiveChunk
} from "./transcribe";

/**
 * The live worker: runs the tap, waits for finished chunks in segments.csv, skips silent ones,
 * transcribes the rest one at a time and appends the lines to live.jsonl on the media timeline.
 * It keeps status.json current (state, real-time factor, counters) and stops on abort: the tap is
 * killed at once, the chunk being transcribed may finish within `stopGraceMs`, nothing new starts.
 */

export type LiveWorkerDeps = {
  store?: LiveStore;
  /** Starts the tap. Default: a plain child process (never heavy admission: the tap must run during calls). */
  spawn?: LiveSpawn;
  ffmpeg?: string;
  /** Replaces the provider call (tests, or a future streaming provider). */
  transcribe?: (input: LiveChunkInput) => Promise<LiveSegment[]>;
  transcribeDeps?: LiveTranscribeDeps;
  measureLevel?: (path: string) => Promise<ChunkLevel>;
  readSecret?: (name: SecretName) => Promise<string | undefined>;
  /** Whether the whisper model file exists. */
  fileExists?: (path: string) => Promise<boolean>;
  /** Checked every few seconds; false means the recording ended, so the worker stops. */
  shouldContinue?: () => Promise<boolean>;
  now?: () => number;
  lock?: (name: string) => Promise<SingletonLease>;
  log?: (event: Record<string, unknown>) => void;
  pollMs?: number;
  stopGraceMs?: number;
  /** Older pending chunks are dropped beyond this, so the text stays close to real time. */
  maxBacklogChunks?: number;
  maxConsecutiveFailures?: number;
  maxTapRestarts?: number;
  tapRestartDelayMs?: number;
  continueCheckMs?: number;
  /** status.json refresh interval while a chunk is being transcribed (default LIVE_STATUS_HEARTBEAT_MS). */
  heartbeatMs?: number;
};

export type LiveWorkerOptions = {
  config: AppConfig;
  sessionId: string;
  session: LiveSessionInput;
  signal?: AbortSignal;
  deps?: LiveWorkerDeps;
};

export type LiveWorkerResult = {
  state: "stopped" | "failed";
  error?: string;
  lastSeq: number;
  chunksDone: number;
  chunksSkipped: number;
  chunksDropped: number;
  rtf: number | null;
};

/** Smoothed real-time factor above which the worker cannot keep up. */
export const LIVE_BEHIND_RTF = 1;
/** This many finished chunks waiting also means behind. */
export const LIVE_BEHIND_BACKLOG = 2;
const MAX_CLOCK_SKEW_MS = 7 * 24 * 3600 * 1000;
/** The highest rtf status.json accepts; a slower chunk is reported at this value. */
const MAX_RTF = 1_000;

class StopWorker extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

type Tap = {
  process: LiveProcess;
  startedMs: number;
  /** Seconds from media start to tap start: added to every chunk time. */
  offset: number;
  exit?: LiveProcessExit;
};

/** A tap that ran this long before dying was healthy: its restart does not count towards the limit. */
const HEALTHY_TAP_MS = 60_000;

const round3 = (value: number): number => Math.round(value * 1_000) / 1_000;

const defaultFileExists = async (path: string): Promise<boolean> =>
  fs.stat(path).then((stat) => stat.isFile(), () => false);

const defaultLog = (event: Record<string, unknown>): void => {
  // Journal line for the transient unit; never includes transcript text or keys.
  console.error(JSON.stringify({ component: "live", ...event }));
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });

const mediaStartMs = (session: LiveSessionInput, now: number): number => {
  const value = session.mediaStartedAt ?? session.startedAt;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed > now + 60_000 || now - parsed > MAX_CLOCK_SKEW_MS) {
    throw new LiveError(LIVE_MESSAGES.invalidSession);
  }
  return parsed;
};

class LiveWorkerRun {
  private readonly store: LiveStore;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly provider: LiveProvider;
  private readonly chunkSeconds: number;
  private readonly startedAt: string;
  private readonly work = new AbortController();
  private seq = 0;
  private chunksDone = 0;
  private chunksSkipped = 0;
  private chunksDropped = 0;
  private consecutiveFailures = 0;
  private rtf: number | null = null;
  private lastError: string | undefined;
  private pending: SegmentListEntry[] = [];
  private lastStatusAt = 0;
  /** Status writes run one after another, so a heartbeat can never land after (and undo) a later state. */
  private statusWrites: Promise<void> = Promise.resolve();
  private statusWritesPending = 0;
  private tap: Tap | undefined;
  private tapStopping: Promise<unknown> | undefined;
  private apiKey: string | undefined;
  private previousText = "";

  constructor(
    private readonly options: LiveWorkerOptions,
    private readonly sessionId: string,
    private readonly mediaStartedMs: number,
    private readonly chunkDir: string,
    private readonly deps: LiveWorkerDeps
  ) {
    this.store = deps.store ?? new LiveStore();
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? defaultLog;
    this.provider = options.config.live.provider;
    this.chunkSeconds = liveChunkSeconds(options.config.live);
    this.startedAt = new Date(this.now()).toISOString();
  }

  private status(state: LiveStatus["state"], error?: string): LiveStatus {
    return {
      version: 1,
      sessionId: this.sessionId,
      state,
      rtf: this.rtf,
      lastSeq: this.seq,
      provider: this.provider,
      ...(error ? { error } : {}),
      startedAt: this.startedAt,
      updatedAt: new Date(this.now()).toISOString(),
      chunkSeconds: this.chunkSeconds,
      chunksDone: this.chunksDone,
      chunksSkipped: this.chunksSkipped,
      chunksDropped: this.chunksDropped,
      backlog: this.pending.length
    };
  }

  private liveState(): "running" | "behind" {
    return (this.rtf !== null && this.rtf > LIVE_BEHIND_RTF) || this.pending.length >= LIVE_BEHIND_BACKLOG ? "behind" : "running";
  }

  private writeStatus(state: LiveStatus["state"], error?: string): Promise<void> {
    this.lastStatusAt = this.now();
    const status = this.status(state, error);
    this.statusWritesPending += 1;
    this.statusWrites = this.statusWrites.then(async () => {
      try {
        await this.store.writeStatus(this.sessionId, status);
      } catch (failure) {
        this.log({ event: "status-write-failed", error: failure instanceof Error ? failure.message : String(failure) });
      } finally {
        this.statusWritesPending -= 1;
      }
    });
    return this.statusWrites;
  }

  /** Refresh status.json unless a write is still in flight (a stalled disk must not queue heartbeats). */
  private heartbeat(): void {
    if (this.statusWritesPending === 0) void this.writeStatus(this.liveState(), this.lastError);
  }

  private result(state: "stopped" | "failed", error?: string): LiveWorkerResult {
    return {
      state,
      ...(error ? { error } : {}),
      lastSeq: this.seq,
      chunksDone: this.chunksDone,
      chunksSkipped: this.chunksSkipped,
      chunksDropped: this.chunksDropped,
      rtf: this.rtf
    };
  }

  private async preflight(): Promise<{ microphone?: string; desktop?: string }> {
    const { config, session } = this.options;
    const sources = resolveLiveSources(session, config.capture);
    if (!sources.microphone && !sources.desktop) throw new StopWorker(LIVE_MESSAGES.noAudioSource);
    if (this.provider === "whisper-cpp") {
      if (!(await (this.deps.fileExists ?? defaultFileExists)(config.live.whisperModelPath))) {
        throw new StopWorker(LIVE_MESSAGES.whisperModelMissing);
      }
    } else {
      this.apiKey = await liveProviderKey(this.provider, config, this.deps.readSecret);
      if (!this.apiKey) throw new StopWorker(this.provider === "groq" ? LIVE_MESSAGES.groqKeyMissing : LIVE_MESSAGES.openaiKeyMissing);
    }
    return sources;
  }

  private startTap(sources: { microphone?: string; desktop?: string }): Tap {
    const command = buildLiveTapCommand({ ...sources, chunkSeconds: this.chunkSeconds, dir: this.chunkDir });
    const startedMs = this.now();
    const child = (this.deps.spawn ?? spawnLiveProcess)(this.deps.ffmpeg ?? command.command, command.args);
    const tap: Tap = { process: child, startedMs, offset: (startedMs - this.mediaStartedMs) / 1_000 };
    child.exited.then((exit) => {
      tap.exit = exit;
    });
    this.log({ event: "tap-started", offset: round3(tap.offset), chunkSeconds: this.chunkSeconds, provider: this.provider });
    return tap;
  }

  private stopTap(): Promise<unknown> {
    if (!this.tap) return Promise.resolve();
    this.tapStopping ??= stopLiveProcess(this.tap.process).catch(() => undefined);
    return this.tapStopping;
  }

  private async removeChunk(entry: SegmentListEntry): Promise<void> {
    await fs.rm(join(this.chunkDir, entry.file), { force: true }).catch(() => undefined);
  }

  private async processChunk(entry: SegmentListEntry, tap: Tap): Promise<void> {
    const path = join(this.chunkDir, entry.file);
    const duration = entry.end - entry.start;
    try {
      if (!(duration >= 0.05)) {
        this.chunksSkipped += 1;
        return;
      }
      let level: ChunkLevel;
      try {
        level = await (this.deps.measureLevel ?? measureWavLevel)(path);
      } catch {
        this.chunksSkipped += 1;
        this.log({ event: "chunk-unreadable", file: entry.file });
        return;
      }
      if (isSilentChunk(level)) {
        this.chunksSkipped += 1;
        return;
      }
      const input: LiveChunkInput = {
        provider: this.provider,
        config: this.options.config,
        wavPath: path,
        workDir: this.chunkDir,
        durationSeconds: duration,
        previousText: this.previousText,
        apiKey: this.apiKey,
        signal: this.work.signal
      };
      const startedMs = this.now();
      let segments: LiveSegment[];
      // A slow chunk (whisper on a weak CPU may take longer than the stale threshold) must not make
      // readers think the worker is gone: keep status.json fresh while waiting.
      const heartbeat = setInterval(() => this.heartbeat(), Math.max(10, this.deps.heartbeatMs ?? LIVE_STATUS_HEARTBEAT_MS));
      try {
        segments = await (this.deps.transcribe ?? ((chunk: LiveChunkInput) => transcribeLiveChunk(chunk, this.deps.transcribeDeps)))(input);
      } catch (error) {
        const kind = error instanceof LiveTranscribeError ? error.kind : this.work.signal.aborted ? "aborted" : "failed";
        if (kind === "aborted") return;
        const message = error instanceof LiveError ? error.message : LIVE_MESSAGES.chunkFailed;
        this.log({ event: "chunk-failed", kind, file: entry.file });
        if (kind === "auth" || kind === "fatal") throw new StopWorker(message);
        this.consecutiveFailures += 1;
        this.lastError = message;
        if (this.consecutiveFailures >= (this.deps.maxConsecutiveFailures ?? 5)) throw new StopWorker(LIVE_MESSAGES.tooManyFailures);
        return;
      } finally {
        clearInterval(heartbeat);
      }
      const elapsed = Math.max(0, this.now() - startedMs);
      const chunkRtf = Math.min(MAX_RTF, elapsed / (duration * 1_000));
      this.rtf = round3(Math.min(MAX_RTF, this.rtf === null ? chunkRtf : this.rtf * 0.5 + chunkRtf * 0.5));
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      const base = tap.offset + entry.start;
      const lines: LiveLine[] = [];
      let seq = this.seq;
      for (const segment of segments) {
        const text = normalizeLiveText(segment.text);
        if (!text) continue;
        const start = round3(Math.max(0, base + segment.start));
        const end = round3(Math.max(start, base + segment.end));
        seq += 1;
        lines.push({ seq, start, end, text, provider: this.provider });
      }
      try {
        await this.store.append(this.sessionId, lines);
      } catch (error) {
        if (error instanceof LiveError) throw new StopWorker(error.message);
        throw error;
      }
      this.seq = seq;
      this.chunksDone += 1;
      if (lines.length) this.previousText = lines.map((line) => line.text).join(" ").slice(-1_000);
    } finally {
      await fs.rm(path, { force: true }).catch(() => undefined);
    }
  }

  /** New finished chunks from the list; beyond the backlog limit the oldest are dropped. */
  private async collect(processed: Set<string>): Promise<void> {
    let list: { entries: SegmentListEntry[]; malformed: number };
    try {
      list = await readSegmentList(this.chunkDir);
    } catch (error) {
      if (error instanceof LiveError) throw new StopWorker(error.message);
      throw error;
    }
    for (const entry of list.entries) {
      if (processed.has(entry.file)) continue;
      processed.add(entry.file);
      this.pending.push(entry);
    }
    const limit = Math.max(1, this.deps.maxBacklogChunks ?? 3);
    while (this.pending.length > limit) {
      const dropped = this.pending.shift();
      if (!dropped) break;
      this.chunksDropped += 1;
      await this.removeChunk(dropped);
    }
  }

  async run(): Promise<LiveWorkerResult> {
    const signal = this.options.signal;
    const deps = this.deps;
    const graceMs = deps.stopGraceMs ?? 15_000;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      void this.stopTap();
      graceTimer = setTimeout(() => this.work.abort(new Error("live worker stopped")), graceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.seq = await this.store.lastSeq(this.sessionId);
      const sources = await this.preflight();
      if (signal?.aborted) {
        await this.writeStatus("stopped");
        return this.result("stopped");
      }
      this.tap = this.startTap(sources);
      await this.writeStatus("running");
      let processed = new Set<string>();
      let restarts = 0;
      let lastContinueCheck = this.now();
      while (!signal?.aborted) {
        // Checked before anything else: a worker that is always busy (behind) must still notice the end.
        if (deps.shouldContinue && this.now() - lastContinueCheck >= (deps.continueCheckMs ?? 5_000)) {
          lastContinueCheck = this.now();
          if (!(await deps.shouldContinue().catch(() => true))) {
            this.log({ event: "recording-ended" });
            break;
          }
        }
        const exitedBefore = this.tap.exit;
        await this.collect(processed);
        const next = this.pending.shift();
        if (next) {
          await this.processChunk(next, this.tap);
          await this.writeStatus(this.liveState(), this.lastError);
          continue;
        }
        if (exitedBefore) {
          // Every chunk the tap finished has been handled: restart it, or give up.
          if (exitedBefore.spawnError === "not-found") throw new StopWorker(LIVE_MESSAGES.ffmpegMissing);
          this.log({ event: "tap-exited", code: exitedBefore.code, signal: exitedBefore.signal, stderr: exitedBefore.stderr.slice(-500) });
          // A device that comes and goes over a long meeting (a headset reconnecting) is not a crash loop.
          if (this.now() - this.tap.startedMs >= HEALTHY_TAP_MS) restarts = 0;
          if (restarts >= (deps.maxTapRestarts ?? 3)) throw new StopWorker(LIVE_MESSAGES.tapStopped);
          restarts += 1;
          await sleep(deps.tapRestartDelayMs ?? 2_000, signal);
          if (signal?.aborted) break;
          await clearChunkDir(this.chunkDir);
          processed = new Set<string>();
          this.tap = this.startTap(sources);
          this.tapStopping = undefined;
          continue;
        }
        if (this.now() - this.lastStatusAt >= LIVE_STATUS_HEARTBEAT_MS) await this.writeStatus(this.liveState(), this.lastError);
        await sleep(deps.pollMs ?? 1_000, signal);
      }
      await this.stopTap();
      this.pending = [];
      await this.writeStatus("stopped");
      this.log({ event: "stopped", lastSeq: this.seq, chunksDone: this.chunksDone, chunksSkipped: this.chunksSkipped, chunksDropped: this.chunksDropped });
      return this.result("stopped");
    } catch (error) {
      const message = error instanceof StopWorker ? error.userMessage : error instanceof LiveError ? error.message : LIVE_MESSAGES.unexpected;
      if (!(error instanceof StopWorker)) this.log({ event: "failed", error: error instanceof Error ? error.message : String(error) });
      await this.stopTap();
      this.pending = [];
      await this.writeStatus("failed", message);
      return this.result("failed", message);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      this.work.abort(new Error("live worker finished"));
      await this.cleanupChunks();
    }
  }

  private async cleanupChunks(): Promise<void> {
    try {
      const stat = await fs.lstat(this.chunkDir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(this.chunkDir, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run the live transcript for one capture session until `signal` aborts, the recording ends
 * (`deps.shouldContinue`) or a fatal error. Resolves with the final state; operational failures are
 * reported there and in status.json, not thrown. Throws only for an invalid session, a disabled
 * setting or a second worker for the same session.
 */
export const runLiveWorker = async (options: LiveWorkerOptions): Promise<LiveWorkerResult> => {
  const sessionId = validateLiveSessionId(options.sessionId);
  const deps = options.deps ?? {};
  if (!options.config.live.enabled) throw new LiveError(LIVE_MESSAGES.disabled);
  const mediaStartedMs = mediaStartMs(options.session, (deps.now ?? Date.now)());
  const lockName = `live-worker-${sessionId}`;
  const lease = await (deps.lock ?? acquireSingleton)(lockName).catch((error) => {
    if (error instanceof Error && error.message === `${lockName} is already running`) throw new LiveError(LIVE_MESSAGES.alreadyRunning);
    throw error;
  });
  try {
    const store = deps.store ?? new LiveStore();
    const chunkDir = await store.prepare(sessionId);
    await clearChunkDir(chunkDir);
    return await new LiveWorkerRun(options, sessionId, mediaStartedMs, chunkDir, { ...deps, store }).run();
  } finally {
    await lease.release();
  }
};
