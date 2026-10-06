import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../defaults";
import { checkAutomation, checkProcessing, listAudioDevices, readServiceStatus, type SetupProbe } from "../setup-checks";
import { buildSyncUnits } from "../../jobs/service";
import { buildProtonBackupUnits } from "../../proton/service";
import { buildCallMonitorUnit } from "../../calls/service";
import { getServiceLaunchCommand } from "../../runtime/launcher";

const probe = (overrides: Partial<SetupProbe> = {}): SetupProbe => ({
  resolve: async (name) => name === "ffmpeg" || name === "whisper-cli" ? `/usr/bin/${name}` : null,
  isFile: async () => true,
  isExecutable: async () => true,
  ollamaModels: async () => ["qwen3.5:9b"],
  run: async () => ({ stdout: "", stderr: "" }),
  ...overrides
});
const byId = (checks: Awaited<ReturnType<typeof checkProcessing>>) => Object.fromEntries(checks.map((check) => [check.id, check.status]));
const none = { openai: "missing", gemini: "missing" };

test("local defaults report each dependency without contacting external hosts", async () => {
  expect(byId(await checkProcessing(DEFAULT_CONFIG, none, probe()))).toEqual({ ffmpeg: "ok", whisper: "ok", "whisper-model": "ok", ollama: "ok" });
  const missing = await checkProcessing(DEFAULT_CONFIG, none, probe({ resolve: async () => null, isFile: async () => false, ollamaModels: async () => { throw new Error("refused"); } }));
  expect(byId(missing)).toEqual({ ffmpeg: "missing", whisper: "missing", "whisper-model": "missing", ollama: "missing" });
  const noModel = await checkProcessing(DEFAULT_CONFIG, none, probe({ ollamaModels: async () => ["llama3:8b"] }));
  expect(noModel.find((check) => check.id === "ollama")).toMatchObject({ status: "warning", detail: expect.stringContaining("ollama pull qwen3.5:9b") });
});

test("external providers check only credential presence; remote Ollama is never contacted", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.transcription.provider = "openai";
  config.summary.ollamaUrl = "https://ollama.example.invalid";
  let contacted = false;
  const checks = await checkProcessing(config, { openai: "calls.env", gemini: "missing" }, probe({ ollamaModels: async () => { contacted = true; return []; } }));
  expect(byId(checks)).toEqual({ ffmpeg: "ok", "transcription-key": "ok", ollama: "skipped" });
  expect(contacted).toBe(false);
  config.summary.provider = "openai";
  config.transcription.provider = "gemini";
  expect(byId(await checkProcessing(config, none, probe()))).toEqual({ ffmpeg: "ok", "transcription-key": "missing", "summary-key": "missing" });
  config.transcription.provider = "whisper-cpp";
  config.processing.defaultTarget = "remote";
  expect(byId(await checkProcessing(config, { openai: "environment", gemini: "missing" }, probe())).whisper).toBe("skipped");
  // Remote jobs use the worker's own keys and Ollama: nothing on this computer is checked for them.
  config.transcription.provider = "openai";
  config.summary.provider = "openai";
  expect(byId(await checkProcessing(config, none, probe()))).toEqual({ ffmpeg: "ok", "transcription-key": "skipped", "summary-key": "skipped" });
  config.summary.provider = "ollama";
  config.summary.ollamaUrl = "http://127.0.0.1:11434";
  let probed = false;
  expect(byId(await checkProcessing(config, none, probe({ ollamaModels: async () => { probed = true; return []; } }))).ollama).toBe("skipped");
  expect(probed).toBe(false);
});

test("audio devices are listed with safe names and descriptions only", async () => {
  const outputs: Record<string, string> = {
    "--format=json": JSON.stringify([
      { name: "alsa_input.usb-mic", description: "USB Mic", volume: {} },
      { name: "alsa_output.speakers.monitor", description: "Monitor of Speakers" },
      { name: "bad name; rm", description: "x" },
      { name: "bluez_input.headset", description: "Headset\nwith newline" }
    ]),
    "get-default-source": "alsa_input.usb-mic\n",
    "get-default-sink": "alsa_output.speakers\n"
  };
  const result = await listAudioDevices(async (_command, args) => ({ stdout: outputs[args[0]], stderr: "" }));
  expect(result).toEqual({
    devices: [
      { name: "alsa_input.usb-mic", description: "USB Mic", monitor: false },
      { name: "alsa_output.speakers.monitor", description: "Monitor of Speakers", monitor: true },
      { name: "bluez_input.headset", description: "Headset with newline", monitor: false }
    ],
    defaultMicrophone: "alsa_input.usb-mic",
    defaultDesktop: "alsa_output.speakers.monitor"
  });
});

