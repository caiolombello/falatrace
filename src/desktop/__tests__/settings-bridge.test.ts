import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { parseRequest } from "../bridge";
import { handleSettingsOperation, type SettingsDeps } from "../settings-bridge";

assertQaIsolation();
const sourceRoot = join(import.meta.dir, "../../..");

const fakeDeps = (overrides: Partial<SettingsDeps> = {}) => {
  const calls: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  const deps: SettingsDeps = {
    read: async () => { calls.push("read"); return {} as never; },
    save: async () => { calls.push("save"); return {} as never; },
    loadConfig: async () => ({ path: "/synthetic/config.json", config }),
    configPath: () => "/synthetic/config.json",
    credentials: async () => ({ openai: "missing", gemini: "missing" }),
    checks: async () => [],
    audioDevices: async () => { throw new Error("pactl unavailable"); },
    services: async () => { calls.push("services"); return {} as never; },
    recording: async () => { throw new Error("probe failed"); },
    captureActive: async () => false,
    lock: async (name) => { calls.push(`lock:${name}`); return { release: async () => { calls.push("release"); } }; },
    applyCalls: async () => { calls.push("applyCalls"); return ""; },
    disableCalls: async () => { calls.push("disableCalls"); return ""; },
    applyTray: async () => { calls.push("applyTray"); return ""; },
    ...overrides
  };
  return { deps, calls, config };
};

describe("settings bridge operations", () => {
  test("service changes are refused during an active capture and the lock is released", async () => {
    const { deps, calls } = fakeDeps({ captureActive: async () => true });
    await expect(handleSettingsOperation("settings-service", { action: "calls-disable" }, deps))
      .rejects.toThrow("Não altere os serviços durante uma gravação ativa.");
    expect(calls).toEqual(["lock:capture-control", "release"]);
  });

  test("the monitor is only applied when automatic recording is enabled", async () => {
    const disabled = fakeDeps();
    await expect(handleSettingsOperation("settings-service", { action: "calls-apply" }, disabled.deps))
      .rejects.toThrow("Ative a gravação automática");
    expect(disabled.calls).not.toContain("applyCalls");

    const enabled = fakeDeps();
    enabled.config.callDetection.enabled = true;
    await handleSettingsOperation("settings-service", { action: "calls-apply" }, enabled.deps);
    expect(enabled.calls).toEqual(["lock:capture-control", "applyCalls", "services", "release"]);
  });

  test("unknown service actions never reach systemd", async () => {
    const { deps, calls } = fakeDeps();
    await expect(handleSettingsOperation("settings-service", { action: "rm -rf" }, deps)).rejects.toThrow("inválida");
    expect(calls).toEqual([]);
  });

  test("diagnostics tolerate unavailable probes and report them", async () => {
    const { deps } = fakeDeps();
    const result = await handleSettingsOperation("settings-diagnose", {}, deps) as Record<string, any>;
    expect(result.audio).toBeNull();
    expect(result.recording).toMatchObject({ selectedBackend: null, blockedReason: expect.stringContaining("Não foi possível") });
    expect(result.credentials).toEqual({ openai: "missing", gemini: "missing" });
  });

  test("request payloads are validated before dispatch", () => {
    expect(() => parseRequest({ id: 1, op: "settings-save", payload: { revision: "a".repeat(64) } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-save", payload: { revision: "a".repeat(64), changes: [] } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-service", payload: { action: "x".repeat(41) } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-read", payload: { action: "calls-apply" } })).toThrow("payload inválido");
    expect(parseRequest({ id: 2, op: "settings-save", payload: { revision: "a".repeat(64), changes: { "callDetection.enabled": true } } }).op).toBe("settings-save");
  });
});

describe("settings through the production desktop bridge", () => {
  const run = async (env: NodeJS.ProcessEnv, requests: unknown[]) => {
    const child = Bun.spawn([
      "/usr/bin/python3", "-I", join(sourceRoot, "scripts/qa-run.py"), process.execPath,
      "run", "--preload", join(sourceRoot, "scripts/offline-network.ts"), join(sourceRoot, "src/desktop/bridge.ts")
    ], { cwd: sourceRoot, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    child.stdin.end();
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("synthetic-private-settings-sentinel");
    return stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: number; ok: boolean; result?: any; error?: string });
  };

  test("read, save and refuse a forbidden field without exposing secrets", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "settings-bridge-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", OPENAI_API_KEY: "" };
      for (const [key, directory] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_STATE_HOME", "state"], ["XDG_DATA_HOME", "data"], ["XDG_RUNTIME_DIR", "runtime"], ["XDG_CACHE_HOME", "cache"], ["TMPDIR", "tmp"]] as const) {
        env[key] = join(root, directory);
        await fs.mkdir(env[key]!, { mode: 0o700 });
      }
      assertQaIsolation(env);
      const config = join(env.XDG_CONFIG_HOME!, "recording-cli/config.json");
      await fs.mkdir(join(config, ".."), { recursive: true, mode: 0o700 });
      await fs.writeFile(config, JSON.stringify({ openai: { apiKey: "synthetic-private-settings-sentinel" }, future: 1 }), { mode: 0o600 });

      const [read] = await run(env, [{ id: 1, op: "settings-read" }]);
      expect(read.ok).toBe(true);
      expect(read.result.credentials.openai).toBe("config");
      const revision = read.result.revision;

      const replies = await run(env, [
        { id: 1, op: "settings-save", payload: { revision, changes: { "openai.apiKey": "replaced" } } },
        { id: 2, op: "settings-save", payload: { revision, changes: { "callDetection.enabled": true, "callDetection.apps.firefox": false } } }
      ]);
      const [forbidden, saved] = replies.sort((a, b) => a.id - b.id);
      expect(forbidden).toMatchObject({ ok: false, error: "Campo não editável: openai.apiKey" });
      expect(saved.ok).toBe(true);
      expect(saved.result).toMatchObject({ saved: true, changed: ["callDetection.enabled", "callDetection.apps.firefox"] });
      const [diagnose] = await run(env, [{ id: 1, op: "settings-diagnose" }]);
      expect(diagnose.ok).toBe(true);
      expect(diagnose.result.services.calls.installed).toBe(false);
      expect(Array.isArray(diagnose.result.checks)).toBe(true);
      const written = JSON.parse(await fs.readFile(config, "utf8"));
      expect(written).toEqual({ openai: { apiKey: "synthetic-private-settings-sentinel" }, future: 1, callDetection: { enabled: true, apps: { firefox: false } } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
