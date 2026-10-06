import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { fileIdentity, findWhisperModel, writeDownloadState } from "../../models/downloads";
import { handleModelOperation, modelUnitName, type ModelDeps } from "../model-bridge";

const deps = (directory: string, overrides: Partial<ModelDeps> = {}) => {
  const runs: string[][] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  const value: ModelDeps = {
    loadConfig: async () => ({ path: "/synthetic/config.json", config }),
    run: async (command, args) => { runs.push([command, ...args]); return { stdout: "ActiveState=inactive\n", stderr: "" }; },
    directory: () => directory,
    ollamaModels: async () => ["qwen3.5:9b"],
    launch: () => ["/opt/falatrace/falatrace"],
    ...overrides
  };
  return { value, runs, config };
};

test("the catalog marks installed files and the configured Ollama model", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "falatrace-model-bridge-"));
  try {
    const { value } = deps(directory);
    type CatalogModel = { id: string; installed: boolean; recommended?: boolean; selected: boolean };
    const catalog = await handleModelOperation("settings-model-catalog", {}, value) as { whisper: { models: CatalogModel[] }; ollama: unknown };
    expect(catalog.whisper.models.every((model) => model.installed === false)).toBe(true);
    expect(catalog.whisper.models.find((model) => model.id === "large-v3-turbo-q5_0")).toMatchObject({ recommended: true, selected: false });
    expect(catalog.ollama).toMatchObject({ loopback: true, reachable: true, installed: ["qwen3.5:9b"], configured: "qwen3.5:9b" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("downloads require consent, start a transient unit and never contact a remote Ollama", async () => {
  const { value, runs, config } = deps("/synthetic/models");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny" }, value)).rejects.toThrow("Confirme");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "huge", consent: true }, value)).rejects.toThrow("desconhecido");
  const started = await handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny", consent: true }, value) as Record<string, unknown>;
  expect(started).toMatchObject({ state: "running", unit: `${modelUnitName("whisper", "tiny")}.service` });
  const launch = runs.find((run) => run[0] === "systemd-run") ?? [];
  expect(launch.slice(launch.indexOf("--") + 1)).toEqual(["/opt/falatrace/falatrace", "models", "download", "tiny"]);
  config.summary.ollamaUrl = "https://ollama.example.com";
  await expect(handleModelOperation("settings-model-download", { kind: "ollama", model: "qwen3.5:9b", consent: true }, value)).rejects.toThrow("neste computador");
});

test("a download whose unit ended without a final state is reported as interrupted", async () => {
  const { value } = deps("/synthetic/models");
  await writeDownloadState({ kind: "whisper", id: "base", state: "running", receivedBytes: 10, totalBytes: 100 });
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "base" }, value)).toMatchObject({ state: "failed", error: expect.stringContaining("interrompido") });
  await writeDownloadState({ kind: "whisper", id: "base", state: "completed", receivedBytes: 100, totalBytes: 100, path: "/x" });
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "base" }, value)).toMatchObject({ state: "completed", path: "/x" });
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "small" }, value)).toMatchObject({ state: "idle" });
});

test("status and cancel keep working while the configuration cannot be loaded", async () => {
  const { value, runs } = deps("/synthetic/models", { loadConfig: async () => { throw new Error("config.json inválido"); } });
  await writeDownloadState({ kind: "whisper", id: "small", state: "running", receivedBytes: 5, totalBytes: 100 });
  // The unit is still running: polling reports progress and Cancel stops it.
  value.run = async (command, args) => { runs.push([command, ...args]); return { stdout: "ActiveState=active\n", stderr: "" }; };
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "small" }, value)).toMatchObject({ state: "running", receivedBytes: 5 });
  expect(await handleModelOperation("settings-model-cancel", { kind: "whisper", model: "small" }, value)).toEqual({ kind: "whisper", id: "small", cancelled: true });
  expect(runs).toContainEqual(["systemctl", "--user", "stop", `${modelUnitName("whisper", "small")}.service`]);
  // Starting a download or listing the catalog still needs a valid configuration.
  await expect(handleModelOperation("settings-model-catalog", {}, value)).rejects.toThrow("inválido");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "small", consent: true }, value)).rejects.toThrow("inválido");
});

test("a Whisper model counts as installed only when a SHA-256 check accepted that exact file", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "falatrace-model-verified-"));
  const model = findWhisperModel("tiny");
  const original = { ...model };
  const payload = Buffer.from("synthetic ggml payload ".repeat(64));
  Object.assign(model, { bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
  try {
    const { value } = deps(directory);
    type Catalog = { whisper: { models: Array<{ id: string; installed: boolean }> } };
    const installed = async () => ((await handleModelOperation("settings-model-catalog", {}, value)) as Catalog).whisper.models.find((item) => item.id === "tiny")?.installed;
    const path = join(directory, model.file);
    await fs.writeFile(path, payload);
    expect(await installed()).toBe(false);
    await writeDownloadState({ kind: "whisper", id: "tiny", state: "completed", receivedBytes: payload.length, totalBytes: payload.length, path, verified: await fileIdentity(path) });
    expect(await installed()).toBe(true);
    // Rewritten in place: same inode, same size and the old mtime put back. Only ctime moves.
    const pinned = 1_700_000_000;
    await fs.utimes(path, pinned, pinned);
    const receipt = await fileIdentity(path);
    await writeDownloadState({ kind: "whisper", id: "tiny", state: "completed", receivedBytes: payload.length, totalBytes: payload.length, path, verified: receipt });
    expect(await installed()).toBe(true);
    const handle = await fs.open(path, "r+");
    await handle.write(Buffer.alloc(16, 7), 0, 16, 0);
    await handle.close();
    await fs.utimes(path, pinned, pinned);
    // On a coarse clock the rewrite can share the receipt's tick; touch until ctime moves.
    for (let tries = 0; (await fs.stat(path)).ctimeMs === receipt.ctimeMs && tries < 100; tries++) {
      await Bun.sleep(10);
      await fs.utimes(path, pinned, pinned);
    }
    const rewritten = await fs.stat(path);
    expect([rewritten.ino, rewritten.size, rewritten.mtimeMs]).toEqual([receipt.ino, receipt.size, receipt.mtimeMs]);
    expect(await installed()).toBe(false);
    // Another file of the same size put in its place is not trusted until it is checked again.
    await writeDownloadState({ kind: "whisper", id: "tiny", state: "completed", receivedBytes: payload.length, totalBytes: payload.length, path, verified: await fileIdentity(path) });
    expect(await installed()).toBe(true);
    await fs.writeFile(join(directory, "replacement"), Buffer.alloc(payload.length, 1));
    await fs.rename(join(directory, "replacement"), path);
    expect(await installed()).toBe(false);
  } finally {
    Object.assign(model, original);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
