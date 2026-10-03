import { expect, test } from "bun:test";
import type { runCommand } from "../../jobs/command";
import { checkRecordingAudio } from "../health";

type FixtureStream = { index: number; codec_type: string; channels?: number; tags?: { title: string } };
type CommandCall = { command: string; args: string[] };

const measuredOutput = (peak: number | "-inf", channelPeaks: (number | "-inf")[] = [], silenceSeconds = 0): string => [
  ...channelPeaks.flatMap((value, index) => [
    `[Parsed_astats_1 @ 0xfixture] Channel: ${index + 1}`,
    `[Parsed_astats_1 @ 0xfixture] Peak level dB: ${value}`
  ]),
  "[Parsed_astats_1 @ 0xfixture] Overall",
  "[Parsed_astats_1 @ 0xfixture] Peak level dB: -1.000000",
  ...(silenceSeconds ? [`[silencedetect @ 0xfixture] silence_end: ${silenceSeconds} | silence_duration: ${silenceSeconds}`] : []),
  `[Parsed_volumedetect_2 @ 0xfixture] max_volume: ${peak} dB`
].join("\n");

const healthFixture = (
  duration: number,
  streams: FixtureStream[],
  outputs: Record<string, string | Error>
): { run: typeof runCommand; calls: CommandCall[] } => {
  const calls: CommandCall[] = [];
  const run: typeof runCommand = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "ffprobe") return { stdout: JSON.stringify({ format: { duration: String(duration) }, streams }), stderr: "" };
    if (command !== "ffmpeg") throw new Error(`Fixture forbids command: ${command}`);
    const stream = args[args.indexOf("-map") + 1];
    const start = args.includes("-ss") ? args[args.indexOf("-ss") + 1] : "0";
    const output = outputs[`${stream}:${start}`];
    if (output instanceof Error) throw output;
    if (output === undefined) throw new Error(`Fixture has no measurement for ${stream}:${start}`);
    return { stdout: "", stderr: output };
  };
  return { run, calls };
};

const syntheticPath = "/synthetic/manual-audio-check.mka";

test("manual recent window exposes silent stereo desktop despite audible mix and microphone", async () => {
  const fixture = healthFixture(120, [
    { index: 1, codec_type: "audio", channels: 2, tags: { title: "Mixed" } },
    { index: 2, codec_type: "audio", channels: 1, tags: { title: "Microphone" } },
    { index: 3, codec_type: "audio", channels: 2, tags: { title: "Desktop" } }
  ], {
    "0:1:0": measuredOutput(-8, [-8, -8]), "0:1:60": measuredOutput(-8, [-8, -8]),
    "0:2:0": measuredOutput(-8, [-8]), "0:2:60": measuredOutput(-8, [-8]),
    "0:3:0": measuredOutput(-8, [-8, -8]), "0:3:60": measuredOutput(-91, ["-inf", "-inf"], 60)
  });
  const report = await checkRecordingAudio(syntheticPath, fixture.run);
  expect(report.durationSeconds).toBe(120);
  expect(report.sampledSeconds).toBe(60);
  expect(report.windows).toEqual([
    { kind: "initial", startSeconds: 0, sampledSeconds: 60 },
    { kind: "recent", startSeconds: 60, sampledSeconds: 60 }
  ]);
  expect(report.tracks.every((track) => track.hasSignal)).toBe(true);
  expect(report.tracks.slice(0, 2).every((track) => track.windows.every((window) => window.hasSignal))).toBe(true);
  const recentDesktop = report.tracks[2].windows[1];
  expect(recentDesktop.hasSignal).toBe(false);
  expect(recentDesktop.channelAnalysis).toBe("measured");
  expect(recentDesktop.channels.map((channel) => channel.hasSignal)).toEqual([false, false]);
  expect(report.warnings).toEqual(["Track 3 (Desktop) has no signal above -50 dB in the recent sample (60–120 seconds)"]);
  const commands = fixture.calls.filter((call) => call.command === "ffmpeg");
  expect(commands).toHaveLength(6);
  expect(commands.every(({ args }) => args[args.indexOf("-t") + 1] === "60")).toBe(true);
  expect(commands.filter(({ args }) => args.includes("-ss")).map(({ args }) => args[args.indexOf("-ss") + 1])).toEqual(["60", "60", "60"]);
  expect(commands.every(({ args }) => args[args.indexOf("-af") + 1] === "silencedetect=noise=-50dB:d=10,astats=metadata=0:reset=0,volumedetect")).toBe(true);
  expect(fixture.calls.every(({ command }) => command === "ffprobe" || command === "ffmpeg")).toBe(true);
});

