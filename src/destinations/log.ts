import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { SHARE_MESSAGES, ShareError, isUuid } from "../share/render";

/**
 * What left the machine, per recording: $XDG_STATE_HOME/recording-cli/share-deliveries/<jobId>.json
 * (`library.json` for library-wide results). Targets are stored redacted. Obsidian also reads it to
 * know whether a note on disk is still exactly what FalaTrace wrote (and may be replaced).
 */

export const DESTINATION_KINDS = ["obsidian", "notion", "slack", "clipboard", "ai-app"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const DELIVERY_RESULTS = ["created", "replaced", "reused", "sent", "copied", "returned", "saved", "opened", "failed"] as const;
export type DeliveryResult = (typeof DELIVERY_RESULTS)[number];

export type DeliveryRecord = {
  at: string;
  destination: DestinationKind;
  /** Redacted: a vault path, "notion:page/<id>", "hooks.slack.com/services/T…/B…/***", "clipboard", "ai-app:<target>". */
  target: string;
  /** sha256 of the bytes delivered. */
  sha256: string;
  result: DeliveryResult;
  /** Where it ended up, when that is not secret: a file path or a Notion page URL. */
  location?: string;
};

/** What every destination returns. */
export type DeliveryReceipt = DeliveryRecord & {
  /** Messages from SHARE_WARNINGS. */
  warnings: string[];
  /** Clipboard and AI apps in "return" mode: the text the Studio copies itself. */
  content?: string;
  /** Slack: messages posted. */
  posts?: number;
  /** AI apps: the URL opened (or to open), never carrying meeting text. */
  url?: string;
  /** AI command-line tools: the command started in a terminal, in the folder of `location`. */
  command?: string[];
};

export const MAX_DELIVERIES = 200;
const MAX_LOG_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|library)$/;

export const defaultDeliveryLogDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  join(env.XDG_STATE_HOME || join(home, ".local", "state"), "recording-cli", "share-deliveries");

/** Log key of a delivery: the job id, or "library" for content not tied to one recording. */
export const deliveryLogKey = (jobId?: string): string => (jobId === undefined ? "library" : isUuid(jobId) ? jobId : (() => {
  throw new ShareError(SHARE_MESSAGES.invalidNote, "invalid");
})());

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/** Strict check of one stored record; returns undefined for anything malformed. */
export const validateDeliveryRecord = (value: unknown): DeliveryRecord | undefined => {
  if (!isObject(value) || Object.keys(value).some((key) => !["at", "destination", "target", "sha256", "result", "location"].includes(key))) return undefined;
  if (typeof value.at !== "string" || value.at.length > 40 || !Number.isFinite(Date.parse(value.at))) return undefined;
  if (!oneOf(DESTINATION_KINDS, value.destination) || !oneOf(DELIVERY_RESULTS, value.result)) return undefined;
  if (typeof value.target !== "string" || value.target.length === 0 || value.target.length > 4096 || /\p{Cc}/u.test(value.target)) return undefined;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return undefined;
  const record: DeliveryRecord = { at: value.at, destination: value.destination, target: value.target, sha256: value.sha256, result: value.result };
  if (value.location !== undefined) {
    if (typeof value.location !== "string" || value.location.length === 0 || value.location.length > 4096 || /\p{Cc}/u.test(value.location)) return undefined;
    record.location = value.location;
  }
  return record;
};

/** The deliveries in a stored file; a file that is not exactly a version-1 log counts as empty. */
export const parseDeliveryLog = (text: string): DeliveryRecord[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.deliveries) || Object.keys(parsed).some((key) => key !== "version" && key !== "deliveries")) return [];
  const records: DeliveryRecord[] = [];
  for (const item of parsed.deliveries.slice(-MAX_DELIVERIES)) {
    const record = validateDeliveryRecord(item);
    if (record) records.push(record);
  }
  return records;
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

export type DeliveryLogOptions = {
  dir?: string;
  lock?: (name: string) => Promise<SingletonLease>;
  lockTimeoutMs?: number;
};

export class DeliveryLog {
  readonly dir: string;
  private readonly lock: (name: string) => Promise<SingletonLease>;
  private readonly lockTimeoutMs: number;

