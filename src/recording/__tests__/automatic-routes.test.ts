import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCaptureCommand } from "../capture";
import { RecordingController } from "../controller";
import { RecordingSessionStore } from "../session";
import { pulseClientName } from "../audio-routes";
import { runCommand } from "../../jobs/command";
import { expect, test } from "bun:test";
import { AudioDefaultsObserver } from "../../calls/pipewire";
import { ManualObsController, type ManualObsClient } from "../obs-recording";
import { DEFAULT_CONFIG } from "../../config/defaults";

test("only changes to effective defaults trigger work, including a return after removal", () => {
  const observer = new AudioDefaultsObserver();
  const update = (name: string | null) => [{ id: 40, type: "PipeWire:Interface:Metadata",
    props: { "metadata.name": "default" }, metadata: [{ subject: 0, key: "default.audio.sink", value: name && { name } }] }];
  expect(observer.apply(update("speaker"))).toEqual(["desktop"]);
  expect(observer.apply(update("speaker"))).toEqual([]);
  expect(observer.apply([{ id: 8, type: "PipeWire:Interface:Node" }])).toEqual([]);
  expect(observer.apply(update(null))).toEqual([]);
  expect(observer.apply(update("speaker"))).toEqual(["desktop"]);
});

test("OBS reopens only active default sources of the changed kind in the owned recording", async () => {
  const writes: string[] = [];
  const client = { async connect() {}, async disconnect() {}, async call(op: string, data: any) {
    if (op === "GetRecordStatus") return { outputActive: true, outputDuration: 0 };
    if (op === "GetRecordDirectory") return { recordDirectory: "/owned" };
    if (op === "GetInputList") return { inputs: ["follow", "pinned", "hidden"].map(inputName => ({ inputName, inputKind: "pulse_output_capture" })) };
    if (op === "GetSourceActive") return { videoActive: data.sourceName !== "hidden" };
    if (op === "GetInputSettings") return { inputKind: "pulse_output_capture", inputSettings: data.inputName === "pinned" ? {device_id:"speaker"} : {} };
    if (op === "SetInputSettings") { expect(data.inputSettings).toEqual({device_id:"default"}); writes.push(data.inputName); return; }
    throw Error(op);
  }} as unknown as ManualObsClient;
  const obs = new ManualObsController(DEFAULT_CONFIG.obs, () => client);
  await obs.refreshAudioRoutes("/other", new Date().toISOString(), ["desktop"]);
  expect(writes).toEqual([]);
  await obs.refreshAudioRoutes("/owned", new Date().toISOString(), ["desktop"]);
  expect(writes).toEqual(["follow"]);
});

test("GPU automatic tracks follow each default while keeping the explicit microphone", () => {
  const capture = buildCaptureCommand("gpu-screen-recorder", { ...DEFAULT_CONFIG.capture, microphone: "fixed" },
    { microphone: "fixed", desktop: "old.monitor" }, "/tmp/out.mkv", "/tmp/token", "call");
  expect(capture.args.filter((_, i) => capture.args[i - 1] === "-a")).toEqual([
    "device:fixed|default_output", "device:fixed", "default_output"
  ]);
});

test.each(["move", "refusal", "exited", "damaged-part"] as const)("a route change with %s keeps one playable session", async scenario => {
  const root = await fs.mkdtemp(join(tmpdir(), "audio-handoff-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = "audio";
  config.capture.audioSource = "desktop";
  config.recordingsDir = root;
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let sink = "speaker";
  let active = false;
  let starts = 0;
  const moves: string[][] = [];
  let currentSource = 1;
  const run: typeof runCommand = async (cmd, args) => {
    let stdout = "";
    if (cmd === "pactl") {
      if (args.includes("source-outputs")) stdout = JSON.stringify([
        { index: 12, source: currentSource, properties: { "application.name": pulseClientName(id, "desktop"), "application.process.id": "123" } },
        { index: 13, source: 1, properties: { "application.name": "some-other-recorder" } }
      ]);
      else if (args.includes("sources")) stdout = JSON.stringify(["speaker", "phones"].map((name,i) => ({
        index: i + 1, name: name + ".monitor", mute: false, volume: { mono: { value: 65536 } }
      })));
      else if (args[0] === "get-default-sink") stdout = sink;
      else if (args[0] === "move-source-output") {
        moves.push(args);
        if (scenario !== "move") throw new Error("server refused");
        currentSource = Number(args[2]);
      }
    } else if (cmd === "systemd-run") {
      expect(active).toBe(false);
      expect(args).toContain(pulseClientName(id, "desktop"));
      await runCommand("ffmpeg", ["-v","error","-f","lavfi","-i",`sine=frequency=${starts ? 880 : 440}:duration=0.2`,
        "-ar","48000","-c:a","flac",args[args.length - 1]]);
      active = true;
      starts++;
    } else if (cmd === "systemctl" && args.includes("--value")) stdout = "123";
    else if (cmd === "systemctl" && args.includes("show")) stdout = "ActiveState=" + (active ? "active" : "inactive");
    else if (cmd === "systemctl" && args.includes("stop")) active = false;
    else throw Error(cmd);
    return { stdout, stderr: "" };
  };
  const store = new RecordingSessionStore(join(root, "session.json"));
  const controller = new RecordingController(config, "call", store, run);
  try {
    await controller.start({sessionId: id});
    const path = controller.getSession()!.outputPath;
    sink = "phones";
    if (scenario === "exited") {
      active = false;
      expect((await controller.recover(() => "wait"))?.phase).toBe("recording");
      expect(starts).toBe(1);
      await controller.recover(() => "resume");
    } else {
      await controller.refreshAudioRoutes(id, ["desktop"]);
      expect(moves).toEqual([["move-source-output","12","2"]]);
    }
    expect(starts).toBe(scenario === "move" ? 1 : 2);
    expect((await store.read())?.audio).toEqual({ desktop: "phones.monitor" });
    if (scenario === "damaged-part") {
      const part = join(dirname(path), "audio-part-1.mka");
      const before = await fs.readFile(path);
      const valid = await fs.readFile(part);
      await fs.writeFile(part, "incomplete media");
      await expect(controller.stop(id)).rejects.toThrow();
      expect(await fs.readFile(path)).toEqual(before);
      expect((await store.read())?.audioPartStarts).toHaveLength(1);
      await fs.writeFile(part, valid);
    }
    // A fresh controller must finish a segmented session with the original pathname and id.
    const stopped = await new RecordingController(config, "call", store, run).stop(id);
    expect(stopped?.outputPath).toBe(path);
    const {stdout} = await runCommand("ffprobe", ["-v","error","-show_format","-show_chapters","-of","json",path]);
    const probe = JSON.parse(stdout);
    expect(Number(probe.format.duration)).toBeGreaterThan(scenario === "move" ? 0.19 : 0.39);
    expect(probe.chapters.length).toBe(scenario === "move" ? 0 : 1);
    expect((await fs.readdir(dirname(path))).filter(name => name.endsWith(".mka"))).toEqual(["recording.mka"]);
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});
