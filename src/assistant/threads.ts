import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { INVALID_JOB_ID } from "../library-index/store";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { scopeKey, validateAssistantScope } from "./retrieval";
import type { AssistantScope, ChatCitation } from "./types";

/**
 * Assistant conversations, kept locally in `$XDG_DATA_HOME/recording-cli/assistant/threads/<uuid>.json`.
 * They quote meeting content, so they are private files and are removed with the meeting.
 */

export const THREAD_LIMITS = Object.freeze({ messages: 200, messageCharacters: 100_000, citations: 500, fileBytes: 8 * 1024 * 1024, files: 2_000, title: 120 });

export const THREAD_ERRORS = {
  notFound: "Conversa não encontrada.",
  invalid: "O arquivo da conversa é inválido.",
  unsafe: "A pasta de conversas do assistente está em um local inseguro; verifique as permissões.",
  busy: "A conversa está sendo salva em outra janela; tente de novo.",
  full: "Esta conversa atingiu o limite de mensagens; comece uma nova.",
  exists: "Já existe uma conversa com este identificador.",
  title: "Dê um nome de até 120 caracteres à conversa.",
  otherScope: "Esta conversa pertence a outro escopo."
} as const;

export type ThreadMessage = {
  role: "user" | "assistant";
  text: string;
  citations: ChatCitation[];
  createdAt: string;
  destination: { label: string; model: string };
  recipeId?: string;
};

export type AssistantThread = {
  version: 1;
  id: string;
  scope: AssistantScope;
  title: string;
  createdAt: string;
  updatedAt: string;
  destinationKey: string;
  messages: ThreadMessage[];
};

export type ThreadSummary = Omit<AssistantThread, "version" | "messages"> & { messageCount: number };

export const defaultThreadsDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "assistant", "threads");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT_ID = /^s\d{6}$/;
const REF = /^(?:m\d{1,4}:)?s\d{6}$/;
const RECIPE_ID = /^(?:custom:)?[a-z0-9][a-z0-9-]{0,80}$/;

const invalid = (): never => { throw new Error(THREAD_ERRORS.invalid); };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): void => { for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(); };
const CONTROL = /\p{Cc}/u;
const text = (value: unknown, maximum: number, required = false): string =>
  typeof value === "string" && value.length <= maximum && (!required || value.trim().length > 0) && !CONTROL.test(value.replace(/[\t\n\r]/g, "")) ? value : invalid();
const iso = (value: unknown): string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : invalid();
const seconds = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e7 ? value : invalid();

const validateCitation = (value: unknown): ChatCitation => {
  const item = record(value); onlyKeys(item, ["ref", "jobId", "segmentId", "start", "end", "title"]);
  const ref = typeof item.ref === "string" && REF.test(item.ref) ? item.ref : invalid();
  const jobId = typeof item.jobId === "string" && UUID.test(item.jobId) ? item.jobId : invalid();
  const segmentId = typeof item.segmentId === "string" && SEGMENT_ID.test(item.segmentId) ? item.segmentId : invalid();
  return { ref, jobId, segmentId, ...(item.start !== undefined ? { start: seconds(item.start) } : {}), ...(item.end !== undefined ? { end: seconds(item.end) } : {}),
    title: text(item.title, 200) };
};

export const validateThreadMessage = (value: unknown): ThreadMessage => {
  const item = record(value); onlyKeys(item, ["role", "text", "citations", "createdAt", "destination", "recipeId"]);
  const role = item.role === "user" || item.role === "assistant" ? item.role : invalid();
  const destination = record(item.destination); onlyKeys(destination, ["label", "model"]);
  const citations = Array.isArray(item.citations) && item.citations.length <= THREAD_LIMITS.citations ? item.citations.map(validateCitation) : invalid();
  const recipeId = item.recipeId === undefined ? undefined : typeof item.recipeId === "string" && RECIPE_ID.test(item.recipeId) ? item.recipeId : invalid();
  return { role, text: text(item.text, THREAD_LIMITS.messageCharacters, true), citations, createdAt: iso(item.createdAt),
    destination: { label: text(destination.label, 200), model: text(destination.model, 200) }, ...(recipeId ? { recipeId } : {}) };
};