test("one quiet stereo channel stays visible when its track peak is audible", async () => {
  const fixture = healthFixture(30, [{ index: 0, codec_type: "audio", channels: 2, tags: { title: "Desktop" } }], {
    "0:0:0": measuredOutput(-8, [-8, "-inf"])
  });
  const report = await checkRecordingAudio(syntheticPath, fixture.run);
  expect(report.tracks[0].hasSignal).toBe(true);
  expect(report.tracks[0].windows[0].channels.map((channel) => channel.hasSignal)).toEqual([true, false]);
  expect(report.warnings).toEqual(["Track 0 (Desktop) (transcription) channel 2 has no signal above -50 dB in the initial sample (0–30 seconds)"]);
});

test("an unnamed track is identified by index without inventing a desktop role", async () => {
  const fixture = healthFixture(120, [{ index: 3, codec_type: "audio", channels: 2 }], {
    "0:3:0": measuredOutput(-8, [-8, -8]), "0:3:60": measuredOutput(-91, ["-inf", "-inf"], 60)
  });
  const report = await checkRecordingAudio(syntheticPath, fixture.run);
  expect(report.tracks[0].index).toBe(3);
  expect(report.tracks[0].title).toBeUndefined();
  expect(report.tracks[0].sourceRole).toBe("unverified");
  expect(report.warnings).toEqual(["Track 3 (transcription) has no signal above -50 dB in the recent sample (60–120 seconds)"]);
  expect(report.warnings.join(" ")).not.toContain("Desktop");
});

test("signal and silence-duration boundaries remain explicit", async () => {
  for (const [peak, silence, signal, warning] of [
    [-50, 0, false, "no signal above -50 dB"],
    [-49.9, 29.9, true, ""],
    [-49.9, 30, true, "at least 30 seconds of silence"]
  ] as const) {
    const fixture = healthFixture(60, [{ index: 0, codec_type: "audio" }], { "0:0:0": measuredOutput(peak, [], silence) });
    const report = await checkRecordingAudio(syntheticPath, fixture.run);
    expect(report.tracks[0].hasSignal).toBe(signal);
    expect(report.tracks[0].longestSilenceSeconds).toBe(silence);
    if (warning) expect(report.warnings.join(" ")).toContain(warning);
    else expect(report.warnings).toEqual([]);
    expect(report.windows).toHaveLength(1);
  }
});

test("short media keeps one bounded initial sample and longer media identifies overlap", async () => {
  for (const duration of [0.2, 61]) {
    const fixture = healthFixture(duration, [{ index: 0, codec_type: "audio", channels: 1 }], {
      "0:0:0": measuredOutput(-8, [-8]), "0:0:1": measuredOutput(-8, [-8])
    });
    const report = await checkRecordingAudio(syntheticPath, fixture.run);
    expect(report.sampledSeconds).toBe(Math.min(60, duration));
    expect(report.windows).toEqual(duration === 61 ? [
      { kind: "initial", startSeconds: 0, sampledSeconds: 60 },
      { kind: "recent", startSeconds: 1, sampledSeconds: 60 }
    ] : [{ kind: "initial", startSeconds: 0, sampledSeconds: 0.2 }]);
    expect(report.warnings).toEqual([]);
  }
});

