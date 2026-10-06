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

test("the catalog lists the Ollama of the draft Settings shows, and only one on this computer", async () => {
  const contacted: string[] = [];
  const { value, config } = deps("/synthetic/models", { ollamaModels: async (url) => { contacted.push(url); return url.endsWith(":11435") ? [] : ["qwen3.5:9b"]; } });
  config.summary.ollamaUrl = "http://127.0.0.1:11434";
  type Catalog = { ollama: { url: string; loopback: boolean; reachable: boolean; installed: string[] } };
  const drafted = await handleModelOperation("settings-model-catalog", { ollamaUrl: "http://127.0.0.1:11435" }, value) as Catalog;
  expect(drafted.ollama).toMatchObject({ url: "http://127.0.0.1:11435", loopback: true, reachable: true, installed: [] });
  const remote = await handleModelOperation("settings-model-catalog", { ollamaUrl: "http://ollama.lan:11434" }, value) as Catalog;
  expect(remote.ollama).toMatchObject({ url: "http://ollama.lan:11434", loopback: false, reachable: false, installed: [] });
  const saved = await handleModelOperation("settings-model-catalog", {}, value) as Catalog;
  expect(saved.ollama).toMatchObject({ url: "http://127.0.0.1:11434", installed: ["qwen3.5:9b"] });
  expect(contacted).toEqual(["http://127.0.0.1:11435", "http://127.0.0.1:11434"]);
});

test("downloads require consent, start a transient unit and never contact a remote Ollama", async () => {
  const { value, runs, config } = deps("/synthetic/models");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny" }, value)).rejects.toThrow("Confirme");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "huge", consent: true }, value)).rejects.toThrow("desconhecido");
  const started = await handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny", consent: true }, value) as Record<string, unknown>;
  expect(started).toMatchObject({ state: "running", unit: `${modelUnitName("whisper", "tiny")}.service` });
  const launch = runs.find((run) => run[0] === "systemd-run") ?? [];
  expect(launch.slice(launch.indexOf("--") + 1)).toEqual(["/opt/falatrace/falatrace", "models", "download", "tiny"]);
  // The unit reads the configuration and writes the state this Studio uses, whatever the manager's XDG paths.
  for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    expect(process.env[name]).toBeTruthy();
    expect(launch).toContain(`--setenv=${name}=${process.env[name]}`);
  }
  config.summary.ollamaUrl = "https://ollama.example.com";
  await expect(handleModelOperation("settings-model-download", { kind: "ollama", model: "qwen3.5:9b", consent: true }, value)).rejects.toThrow("neste computador");
});

test("an Ollama pull uses the endpoint checked here, such as the assistant's unsaved local one", async () => {
  const { value, runs, config } = deps("/synthetic/models", { launch: () => ["/opt/falatrace-$release/falatrace"] });
  const pulled = () => {
    const launches = runs.filter((run) => run[0] === "systemd-run");
    const launch = launches[launches.length - 1] ?? [];
    return launch.slice(launch.indexOf("--") + 1);
  };
  // Saved remote endpoint, reviewed local preset: the pull goes to the drafted loopback Ollama.
  config.summary.ollamaUrl = "https://ollama.example.com";
  await handleModelOperation("settings-model-download", { kind: "ollama", model: "qwen3.5:9b", consent: true, ollamaUrl: "http://127.0.0.1:11434" }, value);
  // systemd would expand "$release": the command carries a literal dollar sign.
  expect(pulled()).toEqual(["/opt/falatrace-$$release/falatrace", "models", "ollama-pull", "qwen3.5:9b", "--url", "http://127.0.0.1:11434"]);
  await expect(handleModelOperation("settings-model-download", { kind: "ollama", model: "qwen3.5:9b", consent: true, ollamaUrl: "http://ollama.lan:11434" }, value))
    .rejects.toThrow("neste computador");
  // Without a drafted endpoint, the saved one is checked and named explicitly.
  config.summary.ollamaUrl = "http://127.0.0.1:11435";
  await handleModelOperation("settings-model-download", { kind: "ollama", model: "qwen3.5:9b", consent: true }, value);
  expect(pulled().slice(-2)).toEqual(["--url", "http://127.0.0.1:11435"]);
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

test("a cancel systemd refuses is reported, and an unreachable systemd changes no download", async () => {
  const { value, runs } = deps("/synthetic/models");
  const refuse = (message: string) => async (command: string, args: string[]) => { runs.push([command, ...args]); throw new Error(`systemctl failed with code 1: ${message}`); };
  // The download unit may still be running: the cancel fails instead of claiming success.
  value.run = refuse("Failed to connect to bus: No such file or directory");
  await expect(handleModelOperation("settings-model-cancel", { kind: "whisper", model: "base" }, value)).rejects.toThrow("Failed to connect to bus");
  // A unit that already ended is cancelled.
  value.run = refuse("Failed to stop recording-cli-model-whisper-x.service: Unit recording-cli-model-whisper-x.service not loaded.");
  expect(await handleModelOperation("settings-model-cancel", { kind: "whisper", model: "base" }, value)).toEqual({ kind: "whisper", id: "base", cancelled: true });
  // With no answer from systemd, a running download keeps its state and no second copy starts.
  value.run = refuse("Connection timed out");
  await writeDownloadState({ kind: "whisper", id: "base", state: "running", receivedBytes: 7, totalBytes: 100 });
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "base" }, value)).toMatchObject({ state: "running", receivedBytes: 7 });
  runs.length = 0;
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "base", consent: true }, value)).rejects.toThrow("consultar os serviços");
  expect(runs.some((run) => run[0] === "systemd-run")).toBe(false);
});

test("a download unit systemd no longer knows reads as ended, not as an unreachable systemd", async () => {
  const { value, runs } = deps("/synthetic/models");
  // Launched with --collect, an ended unit is unloaded; asking about it may then fail as not found.
  value.run = async (command, args) => {
    runs.push([command, ...args]);
    if (args[1] === "show") throw new Error(`systemctl failed with code 1: Unit ${modelUnitName("whisper", "base")}.service not found.`);
    return { stdout: "", stderr: "" };
  };
  await writeDownloadState({ kind: "whisper", id: "base", state: "running", receivedBytes: 7, totalBytes: 100 });
  expect(await handleModelOperation("settings-model-status", { kind: "whisper", model: "base" }, value)).toMatchObject({ state: "failed", error: expect.stringContaining("interrompido") });
  expect(await handleModelOperation("settings-model-download", { kind: "whisper", model: "base", consent: true }, value)).toMatchObject({ state: "running" });
  expect(runs.some((run) => run[0] === "systemd-run")).toBe(true);
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
