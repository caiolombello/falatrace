import { describe, expect, test } from "bun:test";
import { launchRecordingPlayer, normalizePlayerOptions } from "../launcher";
import { parsePlayerTranscript } from "../transcript";

describe("recording player launcher", () => {
  test("normalizes a safe video path and preserves playback context", () => {
    expect(normalizePlayerOptions("/tmp/video.mkv", {
      startSeconds: 12.5,
      transcriptPath: "/tmp/transcript.json",
      title: "Reunião"
    })).toEqual({
      path: "/tmp/video.mkv",
      startSeconds: 12.5,
      transcriptPath: "/tmp/transcript.json",
      title: "Reunião"
    });
    expect(normalizePlayerOptions("https://cdn.example.test/recording.mkv?X-Amz-Signature=redacted").path)
      .toBe("https://cdn.example.test/recording.mkv?X-Amz-Signature=redacted");
  });

  test("rejects unsafe paths and invalid offsets", () => {
    expect(() => normalizePlayerOptions("relative.mkv")).toThrow("absoluto");
    expect(() => normalizePlayerOptions("/tmp/video.mkv", { transcriptPath: "/tmp/a\n.json" })).toThrow("absoluto");
    expect(() => normalizePlayerOptions("/tmp/video.mkv", { startSeconds: -1 })).toThrow("finito");
    expect(() => normalizePlayerOptions("/tmp/video.mkv", { startSeconds: Number.NaN })).toThrow("finito");
    for (const url of [
      "http://cdn.example.test/recording.mkv",
      "file:///tmp/recording.mkv",
      "ftp://cdn.example.test/recording.mkv",
      "https://user:pass@cdn.example.test/recording.mkv",
    ]) expect(() => normalizePlayerOptions(url)).toThrow();
    expect(() => normalizePlayerOptions("https://cdn.example.test/recording.mkv", { startSeconds: 0.7 })).not.toThrow();
  });

  test("rejects a missing video before starting a child", async () => {
    await expect(launchRecordingPlayer("/tmp/recording-cli-player-no-such-file.mkv"))
      .rejects.toThrow("arquivo regular");
  });

  test("an in-memory reviewed snapshot takes precedence over a stale transcript path", async () => {
    await expect(launchRecordingPlayer("/tmp/recording-cli-player-no-such-file.mkv", {
      transcriptPath: "/tmp/recording-cli-player-no-such-transcript.json",
      transcript: { version: 1, provider: "whisper-cpp", model: "fixture", language: "pt", text: "Revisão em memória", segments: [] },
      warnings: ["Legendas indisponíveis: texto revisado sem alinhamento."]
    })).rejects.toThrow("O vídeo não é um arquivo regular");
  });

  test("preserves untimed text without inventing subtitle timestamps", () => {
    expect(parsePlayerTranscript({ text: "Fala sem alinhamento", segments: [] })).toEqual({
      text: "Fala sem alinhamento", timing: "none", segments: []
    });
    expect(parsePlayerTranscript({ text: "Sem segmentos válidos", segments: "invalid" }).timing).toBe("none");
  });

  test("rejects invalid time ranges and distinguishes approximate chunks from audio segments", () => {
    const segments = [
      { start: 10, end: 12, text: "Segunda frase" },
      { start: -1, end: 2, text: "inválido" },
      { start: 0, end: Number.POSITIVE_INFINITY, text: "inválido" },
      { start: true, end: 2, text: "inválido" },
      { start: 0, end: 2, text: " Primeira frase " },
      { start: 1, end: 1, text: "inválido" }
    ];
    const aligned = parsePlayerTranscript({ model: "whisper", segments });
    expect(aligned.segments).toEqual([{ start: 0, end: 2, text: "Primeira frase" }, { start: 10, end: 12, text: "Segunda frase" }]);
    expect(aligned.timing).toBe("segment");
    expect(parsePlayerTranscript({ model: "gpt-transcribe", segments }).timing).toBe("block");
  });

  test("preserves safe speaker labels and requests review for unsafe labels", () => {
    expect(parsePlayerTranscript({ model: "gpt-4o-transcribe-diarize", segments: [
      { start: 0, end: 2, text: "Olá", speaker: "A" },
      { start: 2, end: 3, text: "Oi", speaker: "B\nsecret" }
    ] })).toEqual({
      text: "Olá Oi",
      timing: "segment",
      reviewRequired: true,
      segments: [
        { start: 0, end: 2, text: "Olá", speaker: "A" },
        { start: 2, end: 3, text: "Oi" }
      ]
    });
  });
});
