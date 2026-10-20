import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../jobs/command";
import {
  ENVELOPE_STEP_SECONDS, SILENCE_DB, analyzeMicrophone, parseEnvelope, resolveTrackLayout, scoreMicrophone, verifyOrderedLayout
} from "../microphone";

const STEP = ENVELOPE_STEP_SECONDS;
/** dB envelope with `level` inside each [start, end) second range and `floor` elsewhere. */
const envelope = (seconds: number, ranges: Array<[number, number, number]>, floor = SILENCE_DB): Float32Array => {
  const values = new Float32Array(Math.round(seconds / STEP)).fill(floor);
  for (const [start, end, level] of ranges) for (let index = Math.round(start / STEP); index < Math.round(end / STEP); index++) values[index] = level;
  return values;
};
const turns = (...entries: Array<[number, number, string]>) => entries.map(([start, end, speaker]) => ({ start, end, speaker }));

test("track layout: titled FalaTrace tracks, the untitled GPU Screen Recorder order, and anything else refused", () => {
  expect(resolveTrackLayout([{ title: "Mixed" }, { title: "Microphone" }, { title: "Desktop" }])).toEqual({ source: "titled", microphone: 1, desktop: 2, mix: 0 });
  expect(resolveTrackLayout([{ title: "desktop" }, { title: "microphone" }])).toEqual({ source: "titled", microphone: 1, desktop: 0 });
  expect(resolveTrackLayout([{}, {}, {}])).toEqual({ source: "ordered", mix: 0, microphone: 1, desktop: 2 });
  expect(resolveTrackLayout([{ title: "Mixed" }])).toBeUndefined();
  expect(resolveTrackLayout([{}, {}])).toBeUndefined();
  expect(resolveTrackLayout([{ title: "Track 1" }, { title: "Track 2" }, { title: "Track 3" }])).toBeUndefined();
});

test("parses ffmpeg level output, filling gaps and digital silence with the silence floor", () => {
  const values = parseEnvelope([
    "frame:0    pts:0       pts_time:0", "lavfi.astats.Overall.RMS_level=-21.5",
    "frame:1    pts:800     pts_time:0.1", "lavfi.astats.Overall.RMS_level=-inf",
    "frame:3    pts:2400    pts_time:0.3", "lavfi.astats.Overall.RMS_level=-40.25",
    "garbage", "lavfi.astats.Overall.RMS_level=-1"
  ].join("\n"));
  expect([...values]).toEqual([-21.5, SILENCE_DB, SILENCE_DB, -40.25]);
});

test("the speaker heard on the microphone while the computer is quiet is the owner, even with speaker echo", () => {
  // S01 talks locally (0-10 s, 20-30 s); S02 is remote (10-20 s, 30-40 s) and leaks into the microphone at -45 dB.
  const microphone = envelope(40, [[0, 10, -24], [10, 20, -45], [20, 30, -24], [30, 40, -45]], -70);
  const desktop = envelope(40, [[10, 20, -22], [30, 40, -22]]);
  const score = scoreMicrophone(turns([0, 10, "S01"], [10, 20, "S02"], [20, 30, "S01"], [30, 40, "S02"]), microphone, desktop);
  expect(score.selfSpeakers).toEqual(["S01"]);
  expect(score.reason).toBeUndefined();
  expect(score.speakers).toEqual([
    { speakerId: "S01", localSeconds: 20, remoteSeconds: 0, localShare: 1 },
    { speakerId: "S02", localSeconds: 0, remoteSeconds: 20, localShare: 0 }
  ]);
});

test("a voice split in two by the diarizer keeps both; more than two is ambiguous", () => {
  const desktop = envelope(40, [[30, 40, -20]]);
  const split = scoreMicrophone(turns([0, 10, "S01"], [10, 20, "S03"], [30, 40, "S02"]), envelope(40, [[0, 20, -25]], -70), desktop);
  expect(split.selfSpeakers).toEqual(["S01", "S03"]);
  const crowd = scoreMicrophone(turns([0, 10, "S01"], [10, 20, "S02"], [20, 30, "S03"], [30, 40, "S04"]), envelope(40, [[0, 30, -25]], -70), desktop);
  expect(crowd).toMatchObject({ selfSpeakers: [], reason: "ambiguous" });
});

