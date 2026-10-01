import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { buildCaptureCommand, inspectAudioSources, resolveAudioSources } from "../capture";

const pactlJson = (sources: unknown[]): string => JSON.stringify(sources);

const fakePactl = (sourceJson: string, microphone = "mic", sink = "speaker") =>
  async (_command: string, args: string[]) => {
    if (args.includes("sources") && args.some((arg) => arg.includes("format=json"))) return { stdout: sourceJson, stderr: "" };
    if (args.includes("get-default-source")) return { stdout: `${microphone}\n`, stderr: "" };
    if (args.includes("get-default-sink")) return { stdout: `${sink}\n`, stderr: "" };
    throw new Error(`unexpected pactl args: ${args.join(" ")}`);
  };

test("captures a mixed transcription track plus isolated microphone and desktop tracks", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const sources = resolveAudioSources(config.capture, ["easyeffects_source", "easyeffects_sink.monitor"], {
    microphone: "easyeffects_source", desktop: "easyeffects_sink.monitor"
  });
  const audio = buildCaptureCommand("audio", config.capture, sources, "/tmp/meeting.mka", "/tmp/token");
  expect(audio.command).toBe("ffmpeg");
  expect(audio.args.filter((arg) => arg === "-i")).toHaveLength(2);
  expect(audio.args.join(" ")).toContain("-map [mix] -map [microphone] -map [desktop]");
  const video = buildCaptureCommand("gpu-screen-recorder", config.capture, sources, "/tmp/meeting.mkv", "/tmp/token");
  expect(video.args.slice(0, 2)).toEqual(["-w", "portal"]);
  expect(video.args.filter((arg) => arg === "-a")).toHaveLength(3);
  expect(video.args).toContain("device:easyeffects_source|device:easyeffects_sink.monitor");
});

test("fails before capture when a selected device disappeared", () => {
  const config = { ...DEFAULT_CONFIG.capture, microphone: "disconnected" };
  expect(() => resolveAudioSources(config, ["speaker.monitor"], {
    microphone: "mic", desktop: "speaker.monitor"
  })).toThrow("disconnected");
});

test("keeps GPU capture on hardware instead of silently increasing CPU load", () => {
  const capture = buildCaptureCommand("gpu-screen-recorder", DEFAULT_CONFIG.capture,
    { microphone: "mic" }, "/tmp/meeting.mkv", "/tmp/token");
  expect(capture.args.join(" ")).toContain("-encoder gpu -fallback-cpu-encoding no");
  expect(capture.args.join(" ")).toContain("-q very_high");
  const software = buildCaptureCommand("gpu-screen-recorder", { ...DEFAULT_CONFIG.capture, encoder: "cpu" },
    { microphone: "mic" }, "/tmp/meeting.mkv", "/tmp/token");
  expect(software.args.join(" ")).toContain("-encoder cpu");
});

test("reports muted or zero-volume selected sources without changing them", async () => {
  const config = { ...DEFAULT_CONFIG.capture, audioSource: "both" as const, microphone: "default", desktop: "default" };
  const run = fakePactl(pactlJson([
    { name: "mic", mute: true, volume: { "front-left": { value: 65536 } } },
    { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 65536 } } }
  ]));
  const result = await inspectAudioSources(config, run);
  expect(result.selected).toEqual({ microphone: "mic", desktop: "speaker.monitor" });
  expect(result.warnings).toHaveLength(1);
});

test("blocks capture when every selected source is muted or silent", async () => {
  const config = { ...DEFAULT_CONFIG.capture, audioSource: "both" as const, microphone: "default", desktop: "default" };
  const run = fakePactl(pactlJson([
    { name: "mic", mute: true, volume: { "front-left": { value: 65536 } } },
    { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 0 } } }
  ]));
  await expect(inspectAudioSources(config, run)).rejects.toThrow(/fontes de áudio selecionadas/i);
});

test("re-reads defaults on every inspection", async () => {
  const config = { ...DEFAULT_CONFIG.capture, audioSource: "microphone" as const, microphone: "default" };
  let current = "mic-a";
  const run = fakePactl(pactlJson([
    { name: "mic-a", mute: false, volume: { "front-left": { value: 65536 } } },
    { name: "mic-b", mute: false, volume: { "front-left": { value: 65536 } } }
  ]), "mic-a");
  const dynamicRun = async (command: string, args: string[]) => {
    const result = await run(command, args);
    if (args.includes("get-default-source")) return { stdout: `${current}\n`, stderr: "" };
    return result;
  };
  expect((await inspectAudioSources(config, dynamicRun)).selected.microphone).toBe("mic-a");
  current = "mic-b";
  expect((await inspectAudioSources(config, dynamicRun)).selected.microphone).toBe("mic-b");
});
