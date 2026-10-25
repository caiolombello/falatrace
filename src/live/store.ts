import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIVE_PROVIDERS, type LiveProvider } from "../config/defaults";

/**
 * Live transcript storage: `$XDG_STATE_HOME/recording-cli/live/<sessionId>/` holds an append-only
 * `live.jsonl` (one line per segment), `status.json` (rewritten atomically by the worker) and the
 * tap's `chunks/` folder. Only the worker of a session writes; any process may read.
 */

/** Fixed user-facing messages of the live module (pt-BR source strings, translated by the Studio). */
export const LIVE_MESSAGES = {
  invalidSession: "Sessão ao vivo inválida.",
  invalidCursor: "Posição inválida no texto ao vivo.",
  disabled: "O texto ao vivo está desativado nas configurações.",
  alreadyRunning: "O texto ao vivo desta gravação já está em execução.",
  noAudioSource: "Nenhuma fonte de áudio disponível para o texto ao vivo.",
  whisperModelMissing: "O modelo do Whisper para o texto ao vivo não foi encontrado; baixe um modelo pequeno nas configurações.",
  whisperMissing: "O whisper-cli não foi encontrado; instale o whisper.cpp ou escolha outro provedor para o texto ao vivo.",
  ffmpegMissing: "O ffmpeg não foi encontrado; instale o ffmpeg para usar o texto ao vivo.",
  openaiKeyMissing: "Configure a chave OPENAI_API_KEY para usar o texto ao vivo pela OpenAI.",
  groqKeyMissing: "Configure a chave GROQ_API_KEY para usar o texto ao vivo pela Groq.",
  providerAuth: "O provedor do texto ao vivo recusou a chave; confira a chave nas configurações.",
  providerRateLimited: "O provedor do texto ao vivo limitou as requisições; alguns trechos ficaram sem texto.",
  providerUnavailable: "O provedor do texto ao vivo não respondeu; alguns trechos ficaram sem texto.",
  providerInvalidResponse: "O provedor do texto ao vivo respondeu algo inválido; o trecho ficou sem texto.",
  chunkFailed: "A transcrição de um trecho ao vivo falhou; o próximo trecho será tentado.",
  tooManyFailures: "O texto ao vivo parou depois de várias falhas seguidas.",
  tapStopped: "A captura do texto ao vivo parou inesperadamente.",
  sizeLimit: "O texto ao vivo atingiu o limite de tamanho desta gravação.",
  unsafeDirectory: "A pasta do texto ao vivo não é segura; nada foi alterado.",
  invalidFile: "O arquivo do texto ao vivo é inválido.",
  invalidEndpoint: "O endereço do provedor do texto ao vivo é inválido.",
  unitStartFailed: "Não foi possível iniciar o texto ao vivo.",
  unitStopFailed: "Não foi possível parar o texto ao vivo.",
  sessionEnded: "A gravação deste texto ao vivo não está mais ativa.",
  unexpected: "O texto ao vivo parou por um erro inesperado."
} as const;

export const LIVE_KNOWN_ERRORS: readonly string[] = Object.values(LIVE_MESSAGES);

