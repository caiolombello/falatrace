import { expect, test } from "bun:test";
import { alignCanonicalTranscript } from "../alignment";

const canonical = (text: string) => ({
  version: 1 as const,
  provider: "openai" as const,
  model: "gpt-transcribe",
  language: "pt",
  text,
  segments: []
});

test("preserves the canonical text and aligns Unicode speaker turns", () => {
  const text = "Olá, meu Coração!  AÇÃO técnica: gpt-4o.\n";
  const result = alignCanonicalTranscript(canonical(text), [
    { start: 1, end: 2, text: "ola meu coracao", speaker: "S1" },
    { start: 2, end: 3, text: "ação técnica GPT 4o", speaker: "S2" }
  ]);

  expect(result.text).toBe(text);
  expect(result.segments.map(({ text }) => text).join("")).toBe(text);
  expect(result.segments.filter((segment) => segment.speaker).map((segment) => segment.speaker)).toEqual(["S1", "S2"]);
  expect(result.segments.filter((segment) => segment.speaker).every((segment) => segment.reviewRequired)).toBe(true);
  expect(result.segments.find((segment) => segment.speaker === "S2")?.text).toBe("AÇÃO técnica: gpt-4o.\n");
  expect(result.segments.every((segment) => segment.charStart < segment.charEnd)).toBe(true);
});

test("leaves an omitted boundary phrase unknown instead of extending a speaker", () => {
  const text = "Primeiro ponto importante. Frase omitida. Segundo ponto concluído.";
  const result = alignCanonicalTranscript(canonical(text), [
    { start: 0, end: 4, text: "Primeiro ponto importante", speaker: "A" },
    { start: 4, end: 8, text: "Segundo ponto concluído", speaker: "B" }
  ]);

  const omitted = result.segments.find((segment) => segment.text.includes("Frase omitida"));
  expect(omitted?.speaker).toBeUndefined();
  expect(omitted?.reviewRequired).toBe(true);
  expect(result.segments.find((segment) => segment.speaker === "A")?.text).toBe("Primeiro ponto importante.");
  expect(result.segments.find((segment) => segment.speaker === "B")?.text).toBe("Segundo ponto concluído.");
});

test("does not guess between repeated utterances", () => {
  const result = alignCanonicalTranscript(canonical("Sim. Sim."), [
    { start: 1, end: 2, text: "Sim", speaker: "A" }
  ]);

  expect(result.matchedTokenRatio).toBe(0);
  expect(result.unassignedTokenCount).toBe(2);
  expect(result.segments.every((segment) => segment.speaker === undefined && segment.reviewRequired)).toBe(true);
});

test("does not attach a short unique word outside its acoustic time window", () => {
  const result = alignCanonicalTranscript({
    ...canonical("Uma frase longa. Sim."),
    segments: [
      { start: 0, end: 600, text: "Uma frase longa.", speaker: undefined },
      { start: 600, end: 601, text: "Sim.", speaker: undefined }
    ]
  }, [{ start: 5, end: 6, text: "Sim", speaker: "late" }]);

  expect(result.segments.some((segment) => segment.speaker)).toBe(false);
  expect(result.segments.every((segment) => segment.reviewRequired)).toBe(true);
});

test("uses half-open canonical windows at the 600 second boundary", () => {
  const result = alignCanonicalTranscript({
    ...canonical("Primeira fala. Segunda fala agora."),
    segments: [
      { start: 0, end: 600, text: "Primeira fala.", speaker: undefined },
      { start: 600, end: 1200, text: "Segunda fala agora.", speaker: undefined }
    ]
  }, [{ start: 600, end: 601, text: "Segunda fala agora", speaker: "boundary" }]);

  expect(result.segments.find((segment) => segment.speaker === "boundary")?.text).toBe("Segunda fala agora.");
});

test("does not rename acoustic speaker labels and reports unmatched turns", () => {
  const text = "A palavra canônica permanece.";
  const result = alignCanonicalTranscript(canonical(text), [
    { start: 10, end: 11, text: "outra frase", speaker: "voice-17" }
  ]);

  expect(result.segments.map(({ text }) => text).join("")).toBe(text);
  expect(result.segments.every((segment) => segment.speaker === undefined)).toBe(true);
  expect(result.segments.some((segment) => segment.reviewRequired)).toBe(true);
});

test("keeps successive repeated words monotonic while isolating a technical divergence", () => {
  const text = "Sim, vamos ao deploy do gpt-4o. Sim, vamos ao deploy do gpt-5.";
  const result = alignCanonicalTranscript({
    ...canonical(text),
    segments: [
      { start: 0, end: 5, text: "Sim, vamos ao deploy do gpt-4o.", speaker: undefined },
      { start: 5, end: 10, text: "Sim, vamos ao deploy do gpt-5.", speaker: undefined }
    ]
  }, [
    { start: 0, end: 5, text: "sim vamos ao deploy do GPT 4o", speaker: "voice-a" },
    { start: 5, end: 10, text: "sim vamos ao deploy do GPT 5", speaker: "voice-b" }
  ]);

  expect(result.segments.map(({ text }) => text).join("")).toBe(text);
  expect(result.segments.filter((segment) => segment.speaker).map((segment) => segment.speaker)).toEqual(["voice-a", "voice-b"]);
  expect(result.segments.find((segment) => segment.speaker === "voice-a")?.text).toContain("gpt-4o");
  expect(result.segments.find((segment) => segment.speaker === "voice-b")?.text).toContain("gpt-5");
});
