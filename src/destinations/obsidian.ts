import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import {
  SHARE_MESSAGES,
  SHARE_WARNINGS,
  ShareError,
  assertRenderedShare,
  formatLocalDateTime,
  readFrontmatterValue,
  sha256Hex,
  untitledLabel,
  type RenderedShare
} from "../share/render";
import { openUrlWithXdg, type OpenUrl } from "./clipboard";
import { deliveryLogKey, recordDelivery, type DeliveryLog, type DeliveryReceipt } from "./log";

/**
 * Obsidian: the note is written as a Markdown file straight into the vault, so Obsidian does not
 * have to be running and there is no size limit. Vault files belong to the user (0644), and a file
 * the user may have edited is never overwritten:
 * - same `falatrace_snapshot` in its frontmatter → nothing to do ("reused");
 * - same `falatrace_job` and byte-identical to what FalaTrace last wrote there → replaced atomically;
 * - anything else → the next free "… (2).md" name.
 */

export const MAX_FILE_NAME_CHARACTERS = 120;
const MAX_FILE_NAME_BYTES = 240;
const MAX_CANDIDATES = 99;
const MAX_EXISTING_BYTES = 8 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;

/** Characters Obsidian or the file system refuse in names or links, plus invisible and direction-changing ones. */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029/\\:*?"<>|#^[\]]/gu;

const truncate = (value: string, maxCharacters: number, maxBytes: number): string => {
  let result = "";
  let bytes = 0;
  let characters = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (characters + character.length > maxCharacters || bytes + size > maxBytes) break;
    result += character;
    bytes += size;
    characters += character.length;
  }
  return result;
};

/** A title made safe as part of a file name: no separators, no hidden or traversal names, bounded. */
export const sanitizeFileNamePart = (value: string, maxCharacters = MAX_FILE_NAME_CHARACTERS, maxBytes = MAX_FILE_NAME_BYTES): string => {
  const cleaned = value.normalize("NFC").replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^[.\s]+/, "");
  return truncate(cleaned, maxCharacters, maxBytes).replace(/[.\s]+$/, "");
};

/** "<YYYY-MM-DD HH-mm — title>.md", or "… (n).md" for the n-th candidate; at most 120 characters. */
export const obsidianFileName = (share: Pick<RenderedShare, "date" | "title" | "language">, candidate = 1, timeZone?: string): string => {
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_CANDIDATES) throw new ShareError(SHARE_MESSAGES.obsidianNoFreeName, "conflict");
  const stamp = formatLocalDateTime(share.date, timeZone).replace(":", "-");
  const suffix = `${candidate > 1 ? ` (${candidate})` : ""}.md`;
  const prefix = `${stamp} — `;
  const room = MAX_FILE_NAME_CHARACTERS - prefix.length - suffix.length;
  const roomBytes = MAX_FILE_NAME_BYTES - Buffer.byteLength(prefix + suffix, "utf8");
  const title = sanitizeFileNamePart(share.title, room, roomBytes) || sanitizeFileNamePart(untitledLabel(share.language), room, roomBytes);
  return `${prefix}${title}${suffix}`;
};

/** Folder inside the vault as path components; refuses absolute paths, "." and "..". */
export const obsidianFolderParts = (folder: string): string[] => {
  if (typeof folder !== "string" || folder.length > 200 || /[\p{Cc}]/u.test(folder) || folder.startsWith("/")) {
    throw new ShareError(SHARE_MESSAGES.obsidianFolderInvalid, "config");
  }
  const trimmed = folder.replace(/\/+$/, "");
  if (!trimmed) return [];
  const parts = trimmed.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.trim() !== part || Buffer.byteLength(part, "utf8") > 255) {
      throw new ShareError(SHARE_MESSAGES.obsidianFolderInvalid, "config");
    }
  }
  return parts;
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const realDirectory = async (path: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

/** The vault must exist and be a real folder; the folder inside it is created (0755) one real component at a time. */
const prepareFolder = async (vault: string, folder: string): Promise<string> => {
  if (!vault) throw new ShareError(SHARE_MESSAGES.obsidianNotConfigured, "config");
  if (!isAbsolute(vault) || /[\p{Cc}]/u.test(vault) || !(await realDirectory(vault))) throw new ShareError(SHARE_MESSAGES.obsidianVaultInvalid, "config");
  let current = resolve(vault);
  for (const part of obsidianFolderParts(folder)) {
    current = join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new ShareError(SHARE_MESSAGES.obsidianWriteFailed, "io");
    }
    if (!(await realDirectory(current))) throw new ShareError(SHARE_MESSAGES.obsidianFolderInvalid, "config");
  }
  return current;
};

type Existing =
  | { state: "absent" }
  | { state: "other" }
  | { state: "file"; sha256: string; snapshot?: string; job?: string };