export const LIVE_STATES = ["running", "behind", "stopped", "failed"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export type LiveLine = {
  /** 1, 2, 3… strictly increasing within a session, also across worker restarts. */
  seq: number;
  /** Seconds on the recording's media timeline. */
  start: number;
  end: number;
  text: string;
  provider: LiveProvider;
};

export type LiveStatus = {
  version: 1;
  sessionId: string;
  state: LiveState;
  /** Smoothed processing time ÷ audio duration of transcribed chunks; null before the first one. */
  rtf: number | null;
  lastSeq: number;
  provider: LiveProvider;
  error?: string;
  startedAt: string;
  updatedAt: string;
  chunkSeconds: number;
  chunksDone: number;
  chunksSkipped: number;
  chunksDropped: number;
  /** Completed chunks waiting to be transcribed. */
  backlog: number;
};

export type LiveTranscriptPage = {
  lines: LiveLine[];
  /** Highest seq stored so far (0 when empty). */
  lastSeq: number;
  /** More lines after the last one returned: ask again with `sinceSeq` = last returned seq. */
  hasMore: boolean;
  /** Lines that failed validation and were skipped. */
  invalidLines: number;
};

export type LiveTranscriptView = LiveTranscriptPage & {
  status: LiveStatus | null;
  /** The status says running/behind but the worker stopped updating it (crashed or killed). */
  stale: boolean;
};

export const LIVE_TEXT_MAX_LENGTH = 2_000;
export const LIVE_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
export const LIVE_MAX_LINES = 50_000;
export const LIVE_PAGE_DEFAULT = 500;
export const LIVE_PAGE_MAX = 2_000;
const STATUS_MAX_BYTES = 16 * 1024;
const MAX_MEDIA_SECONDS = 7 * 24 * 3600;
const ERROR_MAX_LENGTH = 300;
/** A running worker rewrites status.json at least this often; older means it is gone. */
export const LIVE_STATUS_HEARTBEAT_MS = 5_000;
export const liveStatusStaleAfterMs = (chunkSeconds: number): number => Math.max(60_000, chunkSeconds * 4_000);

export class LiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LiveError";
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Session ids are capture session UUIDs (lowercase v4); anything else is refused before touching a path. */
export const validateLiveSessionId = (value: unknown): string => {
  if (typeof value !== "string" || !UUID_V4.test(value)) throw new LiveError(LIVE_MESSAGES.invalidSession);
  return value;
};

export const defaultLiveDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "recording-cli", "live");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MEDIA_SECONDS;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Strip control and bidi-override characters and collapse whitespace; the text is shown as-is in the Studio. */
export const normalizeLiveText = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIVE_TEXT_MAX_LENGTH);

export const validateLiveLine = (value: unknown): LiveLine => {
  if (!isRecord(value)) throw new LiveError(LIVE_MESSAGES.invalidFile);
  const { seq, start, end, text, provider } = value;
  if (
    !isCount(seq) || seq < 1 || !isSeconds(start) || !isSeconds(end) || end < start ||
    typeof text !== "string" || !text || text.length > LIVE_TEXT_MAX_LENGTH || normalizeLiveText(text) !== text ||
    !(LIVE_PROVIDERS as readonly unknown[]).includes(provider)
  ) {
    throw new LiveError(LIVE_MESSAGES.invalidFile);
  }
  return { seq, start, end, text, provider: provider as LiveProvider };
};

export const validateLiveStatus = (value: unknown): LiveStatus => {
  if (!isRecord(value) || value.version !== 1) throw new LiveError(LIVE_MESSAGES.invalidFile);
  const { sessionId, state, rtf, lastSeq, provider, error, startedAt, updatedAt, chunkSeconds, chunksDone, chunksSkipped, chunksDropped, backlog } = value;
  if (
    typeof sessionId !== "string" || !UUID_V4.test(sessionId) ||
    !(LIVE_STATES as readonly unknown[]).includes(state) ||
    !(rtf === null || (typeof rtf === "number" && Number.isFinite(rtf) && rtf >= 0 && rtf <= 1_000)) ||
    !isCount(lastSeq) || !(LIVE_PROVIDERS as readonly unknown[]).includes(provider) ||
    !(error === undefined || (typeof error === "string" && error.length > 0 && error.length <= ERROR_MAX_LENGTH && !/\p{Cc}/u.test(error))) ||
    !isIsoDate(startedAt) || !isIsoDate(updatedAt) ||
    !(typeof chunkSeconds === "number" && Number.isSafeInteger(chunkSeconds) && chunkSeconds >= 1 && chunkSeconds <= 600) ||
    !isCount(chunksDone) || !isCount(chunksSkipped) || !isCount(chunksDropped) || !isCount(backlog)
  ) {
    throw new LiveError(LIVE_MESSAGES.invalidFile);
  }
  return {
    version: 1,
    sessionId,
    state: state as LiveState,
    rtf: rtf as number | null,
    lastSeq,
    provider: provider as LiveProvider,
    ...(error === undefined ? {} : { error: error as string }),
    startedAt,
    updatedAt,
    chunkSeconds,
    chunksDone,
    chunksSkipped,
    chunksDropped,
    backlog
  };
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const lstatOrUndefined = async (path: string) =>
  fs.lstat(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });

/** Create (or check) a directory this module owns: a real directory, never a symlink, mode 0700. */
const ensureOwnedDirectory = async (path: string): Promise<void> => {
  let stat = await lstatOrUndefined(path);
  if (!stat) {
    await fs.mkdir(path, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    stat = await fs.lstat(path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
  if ((stat.mode & 0o077) !== 0) await fs.chmod(path, 0o700);
};

/** Read a private regular file without following a symlink; undefined when it does not exist. */
export const readOwnedFile = async (path: string, maxBytes: number, from = 0): Promise<{ data: Buffer; size: number; ino: number } | undefined> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (errorCode(error) === "ELOOP") throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
    if (stat.size > maxBytes) throw new LiveError(LIVE_MESSAGES.sizeLimit);
    const length = Math.max(0, stat.size - from);
    const data = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(data, offset, length - offset, from + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { data: data.subarray(0, offset), size: from + offset, ino: stat.ino };
  } finally {
    await handle.close();
  }
};

/** Write a private file atomically: exclusive temporary file, then rename over the target. */
const writePrivateAtomic = async (path: string, content: string): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

type TranscriptCache = { ino: number; parsedBytes: number; lines: LiveLine[]; invalidLines: number };

export class LiveStore {
  /** Parsed transcript per session, extended incrementally while the file only grows. */
  private readonly cache = new Map<string, TranscriptCache>();
  /**
   * Loads in progress per session. Polls run concurrently (the bridge handles requests in parallel)
   * and share the cache entry, so each load waits for the previous one: two loads extending the same
   * entry from the same offset would count lines twice and push the offset past real line starts.
   */
  private readonly loading = new Map<string, Promise<TranscriptCache>>();

  constructor(readonly root = defaultLiveDir()) {
    if (!root.startsWith("/")) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
  }

  sessionDir(sessionId: string): string {
    return join(this.root, validateLiveSessionId(sessionId));
  }

  chunkDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "chunks");
  }

  transcriptPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "live.jsonl");
  }

  statusPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "status.json");
  }

  /** Create the session folder and its chunk folder (0700). Returns the chunk folder. */
  async prepare(sessionId: string): Promise<string> {
    const sessionDir = this.sessionDir(sessionId);
    await fs.mkdir(join(this.root, ".."), { recursive: true, mode: 0o700 });
    await ensureOwnedDirectory(this.root);
    await ensureOwnedDirectory(sessionDir);
    const chunkDir = this.chunkDir(sessionId);
    await ensureOwnedDirectory(chunkDir);
    return chunkDir;
  }

  /**
   * Append lines in one write; the file never exceeds its bound. Seqs must increase within the batch;
   * continuing the stored ones is the caller's job (the session's single worker), and readers skip any
   * line that does not.
   */
  async append(sessionId: string, lines: LiveLine[]): Promise<void> {
    if (lines.length === 0) return;
    const path = this.transcriptPath(sessionId);
    const validated = lines.map(validateLiveLine);
    for (let index = 1; index < validated.length; index += 1) {
      if (validated[index].seq <= validated[index - 1].seq) throw new LiveError(LIVE_MESSAGES.invalidFile);
    }
    const body = `${validated.map((line) => JSON.stringify(line)).join("\n")}\n`;
    const handle = await fs
      .open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      .catch((error) => {
        if (errorCode(error) === "ELOOP") throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
        throw error;
      });
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
      // A writer killed mid-line leaves a fragment without "\n": end it first, or the next line would be
      // glued to it and lost. The fragment then reads as one invalid line.
      let terminated = true;
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        const { bytesRead } = await handle.read(last, 0, 1, stat.size - 1);
        terminated = bytesRead === 1 && last[0] === 0x0a;
      }
      const payload = Buffer.from(terminated ? body : `\n${body}`, "utf8");
      if (stat.size + payload.length > LIVE_TRANSCRIPT_MAX_BYTES) throw new LiveError(LIVE_MESSAGES.sizeLimit);
      await handle.write(payload, 0, payload.length);
    } finally {
      await handle.close();
    }
  }

  private loadTranscript(sessionId: string): Promise<TranscriptCache> {
    const previous = this.loading.get(sessionId);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve(undefined)).then(() => this.loadTranscriptNow(sessionId));
    this.loading.set(sessionId, next);
    const settle = (): void => {
      if (this.loading.get(sessionId) === next) this.loading.delete(sessionId);
    };
    next.then(settle, settle);
    return next;
  }

  private async loadTranscriptNow(sessionId: string): Promise<TranscriptCache> {
    const path = this.transcriptPath(sessionId);
    let cached = this.cache.get(sessionId);
    const stat = await lstatOrUndefined(path);
    if (!stat) {
      this.cache.delete(sessionId);
      return { ino: 0, parsedBytes: 0, lines: [], invalidLines: 0 };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
    if (!cached || cached.ino !== stat.ino || stat.size < cached.parsedBytes) {
      cached = { ino: stat.ino, parsedBytes: 0, lines: [], invalidLines: 0 };
    }
    if (stat.size === cached.parsedBytes) {
      this.cache.set(sessionId, cached);
      return cached;
    }
    const read = await readOwnedFile(path, LIVE_TRANSCRIPT_MAX_BYTES, cached.parsedBytes);
    if (!read) {
      this.cache.delete(sessionId);
      return { ino: 0, parsedBytes: 0, lines: [], invalidLines: 0 };
    }
    if (read.ino !== cached.ino) {
      // Replaced between lstat and open: parse the new file from the start next time.
      this.cache.delete(sessionId);
      return this.loadTranscriptNow(sessionId);
    }
    // Only complete lines count; a line still being written is picked up on a later read.
    const lastNewline = read.data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      this.cache.set(sessionId, cached);
      return cached;
    }
    const complete = read.data.subarray(0, lastNewline + 1).toString("utf8");
    let lastSeq = cached.lines.length ? cached.lines[cached.lines.length - 1].seq : 0;
    for (const raw of complete.split("\n")) {
      if (!raw) continue;
      try {
        const line = validateLiveLine(JSON.parse(raw));
        if (line.seq <= lastSeq || cached.lines.length >= LIVE_MAX_LINES) {
          cached.invalidLines += 1;
          continue;
        }
        cached.lines.push(line);
        lastSeq = line.seq;
      } catch {
        cached.invalidLines += 1;
      }
    }
    cached.parsedBytes += lastNewline + 1;
    this.cache.set(sessionId, cached);
    return cached;
  }

  /** Lines with seq > sinceSeq, oldest first, at most `limit`. */
  async read(sessionId: string, sinceSeq = 0, limit = LIVE_PAGE_DEFAULT): Promise<LiveTranscriptPage> {
    validateLiveSessionId(sessionId);
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new LiveError(LIVE_MESSAGES.invalidCursor);
    const pageSize = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), LIVE_PAGE_MAX) : LIVE_PAGE_DEFAULT;
    const transcript = await this.loadTranscript(sessionId);
    const { lines } = transcript;
    // Seqs are strictly increasing: binary search the first one after sinceSeq.
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle].seq <= sinceSeq) low = middle + 1;
      else high = middle;
    }
    const page = lines.slice(low, low + pageSize);
    return {
      lines: page.map((line) => ({ ...line })),
      lastSeq: lines.length ? lines[lines.length - 1].seq : 0,
      hasMore: low + pageSize < lines.length,
      invalidLines: transcript.invalidLines
    };
  }

  async lastSeq(sessionId: string): Promise<number> {
    return (await this.read(sessionId, 0, 1)).lastSeq;
  }

  async writeStatus(sessionId: string, status: LiveStatus): Promise<void> {
    const validated = validateLiveStatus(status);
    if (validated.sessionId !== validateLiveSessionId(sessionId)) throw new LiveError(LIVE_MESSAGES.invalidSession);
    await writePrivateAtomic(this.statusPath(sessionId), `${JSON.stringify(validated, null, 2)}\n`);
  }

  async readStatus(sessionId: string): Promise<LiveStatus | null> {
    const read = await readOwnedFile(this.statusPath(sessionId), STATUS_MAX_BYTES);
    if (!read) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.data.toString("utf8"));
    } catch (error) {
      throw new LiveError(LIVE_MESSAGES.invalidFile, { cause: error });
    }
    const status = validateLiveStatus(parsed);
    if (status.sessionId !== sessionId) throw new LiveError(LIVE_MESSAGES.invalidFile);
    return status;
  }

  /** Delete a session's folder (transcript, status, chunks). False when there was nothing. */
  async remove(sessionId: string): Promise<boolean> {
    const dir = this.sessionDir(sessionId);
    const stat = await lstatOrUndefined(dir);
    this.cache.delete(sessionId);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Remove sessions whose worker is not running (or went stale) and that were last updated more than
   * `maxAgeMs` ago. Returns the removed ids. Unknown entries in the folder are left alone.
   */
  async prune(options: { now?: number; maxAgeMs: number; keep?: string[] }): Promise<string[]> {
    const now = options.now ?? Date.now();
    // NaN would make every age comparison false and remove every stopped session.
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0 || !Number.isFinite(now)) {
      throw new Error("Live prune needs a finite, non-negative maximum age");
    }
    const rootStat = await lstatOrUndefined(this.root);
    if (!rootStat) return [];
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new LiveError(LIVE_MESSAGES.unsafeDirectory);
    const removed: string[] = [];
    const entries = (await fs.readdir(this.root)).slice(0, 5_000);
    for (const name of entries) {
      if (!UUID_V4.test(name) || options.keep?.includes(name)) continue;
      const dirStat = await lstatOrUndefined(join(this.root, name));
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
      let status: LiveStatus | null = null;
      try {
        status = await this.readStatus(name);
      } catch {
        status = null;
      }
      const updatedAt = status ? Date.parse(status.updatedAt) : dirStat.mtimeMs;
      const active = status !== null && (status.state === "running" || status.state === "behind") &&
        now - updatedAt <= liveStatusStaleAfterMs(status.chunkSeconds);
      if (active || now - updatedAt <= options.maxAgeMs) continue;
      if (await this.remove(name)) removed.push(name);
    }
    return removed;
  }
}

