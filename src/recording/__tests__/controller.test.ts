import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { RecordingController } from "../controller";
import { RecordingSessionStore } from "../session";

test.each(["abort", "persisted-pause"])("cancelling startup with %s stops its process and retains partial media for recovery", async (reason) => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-cancel-"));
  const store = new RecordingSessionStore(join(root, "session.json"));
  const abort = new AbortController();
  let active = false;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.recordingsDir = root;
    const runner: typeof runCommand = async (command, args) => {
      if (command === "systemd-run") {
        await fs.writeFile(args[args.length - 1], "partial media");
        active = true;
        if (reason === "abort") abort.abort();
      }
      if (command === "systemctl") {
        if (args.includes("stop")) active = false;
        return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
      }
      return { stdout: args[0]?.includes("format=json") ? JSON.stringify([{ name: "mic", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }, { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }]) : args[0] === "get-default-source" ? "mic" : "speaker", stderr: "" };
    };
    const recorder = new RecordingController(config, "call", store, runner);
    expect(await recorder.start({ signal: abort.signal,
      shouldContinue: reason === "persisted-pause" ? async () => !active : undefined
    })).toBe("cancelled");
    expect(active).toBe(false);
    const session = await store.read();
    expect(session?.phase).toBe("stopped");
    expect(await fs.readFile(session!.outputPath, "utf8")).toBe("partial media");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed capture startup releases empty state without losing an existing recording", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-start-failure-"));
  const store = new RecordingSessionStore(join(root, "session.json"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.recordingsDir = root;
    const runner: typeof runCommand = async (command, args) => {
      if (command === "systemd-run") throw new Error("encoder failed");
      if (command === "systemctl") return { stdout: "ActiveState=inactive", stderr: "" };
      return { stdout: args[0]?.includes("format=json") ? JSON.stringify([{ name: "mic", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }, { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }]) : args[0] === "get-default-source" ? "mic" : "speaker", stderr: "" };
    };
    const recorder = new RecordingController(config, "call", store, runner);
    await expect(recorder.start()).rejects.toThrow("encoder failed");
    expect(await store.read()).toBeNull();
    const existing = { version: 1 as const, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", owner: "manual" as const,
      backend: "audio" as const, phase: "recording" as const, outputPath: join(root, "existing.mka"), startedAt: new Date().toISOString() };
    await store.write(existing);
    expect(await recorder.start()).toBe("already-recording");
    expect(await store.read()).toEqual(existing);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed stop keeps its session and media available for retry", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-stop-failure-"));
  const store = new RecordingSessionStore(join(root, "session.json"));
  try {
    const session = { version: 1 as const, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner: "call" as const,
      backend: "audio" as const, phase: "recording" as const, outputPath: join(root, "media.mka"), startedAt: new Date().toISOString() };
    await fs.writeFile(session.outputPath, "partial media");
    await store.write(session);
    const run: typeof runCommand = async (_command, args) => {
      if (args.includes("stop")) throw new Error("could not stop capture");
      return { stdout: "ActiveState=active", stderr: "" };
    };
    const recorder = new RecordingController(DEFAULT_CONFIG, "call", store, run);
    await expect(recorder.stop(session.id)).rejects.toThrow("could not stop");
    expect((await store.read())?.phase).toBe("recording");
    expect(await fs.readFile(session.outputPath, "utf8")).toBe("partial media");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recovers an owned capture after a controller restart and stops only that session", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-controller-"));
  const store = new RecordingSessionStore(join(root, "session.json"));
  let active = false;
  const commands: string[][] = [];
  const run: typeof runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (command === "pactl") {
      return { stdout: args[0]?.includes("format=json") ? JSON.stringify([{ name: "mic", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }, { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }]) : args[0] === "get-default-source" ? "mic\n" : "speaker\n", stderr: "" };
    }
    if (command === "systemd-run") {
      active = true;
      await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "flac", "-f", "matroska", args[args.length - 1]]);
    }
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}\nMainPID=123\n`, stderr: "" };
    if (command === "systemctl" && args.includes("stop")) active = false;
    return { stdout: "", stderr: "" };
  };
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.recordingsDir = root;
    const first = new RecordingController(config, "call", store, run);
    expect(await first.start({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toBe("started");
    const recovered = new RecordingController(config, "call", store, run);
    expect((await recovered.recover())?.phase).toBe("recording");
    expect(recovered.ownsRecording()).toBe(true);
    expect(await recovered.stop("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeNull();
    expect(active).toBe(true);
    const stopped = await recovered.stop("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(stopped?.phase).toBe("stopped");
    expect((await store.read())?.phase).toBe("stopped");
    expect(commands.filter((cmd) => cmd.includes("stop")).every((cmd) => cmd.includes("recording-cli-capture-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service"))).toBe(true);
    await recovered.acknowledge(stopped!.id);
    expect(await store.read()).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