test("service status flags a unit with stale paths and a config newer than the running monitor", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-service-status-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const configPath = join(root, "config.json");
    await fs.writeFile(configPath, "{}");
    let startedAt = "Thu 1970-01-01 00:00:01.000000 UTC";
    const run = async (_command: string, args: string[]) => {
      if (args.includes("--timestamp=us+utc")) return { stdout: `${startedAt}\n`, stderr: "" };
      if (args[1] === "show") return { stdout: "@1000\n", stderr: "" };
      return { stdout: args[1] === "is-enabled" ? "enabled\n" : "active\n", stderr: "" };
    };
    const missing = await readServiceStatus(config, configPath, run as never, join(root, "absent"));
    expect(missing.calls).toMatchObject({ installed: false, outdated: false });
    await fs.writeFile(join(root, "recording-cli-calls.service"), buildCallMonitorUnit(config, ["/x"]));
    const current = await readServiceStatus(config, configPath, run as never, root);
    expect(current.calls).toEqual({ installed: true, enabled: true, active: true, outdated: false, staleConfig: true });
    // A restart in the same second as the save, but after it, is not stale; one before it is.
    await fs.utimes(configPath, new Date(1700000000400), new Date(1700000000400));
    startedAt = "Tue 2023-11-14 22:13:20.700000 UTC";
    expect((await readServiceStatus(config, configPath, run as never, root)).calls.staleConfig).toBe(false);
    startedAt = "Tue 2023-11-14 22:13:20.100000 UTC";
    expect((await readServiceStatus(config, configPath, run as never, root)).calls.staleConfig).toBe(true);
    config.recordingsDir = "/elsewhere/Recordings";
    expect((await readServiceStatus(config, configPath, run as never, root)).calls.outdated).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("service units prefer a stable link that resolves to the running release", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-launcher-"));
  try {
    const release = join(root, "releases", "v1", "falatrace");
    await fs.mkdir(join(root, "releases", "v1"), { recursive: true });
    await fs.writeFile(release, "");
    await fs.symlink(join(root, "releases", "v1"), join(root, "current"));
    await fs.symlink(join(root, "current", "falatrace"), join(root, "stable"));
    expect(getServiceLaunchCommand(release, "", [join(root, "absent"), join(root, "stable")])).toEqual([join(root, "stable")]);
    expect(getServiceLaunchCommand(release, "", [join(root, "absent")])).toEqual([release]);
    expect(getServiceLaunchCommand("/usr/bin/bun", "/src/cli/index.ts", [])).toEqual(["/usr/bin/bun", "/src/cli/index.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("automation checks say what will really record and whether new recordings get processed", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const idleTimer = { installed: false, enabled: false, active: false, outdated: false, nextRunAt: null, lastResult: null };
  const services = { calls: { installed: false, enabled: false, active: false, outdated: false, staleConfig: false }, tray: { installed: false, enabled: false, active: false, outdated: false, staleConfig: false }, sync: idleTimer, archive: idleTimer, backup: idleTimer };
  expect(checkAutomation(config, services)).toEqual([]);
  config.callDetection.enabled = true;
  expect(checkAutomation(config, services)).toEqual([]);
  config.callDetection.mode = "record";
  // The shipped `simple` backend means OBS for automatic recording, and OBS starts disabled.
  expect(checkAutomation(config, services)[0]).toMatchObject({ id: "automatic-backend", status: "missing", action: "capture" });
  config.backend = "audio";
  expect(checkAutomation(config, services)[0]).toMatchObject({ id: "automatic-backend", status: "ok", detail: expect.stringContaining("só áudio") });
  config.backend = "gnome";
  expect(checkAutomation(config, services)[0]).toMatchObject({ status: "missing", detail: expect.stringContaining("não grava automaticamente") });
  config.backend = "audio";
  config.processing.autoEnqueue = true;
  expect(checkAutomation(config, services).find((check) => check.id === "processing-timer")).toMatchObject({ status: "warning", action: "sync-apply" });
  expect(checkAutomation(config, { ...services, sync: { ...idleTimer, installed: true, enabled: true, active: true } }).find((check) => check.id === "processing-timer")).toMatchObject({ status: "ok" });
  // Enabled but stopped (or failed to start): jobs stay pending, so it is not healthy.
  expect(checkAutomation(config, { ...services, sync: { ...idleTimer, installed: true, enabled: true, active: false } }).find((check) => check.id === "processing-timer")).toMatchObject({ status: "warning", action: "sync-apply" });
  config.processing.defaultTarget = "remote";
  expect(checkAutomation(config, services).find((check) => check.id === "remote-worker")).toMatchObject({ status: "missing" });
  config.archive.enabled = true;
  config.proton.enabled = true;
  const ids = checkAutomation(config, services).map((check) => check.id);
  expect(ids).toContain("archive-timer");
  expect(ids).toContain("backup-timer");
});

test("timer status reports drift in the interval or the recordings folder baked into the unit", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-timer-status-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const configPath = join(root, "config.json");
    await fs.writeFile(configPath, "{}");
    const run = async (_command: string, args: string[]) => {
      if (args.includes("NextElapseUSecRealtime")) return { stdout: "@1700000000\n", stderr: "" };
      if (args.includes("Result")) return { stdout: "success\n", stderr: "" };
      if (args[1] === "show") return { stdout: "@1000\n", stderr: "" };
      return { stdout: args[1] === "is-enabled" ? "enabled\n" : "active\n", stderr: "" };
    };
    const units = buildSyncUnits(config, ["/x/falatrace"]);
    await fs.writeFile(join(root, "recording-cli-sync.service"), units.service);
    await fs.writeFile(join(root, "recording-cli-sync.timer"), units.timer);
    const current = await readServiceStatus(config, configPath, run as never, root);
    expect(current.sync).toEqual({ installed: true, enabled: true, active: true, outdated: false, nextRunAt: new Date(1700000000000).toISOString(), lastResult: "success" });
    expect(current.archive.installed).toBe(false);
    config.processing.syncIntervalMinutes = 7;
    expect((await readServiceStatus(config, configPath, run as never, root)).sync.outdated).toBe(true);
    config.processing.syncIntervalMinutes = DEFAULT_CONFIG.processing.syncIntervalMinutes;
    config.recordingsDir = "/elsewhere";
    expect((await readServiceStatus(config, configPath, run as never, root)).sync.outdated).toBe(true);
    config.recordingsDir = "/rec/100%";
    const percent = buildSyncUnits(config, ["/x/falatrace"]);
    await fs.writeFile(join(root, "recording-cli-sync.service"), percent.service);
    expect((await readServiceStatus(config, configPath, run as never, root)).sync.outdated).toBe(false);

    // The Proton backup timer runs on the processing interval too.
    const backup = buildProtonBackupUnits(config, ["/x/falatrace"]);
    await fs.writeFile(join(root, "recording-cli-proton-backup.service"), backup.service);
    await fs.writeFile(join(root, "recording-cli-proton-backup.timer"), backup.timer);
    expect((await readServiceStatus(config, configPath, run as never, root)).backup).toMatchObject({ installed: true, outdated: false });
    config.processing.syncIntervalMinutes = 7;
    expect((await readServiceStatus(config, configPath, run as never, root)).backup.outdated).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("key checks explain session-only keys, open permissions and keys hidden from the Studio", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.transcription.provider = "gemini";
  const sessionOnly = await checkProcessing(config, {
    openai: "missing", gemini: "missing",
    details: [{ name: "GEMINI_API_KEY", source: "missing", sessionOnly: true, shadowsStudioKey: false, savedInStudio: false }]
  }, probe());
  expect(sessionOnly.find((check) => check.id === "transcription-key")).toMatchObject({ status: "missing", action: "keys", detail: expect.stringContaining("só no ambiente desta sessão") });
  const open = await checkProcessing(config, {
    openai: "missing", gemini: "worker.env",
    files: [{ file: "worker.env", exists: true, usable: true, tooOpen: true }]
  }, probe());
  expect(open.find((check) => check.id === "transcription-key")).toMatchObject({ status: "warning", detail: expect.stringContaining("600") });
  const shadowed = await checkProcessing(config, {
    openai: "missing", gemini: "environment",
    details: [{ name: "GEMINI_API_KEY", source: "environment", sessionOnly: false, shadowsStudioKey: true, savedInStudio: true }]
  }, probe());
  expect(shadowed.find((check) => check.id === "transcription-key")).toMatchObject({ status: "warning", detail: expect.stringContaining("prioridade") });
});
