import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { acquireSingleton, type SingletonLease } from "../../runtime/singleton";

// Sign in with ChatGPT credentials: one 0600 JSON file under a 0700 directory in the state
// dir. Writes are atomic and serialized by a per-store lock, with a revision counter so a
// refresh never overwrites a newer token written by another process.

export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";

export type ChatGptCredentials = {
  version: 1;
  /** Bumped on every write. */
  rev: number;
  /** ext_agent_host_id: stable per installation, never derived from the user. */
  hostId: string;
  /** Client id OpenAI issued at the first registration (oaiapp_…). */
  clientId?: string;
  /** Present together, or not at all. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  email?: string;
  updatedAt: string;
};

export const CHATGPT_STORE_MESSAGES = {
  unsafe: "O arquivo de login do ChatGPT não é seguro (link simbólico ou permissões). Remova-o e entre de novo.",
  busy: "Outro processo está atualizando o login do ChatGPT. Tente de novo em instantes.",
  conflict: "O login do ChatGPT mudou em outra janela. Tente de novo."
} as const;

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TOKEN = /^[\x21-\x7e]+$/;
const SCOPE = /^[\x21-\x7e]{1,200}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}$/;

export const newHostId = (): string => `urn:uuid:${randomUUID()}`;

export const defaultChatGptDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "recording-cli", "chatgpt");
};

const isIsoDate = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** Rebuilds a stored record field by field; throws on anything unexpected. */
export const validateChatGptCredentials = (value: unknown): ChatGptCredentials => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("credentials must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported credentials version");
  if (!Number.isSafeInteger(raw.rev) || (raw.rev as number) < 0) throw new Error("invalid rev");
  if (typeof raw.hostId !== "string" || !HOST_ID.test(raw.hostId)) throw new Error("invalid hostId");
  if (!isIsoDate(raw.updatedAt)) throw new Error("invalid updatedAt");
  const record: ChatGptCredentials = { version: 1, rev: raw.rev as number, hostId: raw.hostId, updatedAt: raw.updatedAt };
  if (raw.clientId !== undefined) {
    if (typeof raw.clientId !== "string" || !CLIENT_ID_PATTERN.test(raw.clientId) || raw.clientId === DYNAMIC_CLIENT_ID) throw new Error("invalid clientId");
    record.clientId = raw.clientId;
  }
  const tokenFields = [raw.accessToken, raw.refreshToken, raw.expiresAt, raw.scopes];
  const present = tokenFields.filter((field) => field !== undefined).length;
  if (present !== 0 && present !== tokenFields.length) throw new Error("incomplete tokens");
  if (present) {
    for (const token of [raw.accessToken, raw.refreshToken]) {
      if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !TOKEN.test(token)) throw new Error("invalid token");
    }
    if (!isIsoDate(raw.expiresAt)) throw new Error("invalid expiresAt");
    if (!Array.isArray(raw.scopes) || raw.scopes.length === 0 || raw.scopes.length > 30 || raw.scopes.some((scope) => typeof scope !== "string" || !SCOPE.test(scope))) {
      throw new Error("invalid scopes");
    }
    if (!record.clientId) throw new Error("tokens without clientId");
    record.accessToken = raw.accessToken as string;
    record.refreshToken = raw.refreshToken as string;
    record.expiresAt = raw.expiresAt as string;
    record.scopes = [...new Set(raw.scopes as string[])];
  }
  if (raw.email !== undefined) {
    if (typeof raw.email !== "string" || !EMAIL.test(raw.email)) throw new Error("invalid email");
    record.email = raw.email;
  }
  return record;
};

/** Without tokens and e-mail; keeps the installation id and the issued client id for the next sign-in. */
export const withoutTokens = (record: ChatGptCredentials): ChatGptCredentials => {
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, scopes: _s, email: _m, ...rest } = record;
  return rest;
};

export type ChatGptStoreOptions = { lockWaitMs?: number; now?: () => Date };

/** Result of a transaction step: the record to write (null deletes the file, undefined keeps it) and a value. */
export type StoreStep<T> = { next?: ChatGptCredentials | null; result: T };

export class ChatGptStore {
  private readonly lockWaitMs: number;
  private readonly now: () => Date;

  constructor(readonly root: string = defaultChatGptDir(), options: ChatGptStoreOptions = {}) {
    this.lockWaitMs = options.lockWaitMs ?? 40_000;
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return join(this.root, "oauth.json");
  }

  /** The stored record; a damaged file reads as signed out. A link or foreign file is refused. */
  async read(): Promise<ChatGptCredentials | undefined> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      if (code === "ELOOP") throw new Error(CHATGPT_STORE_MESSAGES.unsafe);
      throw error;
    }
    try {
      const stat = await handle.stat();
      const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error(CHATGPT_STORE_MESSAGES.unsafe);
      if (stat.size > MAX_FILE_BYTES) return undefined;
      const text = await handle.readFile("utf8");
      try {
        return validateChatGptCredentials(JSON.parse(text));
      } catch {
        return undefined;
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads, lets `step` decide, and writes under the lock. With expectedRev, a record whose rev
   * differs is refused (another process wrote in between).
   */
  async transaction<T>(step: (current: ChatGptCredentials | undefined) => Promise<StoreStep<T>> | StoreStep<T>, options: { expectedRev?: number } = {}): Promise<T> {
    const lease = await this.lock();
    try {
      const current = await this.read();
      if (options.expectedRev !== undefined && (current?.rev ?? 0) !== options.expectedRev) throw new Error(CHATGPT_STORE_MESSAGES.conflict);
      const { next, result } = await step(current);
      if (next === null) await this.removeFile();
      else if (next !== undefined) await this.write({ ...next, version: 1, rev: (current?.rev ?? 0) + 1, updatedAt: this.now().toISOString() });
      return result;
    } finally {
      await lease.release();
    }
  }

  /** Deletes the file (or a link planted in its place) under the lock, without reading it. */
  async remove(): Promise<void> {
    const lease = await this.lock();
    try {
      await this.removeFile();
    } finally {
      await lease.release();
    }
  }

  /** The installation id, created and saved on first use. */
  async ensureHostId(): Promise<ChatGptCredentials> {
    return this.transaction((current) => {
      if (current) return { result: current };
      const next: ChatGptCredentials = { version: 1, rev: 0, hostId: newHostId(), updatedAt: this.now().toISOString() };
      return { next, result: { ...next, rev: 1 } };
    });
  }

  private async lock(): Promise<SingletonLease> {
    const name = `chatgpt-oauth-${createHash("sha256").update(this.root).digest("hex").slice(0, 16)}`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        return await acquireSingleton(name);
      } catch (error) {
        if ((error as Error).message !== `${name} is already running`) throw error;
        if (Date.now() >= deadline) throw new Error(CHATGPT_STORE_MESSAGES.busy);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error(CHATGPT_STORE_MESSAGES.unsafe);
    if ((stat.mode & 0o077) !== 0) await fs.chmod(this.root, 0o700);
  }

  private async write(record: ChatGptCredentials): Promise<void> {
    const checked = validateChatGptCredentials(record);
    await this.ensureDirectory();
    const existing = await fs.lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(CHATGPT_STORE_MESSAGES.unsafe);
    const temporary = join(this.root, `.oauth.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.path);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async removeFile(): Promise<void> {
    const existing = await fs.lstat(this.path).catch(() => undefined);
    if (!existing) return;
    if (!existing.isFile() && !existing.isSymbolicLink()) throw new Error(CHATGPT_STORE_MESSAGES.unsafe);
    // Unlinking removes a link itself, never its target.
    await fs.rm(this.path, { force: true });
  }
}
