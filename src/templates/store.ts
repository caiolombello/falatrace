import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getConfigPath } from "../config/load";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import {
  BUILT_IN_TEMPLATES,
  TEMPLATE_LIMITS,
  TEMPLATE_MESSAGES,
  builtInTemplate,
  customTemplateSlug,
  validateTemplate,
  type SummaryTemplate
} from "./catalog";

// Custom templates are user configuration, so they live next to the active config file:
// <config dir>/templates/<slug>.json, one file per "custom:<slug>" template.

export const MAX_CUSTOM_TEMPLATES = 100;
export const MAX_TEMPLATE_FILE_BYTES = 64 * 1024;
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,40})\.json$/;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export type StoredTemplateFile = { version: 1; updatedAt: string; template: SummaryTemplate };

export type TemplateFileProblemReason =
  | "unsafe-directory"
  | "not-a-file"
  | "too-large"
  | "unreadable"
  | "invalid-json"
  | "invalid-template"
  | "id-mismatch"
  | "over-limit";

/** A file in the templates folder that was skipped, so Settings can point at it. */
export type TemplateFileProblem = { file: string; reason: TemplateFileProblemReason };

export type TemplateStoreOptions = {
  /** Folder of the custom templates; defaults to defaultTemplatesDir(). */
  dir?: string;
  /** Cross-process lock; defaults to acquireSingleton. */
  lock?: (name: string) => Promise<SingletonLease>;
  now?: () => Date;
  lockTimeoutMs?: number;
};

export type TemplateWriteOptions = {
  /** Omit to create (fails when the id exists); pass the version you loaded to update it. */
  expectedVersion?: number;
};

/** <dirname(active config file)>/templates, resolved on each call. */
export const defaultTemplatesDir = (): string => join(dirname(getConfigPath()), "templates");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict check of a stored file: { version: 1, updatedAt, template } with a custom template. */
export const validateTemplateFile = (value: unknown): StoredTemplateFile => {
  if (!isObject(value) || Object.keys(value).some((key) => !["version", "updatedAt", "template"].includes(key)) || value.version !== 1 ||
      typeof value.updatedAt !== "string" || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(TEMPLATE_MESSAGES.invalidFile);
  }
  const template = validateTemplate(value.template);
  if (template.builtIn || !customTemplateSlug(template.id)) throw new Error(TEMPLATE_MESSAGES.invalidFile);
  return { version: 1, updatedAt: value.updatedAt, template };
};

type Slot =
  | { state: "absent" }
  | { state: "valid"; file: StoredTemplateFile }
  | { state: "invalid"; reason: TemplateFileProblemReason };

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const validExpectedVersion = (value: unknown): value is number | undefined =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < TEMPLATE_LIMITS.maxVersion);

export class TemplateStore {
  readonly dir: string;
  private readonly lock: (name: string) => Promise<SingletonLease>;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;

