import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { JobStore } from "../../jobs/store";
import { setAutomationPaused } from "../control";
import { CallMonitorRuntime } from "../runtime";
import { readCallStatus } from "../status";
import type { PipeWireNodeRecord } from "../types";

const until = async (predicate: () => Promise<boolean>, milliseconds = 4_000): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected call state");
    await Bun.sleep(50);
  }
};

test("pause suppresses future automatic captures and preserves a recording already in progress", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "automation-runtime-"));
  const old = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  let active = false;
  let starts = 0;
  let pauseDuringStart = false;
  let recordingStartedNotifications = 0;
  let emit: (nodes: PipeWireNodeRecord[]) => void = () => {};
  const nodes: PipeWireNodeRecord[] = ["Stream/Input/Audio", "Stream/Output/Audio"].map((mediaClass, index) => ({
    id: index + 1, type: "PipeWire:Interface:Node", info: { state: "running", props: {
      "application.process.binary": "helium", "media.class": mediaClass, "stream.is-live": true
    } }
  }));
  const pactlSources = JSON.stringify([
    { name: "mic", mute: false, volume: { "front-left": { value_percent: "100%" } } },
    { name: "desktop.monitor", mute: false, volume: { "front-left": { value_percent: "100%" } } }
  ]);
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") return { stdout: args.includes("list") ? pactlSources : args[0] === "get-default-source" ? "mic\n" : "desktop\n", stderr: "" };
    if (command === "systemd-run") {
      starts++;
      active = true;
      await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "flac", "-f", "matroska", args[args.length - 1]]);
      if (pauseDuringStart) await setAutomationPaused(true);
    }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) active = false;
    return { stdout: "", stderr: "" };
  };
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.recordingsDir = join(root, "recordings");
    config.callDetection.mode = "record";
    config.callDetection.entryDebounceSeconds = 1;
    config.callDetection.exitTimeoutSeconds = 1;
    config.processing.defaultTarget = "local";
    config.processing.autoEnqueue = true;
    config.timesheet.enabled = false;
    await setAutomationPaused(true);
    const runtime = new CallMonitorRuntime(config, false, {
      run,
      network: async () => Object.fromEntries(["slack", "zen", "helium"].map(app => [app, { tcpSockets: 0, udpSockets: 0, tcpBytesSent: 0, tcpBytesReceived: 0 }])) as any,
      monitor: async (onNodes, signal) => {
        emit = onNodes;
        emit(nodes);
        await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      },
      notifications: {
        callStarted: async () => {}, callEnded: async () => {}, recordingStarted: async () => { recordingStartedNotifications++; },
        recordingStopped: async () => {}, unavailable: async () => {}, warning: async () => {}
      }
    });
    running = runtime.run(abort.signal);
    await until(async () => (await readCallStatus())?.state === "IN_CALL", 15_000);
    expect(starts).toBe(0);
    expect((await readCallStatus())?.automationPaused).toBe(true);
    await setAutomationPaused(false);
    await until(async () => (await readCallStatus())?.automationPaused === false);
    expect(starts).toBe(0);
    emit([]);
    await until(async () => (await readCallStatus())?.state === "IDLE");
    emit(nodes);
    await until(async () => (await readCallStatus())?.recordingOwned === true);
    expect(starts).toBe(1);
    await setAutomationPaused(true);
    await until(async () => (await readCallStatus())?.automationPaused === true);
    await Bun.sleep(300);
    expect(active).toBe(true);
    emit([]);
    await until(async () => (await new JobStore().list()).length === 1, 6_000);
    expect(active).toBe(false);
    expect((await new JobStore().list())[0].state).toBe("pending");
    await until(async () => (await readCallStatus())?.recordingOwned === false);
    await setAutomationPaused(false);
    pauseDuringStart = true;
    emit(nodes);
    await until(async () => starts === 2);
    await until(async () => !active);
    // The stop adapter finishes before the monitor publishes its next status/ACK.
    await until(async () => (await readCallStatus())?.automationPaused === true);
    expect(recordingStartedNotifications).toBe(1);
    expect((await readCallStatus())?.automationPaused).toBe(true);
  } finally {
    abort.abort();
    await running?.catch(() => undefined);
    process.env.XDG_STATE_HOME = old.state;
    process.env.XDG_DATA_HOME = old.data;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 40_000);
