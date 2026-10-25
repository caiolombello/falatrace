import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getConfigPath } from "../config/load";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import { BUILT_IN_RECIPES, RECIPE_LIMITS, RECIPE_MESSAGES, builtInRecipe, customRecipeSlug, validateRecipe, type Recipe } from "./catalog";

// Custom recipes are user configuration, so they live next to the active config file:
// <config dir>/recipes/<slug>.json, one file per "custom:<slug>" recipe.

export const MAX_CUSTOM_RECIPES = 100;
export const MAX_RECIPE_FILE_BYTES = 64 * 1024;
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,40})\.json$/;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export type StoredRecipeFile = { version: 1; updatedAt: string; recipe: Recipe };

export type RecipeFileProblemReason =
  | "unsafe-directory"
  | "not-a-file"
  | "too-large"
  | "unreadable"
  | "invalid-json"
  | "invalid-recipe"
  | "id-mismatch"
  | "over-limit";

/** A file in the recipes folder that was skipped, so Settings can point at it. */
export type RecipeFileProblem = { file: string; reason: RecipeFileProblemReason };

export type RecipeStoreOptions = {
  /** Folder of the custom recipes; defaults to defaultRecipesDir(). */
  dir?: string;
  /** Cross-process lock; defaults to acquireSingleton. */
  lock?: (name: string) => Promise<SingletonLease>;
  now?: () => Date;
  lockTimeoutMs?: number;
};

export type RecipeWriteOptions = {
  /** Omit to create (fails when the id exists); pass the version you loaded to update it. */
  expectedVersion?: number;
};

/** <dirname(active config file)>/recipes, resolved on each call. */
export const defaultRecipesDir = (): string => join(dirname(getConfigPath()), "recipes");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict check of a stored file: { version: 1, updatedAt, recipe } with a custom recipe. */
export const validateRecipeFile = (value: unknown): StoredRecipeFile => {
  if (!isObject(value) || Object.keys(value).some((key) => !["version", "updatedAt", "recipe"].includes(key)) || value.version !== 1 ||
      typeof value.updatedAt !== "string" || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(RECIPE_MESSAGES.invalidFile);
  }
  const recipe = validateRecipe(value.recipe);
  if (recipe.builtIn || !customRecipeSlug(recipe.id)) throw new Error(RECIPE_MESSAGES.invalidFile);
  return { version: 1, updatedAt: value.updatedAt, recipe };
};

type Slot =
  | { state: "absent" }
  | { state: "valid"; file: StoredRecipeFile }
  | { state: "invalid"; reason: RecipeFileProblemReason };

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const validExpectedVersion = (value: unknown): value is number | undefined =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < RECIPE_LIMITS.maxVersion);

export class RecipeStore {
  readonly dir: string;
  private readonly lock: (name: string) => Promise<SingletonLease>;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;