  constructor(options: TemplateStoreOptions = {}) {
    this.dir = resolve(options.dir ?? defaultTemplatesDir());
    this.lock = options.lock ?? acquireSingleton;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** File path of a custom template id, or undefined for built-in or malformed ids. */
  path(id: string): string | undefined {
    const slug = customTemplateSlug(id);
    return slug ? join(this.dir, `${slug}.json`) : undefined;
  }

  /** Built-ins in catalog order, then valid custom templates by id. */
  async list(): Promise<SummaryTemplate[]> {
    return [...BUILT_IN_TEMPLATES, ...(await this.inspect()).templates];
  }

  /** Valid custom templates plus the files that were skipped and why. Never throws for a
   * broken folder: summaries go on with the built-ins and the problem is reported. */
  async inspect(): Promise<{ templates: SummaryTemplate[]; problems: TemplateFileProblem[] }> {
    let names: string[];
    try {
      const directory = await this.directoryState();
      if (directory === "absent") return { templates: [], problems: [] };
      if (directory === "unsafe") return { templates: [], problems: [{ file: ".", reason: "unsafe-directory" }] };
      names = (await fs.readdir(this.dir)).filter((name) => FILE_NAME.test(name)).sort();
    } catch {
      return { templates: [], problems: [{ file: ".", reason: "unreadable" }] };
    }
    const problems: TemplateFileProblem[] = names.slice(MAX_CUSTOM_TEMPLATES).map((file) => ({ file, reason: "over-limit" }));
    const templates: SummaryTemplate[] = [];
    for (const file of names.slice(0, MAX_CUSTOM_TEMPLATES)) {
      const slot = await this.readSlot(join(this.dir, file));
      if (slot.state === "valid") templates.push(slot.file.template);
      else if (slot.state === "invalid") problems.push({ file, reason: slot.reason });
    }
    templates.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return { templates, problems };
  }

  /** A built-in or custom template; undefined when it does not exist. A broken file throws. */
  async get(id: string): Promise<SummaryTemplate | undefined> {
    if (typeof id !== "string") return undefined;
    const builtIn = builtInTemplate(id);
    if (builtIn) return builtIn;
    const path = this.path(id);
    if (!path || (await this.directoryState()) !== "safe") return undefined;
    const slot = await this.readSlot(path);
    if (slot.state === "invalid") throw new Error(TEMPLATE_MESSAGES.invalidFile);
    return slot.state === "valid" ? slot.file.template : undefined;
  }

  /** Creates (no expectedVersion) or updates (expectedVersion = the version you loaded) a
   * custom template. Returns what was stored, with its new version. */
  async save(value: unknown, options: TemplateWriteOptions = {}): Promise<SummaryTemplate> {
    const template = validateTemplate(value);
    if (builtInTemplate(template.id)) throw new Error(TEMPLATE_MESSAGES.builtInReadOnly);
    const path = this.path(template.id);
    if (template.builtIn || !path) throw new Error(TEMPLATE_MESSAGES.customIdRequired);
    if (!validExpectedVersion(options.expectedVersion)) throw new Error(TEMPLATE_MESSAGES.invalid);
    const expected = options.expectedVersion;
    return this.withLock(async () => {
      await this.ensureDirectory();
      const slot = await this.readSlot(path);
      let version = 1;
      if (expected === undefined) {
        if (slot.state !== "absent") throw new Error(TEMPLATE_MESSAGES.exists);
        if ((await this.countFiles()) >= MAX_CUSTOM_TEMPLATES) throw new Error(TEMPLATE_MESSAGES.limit);
      } else {
        if (slot.state === "absent") throw new Error(TEMPLATE_MESSAGES.missing);
        if (slot.state === "invalid") throw new Error(TEMPLATE_MESSAGES.invalidFile);
        if (slot.file.template.version !== expected) throw new Error(TEMPLATE_MESSAGES.conflict);
        version = expected + 1;
      }
      const stored: StoredTemplateFile = { version: 1, updatedAt: this.now().toISOString(), template: { ...template, version, builtIn: false } };
      const text = `${JSON.stringify(stored, null, 2)}\n`;
      if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_FILE_BYTES) throw new Error(TEMPLATE_MESSAGES.tooLarge);
      await this.writeAtomic(path, text);
      return stored.template;
    });
  }

  /** Deletes a custom template; false when it was already gone. Pass expectedVersion to
   * refuse deleting a template that changed since it was loaded. */
  async remove(id: string, options: TemplateWriteOptions = {}): Promise<boolean> {
    if (typeof id === "string" && builtInTemplate(id)) throw new Error(TEMPLATE_MESSAGES.builtInReadOnly);
    const path = typeof id === "string" ? this.path(id) : undefined;
    if (!path) throw new Error(TEMPLATE_MESSAGES.invalidId);
    if (!validExpectedVersion(options.expectedVersion)) throw new Error(TEMPLATE_MESSAGES.invalid);
    return this.withLock(async () => {
      const directory = await this.directoryState();
      if (directory === "absent") return false;
      if (directory === "unsafe") throw new Error(TEMPLATE_MESSAGES.unsafeDirectory);
      const stat = await fs.lstat(path).catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return false;
      // A symlink is removed itself (unlink never follows it); a folder is never touched.
      if (stat.isDirectory()) throw new Error(TEMPLATE_MESSAGES.invalidFile);
      if (options.expectedVersion !== undefined) {
        const slot = await this.readSlot(path);
        if (slot.state === "absent") return false;
        if (slot.state === "invalid") throw new Error(TEMPLATE_MESSAGES.invalidFile);
        if (slot.file.template.version !== options.expectedVersion) throw new Error(TEMPLATE_MESSAGES.conflict);
      }
      await fs.unlink(path).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      return true;
    });
  }

