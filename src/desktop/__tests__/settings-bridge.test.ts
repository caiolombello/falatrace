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
    credentials: async () => ({ openai: "missing", gemini: "missing", details: [], files: [], managerEnvironment: "unavailable" }),
    managerEnv: async () => null,
    checks: async () => [],
    audioDevices: async () => { throw new Error("pactl unavailable"); },
    services: async () => { calls.push("services"); return {} as never; },
    recording: async () => { throw new Error("probe failed"); },
    captureActive: async () => false,
    lock: async (name) => { calls.push(`lock:${name}`); return { release: async () => { calls.push("release"); } }; },
    applyCalls: async () => { calls.push("applyCalls"); return ""; },
    disableCalls: async () => { calls.push("disableCalls"); return ""; },
    applyTray: async () => { calls.push("applyTray"); return ""; },
    disableTray: async () => { calls.push("disableTray"); return ""; },
    applySync: async () => { calls.push("applySync"); return []; },
    disableSync: async () => { calls.push("disableSync"); return []; },
    applyArchive: async () => { calls.push("applyArchive"); return []; },
    disableArchive: async () => { calls.push("disableArchive"); return []; },
    applyBackup: async () => { calls.push("applyBackup"); return []; },
    disableBackup: async () => { calls.push("disableBackup"); return []; },
    setSecret: async (name) => { calls.push(`setSecret:${String(name)}`); },
    removeSecret: async (name) => { calls.push(`removeSecret:${String(name)}`); return { removed: true }; },
    testKey: async (provider) => ({ provider, status: "ok", source: "secrets.env", detail: "ok" }),
    remoteCheck: async () => "host=worker\nffmpeg=ok\nwhisper-cli=missing\n/dev/sda1 100G 10G 90G 10% /home\n",
    obsCheck: async () => false,
    audioTest: async () => ({ seconds: 5, tracks: [], warnings: [] }),
    backups: async () => [],
    restore: async () => ({ restored: "x", backupCreated: true, prunedBackups: 0 }),
    exportTo: async () => ({ exported: "/tmp/x.json", credentialsOmitted: true }),
    importRead: async () => ({ values: {}, rejected: [], ignored: [], credentialsIgnored: false }),
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
    expect(result.credentials).toMatchObject({ openai: "missing", gemini: "missing" });
    expect(Array.isArray(result.automation)).toBe(true);
  });

  test("secrets are saved through the write-only path and never echoed", async () => {
    const { deps, calls } = fakeDeps();
    const saved = await handleSettingsOperation("settings-secret-set", { name: "OPENAI_API_KEY", value: "sk-synthetic-echo" }, deps);
    expect(JSON.stringify(saved)).not.toContain("sk-synthetic-echo");
    expect(calls).toContain("setSecret:OPENAI_API_KEY");
    await handleSettingsOperation("settings-secret-remove", { name: "OPENAI_API_KEY" }, deps);
    expect(calls).toContain("removeSecret:OPENAI_API_KEY");
    await expect(handleSettingsOperation("settings-secret-test", { service: "anthropic" }, deps)).rejects.toThrow("Chave não suportada");
    expect(await handleSettingsOperation("settings-secret-test", { service: "gemini" }, deps)).toMatchObject({ provider: "gemini", status: "ok" });
  });

  test("the remote worker is tested only once configured and its report is parsed", async () => {
    const placeholder = fakeDeps();
    await expect(handleSettingsOperation("settings-remote-check", {}, placeholder.deps)).rejects.toThrow("Configure o worker remoto");
    const configured = fakeDeps();
    configured.config.remote.host = "worker.lan";
    expect(await handleSettingsOperation("settings-remote-check", {}, configured.deps)).toEqual({
      ok: true, host: "worker", commands: [{ name: "ffmpeg", ok: true }, { name: "whisper-cli", ok: false }], disk: "/dev/sda1 100G 10G 90G 10% /home"
    });
    const refused = fakeDeps({ remoteCheck: async () => { throw new Error("ssh failed with code 255: Host key verification failed."); } });
    refused.config.remote.host = "worker.lan";
    expect(await handleSettingsOperation("settings-remote-check", {}, refused.deps)).toMatchObject({ ok: false, hint: expect.stringContaining("chave") });
  });

  test("the audio test uses the capture lock and is refused during a capture", async () => {
    const busy = fakeDeps({ captureActive: async () => true });
    await expect(handleSettingsOperation("settings-audio-test", {}, busy.deps)).rejects.toThrow("Não teste o áudio");
    expect(busy.calls).toEqual(["lock:capture-control", "release"]);
    const idle = fakeDeps();
    expect(await handleSettingsOperation("settings-audio-test", { seconds: 3 }, idle.deps)).toMatchObject({ seconds: 5 });
  });

  test("timer actions check their preconditions and every action reaches its own installer", async () => {
    const { deps, calls, config } = fakeDeps();
    await expect(handleSettingsOperation("settings-service", { action: "archive-apply" }, deps)).rejects.toThrow("Ative o arquivo");
    await expect(handleSettingsOperation("settings-service", { action: "backup-apply" }, deps)).rejects.toThrow("Ative o backup");
    config.archive.enabled = true;
    config.proton.enabled = true;
    for (const action of ["sync-apply", "sync-disable", "archive-apply", "archive-disable", "backup-apply", "backup-disable", "tray-disable"]) {
      await handleSettingsOperation("settings-service", { action }, deps);
    }
    for (const name of ["applySync", "disableSync", "applyArchive", "disableArchive", "applyBackup", "disableBackup", "disableTray"]) expect(calls).toContain(name);
  });

  test("the monitor is not applied when automatic recording has no usable backend", async () => {
    const { deps, calls, config } = fakeDeps();
    config.callDetection.enabled = true;
    config.callDetection.mode = "record";
    await expect(handleSettingsOperation("settings-service", { action: "calls-apply" }, deps)).rejects.toThrow("backend que funcione");
    expect(calls).not.toContain("applyCalls");
    config.backend = "audio";
    await handleSettingsOperation("settings-service", { action: "calls-apply" }, deps);
    expect(calls).toContain("applyCalls");
  });

  test("request payloads are validated before dispatch", () => {
    expect(() => parseRequest({ id: 1, op: "settings-save", payload: { revision: "a".repeat(64) } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-save", payload: { revision: "a".repeat(64), changes: [] } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-service", payload: { action: "x".repeat(41) } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 1, op: "settings-read", payload: { action: "calls-apply" } })).toThrow("payload inválido");
    expect(parseRequest({ id: 2, op: "settings-save", payload: { revision: "a".repeat(64), changes: { "callDetection.enabled": true } } }).op).toBe("settings-save");
    expect(parseRequest({ id: 3, op: "settings-save", payload: { revision: "a".repeat(64), changes: {}, initialize: true } }).payload?.initialize).toBe(true);
    expect(() => parseRequest({ id: 4, op: "settings-secret-set", payload: { name: "openai", value: "x" } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-secret-set", payload: { name: "OPENAI_API_KEY", value: "x".repeat(4097) } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-secret-set", payload: { name: "OPENAI_API_KEY", value: "a\nb" } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-export", payload: { path: "relative.json" } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-restore", payload: { revision: "a".repeat(64), backup: "../x" } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-model-download", payload: { kind: "pip", model: "x" } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "settings-audio-test", payload: { seconds: 60 } })).toThrow("payload inválido");
    expect(() => parseRequest({ id: 4, op: "agent-connect", payload: { grantId: "123e4567-e89b-42d3-a456-426614174000", client: "vim" } })).toThrow("payload inválido");
    expect(parseRequest({ id: 5, op: "settings-secret-test", payload: { service: "gemini" } }).op).toBe("settings-secret-test");
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

      // A key file other users can change is refused with the reason, not a generic failure.
      const secrets = join(config, "..", "secrets.env");
      await fs.writeFile(secrets, "# synthetic\n", { mode: 0o600 });
      await fs.chmod(secrets, 0o664);
      const [refused] = await run(env, [{ id: 1, op: "settings-secret-set", payload: { name: "OPENAI_API_KEY", value: "synthetic-private-settings-sentinel-key" } }]);
      expect(refused).toMatchObject({ ok: false, error: "secrets.env outros usuários podem alterá-lo; ignorado. Corrija o arquivo antes de salvar." });
      expect(await fs.readFile(secrets, "utf8")).toBe("# synthetic\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
