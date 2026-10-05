import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../defaults";
import { checkProcessing, listAudioDevices, readServiceStatus, type SetupProbe } from "../setup-checks";
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
    const run = async (_command: string, args: string[]) => {
      if (args[1] === "show") return { stdout: "@1000\n", stderr: "" };
      return { stdout: args[1] === "is-enabled" ? "enabled\n" : "active\n", stderr: "" };
    };
    const missing = await readServiceStatus(config, configPath, run as never, join(root, "absent"));
    expect(missing.calls).toMatchObject({ installed: false, outdated: false });
    await fs.writeFile(join(root, "recording-cli-calls.service"), buildCallMonitorUnit(config, ["/x"]));
    const current = await readServiceStatus(config, configPath, run as never, root);
    expect(current.calls).toEqual({ installed: true, enabled: true, active: true, outdated: false, staleConfig: true });
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