test("no suggestion without computer audio to compare, without microphone speech, or without a matching speaker", () => {
  const speech = envelope(30, [[0, 10, -25]], -70);
  expect(scoreMicrophone(turns([0, 10, "S01"], [10, 30, "S02"]), speech, envelope(30, []))).toMatchObject({ selfSpeakers: [], reason: "no-desktop-audio" });
  expect(scoreMicrophone(turns([0, 30, "S01"]), envelope(30, [], -70), envelope(30, [[0, 30, -20]]))).toMatchObject({ selfSpeakers: [], reason: "no-microphone-speech" });
  // Microphone speech that no diarized turn covers.
  expect(scoreMicrophone(turns([10, 30, "S02"]), speech, envelope(30, [[10, 30, -20]]))).toMatchObject({ selfSpeakers: [], reason: "no-match" });
  // A computer track that never goes quiet (background at -45 dB) still separates remote speech.
  expect(scoreMicrophone(turns([0, 10, "S01"], [10, 30, "S02"]), speech, envelope(30, [[10, 30, -20]], -45)).selfSpeakers).toEqual(["S01"]);
  // Double talk is neither local nor counted for the owner.
  const both = scoreMicrophone(turns([0, 20, "S01"]), envelope(20, [[0, 20, -24]], -70), envelope(20, [[0, 20, -22]]));
  expect(both.speakers[0]).toEqual({ speakerId: "S01", localSeconds: 0, remoteSeconds: 20, localShare: 0 });
});

test("the untitled order is used only when the first track carries the others and the third looks like the computer", () => {
  const microphone = envelope(20, [[0, 10, -25]], -70);
  const desktop = envelope(20, [[10, 20, -22]]);
  const mix = envelope(20, [[0, 10, -25], [10, 20, -22]], -70);
  expect(verifyOrderedLayout({ mix, microphone, desktop })).toBe(true);
  // Swapped tracks: the "microphone" is digitally silent while the "computer" has a noise floor.
  expect(verifyOrderedLayout({ mix, microphone: desktop, desktop: microphone })).toBe(false);
  expect(verifyOrderedLayout({ mix: envelope(20, []), microphone, desktop })).toBe(false);
});

const fixtureRoot = async (): Promise<string> => fs.mkdtemp(join(tmpdir(), "falatrace-speakers-mic-"));
const synthesize = async (path: string, titled: boolean): Promise<void> => {
  // Microphone speaks from 0 to 8 s; the computer plays a remote voice from 8 to 16 s.
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=16",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16",
    "-filter_complex", "[0:a]volume='if(lt(t,8),0.5,0)':eval=frame,asplit=2[m1][m2];[1:a]volume='if(gte(t,8),0.5,0)':eval=frame,asplit=2[d1][d2];[m1][d1]amix=inputs=2:normalize=0[mix]",
    "-map", "[mix]", "-map", "[m2]", "-map", "[d2]",
    ...(titled ? ["-metadata:s:a:0", "title=Mixed", "-metadata:s:a:1", "title=Microphone", "-metadata:s:a:2", "title=Desktop"] : []),
    "-c:a", "flac", "-f", "matroska", path], { timeoutMs: 60_000 });
};

test("analyzes real titled and untitled FalaTrace captures with ffmpeg and refuses a single track", async () => {
  const root = await fixtureRoot();
  try {
    const spoken = turns([0.2, 7.8, "S01"], [8.2, 15.8, "S02"]);
    for (const titled of [true, false]) {
      const media = join(root, titled ? "titled.mkv" : "ordered.mkv");
      await synthesize(media, titled);
      const work = await fs.mkdtemp(join(root, "work-"));
      const result = await analyzeMicrophone(media, spoken, work);
      expect(result).toMatchObject({ state: "ready", layout: titled ? "titled" : "ordered", selfSpeakers: ["S01"] });
      // Level files stay inside the work directory the caller owns.
      expect((await fs.readdir(work)).sort()).toEqual(titled ? ["desktop.txt", "microphone.txt"] : ["desktop.txt", "microphone.txt", "mix.txt"]);
    }
    const single = join(root, "single.wav");
    await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=16000:duration=2", single], { timeoutMs: 60_000 });
    expect(await analyzeMicrophone(single, spoken, await fs.mkdtemp(join(root, "work-")))).toEqual({ state: "unavailable", reason: "no-separate-tracks" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