  private async directoryState(): Promise<"absent" | "safe" | "unsafe"> {
    try {
      const stat = await fs.lstat(this.dir);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "safe" : "unsafe";
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "absent";
      // A file where a parent folder should be.
      if (errorCode(error) === "ENOTDIR") return "unsafe";
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 }).catch((error) => {
      // EEXIST: a file named "templates"; ENOTDIR: a file where a parent folder should be.
      if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTDIR") throw new Error(TEMPLATE_MESSAGES.unsafeDirectory);
      throw error;
    });
    if ((await this.directoryState()) !== "safe") throw new Error(TEMPLATE_MESSAGES.unsafeDirectory);
    // mkdir leaves an existing folder (made by hand, or with a looser umask) as it was.
    await fs.chmod(this.dir, 0o700);
  }

  private async countFiles(): Promise<number> {
    return (await fs.readdir(this.dir)).filter((name) => FILE_NAME.test(name)).length;
  }

  private async readSlot(path: string): Promise<Slot> {
    let handle: fs.FileHandle;
    try {
      // O_NOFOLLOW refuses symlinks; O_NONBLOCK keeps a planted FIFO from hanging the read.
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { state: "absent" };
      return { state: "invalid", reason: code === "ELOOP" ? "not-a-file" : "unreadable" };
    }
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { state: "invalid", reason: "not-a-file" };
      if (stat.size > MAX_TEMPLATE_FILE_BYTES) return { state: "invalid", reason: "too-large" };
      // Bounded even if the file grows after the stat: never more than the limit plus one byte.
      const buffer = Buffer.alloc(MAX_TEMPLATE_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_TEMPLATE_FILE_BYTES) return { state: "invalid", reason: "too-large" };
      raw = buffer.subarray(0, size).toString("utf8");
    } catch {
      return { state: "invalid", reason: "unreadable" };
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid", reason: "invalid-json" };
    }
    let file: StoredTemplateFile;
    try {
      file = validateTemplateFile(parsed);
    } catch {
      return { state: "invalid", reason: "invalid-template" };
    }
    // The file name is the identity; a copied file with another id is not loaded twice.
    if (this.path(file.template.id) !== path) return { state: "invalid", reason: "id-mismatch" };
    return { state: "valid", file };
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const existing = await fs.lstat(path).catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(TEMPLATE_MESSAGES.invalidFile);
    const temporary = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const name = `templates-${createHash("sha256").update(this.dir).digest("hex").slice(0, 24)}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let lease: SingletonLease;
    for (;;) {
      try {
        lease = await this.lock(name);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== `${name} is already running`) throw error;
        if (Date.now() >= deadline) throw new Error(TEMPLATE_MESSAGES.busy);
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

/** Built-in templates followed by valid custom templates. */
export const listTemplates = (options?: TemplateStoreOptions): Promise<SummaryTemplate[]> => new TemplateStore(options).list();

/** Custom templates and the files that could not be loaded. */
export const inspectCustomTemplates = (options?: TemplateStoreOptions): Promise<{ templates: SummaryTemplate[]; problems: TemplateFileProblem[] }> =>
  new TemplateStore(options).inspect();

export const getTemplate = (id: string, options?: TemplateStoreOptions): Promise<SummaryTemplate | undefined> => new TemplateStore(options).get(id);

export const saveCustomTemplate = (template: unknown, options: TemplateStoreOptions & TemplateWriteOptions = {}): Promise<SummaryTemplate> =>
  new TemplateStore(options).save(template, { expectedVersion: options.expectedVersion });

export const deleteCustomTemplate = (id: string, options: TemplateStoreOptions & TemplateWriteOptions = {}): Promise<boolean> =>
  new TemplateStore(options).remove(id, { expectedVersion: options.expectedVersion });
