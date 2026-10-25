import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CallDetectionMode, DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import type { JobRecord } from "../../jobs/types";
import { readFirstRun } from "../../metrics/first-run";
import { type MeetingOverride, setMeetingOverride } from "../../reminders/overrides";
import { CallMonitorRuntime } from "../runtime";
import { readCallStatus } from "../status";
import type { PipeWireNodeRecord } from "../types";

const nodes: PipeWireNodeRecord[] = ["Stream/Input/Audio", "Stream/Output/Audio"].map((kind, index) => ({
  id: index + 1, type: "PipeWire:Interface:Node", info: { state: "running", props: { "application.process.binary": "helium", "media.class": kind, "stream.is-live": true } }
}));
const HASH = "a".repeat(64);
const quiet = { callStarted: async () => {}, callEnded: async () => {}, recordingStarted: async () => {}, recordingStopped: async () => {}, unavailable: async () => {}, warning: async () => {} };

const override = (decision: "skip" | "record", title = "Daily Sync"): MeetingOverride => {
  const now = Date.now();
  return {
    eventIdHash: HASH, title, decision, startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 30 * 60_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now + 45 * 60_000).toISOString()
  };
};

type Options = { mode: CallDetectionMode; fastPath?: boolean; backend?: string; decision?: () => MeetingOverride | undefined | Promise<MeetingOverride | undefined> };

const fixture = async (options: Options) => {
  const root = await fs.mkdtemp(join(tmpdir(), "meeting-override-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const media = join(root, "synthetic.mka");
  await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "flac", "-f", "matroska", media]);
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = (options.backend ?? "audio") as typeof config.backend;
  config.recordingsDir = join(root, "recordings");
  config.callDetection.enabled = true;
  config.callDetection.mode = options.mode;
  config.callDetection.entryDebounceSeconds = 0;
  config.callDetection.exitTimeoutSeconds = 0;
  config.processing.autoEnqueue = false;
  config.processing.fastPath = options.fastPath === true;
  config.timesheet.enabled = false;
  config.archive.enabled = false;
  let active = false;
  const starts: string[] = [];
  const queued: string[] = [];
  const enqueued: Array<{ path: string; recordingId?: string }> = [];
  let unavailable = 0;
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") return { stdout: args.includes("list") ? JSON.stringify([{ name: "mic", mute: false, volume: {} }, { name: "desktop.monitor", mute: false, volume: {} }]) : args[0] === "get-default-source" ? "mic\n" : "desktop\n", stderr: "" };
    if (command === "systemd-run") {
      starts.push(args[args.length - 1]);
      active = true;
      await fs.copyFile(media, args[args.length - 1]);
    }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) active = false;
    return { stdout: "", stderr: "" };
  };
  const runtime = new CallMonitorRuntime(config, false, {
    run,
    notifications: { ...quiet, unavailable: async () => { unavailable++; } },
    meetingOverride: async () => options.decision?.(),
    enqueue: async (_config, path, opts) => {
      enqueued.push({ path, recordingId: opts?.recordingId });
      return { id: opts?.recordingId } as JobRecord;
    },
    queueJob: async (id) => { queued.push(id); }
  // biome-ignore lint/suspicious/noExplicitAny: drives private runtime state like the other runtime tests
  }) as any;
  runtime.readyAt = 0;
  runtime.updateNetworkPolling = () => {};
  const flush = async () => { let queue: Promise<void>; do { queue = runtime.evaluationQueue; await queue; } while (queue !== runtime.evaluationQueue); };
  const emit = async (value: PipeWireNodeRecord[]) => { runtime.onNodesChanged(value); await flush(); };
  return {
    runtime, emit, flush, starts, queued, enqueued, unavailable: () => unavailable,
    close: async () => {
      await runtime.shutdown();
      if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
      if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
      await fs.rm(root, { recursive: true, force: true });
    }
  };
};

test("a meeting marked skip is not recorded in record mode, and the status says why", async () => {
  let decision: MeetingOverride | undefined = override("skip");
  const f = await fixture({ mode: "record", decision: () => decision });
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.runtime.machine.getSnapshot().state).toBe("IN_CALL");
    expect(f.starts).toHaveLength(0);
    await f.runtime.persistStatus();
    expect(await readCallStatus()).toMatchObject({ mode: "record", meetingDecision: "skip" });
    // The decision covers only that meeting: the next call records as usual.
    decision = undefined;
    await f.emit([]); await f.emit([]);
    expect(f.runtime.machine.getSnapshot().state).toBe("IDLE");
    await f.emit(nodes); await f.emit(nodes);
    expect(f.starts).toHaveLength(1);
  } finally { await f.close(); }
}, 15_000);

