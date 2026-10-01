import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { JobStore } from "../../jobs/store";
import { RecordingSessionStore } from "../../recording/session";
import { CallMonitorRuntime } from "../runtime";
import type { PipeWireNodeRecord } from "../types";

test("a detected call records without OBS and leaves exactly one job for the worker", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-runtime-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const abort = new AbortController();
  let active = false;
  let starts = 0;
  const notices: string[] = [];
  let running: Promise<void> | undefined;
  const pactlSources = JSON.stringify([
    { name: "mic", mute: false, volume: { "front-left": { value_percent: "100%" } } },
    { name: "desktop.monitor", mute: false, volume: { "front-left": { value_percent: "100%" } } }
  ]);
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") return { stdout: args.includes("list") ? pactlSources : args[0] === "get-default-source" ? "mic\n" : "desktop\n", stderr: "" };
    if (command === "systemd-run") {
      expect(args).toContain("ffmpeg");
      expect(args.join(" ")).not.toContain("obs");
      starts++;
      active = true;
      await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "flac", "-f", "matroska", args[args.length - 1]]);
    }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) active = false;
    return { stdout: "", stderr: "" };
  };
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.obs.enabled = false;
    config.recordingsDir = join(root, "recordings");
    config.callDetection.mode = "record";
    config.callDetection.entryDebounceSeconds = 1;
    config.callDetection.exitTimeoutSeconds = 1;
    // The new mode uses the single processing policy; the legacy OBS switch is ignored.
    config.callDetection.enqueueOnStop = false;
    config.processing.defaultTarget = "local";
    config.processing.autoEnqueue = true;
    const nodes: PipeWireNodeRecord[] = ["Stream/Input/Audio", "Stream/Output/Audio"].map((mediaClass, index) => ({
      id: index + 1, type: "PipeWire:Interface:Node", info: { state: "running", props: {
        "application.process.binary": "helium", "media.class": mediaClass, "stream.is-live": true
      } }
    }));
    const runtime = new CallMonitorRuntime(config, false, {
      run,
      monitor: async (emit, signal) => {
        emit(nodes);
        const timer = setTimeout(() => emit([]), 13_000);
        try { await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true })); }
        finally { clearTimeout(timer); }
      },
      notifications: {
        callStarted: async () => { notices.push("call-start"); },
        callEnded: async () => { notices.push("call-end"); },
        recordingStarted: async () => { notices.push("record-start"); },
        recordingStopped: async () => { notices.push("record-stop"); },
        unavailable: async () => { notices.push("unavailable"); },
        warning: async () => { notices.push("warning"); }
      }
    });
    running = runtime.run(abort.signal);
    const store = new JobStore();
    const deadline = Date.now() + 22_000;
    while (Date.now() < deadline && (await store.list()).length === 0) await Bun.sleep(100);
    abort.abort();
    await running;
    const jobs = await store.list();
    expect(starts).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("pending");
    expect(await new RecordingSessionStore().read()).toBeNull();
    expect(notices).toEqual(["call-start", "record-start", "call-end", "record-stop"]);
  } finally {
    abort.abort();
    await running?.catch(() => undefined);
    process.env.XDG_STATE_HOME = previous.state;
    process.env.XDG_DATA_HOME = previous.data;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
