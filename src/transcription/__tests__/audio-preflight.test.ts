import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../../jobs/command";
import { assertPaidAudioSignal, assertPaidAudioMeasurement } from "../audio-preflight";
import { transcribeWithOpenAI } from "../openai";
import { transcribeWithGemini } from "../gemini";
import { DEFAULT_CONFIG } from "../../config/defaults";

const filterId = "falatrace_paid_synthetic_fixture";
const report = (peak: string, samples = "5552", instance = "0x123") => [
  `[astats@${filterId} @ ${instance}] Overall`,
  `[astats@${filterId} @ ${instance}] Peak level dB: ${peak}`,
  `[astats@${filterId} @ ${instance}] Number of samples: ${samples}`
].join("\n");

test("container metadata and another filter cannot turn genuine measured silence into signal", () => {
  const metadata = "Input #0, mp3, from '/tmp/synthetic.mp3':\n  Metadata:\n    comment : Peak level dB: -10\n";
  const unrelated = "[Parsed_astats_0 @ 0x999] Overall\n[Parsed_astats_0 @ 0x999] Peak level dB: -10\n";
  expect(() => assertPaidAudioMeasurement(metadata + unrelated + report("-inf"), filterId)).toThrow("digital silence");
});

test("only genuine complete Overall signal from the owned instance permits paid preflight", () => {
  expect(() => assertPaidAudioMeasurement(report("-inf"), filterId)).toThrow("digital silence");
  expect(() => assertPaidAudioMeasurement(report("-10.5"), filterId)).not.toThrow();
  expect(() => assertPaidAudioMeasurement(report("-130"), filterId)).not.toThrow();
});

test("unknown prefixes, missing Overall, missing metrics and zero decoded samples remain unverified", () => {
  for (const stderr of [
    "comment : Peak level dB: -10",
    report("-10").replaceAll(`astats@${filterId}`, "unknown_filter"),
    report("-10").replace("Overall", "Channel: 1"),
    report("-10").split("\n").slice(0, 2).join("\n"),
    report("-10", "0"), report("nan"), report("inf"), report("-10", "nan")
  ]) expect(() => assertPaidAudioMeasurement(stderr, filterId)).toThrow("could not be verified");
});

test("samples from a different instance cannot complete an Overall report", () => {
  const mixed = report("-10").replace(
    `[astats@${filterId} @ 0x123] Number of samples`, `[astats@${filterId} @ 0x456] Number of samples`
  );
  expect(() => assertPaidAudioMeasurement(mixed, filterId)).toThrow("could not be verified");
});

test("paid preflight rejects only complete digital silence and preserves short/quiet/late signal", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "paid-signal-"));
  try {
    for (const [name, input, volume] of [
      ["silence", "anullsrc=r=16000:cl=mono:d=0.347", "1"],
      ["short", "sine=sample_rate=16000:duration=0.347", "1"],
      ["quiet", "sine=sample_rate=16000:duration=0.1", "0.00001"],
      ["late", "sine=sample_rate=16000:duration=0.1", "1"]
    ]) {
      const path = join(root, `${name}.wav`);
      const filter = name === "late" ? "adelay=1200,volume=1" : `volume=${volume}`;
      await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", input, "-af", filter, "-c:a", "pcm_f32le", path]);
      if (name === "silence") await expect(assertPaidAudioSignal(path)).rejects.toThrow("digital silence");
      else await assertPaidAudioSignal(path);
      expect((await fs.stat(path)).size).toBeGreaterThan(0);
    }
    await expect(assertPaidAudioSignal(join(root, "missing.wav"))).rejects.toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("both paid pipeline adapters reject synthetic silent fragments before dispatch", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "paid-no-dispatch-"));
  const oldKey = process.env.GEMINI_API_KEY;
  const nativeFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw Error("unexpected dispatch"); }) as unknown as typeof fetch;
  try {
    const path = join(root, "silence.wav");
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.347",
      "-metadata", "comment=Peak level dB: -10", path]);
    const config = structuredClone(DEFAULT_CONFIG);
    config.openai.apiKey = "synthetic-not-a-real-key";
    process.env.GEMINI_API_KEY = "synthetic-not-a-real-key";
    await expect(transcribeWithOpenAI(config, path, root, "gpt-transcribe", "pt")).rejects.toThrow("Paid transcription not sent");
    await expect(transcribeWithGemini(path, root, "synthetic", "pt")).rejects.toThrow("Paid transcription not sent");
    expect(requests).toBe(0);
    expect((await fs.stat(path)).size).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = nativeFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});
