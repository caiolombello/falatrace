import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildDiarizationView, buildTranscriptBoundary } from "./bridge";
import { parsePlayerTranscript } from "../player/transcript";
import type { DiarizationResult } from "../diarization/store";
import { transcriptChecksum, validateDiarizationResult } from "../diarization/store";
import type { Transcript } from "../jobs/types";

const result = (turns = [
  { start: 1, end: 3, speaker: "S01", text: "Primeira fala sintética." },
  { start: 2, end: 4, speaker: "S02", text: "Resposta sintética simultânea." }
]): DiarizationResult => ({
  version: 1, jobId: "11111111-1111-4111-8111-111111111111",
  mediaSha256: "a".repeat(64), transcriptSha256: transcriptChecksum("Texto canônico diferente."),
  provider: "openai", model: "gpt-4o-transcribe-diarize",
  duration: Math.max(5, ...turns.map(t => t.end)), generatedAt: "2026-10-01T00:00:00Z", acousticValidation: "pending",
  labels: { S01: "Pessoa A", S02: "Pessoa B" }, turns,
  alignment: { text: "Texto canônico diferente.", matchedTokenRatio: 0,
    unassignedTokenCount: 3, segments: [{ start: 0, end: 5, charStart: 0,
      charEnd: "Texto canônico diferente.".length, text: "Texto canônico diferente.", reviewRequired: true }] }
});

describe("diarized dialogue presentation", () => {
  test("uses existing timed diarizer text for captions without replacing or aligning canonical blocks", () => {
    const canonical: Transcript = { version: 1, provider: "openai", model: "gpt-transcribe", language: "pt",
      text: "Texto canônico diferente.", segments: [{ start: 0, end: 600, text: "Texto canônico diferente." }] };
    const sidecar = validateDiarizationResult(result());
    const view = buildDiarizationView(sidecar);
    const before = JSON.stringify({ canonical, sidecar, view });
    const boundary = buildTranscriptBoundary(canonical, parsePlayerTranscript(canonical), view);
    expect(boundary.transcript.text).toBe(canonical.text);
    expect(boundary.transcript.timing).toBe("block");
    expect(boundary.captionSource).toBe("diarization");
    expect(boundary.captionPartial).toBe(false);
    expect(boundary.captionTranscript.reviewRequired).toBe(true);
    expect(boundary.captionTranscript.segments).toEqual([
      { start: 1, end: 3, speaker: "Pessoa A", text: "Primeira fala sintética." },
      { start: 2, end: 4, speaker: "Pessoa B", text: "Resposta sintética simultânea." }
    ]);
    expect(JSON.stringify({ canonical, sidecar, view })).toBe(before);
  });

  test("keeps usable existing captions ahead of diarization and never promotes block text alone", () => {
    const block = parsePlayerTranscript({ model: "gpt-transcribe", text: "Bloco aproximado", segments: [{ start: 0, end: 600, text: "Bloco aproximado" }] });
    const aligned = parsePlayerTranscript({ model: "whisper", segments: [{ start: 1, end: 2, text: "Cue existente" }] });
    const view = buildDiarizationView(validateDiarizationResult(result()));
    expect(buildTranscriptBoundary(undefined, aligned, view).captionTranscript).toEqual(aligned);
    expect(buildTranscriptBoundary(undefined, aligned, view).captionSource).toBe("transcript");
    const absent = buildTranscriptBoundary(undefined, block, { state: "idle", turns: [] });
    expect(absent.captionSource).toBe("none");
    expect(absent.captionTranscript.timing).toBe("block");
    for (const state of ["idle", "running", "failed"] as const) {
      expect(buildTranscriptBoundary(undefined, block, { ...view, state }).captionSource).toBe("none");
    }
  });

  test("discloses partial timed text and refuses missing text or invalid cue intervals", () => {
    const view = { state: "review" as const, turns: [
      { start: 1, end: 2, speaker: "S01", text: "Fala utilizável" },
      { start: 2, end: 3, speaker: "S02" },
      { start: 4, end: 4, text: "Sem duração" },
      { start: NaN, end: 6, text: "Horário inválido" }
    ] };
    const boundary = buildTranscriptBoundary(undefined, parsePlayerTranscript(null), view);
    expect(boundary.captionSource).toBe("diarization");
    expect(boundary.captionPartial).toBe(true);
    expect(boundary.captionTranscript.segments).toEqual([{ start: 1, end: 2, speaker: "S01", text: "Fala utilizável" }]);
    expect(buildTranscriptBoundary(undefined, parsePlayerTranscript(null), { state: "review", turns: view.turns.slice(1) }).captionSource).toBe("none");
  });

  test("keeps each diarizer utterance with its own speaker and timestamp; never replaces canonical text", () => {
    const sidecar = validateDiarizationResult(result()); const before = JSON.stringify(sidecar);
    const view = buildDiarizationView(sidecar);
    expect(view.state).toBe("review");
    expect(view.turns).toEqual([
      { start: 1, end: 3, speaker: "S01", label: "Pessoa A", text: "Primeira fala sintética." },
      { start: 2, end: 4, speaker: "S02", label: "Pessoa B", text: "Resposta sintética simultânea." }
    ]);
    expect(view.textCoverage?.shownTurns).toBe(2);
    const canonical: Transcript = { version: 1, provider: "openai", model: "test", language: "pt",
      text: "Texto canônico diferente.", segments: [{ start: 0, end: 5, text: "Texto canônico diferente." }] };
    expect(buildTranscriptBoundary(canonical, parsePlayerTranscript(canonical), view).transcript.text).toBe(canonical.text);
    expect(JSON.stringify(sidecar)).toBe(before);
  });

  test("shows disclosure for large text payloads and keeps all timing/labels and stored source", () => {
    const long = "<test>\\\"".repeat(1250);
    const sidecar = validateDiarizationResult(result(Array.from({ length: 80 }, (_, i) => ({ start: i, end: i + 1, speaker: "S01", text: long }))));
    const before = JSON.stringify(sidecar); const view = buildDiarizationView(sidecar);
    expect(view.turns).toHaveLength(80);
    expect(view.textCoverage?.shownTurns).toBeLessThan(80);
    expect(view.textCoverage?.totalTurns).toBe(80);
    const added = (view.turns || []).reduce((sum, t) => sum + (t.text === undefined ? 0 : Buffer.byteLength(JSON.stringify(t.text)) + 8), 0);
    expect(added).toBeLessThanOrEqual(view.textCoverage!.maxBytes);
    expect(view.turns?.[79]?.start).toBe(79);
    expect(JSON.stringify(sidecar)).toBe(before);
  });
});

