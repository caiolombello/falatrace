import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import { JobStore } from "../store";
import { validateJobManifest, validateTranscript } from "../types";

test("accepts Gemini as an opt-in transcriber while preserving existing defaults", () => {
  const config = mergeConfig(DEFAULT_CONFIG, {
    transcription: { provider: "gemini" }
  });

  expect(() => validateConfig(config)).not.toThrow();
  expect(config.transcription.geminiModel).toBe("gemini-3.5-transcribe");
  expect(DEFAULT_CONFIG.transcription.provider).toBe("whisper-cpp");
  expect(config.transcription.openaiModel).toBe("gpt-transcribe");
});

test("rejects an invalid Gemini model before it can create an unreadable job", () => {
  for (const geminiModel of [null, 17, "", " ", "x".repeat(201)]) {
    const config = mergeConfig(DEFAULT_CONFIG, {
      transcription: { provider: "gemini", geminiModel: geminiModel as unknown as string }
    });
    expect(() => validateConfig(config)).toThrow("transcription.geminiModel");
  }
});

test("retains validated word timings when a Gemini transcript is loaded from disk", () => {
  const transcript = {
    version: 1,
    provider: "gemini",
    model: "gemini-3.5-transcribe",
    language: "pt",
    text: "Bom dia.",
    segments: [{ start: 0.1, end: 0.8, text: "Bom dia.", speaker: "spk_1" }],
    words: [
      { start: 0.1, end: 0.3, text: "Bom", speaker: "spk_1" },
      { start: 0.4, end: 0.8, text: "dia.", speaker: "spk_1" }
    ]
  };
  expect(validateTranscript(transcript).words).toEqual(transcript.words);
  expect(() => validateTranscript({ ...transcript, words: [{ ...transcript.words[0], end: -1 }] })).toThrow();
});

test("creates and reloads a Gemini job without applying OpenAI prompt or keyword settings", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-gemini-job-"));
  try {
    const source = join(root, "meeting.wav");
    await fs.writeFile(source, "fixture media");
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const config = mergeConfig(DEFAULT_CONFIG, {
      transcription: { provider: "openai", openaiPrompt: "Glossário do GPT" }
    });
    const job = await store.enqueue(config, source, {
      target: "local",
      transcriptionProvider: "gemini"
    });

    expect(job.transcription).toEqual({
      provider: "gemini",
      model: "gemini-3.5-transcribe",
      language: "pt"
    });
    expect(validateJobManifest(store.toManifest(job)).transcription.provider).toBe("gemini");
    expect((await store.get(job.id)).transcription).toEqual(job.transcription);
    expect(config.transcription.provider).toBe("openai");
    expect(validateTranscript({
      version: 1,
      ...job.transcription,
      text: "Bom dia.",
      segments: [{ start: 0.5, end: 1.2, text: "Bom dia.", speaker: "spk_1" }]
    }).segments[0].speaker).toBe("spk_1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