  constructor(options: DeliveryLogOptions = {}) {
    this.dir = resolve(options.dir ?? defaultDeliveryLogDir());
    this.lock = options.lock ?? acquireSingleton;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  path(key: string): string {
    if (!KEY.test(key)) throw new ShareError(SHARE_MESSAGES.invalidNote, "invalid");
    return join(this.dir, `${key}.json`);
  }

  /** Deliveries of a recording (or "library"), oldest first. */
  async read(key: string): Promise<DeliveryRecord[]> {
    const path = this.path(key);
    if ((await this.directoryState()) !== "safe") return [];
    return this.readFile(path);
  }

  /** Appends one delivery, keeping the newest MAX_DELIVERIES. */
  async append(key: string, record: DeliveryRecord): Promise<void> {
    const checked = validateDeliveryRecord(record);
    if (!checked) throw new ShareError(SHARE_MESSAGES.invalidNote, "invalid");
    const path = this.path(key);
    await this.withLock(async () => {
      await this.ensureDirectory();
      const records = [...(await this.readFile(path)), checked].slice(-MAX_DELIVERIES);
      let text = `${JSON.stringify({ version: 1, deliveries: records })}\n`;
      // Stay under the read bound: drop the oldest entries until it fits.
      while (Buffer.byteLength(text, "utf8") > MAX_LOG_BYTES && records.length > 1) {
        records.shift();
        text = `${JSON.stringify({ version: 1, deliveries: records })}\n`;
      }
      await this.writeAtomic(path, text);
    });
  }

  /** Newest delivery matching the filter. */
  async last(key: string, filter: { destination: DestinationKind; target?: string; results?: readonly DeliveryResult[] }): Promise<DeliveryRecord | undefined> {
    const records = await this.read(key);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.destination !== filter.destination) continue;
      if (filter.target !== undefined && record.target !== filter.target) continue;
      if (filter.results && !filter.results.includes(record.result)) continue;
      return record;
    }
    return undefined;
  }

  /** Forget a recording's deliveries (when the recording is deleted). */
  async remove(key: string): Promise<boolean> {
    const path = this.path(key);
    return this.withLock(async () => {
      if ((await this.directoryState()) !== "safe") return false;
      try {
        const stat = await fs.lstat(path);
        if (stat.isDirectory()) return false;
        await fs.unlink(path);
        return true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    });
  }

  private async readFile(path: string): Promise<DeliveryRecord[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return [];
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_LOG_BYTES) return [];
      return parseDeliveryLog((await handle.readFile()).toString("utf8"));
    } catch {
      return [];
    } finally {
      await handle.close();
    }
  }

  private async directoryState(): Promise<"absent" | "safe" | "unsafe"> {
    try {
      const stat = await fs.lstat(this.dir);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "safe" : "unsafe";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      return "unsafe";
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    if ((await this.directoryState()) !== "safe") throw new ShareError(SHARE_MESSAGES.logUnsafe, "io");
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const existing = await fs.lstat(path).catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new ShareError(SHARE_MESSAGES.logUnsafe, "io");
    const temporary = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const name = `share-deliveries-${createHash("sha256").update(this.dir).digest("hex").slice(0, 24)}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let lease: SingletonLease;
    for (;;) {
      try {
        lease = await this.lock(name);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== `${name} is already running`) throw error;
        if (Date.now() >= deadline) throw new ShareError(SHARE_MESSAGES.logBusy, "busy");
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }
}

/** Records a delivery without letting a log problem turn a completed share into a failure. */
export const recordDelivery = async (log: DeliveryLog | undefined, jobId: string | undefined, record: DeliveryRecord): Promise<boolean> => {
  if (!log) return false;
  try {
    await log.append(deliveryLogKey(jobId), record);
    return true;
  } catch {
    return false;
  }
};

/** Forget every delivery of a deleted recording. */
export const removeDeliveriesForJob = (jobId: string, options?: DeliveryLogOptions): Promise<boolean> =>
  new DeliveryLog(options).remove(deliveryLogKey(jobId));