test("a meeting marked record is recorded in notify-only mode, named after the meeting, and processed at once on the fast path", async () => {
  const f = await fixture({ mode: "notify-only", fastPath: true, decision: () => override("record", "Daily Sync / Equipe") });
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.starts).toHaveLength(1);
    expect(basename(dirname(f.starts[0]))).toMatch(/_Daily_Sync__Equipe-[0-9a-f]{8}$/);
    // The first recording started is a first-run milestone (kept in the state directory).
    expect((await readFirstRun()).firstRecordingAt).toMatch(/^\d{4}-/);
    const sessionId = f.runtime.sessionId;
    await f.runtime.persistStatus();
    expect(await readCallStatus()).toMatchObject({ mode: "notify-only", meetingDecision: "record", recordingOwned: true });
    await f.emit([]); await f.emit([]);
    expect(f.runtime.recorder.ownsRecording()).toBe(false);
    // Queued because the fast path is on, although automatic processing is off; then started right away.
    expect(f.enqueued).toEqual([{ path: f.starts[0], recordingId: sessionId }]);
    expect(f.queued).toEqual([sessionId]);
  } finally { await f.close(); }
}, 15_000);

test("notify-only without a decision records nothing; record mode without fast path queues nothing to run", async () => {
  const notify = await fixture({ mode: "notify-only" });
  try {
    await notify.emit(nodes); await notify.emit(nodes);
    expect(notify.starts).toHaveLength(0);
    await notify.runtime.persistStatus();
    const status = await readCallStatus();
    expect(status?.mode).toBe("notify-only");
    expect(status?.meetingDecision).toBeUndefined();
  } finally { await notify.close(); }
  const record = await fixture({ mode: "record" });
  try {
    await record.emit(nodes); await record.emit(nodes);
    expect(record.starts).toHaveLength(1);
    expect(basename(dirname(record.starts[0]))).toMatch(/_recording-[0-9a-f]{8}$/);
    await record.emit([]); await record.emit([]);
    expect(record.enqueued).toHaveLength(0);
    expect(record.queued).toHaveLength(0);
  } finally { await record.close(); }
}, 20_000);

test("record with a backend the automatic controller cannot drive reports the recorder unavailable", async () => {
  const f = await fixture({ mode: "notify-only", backend: "gnome", decision: () => override("record") });
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.starts).toHaveLength(0);
    expect(f.unavailable()).toBe(1);
  } finally { await f.close(); }
}, 15_000);

test("a damaged decision file falls back to the configured mode", async () => {
  const f = await fixture({ mode: "record", decision: () => { throw new Error("O arquivo meeting-overrides.json do FalaTrace é inválido; apague-o para continuar."); } });
  try {
    await f.emit(nodes); await f.emit(nodes);
    expect(f.starts).toHaveLength(1);
  } finally { await f.close(); }
}, 15_000);

test("a record decision saved while the call is already going on starts the recording (watched file)", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "meeting-override-watch-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  const media = join(root, "synthetic.mka");
  await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "flac", "-f", "matroska", media]);
  let active = false;
  let starts = 0;
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") return { stdout: args.includes("list") ? JSON.stringify([{ name: "mic", mute: false, volume: {} }, { name: "desktop.monitor", mute: false, volume: {} }]) : args[0] === "get-default-source" ? "mic\n" : "desktop\n", stderr: "" };
    if (command === "systemd-run") { starts++; active = true; await fs.copyFile(media, args[args.length - 1]); }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) active = false;
    return { stdout: "", stderr: "" };
  };
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.recordingsDir = join(root, "recordings");
    config.callDetection.enabled = true;
    config.callDetection.mode = "notify-only";
    config.callDetection.entryDebounceSeconds = 0;
    config.callDetection.exitTimeoutSeconds = 0;
    config.timesheet.enabled = false;
    config.archive.enabled = false;
    const runtime = new CallMonitorRuntime(config, false, {
      run, notifications: quiet,
      network: async () => ({}) as never,
      monitor: async (onNodes, signal) => {
        onNodes(nodes);
        await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      }
    // biome-ignore lint/suspicious/noExplicitAny: skips the startup grace like the other runtime tests
    }) as any;
    runtime.readyAt = 0;
    running = runtime.run(abort.signal);
    const until = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8_000;
      while (!await predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await Bun.sleep(25); }
    };
    await until(async () => runtime.machine.getSnapshot().state === "IN_CALL");
    await Bun.sleep(200);
    expect(starts).toBe(0);
    const now = Date.now();
    await setMeetingOverride({ eventIdHash: HASH, title: "Planejamento", startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(), decision: "record" });
    await until(() => starts === 1);
    await until(async () => (await readCallStatus())?.recordingOwned === true);
    expect((await readCallStatus())?.meetingDecision).toBe("record");
    expect(basename(dirname(runtime.recorder.getSession().outputPath))).toMatch(/_Planejamento-[0-9a-f]{8}$/);
  } finally {
    abort.abort();
    await running?.catch(() => undefined);
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
