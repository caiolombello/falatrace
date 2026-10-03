import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { TimeEntryStore } from "../../timesheet/store";
import { JobStore } from "../../jobs/store";
import { CallMonitorRuntime } from "../runtime";
import { setAutomationPaused } from "../control";
import type { PipeWireNodeRecord } from "../types";

const nodes: PipeWireNodeRecord[] = ["Stream/Input/Audio", "Stream/Output/Audio"].map((kind, index) => ({ id: index + 1, type: "PipeWire:Interface:Node", info: { state: "running", props: { "application.process.binary": "helium", "media.class": kind, "stream.is-live": true } } }));

const fixture = async (mode: "bounce" | "coalesced" | "denied" | "paused" | "no-media" = "bounce") => {
  const root = await fs.mkdtemp(join(tmpdir(), "cancelled-start-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const media = join(root, "synthetic.mkv");
  await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.347", "-c:a", "flac", media]);
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = "audio";
  config.recordingsDir = join(root, "recordings");
  config.callDetection.mode = "record";
  config.callDetection.entryDebounceSeconds = 0;
  config.callDetection.exitTimeoutSeconds = 30;
  config.processing.autoEnqueue = true;
  config.processing.defaultTarget = "local";
  config.timesheet.enabled = mode === "no-media";
  config.timesheet.automaticFromCalls = true;
  config.calendar.enabled = false;
  let active = false, starts = 0, maxActive = 0, denied = false;
  const paths: string[] = [];
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") return { stdout: args.includes("list") ? JSON.stringify([{ name: "mic", mute: false, volume: {} }, { name: "desktop.monitor", mute: false, volume: {} }]) : args[0] === "get-default-source" ? "mic\n" : "desktop\n", stderr: "" };
    if (command === "systemd-run") {
      expect(active).toBe(false);
      starts++;
      if (denied) throw Error("synthetic portal permission denied");
      active = true; maxActive = Math.max(maxActive, Number(active));
      paths.push(args[args.length - 1]);
      if (starts !== 1 || mode !== "no-media") await fs.copyFile(media, paths[paths.length - 1]);
      if (starts === 1) {
        if (mode === "paused") await setAutomationPaused(true);
        else runtime.onNodesChanged([]);
      }
    }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) {
      await Bun.sleep(10); // observation may recover while stop is still awaited
      active = false;
      if (mode === "coalesced" && starts === 1) runtime.onNodesChanged(nodes);
    }
    return { stdout: "", stderr: "" };
  };
  // Drive the actual runtime/controller queue deterministically; skip only the
  // startup grace and unrelated network sampling. All capture/services are fake.
  const runtime = new CallMonitorRuntime(config, false, { run, notifications: { callStarted: async () => {}, callEnded: async () => {}, recordingStarted: async () => {}, recordingStopped: async () => {}, unavailable: async () => {}, warning: async () => {} } }) as any;
  runtime.readyAt = 0;
  runtime.updateNetworkPolling = () => {};
  const flush = async () => { let queue; do { queue = runtime.evaluationQueue; await queue; } while (queue !== runtime.evaluationQueue); };
  const emit = async (value: PipeWireNodeRecord[]) => { runtime.onNodesChanged(value); await flush(); };
  return { runtime, emit, flush, starts: () => starts, paths, maxActive: () => maxActive, deny: () => { denied = true; }, close: async () => {
    await runtime.shutdown();
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    await fs.rm(root, { recursive: true, force: true });
  } };
};

for (const mode of ["bounce", "coalesced"] as const) test(`cancelled startup recovers once after ${mode} async signal return, preserving the fragment`, async () => {
  const f = await fixture(mode);
  try {
    await f.emit(nodes); await f.emit(nodes);
    if (mode === "bounce") {
      expect(f.runtime.machine.getSnapshot().state).toBe("ENDING");
      expect(f.starts()).toBe(1);
      await f.emit(nodes);
    }
    expect(f.starts()).toBe(2);
    expect(f.maxActive()).toBe(1);
    expect(f.runtime.recorder.getSession().phase).toBe("recording");
    await f.emit([]); await f.emit(nodes); await f.emit(nodes);
    expect(f.starts()).toBe(2); // an already live capture survives subsequent bounce
    expect(new Set(f.paths).size).toBe(2);
    const jobs = await new JobStore().list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("pending");
    expect((await fs.stat(jobs[0].sourcePath)).size).toBeGreaterThan(0);
  } finally { await f.close(); }
}, 15000);

test("a denied recovery is attempted once; further signal bounce never re-prompts", async () => {
  const f = await fixture("denied");
  try {
    await f.emit(nodes); await f.emit(nodes);
    f.deny(); await f.emit(nodes);
    expect(f.starts()).toBe(2);
    expect(f.runtime.cancelledStartRecovery).toBe(false);
    await f.emit([]); await f.emit(nodes); await f.emit(nodes);
    expect(f.starts()).toBe(2);
    expect((await new JobStore().list())).toHaveLength(1);
  } finally { await f.close(); }
}, 15000);

test("automation pause during startup never authorizes same-call recovery", async () => {
  const f = await fixture("paused");
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.starts()).toBe(1);
    await setAutomationPaused(false);
    await f.emit([]); await f.emit(nodes);
    expect(f.starts()).toBe(1);
  } finally { await f.close(); }
}, 15000);


test("cancelled startup without media closes the previous automatic timesheet before recovery", async () => {
  const f = await fixture("no-media");
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.runtime.recorder.ownsRecording()).toBe(false);
    const oldId = f.runtime.sessionId;
    await f.emit(nodes);
    expect(f.starts()).toBe(2);
    const entries = await new TimeEntryStore().list();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.source.sessionId === oldId)).toMatchObject({ status: "draft", classificationStatus: "disabled" });
    expect(entries.filter(entry => entry.status === "capturing")).toHaveLength(1);
    expect((await new JobStore().list())).toHaveLength(0);
  } finally { await f.close(); }
}, 15000);


test("a timesheet write error does not suppress recovery of an otherwise eligible capture", async () => {
  const f = await fixture("no-media");
  const finish = f.runtime.timeEntries.finishCall.bind(f.runtime.timeEntries);
  try {
    await f.emit(nodes); await f.emit(nodes);
    f.runtime.timeEntries.finishCall = async () => { throw Error("synthetic timesheet write failure"); };
    await f.emit(nodes);
    expect(f.starts()).toBe(2);
    expect(f.runtime.recorder.getSession().phase).toBe("recording");
    expect(f.runtime.cancelledStartRecovery).toBe(false);
    await f.emit(nodes);
    expect(f.starts()).toBe(2);
  } finally { f.runtime.timeEntries.finishCall = finish; await f.close(); }
}, 15000);