const qml = readFileSync(new URL("./Main.qml", import.meta.url), "utf8");
const body = qml.match(/function captionTextAt\(seconds\)\s*\{([\s\S]*?)\n    \}/)?.[1];
if (!body) throw new Error("Actual QML caption function absent");
const captionTextAt = new Function("captionTrack", "seconds", body) as (track: unknown, seconds: number) => string;
describe("actual QML simultaneous captions", () => {
  const track = { timing: "segment", segments: [
    { start: 1, end: 3, text: "Sintético A", speaker: "S01" },
    { start: 2, end: 4, text: "Sintético B", speaker: "S02" }
  ] };
  test("displays both overlapping cues with existing speaker IDs", () => {
    expect(captionTextAt(track, 2.5)).toBe("S01: Sintético A\nS02: Sintético B");
  });
  test("does not leak expired/future captions at boundaries or through empty tracks", () => {
    expect(captionTextAt(track, 0)).toBe("");
    expect(captionTextAt(track, 1)).toBe("S01: Sintético A");
    expect(captionTextAt(track, 3)).toBe("S02: Sintético B");
    expect(captionTextAt(track, 4)).toBe("");
    expect(captionTextAt({}, 2)).toBe("");
  });
  test("switching track at the same playhead position does not reuse old utterances", () => {
    const other = { timing: "segment", segments: [{ start: 2, end: 4, text: "Outra gravação sintética" }] };
    expect(captionTextAt(other, 2.5)).toBe("Outra gravação sintética");
    expect(captionTextAt({}, 2.5)).toBe("");
  });
  test("does not turn approximate blocks or unclassified intervals into caption text", () => {
    const segments = [{ start: 0, end: 600, text: "Bloco sem alinhamento acústico" }];
    for (const timing of ["block", "none", undefined]) {
      expect(captionTextAt({ timing, segments }, 2.5)).toBe("");
    }
  });
});