const sharedStores = new Map<string, LiveStore>();

/** One store per folder per process, so repeated polls reuse the parsed transcript. */
export const sharedLiveStore = (root = defaultLiveDir()): LiveStore => {
  let store = sharedStores.get(root);
  if (!store) {
    store = new LiveStore(root);
    sharedStores.set(root, store);
  }
  return store;
};

/**
 * What the Studio polls during a capture: new lines after `sinceSeq` plus the worker status.
 * `stale` is true when the status still says running but the worker stopped updating it.
 */
export const readLiveTranscript = async (
  sessionId: string,
  sinceSeq = 0,
  options: { store?: LiveStore; limit?: number; now?: number } = {}
): Promise<LiveTranscriptView> => {
  const store = options.store ?? sharedLiveStore();
  const page = await store.read(sessionId, sinceSeq, options.limit);
  let status: LiveStatus | null;
  try {
    status = await store.readStatus(sessionId);
  } catch (error) {
    if (error instanceof LiveError && error.message === LIVE_MESSAGES.unsafeDirectory) throw error;
    status = null;
  }
  const now = options.now ?? Date.now();
  const stale = status !== null && (status.state === "running" || status.state === "behind") &&
    now - Date.parse(status.updatedAt) > liveStatusStaleAfterMs(status.chunkSeconds);
  return { ...page, status, stale };
};
