import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { JobStore } from "../../jobs/store";
import type { PipeWireNodeRecord } from "../types";
import { CallMonitorRuntime } from "../runtime";

test("a recovered call coalesces route events and moves its audio without restarting", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "audio-recovery-composition-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  const media = join(root, "synthetic.mka");
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = "audio";
  config.recordingsDir = join(root, "recordings");
  config.capture.audioSource = "desktop";
  config.callDetection.mode = "record";
  config.callDetection.entryDebounceSeconds = 0;
  config.callDetection.exitTimeoutSeconds = 30;
  config.processing.autoEnqueue = true;
  config.processing.defaultTarget = "local";
  config.timesheet.enabled = false;
  config.calendar.enabled = false;
  const nodes: PipeWireNodeRecord[] = ["Stream/Input/Audio", "Stream/Output/Audio"].map((kind, index) => ({
    id: index + 1, type: "PipeWire:Interface:Node", info: { state: "running", props: {
      "application.process.binary": "helium", "media.class": kind, "stream.is-live": true
    } }
  }));
  let active = false, starts = 0, stops = 0, sink = "output-a";
  const paths: string[] = [];
  let sourceIndex = 1, moves = 0, pulseClient = "";
  const notices: string[] = [];
  const run: typeof runCommand = async (command, args) => {
    if (command === "pactl") {
      if (args.includes("source-outputs")) return { stdout: JSON.stringify([{ index: 12, source: sourceIndex,
        properties: { "application.name": pulseClient, "application.process.id": "345" } }]), stderr: "" };
      if (args[0] === "move-source-output") {
        moves++;
        sourceIndex = Number(args[2]);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("list")) return { stdout: JSON.stringify(["output-a.monitor", "output-b.monitor", "output-c.monitor"].map((name,index) => ({
        name,index, mute: false, volume: { mono: { value: 65536 } }
      }))), stderr: "" };
      return { stdout: args[0] === "get-default-source" ? "synthetic-unused-mic\n" : `${sink}\n`, stderr: "" };
    }
    if (command === "systemd-run") {
      expect(active).toBe(false);
      pulseClient = args[args.indexOf("-name") + 1];
      starts++;
      active = true;
      paths.push(args[args.length - 1]);
      await fs.copyFile(media, paths[paths.length - 1]);
      if (starts === 1) runtime.onNodesChanged([]);
      return { stdout: "", stderr: "" };
    }
    if (command === "systemctl" && args.includes("--value")) return { stdout: "345", stderr: "" };
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) { stops++; active = false; return { stdout: "", stderr: "" }; }
    throw Error(`Offline composition fixture refused command: ${command}`);
  };
  const noop = async () => {};
  const runtime = new CallMonitorRuntime(config, false, { run, notifications: {
    callStarted: noop, callEnded: noop, recordingStarted: noop, recordingStopped: noop,
    unavailable: noop, warning: async message => { notices.push(message); }
  } }) as any;
  runtime.readyAt = 0;
  runtime.updateNetworkPolling = () => {};
  const flush = async () => { let queue; do { queue = runtime.evaluationQueue; await queue; } while (queue !== runtime.evaluationQueue); };
  const emit = async (value: PipeWireNodeRecord[]) => { runtime.onNodesChanged(value); await flush(); };
  try {
    await runCommand("ffmpeg", ["-v", "error", "-threads", "1", "-f", "lavfi", "-i", "sine=duration=0.1", "-c:a", "flac", media]);
    await emit(nodes); await emit(nodes);
    expect(starts).toBe(1);
    expect(runtime.recorder.getSession().audio).toEqual({ desktop: "output-a.monitor" });
    sink = "output-b";
    await emit(nodes);
    const recovered = runtime.recorder.getSession();
    expect(starts).toBe(2);
    expect(recovered.phase).toBe("recording");
    expect(recovered.audio).toEqual({ desktop: "output-b.monitor" });
    expect(recovered.audioSelection).toEqual({ desktop: "default" });
    expect(paths[0]).not.toBe(paths[1]);
    const jobs = await new JobStore().list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sourcePath).toBe(paths[0]);
    expect(jobs[0].state).toBe("pending");
    expect((await fs.stat(paths[0])).size).toBeGreaterThan(0);
    const stoppedDuringCancellation = stops;
    sink = "output-c";
    await runtime.checkCaptureHealth();
    await runtime.checkCaptureHealth();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("output-b.monitor, selecionada pelo padrão no início");
    expect(notices[0]).toContain("output-c.monitor");
    expect(starts).toBe(2);
    expect(stops).toBe(stoppedDuringCancellation);
    expect(runtime.recorder.getSession().id).toBe(recovered.id);
    expect(runtime.recorder.getSession().audio).toEqual({ desktop: "output-b.monitor" });
    for (let i = 0; i < 3; i++) runtime.scheduleAudioRoutes(["desktop"]);
    await Bun.sleep(350);
    await flush();
    expect(moves).toBe(1);
    expect(starts).toBe(2);
    expect(runtime.recorder.getSession().id).toBe(recovered.id);
    expect(runtime.recorder.getSession().audio.desktop).toBe("output-c.monitor");
    expect(await runtime.recorder.health()).toEqual({ active: true });
  } finally {
    await runtime.shutdown();
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);
