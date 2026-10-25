import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILT_IN_RECIPES,
  MAX_CUSTOM_RECIPES,
  RECIPE_MESSAGES,
  RecipeStore,
  defaultRecipesDir,
  deleteCustomRecipe,
  getRecipe,
  listRecipes,
  saveCustomRecipe,
  validateRecipeFile
} from "../index";

const custom = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "custom:weekly-report",
  version: 1,
  builtIn: false,
  name: { "pt-BR": "Relatório semanal", en: "Weekly report", es: "Informe semanal" },
  description: "A weekly status report for the client.",
  scope: "meeting",
  prompt: "Write a weekly report about {{meeting.title}} in {{language}}.",
  ...overrides
});

let root: string;
let dir: string;
let store: RecipeStore;
const NOW = new Date("2026-10-25T10:00:00.000Z");

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "recipes-"));
  dir = join(root, "config", "recipes");
  store = new RecipeStore({ dir, now: () => NOW });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("RecipeStore", () => {
  test("lists built-ins when no folder exists", async () => {
    expect((await store.list()).map((recipe) => recipe.id)).toEqual(BUILT_IN_RECIPES.map((recipe) => recipe.id));
    expect(await store.inspect()).toEqual({ recipes: [], problems: [] });
    expect(await store.get("custom:nothing")).toBeUndefined();
    expect(await store.get("risks")).toBe(BUILT_IN_RECIPES[1]);
  });

  test("creates a private file and lists it after the built-ins", async () => {
    const saved = await store.save(custom());
    expect(saved).toMatchObject({ id: "custom:weekly-report", version: 1, builtIn: false });
    const path = join(dir, "weekly-report.json");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const file = JSON.parse(await fs.readFile(path, "utf8"));
    expect(file).toEqual({ version: 1, updatedAt: NOW.toISOString(), recipe: saved });
    const list = await store.list();
    expect(list.length).toBe(BUILT_IN_RECIPES.length + 1);
    expect(list[list.length - 1]).toEqual(saved);
    expect(await store.get("custom:weekly-report")).toEqual(saved);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("updates with compare-and-swap on the version", async () => {
    await store.save(custom());
    await expect(store.save(custom())).rejects.toThrow(RECIPE_MESSAGES.exists);
    const updated = await store.save(custom({ prompt: "Updated prompt for {{client}}." }), { expectedVersion: 1 });
    expect(updated.version).toBe(2);
    await expect(store.save(custom({ prompt: "Stale writer prompt." }), { expectedVersion: 1 })).rejects.toThrow(RECIPE_MESSAGES.conflict);
    expect((await store.get("custom:weekly-report"))?.prompt).toBe("Updated prompt for {{client}}.");
    await expect(store.save(custom({ id: "custom:ghost" }), { expectedVersion: 1 })).rejects.toThrow(RECIPE_MESSAGES.missing);
    await expect(store.save(custom(), { expectedVersion: 0 })).rejects.toThrow(RECIPE_MESSAGES.invalid);
  });

  test("concurrent creates of the same id: exactly one wins", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      new RecipeStore({ dir }).save(custom({ prompt: `Prompt number ${index} for the report.` }))));
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    for (const result of results) if (result.status === "rejected") expect((result.reason as Error).message).toBe(RECIPE_MESSAGES.exists);
  });

  test("concurrent updates from the same version: exactly one wins", async () => {
    await store.save(custom());
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      new RecipeStore({ dir }).save(custom({ prompt: `Edited prompt ${index} for the report.` }), { expectedVersion: 1 })));
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect((await store.get("custom:weekly-report"))?.version).toBe(2);
  });

  test("built-ins are read-only and custom ids are required", async () => {
    await expect(store.save({ ...BUILT_IN_RECIPES[0] })).rejects.toThrow(RECIPE_MESSAGES.builtInReadOnly);
    await expect(store.remove("risks")).rejects.toThrow(RECIPE_MESSAGES.builtInReadOnly);
    await expect(store.save(custom({ id: "weekly" }))).rejects.toThrow(RECIPE_MESSAGES.customIdRequired);
    await expect(store.remove("weekly")).rejects.toThrow(RECIPE_MESSAGES.invalidId);
    await expect(store.remove("custom:../x")).rejects.toThrow(RECIPE_MESSAGES.invalidId);
  });

  test("deletes, optionally checking the version", async () => {
    await store.save(custom());
    await expect(store.remove("custom:weekly-report", { expectedVersion: 7 })).rejects.toThrow(RECIPE_MESSAGES.conflict);
    expect(await store.remove("custom:weekly-report", { expectedVersion: 1 })).toBe(true);
    expect(await store.remove("custom:weekly-report")).toBe(false);
    expect(await store.get("custom:weekly-report")).toBeUndefined();
  });

  test("broken, oversized, mismatched and symlinked files are reported, never followed", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "broken.json"), "{");
    await fs.writeFile(join(dir, "wrong.json"), JSON.stringify({ version: 1, updatedAt: NOW.toISOString(), recipe: custom({ prompt: 5 }) }));
    await fs.writeFile(join(dir, "big.json"), "x".repeat(64 * 1024 + 1));
    await fs.writeFile(join(dir, "copy.json"), JSON.stringify({ version: 1, updatedAt: NOW.toISOString(), recipe: custom() }));
    const outside = join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ version: 1, updatedAt: NOW.toISOString(), recipe: custom({ id: "custom:linked" }) }));
    await fs.symlink(outside, join(dir, "linked.json"));
    await fs.mkdir(join(dir, "folder.json"));
    await fs.writeFile(join(dir, "Ignored Name.json"), "{}");
    const { recipes, problems } = await store.inspect();
    expect(recipes).toEqual([]);
    expect(problems).toEqual([
      { file: "big.json", reason: "too-large" },
      { file: "broken.json", reason: "invalid-json" },
      { file: "copy.json", reason: "id-mismatch" },
      { file: "folder.json", reason: "not-a-file" },
      { file: "linked.json", reason: "not-a-file" },
      { file: "wrong.json", reason: "invalid-recipe" }
    ]);
    await expect(store.get("custom:broken")).rejects.toThrow(RECIPE_MESSAGES.invalidFile);
    await expect(store.save(custom({ id: "custom:linked" }), { expectedVersion: 1 })).rejects.toThrow(RECIPE_MESSAGES.invalidFile);
    await expect(store.save(custom({ id: "custom:linked" }))).rejects.toThrow(RECIPE_MESSAGES.exists);
    expect(JSON.parse(await fs.readFile(outside, "utf8")).recipe.id).toBe("custom:linked");
    // Deleting a symlinked entry removes the link only.
    expect(await store.remove("custom:linked")).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toContain("custom:linked");
    await expect(store.remove("custom:folder")).rejects.toThrow(RECIPE_MESSAGES.invalidFile);
  });

  test("a symlinked recipes folder is unsafe", async () => {
    const real = join(root, "real");
    await fs.mkdir(real);
    await fs.mkdir(join(root, "config"), { recursive: true });
    await fs.symlink(real, dir);
    expect((await store.inspect()).problems).toEqual([{ file: ".", reason: "unsafe-directory" }]);
    await expect(store.save(custom())).rejects.toThrow(RECIPE_MESSAGES.unsafeDirectory);
    await expect(store.remove("custom:weekly-report")).rejects.toThrow(RECIPE_MESSAGES.unsafeDirectory);
    expect(await store.get("custom:weekly-report")).toBeUndefined();
    expect(await fs.readdir(real)).toEqual([]);
  });

  test("enforces the count and size limits", async () => {
    await fs.mkdir(dir, { recursive: true });
    for (let index = 0; index < MAX_CUSTOM_RECIPES; index += 1) await fs.writeFile(join(dir, `r${index}.json`), "{}");
    await expect(store.save(custom())).rejects.toThrow(RECIPE_MESSAGES.limit);
    await fs.writeFile(join(dir, "zz-extra.json"), "{}");
    expect((await store.inspect()).problems.filter((problem) => problem.reason === "over-limit")).toEqual([{ file: "zz-extra.json", reason: "over-limit" }]);
  });

  test("a held lock times out with a known message", async () => {
    const busy = new RecipeStore({ dir, lockTimeoutMs: 50, lock: async (name) => { throw new Error(`${name} is already running`); } });
    await expect(busy.save(custom())).rejects.toThrow(RECIPE_MESSAGES.busy);
  });

  test("module helpers use the folder next to the active config", async () => {
    expect(defaultRecipesDir()).toBe(join(process.env.XDG_CONFIG_HOME as string, "recording-cli", "recipes"));
    await saveCustomRecipe(custom(), { dir });
    expect((await getRecipe("custom:weekly-report", { dir }))?.version).toBe(1);
    expect((await listRecipes({ dir })).length).toBe(BUILT_IN_RECIPES.length + 1);
    expect(await deleteCustomRecipe("custom:weekly-report", { dir, expectedVersion: 1 })).toBe(true);
  });

  test("validateRecipeFile is strict", () => {
    expect(() => validateRecipeFile({ version: 2, updatedAt: NOW.toISOString(), recipe: custom() })).toThrow(RECIPE_MESSAGES.invalidFile);
    expect(() => validateRecipeFile({ version: 1, updatedAt: "nope", recipe: custom() })).toThrow(RECIPE_MESSAGES.invalidFile);
    expect(() => validateRecipeFile({ version: 1, updatedAt: NOW.toISOString(), recipe: custom(), extra: 1 })).toThrow(RECIPE_MESSAGES.invalidFile);
    expect(() => validateRecipeFile({ version: 1, updatedAt: NOW.toISOString(), recipe: { ...BUILT_IN_RECIPES[0] } })).toThrow(RECIPE_MESSAGES.invalidFile);
  });
});