export const validateThread = (value: unknown): AssistantThread => {
  const item = record(value); onlyKeys(item, ["version", "id", "scope", "title", "createdAt", "updatedAt", "destinationKey", "messages"]);
  if (item.version !== 1 || typeof item.id !== "string" || !UUID.test(item.id)) invalid();
  let scope: AssistantScope;
  try { scope = validateAssistantScope(item.scope); } catch { return invalid(); }
  const messages = Array.isArray(item.messages) && item.messages.length <= THREAD_LIMITS.messages ? item.messages.map(validateThreadMessage) : invalid();
  return { version: 1, id: (item.id as string).toLowerCase(), scope, title: text(item.title, THREAD_LIMITS.title, true), createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt), destinationKey: typeof item.destinationKey === "string" && SHA256.test(item.destinationKey) ? item.destinationKey : invalid(), messages };
};

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Removes the given `[[ref]]` markers, leaving one space between words and none before punctuation. */
export const removeMarkers = (text: string, refs: ReadonlySet<string>): string =>
  text.replace(/([ \t]*)\[\[((?:m\d{1,4}:)?s\d{6})\]\]/g, (whole: string, space: string, ref: string, offset: number, all: string) => {
    if (!refs.has(ref)) return whole;
    const next = all.charAt(offset + whole.length);
    return space && next && !/[\s.,;:!?)\]]/.test(next) ? " " : "";
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ThreadStore {
  constructor(
    readonly root = defaultThreadsDir(),
    private readonly options: { acquireLock?: (name: string) => Promise<SingletonLease>; lockWaitMs?: number } = {}
  ) {}

  private path(id: string): string {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error(THREAD_ERRORS.notFound);
    return join(this.root, `${id.toLowerCase()}.json`);
  }

  private async directory(create: boolean): Promise<boolean> {
    if (create) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let stat: Stats;
    try { stat = await fs.lstat(this.root); } catch (error) { if (!create && missing(error)) return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error(THREAD_ERRORS.unsafe);
    }
    return true;
  }

  private async readFile(id: string): Promise<AssistantThread | undefined> {
    if (!await this.directory(false)) return undefined;
    let handle: FileHandle;
    try { handle = await fs.open(this.path(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if (missing(error)) return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(THREAD_ERRORS.unsafe);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(THREAD_ERRORS.unsafe);
      if (stat.size > THREAD_LIMITS.fileBytes) throw new Error(THREAD_ERRORS.invalid);
      let parsed: unknown;
      try { parsed = JSON.parse((await handle.readFile()).toString("utf8")); } catch { throw new Error(THREAD_ERRORS.invalid); }
      const thread = validateThread(parsed);
      if (thread.id !== id.toLowerCase()) throw new Error(THREAD_ERRORS.invalid);
      return thread;
    } finally {
      await handle.close();
    }
  }

  /** Meeting named by the scope of a thread file, read leniently (only to honour a deletion). */
  private async meetingOf(id: string): Promise<string | undefined> {
    try {
      const handle = await fs.open(this.path(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > THREAD_LIMITS.fileBytes) return undefined;
        const parsed = JSON.parse((await handle.readFile()).toString("utf8")) as { scope?: { kind?: unknown; jobId?: unknown } } | null;
        const scope = parsed && typeof parsed === "object" ? parsed.scope : undefined;
        return scope && scope.kind === "meeting" && typeof scope.jobId === "string" ? scope.jobId.toLowerCase() : undefined;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  private async write(thread: AssistantThread): Promise<void> {
    const checked = validateThread(thread);
    const raw = JSON.stringify(checked);
    if (Buffer.byteLength(raw, "utf8") > THREAD_LIMITS.fileBytes) throw new Error(THREAD_ERRORS.full);
    await this.directory(true);
    const path = this.path(checked.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Serializes writers of one thread across windows and processes. */
  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const name = `assistant-thread-${createHash("sha256").update(`${this.root}:${id.toLowerCase()}`).digest("hex").slice(0, 32)}`;
    const acquire = this.options.acquireLock ?? acquireSingleton;
    const deadline = Date.now() + (this.options.lockWaitMs ?? 5_000);
    let lease: SingletonLease;
    for (;;) {
      try { lease = await acquire(name); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("is already running")) throw error;
        if (Date.now() >= deadline) throw new Error(THREAD_ERRORS.busy);
        await sleep(25);
      }
    }
    try { return await action(); } finally { await lease.release(); }
  }

  async read(id: string): Promise<AssistantThread> {
    // Checked before touching the disk: a malformed id is "not found", whatever the folder state.
    this.path(id);
    const thread = await this.readFile(id);
    if (!thread) throw new Error(THREAD_ERRORS.notFound);
    return thread;
  }

  /** New thread, optionally with its first messages and a chosen id. */
  async create(input: { id?: string; scope: AssistantScope; title: string; destinationKey: string; messages?: ThreadMessage[]; now?: Date }): Promise<AssistantThread> {
    const id = (input.id ?? randomUUID()).toLowerCase();
    const at = (input.now ?? new Date()).toISOString();
    const thread = validateThread({ version: 1, id, scope: input.scope, title: input.title.trim().slice(0, THREAD_LIMITS.title) || "Conversa", createdAt: at, updatedAt: at,
      destinationKey: input.destinationKey, messages: input.messages ?? [] });
    return this.withLock(id, async () => {
      if (await this.readFile(id)) throw new Error(THREAD_ERRORS.exists);
      await this.write(thread);
      return thread;
    });
  }

  /**
   * Adds messages to the thread, creating it first when it does not exist yet (two answers of a
   * new conversation may finish together). An existing thread must have the same scope.
   */
  async appendOrCreate(input: { id: string; scope: AssistantScope; title: string; destinationKey: string; messages: ThreadMessage[]; now?: Date }): Promise<AssistantThread> {
    this.path(input.id);
    const id = input.id.toLowerCase();
    const at = (input.now ?? new Date()).toISOString();
    const scope = validateAssistantScope(input.scope);
    const added = input.messages.map(validateThreadMessage);
    return this.withLock(id, async () => {
      const current = await this.readFile(id);
      if (current && scopeKey(current.scope) !== scopeKey(scope)) throw new Error(THREAD_ERRORS.otherScope);
      if ((current?.messages.length ?? 0) + added.length > THREAD_LIMITS.messages) throw new Error(THREAD_ERRORS.full);
      const thread: AssistantThread = current
        ? { ...current, messages: [...current.messages, ...added], updatedAt: at, destinationKey: input.destinationKey }
        : { version: 1, id, scope, title: input.title.trim().slice(0, THREAD_LIMITS.title) || "Conversa", createdAt: at, updatedAt: at, destinationKey: input.destinationKey, messages: added };
      await this.write(thread);
      return validateThread(thread);
    });
  }

  /** Adds messages at the end. Refuses (never trims) a thread that would pass the message limit. */
  async append(id: string, messages: ThreadMessage[], options: { destinationKey?: string; now?: Date } = {}): Promise<AssistantThread> {
    this.path(id);
    const added = messages.map(validateThreadMessage);
    return this.withLock(id, async () => {
      const thread = await this.read(id);
      if (thread.messages.length + added.length > THREAD_LIMITS.messages) throw new Error(THREAD_ERRORS.full);
      const updated: AssistantThread = { ...thread, messages: [...thread.messages, ...added], updatedAt: (options.now ?? new Date()).toISOString(),
        destinationKey: options.destinationKey ?? thread.destinationKey };
      await this.write(updated);
      return updated;
    });
  }

  async rename(id: string, title: string): Promise<AssistantThread> {
    this.path(id);
    const name = typeof title === "string" ? title.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > THREAD_LIMITS.title) throw new Error(THREAD_ERRORS.title);
    return this.withLock(id, async () => {
      const thread = await this.read(id);
      const updated = { ...thread, title: name };
      await this.write(updated);
      return updated;
    });
  }

  /** Threads newest first, optionally of one scope. Unreadable files are skipped. */
  async list(options: { scope?: AssistantScope } = {}): Promise<ThreadSummary[]> {
    if (!await this.directory(false)) return [];
    const wanted = options.scope ? scopeKey(validateAssistantScope(options.scope)) : undefined;
    const names = (await fs.readdir(this.root)).filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5))).slice(0, THREAD_LIMITS.files);
    const summaries: ThreadSummary[] = [];
    for (const name of names) {
      const thread = await this.readFile(name.slice(0, -5)).catch(() => undefined);
      if (!thread || (wanted && scopeKey(thread.scope) !== wanted)) continue;
      const { version: _version, messages, ...rest } = thread;
      summaries.push({ ...rest, messageCount: messages.length });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async remove(id: string): Promise<boolean> {
    const path = this.path(id);
    return this.withLock(id, async () => {
      try { await fs.lstat(path); } catch (error) { if (missing(error)) return false; throw error; }
      await fs.rm(path, { force: true });
      return true;
    });
  }

  /**
   * When a meeting is deleted: removes its own threads and strips citations to it from other
   * threads (the answers stay; their jump-to-moment links to the deleted recording do not).
   */
  async removeThreadsForJob(jobId: string): Promise<{ removed: number; scrubbed: number }> {
    if (typeof jobId !== "string" || !UUID.test(jobId)) throw new Error(INVALID_JOB_ID);
    const target = jobId.toLowerCase();
    const result = { removed: 0, scrubbed: 0 };
    if (!await this.directory(false)) return result;
    const names = (await fs.readdir(this.root)).filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)));
    for (const name of names) {
      const id = name.slice(0, -5);
      await this.withLock(id, async () => {
        let thread: AssistantThread | undefined;
        try { thread = await this.readFile(id); }
        catch (error) {
          // A private file this version cannot validate (damaged, or from a newer version) still quotes
          // the meeting: when its scope names the deleted meeting, it goes too. Unsafe files are left alone.
          if (error instanceof Error && error.message === THREAD_ERRORS.invalid && await this.meetingOf(id) === target) {
            await fs.rm(this.path(id), { force: true });
            result.removed++;
          }
          return;
        }
        if (!thread) return;
        if (thread.scope.kind === "meeting" && thread.scope.jobId === target) {
          await fs.rm(this.path(id), { force: true });
          result.removed++;
          return;
        }
        if (!thread.messages.some((message) => message.citations.some((citation) => citation.jobId.toLowerCase() === target))) return;
        await this.write({ ...thread, messages: thread.messages.map((message) => {
          const gone = new Set(message.citations.filter((citation) => citation.jobId.toLowerCase() === target).map((citation) => citation.ref));
          if (!gone.size) return message;
          // Markers are per message: "m1" may name another meeting elsewhere in the thread.
          const stripped = removeMarkers(message.text, gone).trim();
          return { ...message, text: stripped || "…", citations: message.citations.filter((citation) => citation.jobId.toLowerCase() !== target) };
        }) });
        result.scrubbed++;
      });
    }
    return result;
  }
}