test("missing channel metrics are unavailable rather than manufactured silence", async () => {
  const fixture = healthFixture(60, [{ index: 0, codec_type: "audio", channels: 2 }], {
    "0:0:0": measuredOutput(-8)
  });
  const report = await checkRecordingAudio(syntheticPath, fixture.run);
  expect(report.tracks[0].hasSignal).toBe(true);
  expect(report.tracks[0].windows[0].channelAnalysis).toBe("unavailable");
  expect(report.tracks[0].windows[0].channels).toEqual([
    { index: 0, measurement: "unavailable", hasSignal: null, peakDb: null },
    { index: 1, measurement: "unavailable", hasSignal: null, peakDb: null }
  ]);
  expect(report.warnings).toEqual([]);
  const partial = healthFixture(60, [{ index: 0, codec_type: "audio", channels: 2 }], {
    "0:0:0": measuredOutput(-8, [-8])
  });
  const partialReport = await checkRecordingAudio(syntheticPath, partial.run);
  expect(partialReport.tracks[0].windows[0].channelAnalysis).toBe("unavailable");
  expect(partialReport.tracks[0].windows[0].channels.map((channel) => channel.hasSignal)).toEqual([true, null]);
  expect(partialReport.warnings).toEqual([]);
});

test("missing aggregate measurements and analysis failure reject without a silence result", async () => {
  for (const output of ["[Parsed_volumedetect_1 @ 0xfixture] mean_volume: -8 dB", measuredOutput("-inf").replace("max_volume: -inf", "max_volume: nan"), new Error("Synthetic analysis failed")]) {
    const fixture = healthFixture(120, [{ index: 0, codec_type: "audio" }], {
      "0:0:0": measuredOutput(-8), "0:0:60": output
    });
    await expect(checkRecordingAudio(syntheticPath, fixture.run)).rejects.toThrow(output instanceof Error ? "Synthetic analysis failed" : "Audio measurement unavailable");
  }
  const unavailable: typeof runCommand = async () => { throw new Error("Synthetic probe unavailable"); };
  await expect(checkRecordingAudio(syntheticPath, unavailable)).rejects.toThrow("Synthetic probe unavailable");
});

test("a later manual check with audible signal has no stale silence warning", async () => {
  const stream = [{ index: 0, codec_type: "audio", channels: 2, tags: { title: "Desktop" } }];
  const silent = healthFixture(120, stream, { "0:0:0": measuredOutput(-8, [-8, -8]), "0:0:60": measuredOutput(-91, ["-inf", "-inf"], 60) });
  expect((await checkRecordingAudio(syntheticPath, silent.run)).warnings).toHaveLength(1);
  const recovered = healthFixture(120, stream, { "0:0:0": measuredOutput(-8, [-8, -8]), "0:0:60": measuredOutput(-8, [-8, -8]) });
  const report = await checkRecordingAudio(syntheticPath, recovered.run);
  expect(report.warnings).toEqual([]);
  expect(report.tracks[0].windows.every((window) => window.hasSignal && window.channelAnalysis === "measured")).toBe(true);
});

test("track and per-channel work remain bounded", async () => {
  const nineTracks = healthFixture(120, Array.from({ length: 9 }, (_, index) => ({ index, codec_type: "audio" })), {});
  await expect(checkRecordingAudio(syntheticPath, nineTracks.run)).rejects.toThrow("up to eight tracks");
  expect(nineTracks.calls).toHaveLength(1);
  const wide = healthFixture(120, [{ index: 0, codec_type: "audio", channels: 9 }], {
    "0:0:0": measuredOutput(-8), "0:0:60": measuredOutput(-8)
  });
  const report = await checkRecordingAudio(syntheticPath, wide.run);
  expect(report.tracks[0].windows.every((window) => window.channelAnalysis === "unsupported" && window.channels.length === 0)).toBe(true);
  expect(wide.calls.filter(({ command }) => command === "ffmpeg").every(({ args }) => !args[args.indexOf("-af") + 1].includes("astats"))).toBe(true);
});