const inspect = async (path: string): Promise<Existing> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "absent" } : { state: "other" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_EXISTING_BYTES) return { state: "other" };
    const bytes = await handle.readFile();
    const text = bytes.toString("utf8");
    return {
      state: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      snapshot: readFrontmatterValue(text, "falatrace_snapshot"),
      job: readFrontmatterValue(text, "falatrace_job")
    };
  } catch {
    return { state: "other" };
  } finally {
    await handle.close();
  }
};

const createExclusive = async (path: string, text: string): Promise<"created" | "exists"> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP") return "exists";
    throw new ShareError(SHARE_MESSAGES.obsidianWriteFailed, "io");
  }
  try {
    await handle.writeFile(text, "utf8");
  } catch {
    await handle.close().catch(() => undefined);
    await fs.rm(path, { force: true });
    throw new ShareError(SHARE_MESSAGES.obsidianWriteFailed, "io");
  }
  await handle.close();
  return "created";
};

/** Replaces `path` with `text` only if it still has `expectedSha256`; false when it changed meanwhile. */
const replaceIfUnchanged = async (dir: string, path: string, text: string, expectedSha256: string): Promise<boolean> => {
  const temporary = join(dir, `.falatrace-${randomUUID()}.tmp`);
  try {
    if ((await createExclusive(temporary, text)) !== "created") throw new ShareError(SHARE_MESSAGES.obsidianWriteFailed, "io");
    const current = await inspect(path);
    if (current.state !== "file" || current.sha256 !== expectedSha256) return false;
    await fs.rename(temporary, path);
    return true;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError(SHARE_MESSAGES.obsidianWriteFailed, "io");
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

export type ObsidianDeliverInput = {
  share: RenderedShare;
  /** Absolute path of the vault (destinations.obsidianVault). */
  vault: string;
  /** Folder inside the vault (destinations.obsidianFolder); "" writes at the vault root. */
  folder: string;
  /** Open the note in Obsidian afterwards. */
  open?: boolean;
  timeZone?: string;
};

export type ObsidianDeps = {
  log?: DeliveryLog;
  now?: () => Date;
  openUrl?: OpenUrl;
  lock?: (name: string) => Promise<SingletonLease>;
};

const withLock = async <T>(name: string, lock: (name: string) => Promise<SingletonLease>, action: () => Promise<T>): Promise<T> => {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lease: SingletonLease;
  for (;;) {
    try {
      lease = await lock(name);
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
};

/** obsidian://open for an absolute file path ("/" is encoded too, as Obsidian expects). */
export const obsidianOpenUrl = (path: string): string => `obsidian://open?path=${encodeURIComponent(path)}`;

export const deliverObsidian = async (input: ObsidianDeliverInput, deps: ObsidianDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  const key = deliveryLogKey(share.jobId);
  const now = deps.now ?? (() => new Date());
  const folder = await prepareFolder(input.vault, input.folder);
  const text = share.document;
  const sha256 = sha256Hex(text);
  const writeNote = async (): Promise<{ path: string; result: "created" | "replaced" | "reused" }> => {
    for (let candidate = 1; candidate <= MAX_CANDIDATES; candidate += 1) {
      const path = join(folder, obsidianFileName(share, candidate, input.timeZone));
      // Two passes: a file created between the check and the exclusive create is inspected again.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await inspect(path);
        if (existing.state === "absent") {
          if ((await createExclusive(path, text)) === "created") return { path, result: "created" as const };
          continue;
        }
        if (existing.state !== "file") break;
        if (existing.snapshot === share.snapshot) return { path, result: "reused" as const };
        if (share.jobId && existing.job === share.jobId && deps.log) {
          const last = await deps.log.last(key, { destination: "obsidian", target: path, results: ["created", "replaced"] });
          if (last?.sha256 === existing.sha256 && (await replaceIfUnchanged(folder, path, text, existing.sha256))) {
            return { path, result: "replaced" as const };
          }
        }
        break;
      }
    }
    throw new ShareError(SHARE_MESSAGES.obsidianNoFreeName, "conflict");
  };
  const outcome = await withLock(`share-obsidian-${sha256Hex(folder).slice(0, 24)}`, deps.lock ?? acquireSingleton, async () => {
    const written = await writeNote();
    // Recorded under the lock, so the next delivery sees this hash when it decides whether to replace.
    const at = now().toISOString();
    await recordDelivery(deps.log, share.jobId, { at, destination: "obsidian", target: written.path, sha256, result: written.result, location: written.path });
    return { ...written, at };
  });
  const warnings: string[] = [];
  if (input.open) {
    try {
      await (deps.openUrl ?? openUrlWithXdg)(obsidianOpenUrl(outcome.path));
    } catch {
      warnings.push(SHARE_WARNINGS.obsidianNotOpened);
    }
  }
  return { at: outcome.at, destination: "obsidian", target: outcome.path, sha256, result: outcome.result, location: outcome.path, warnings };
};
