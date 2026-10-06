import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { writeDownloadState } from "../../models/downloads";
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
    const catalog = await handleModelOperation("settings-model-catalog", {}, value) as any;
    expect(catalog.whisper.models.every((model: any) => model.installed === false)).toBe(true);
    expect(catalog.whisper.models.find((model: any) => model.id === "large-v3-turbo-q5_0")).toMatchObject({ recommended: true, selected: false });
    expect(catalog.ollama).toMatchObject({ loopback: true, reachable: true, installed: ["qwen3.5:9b"], configured: "qwen3.5:9b" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("downloads require consent, start a transient unit and never contact a remote Ollama", async () => {
  const { value, runs, config } = deps("/synthetic/models");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny" }, value)).rejects.toThrow("Confirme");
  await expect(handleModelOperation("settings-model-download", { kind: "whisper", model: "huge", consent: true }, value)).rejects.toThrow("desconhecido");
  const started = await handleModelOperation("settings-model-download", { kind: "whisper", model: "tiny", consent: true }, value) as any;
  expect(started).toMatchObject({ state: "running", unit: `${modelUnitName("whisper", "tiny")}.service` });
  const launch = runs.find((run) => run[0] === "systemd-run")!;
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