  constructor(options: RecipeStoreOptions = {}) {
    this.dir = resolve(options.dir ?? defaultRecipesDir());
    this.lock = options.lock ?? acquireSingleton;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** File path of a custom recipe id, or undefined for built-in or malformed ids. */
  path(id: string): string | undefined {
    const slug = customRecipeSlug(id);
    return slug ? join(this.dir, `${slug}.json`) : undefined;
  }

  /** Built-ins in catalog order, then valid custom recipes by id. */
  async list(): Promise<Recipe[]> {
    return [...BUILT_IN_RECIPES, ...(await this.inspect()).recipes];
  }

  /** Valid custom recipes plus the files that were skipped and why. */
  async inspect(): Promise<{ recipes: Recipe[]; problems: RecipeFileProblem[] }> {
    const directory = await this.directoryState();
    if (directory === "absent") return { recipes: [], problems: [] };
    if (directory === "unsafe") return { recipes: [], problems: [{ file: ".", reason: "unsafe-directory" }] };
    const names = (await fs.readdir(this.dir)).filter((name) => FILE_NAME.test(name)).sort();
    const problems: RecipeFileProblem[] = names.slice(MAX_CUSTOM_RECIPES).map((file) => ({ file, reason: "over-limit" }));
    const recipes: Recipe[] = [];
    for (const file of names.slice(0, MAX_CUSTOM_RECIPES)) {
      const slot = await this.readSlot(join(this.dir, file));
      if (slot.state === "valid") recipes.push(slot.file.recipe);
      else if (slot.state === "invalid") problems.push({ file, reason: slot.reason });
    }
    recipes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return { recipes, problems };
  }

  /** A built-in or custom recipe; undefined when it does not exist. A broken file throws. */
  async get(id: string): Promise<Recipe | undefined> {
    if (typeof id !== "string") return undefined;
    const builtIn = builtInRecipe(id);
    if (builtIn) return builtIn;
    const path = this.path(id);
    if (!path || (await this.directoryState()) !== "safe") return undefined;
    const slot = await this.readSlot(path);
    if (slot.state === "invalid") throw new Error(RECIPE_MESSAGES.invalidFile);
    return slot.state === "valid" ? slot.file.recipe : undefined;
  }

  /** Creates (no expectedVersion) or updates (expectedVersion = the version you loaded) a custom
   * recipe. Returns what was stored, with its new version. */
  async save(value: unknown, options: RecipeWriteOptions = {}): Promise<Recipe> {
    const recipe = validateRecipe(value);
    if (builtInRecipe(recipe.id)) throw new Error(RECIPE_MESSAGES.builtInReadOnly);
    const path = this.path(recipe.id);
    if (recipe.builtIn || !path) throw new Error(RECIPE_MESSAGES.customIdRequired);
    if (!validExpectedVersion(options.expectedVersion)) throw new Error(RECIPE_MESSAGES.invalid);
    const expected = options.expectedVersion;
    return this.withLock(async () => {
      await this.ensureDirectory();
      const slot = await this.readSlot(path);
      let version = 1;
      if (expected === undefined) {
        if (slot.state !== "absent") throw new Error(RECIPE_MESSAGES.exists);
        if ((await this.countFiles()) >= MAX_CUSTOM_RECIPES) throw new Error(RECIPE_MESSAGES.limit);
      } else {
        if (slot.state === "absent") throw new Error(RECIPE_MESSAGES.missing);
        if (slot.state === "invalid") throw new Error(RECIPE_MESSAGES.invalidFile);
        if (slot.file.recipe.version !== expected) throw new Error(RECIPE_MESSAGES.conflict);
        version = expected + 1;
      }
      const stored: StoredRecipeFile = { version: 1, updatedAt: this.now().toISOString(), recipe: { ...recipe, version, builtIn: false } };
      const text = `${JSON.stringify(stored, null, 2)}\n`;
      if (Buffer.byteLength(text, "utf8") > MAX_RECIPE_FILE_BYTES) throw new Error(RECIPE_MESSAGES.tooLarge);
      await this.writeAtomic(path, text);
      return stored.recipe;
    });
  }

  /** Deletes a custom recipe; false when it was already gone. Pass expectedVersion to refuse
   * deleting a recipe that changed since it was loaded. */
  async remove(id: string, options: RecipeWriteOptions = {}): Promise<boolean> {
    if (typeof id === "string" && builtInRecipe(id)) throw new Error(RECIPE_MESSAGES.builtInReadOnly);
    const path = typeof id === "string" ? this.path(id) : undefined;
    if (!path) throw new Error(RECIPE_MESSAGES.invalidId);
    if (!validExpectedVersion(options.expectedVersion)) throw new Error(RECIPE_MESSAGES.invalid);
    return this.withLock(async () => {
      const directory = await this.directoryState();
      if (directory === "absent") return false;
      if (directory === "unsafe") throw new Error(RECIPE_MESSAGES.unsafeDirectory);
      const stat = await fs.lstat(path).catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return false;
      // A symlink is removed itself (unlink never follows it); a folder is never touched.
      if (stat.isDirectory()) throw new Error(RECIPE_MESSAGES.invalidFile);
      if (options.expectedVersion !== undefined) {
        const slot = await this.readSlot(path);
        if (slot.state === "absent") return false;
        if (slot.state === "invalid") throw new Error(RECIPE_MESSAGES.invalidFile);
        if (slot.file.recipe.version !== options.expectedVersion) throw new Error(RECIPE_MESSAGES.conflict);
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
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    if ((await this.directoryState()) !== "safe") throw new Error(RECIPE_MESSAGES.unsafeDirectory);
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
      if (stat.size > MAX_RECIPE_FILE_BYTES) return { state: "invalid", reason: "too-large" };
      const bytes = await handle.readFile();
      if (bytes.length > MAX_RECIPE_FILE_BYTES) return { state: "invalid", reason: "too-large" };
      raw = bytes.toString("utf8");
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
    let file: StoredRecipeFile;
    try {
      file = validateRecipeFile(parsed);
    } catch {
      return { state: "invalid", reason: "invalid-recipe" };
    }
    // The file name is the identity; a copied file with another id is not loaded twice.
    if (this.path(file.recipe.id) !== path) return { state: "invalid", reason: "id-mismatch" };
    return { state: "valid", file };
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const existing = await fs.lstat(path).catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(RECIPE_MESSAGES.invalidFile);
    const temporary = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const name = `recipes-${createHash("sha256").update(this.dir).digest("hex").slice(0, 24)}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let lease: SingletonLease;
    for (;;) {
      try {
        lease = await this.lock(name);
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== `${name} is already running`) throw error;
        if (Date.now() >= deadline) throw new Error(RECIPE_MESSAGES.busy);
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

/** Built-in recipes followed by valid custom recipes. */
export const listRecipes = (options?: RecipeStoreOptions): Promise<Recipe[]> => new RecipeStore(options).list();

/** Custom recipes and the files that could not be loaded. */
export const inspectCustomRecipes = (options?: RecipeStoreOptions): Promise<{ recipes: Recipe[]; problems: RecipeFileProblem[] }> =>
  new RecipeStore(options).inspect();

export const getRecipe = (id: string, options?: RecipeStoreOptions): Promise<Recipe | undefined> => new RecipeStore(options).get(id);

export const saveCustomRecipe = (recipe: unknown, options: RecipeStoreOptions & RecipeWriteOptions = {}): Promise<Recipe> =>
  new RecipeStore(options).save(recipe, { expectedVersion: options.expectedVersion });

export const deleteCustomRecipe = (id: string, options: RecipeStoreOptions & RecipeWriteOptions = {}): Promise<boolean> =>
  new RecipeStore(options).remove(id, { expectedVersion: options.expectedVersion });
