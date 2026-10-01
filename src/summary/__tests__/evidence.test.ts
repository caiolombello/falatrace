import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSummaryUserContent } from "../context";
import { attachSummarySupport, buildSummaryEvidence } from "../evidence";
import { validateSummary, type Transcript } from "../../jobs/types";
import { formatSummaryMarkdown } from "../../jobs/format";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { summarizeWithOllama } from "../ollama";

const transcript: Transcript = { version: 1, provider: "whisper-cpp", model: "synthetic", language: "pt", text: "Revisar antes de publicar.", segments: [{ start: 12, end: 18, text: "Revisar antes de publicar." }] };
const summary = () => validateSummary({ title: "Revisão do protótipo", overview: "Revisar antes de publicar.", topics: [], decisions: ["Revisar antes de publicar."], actionItems: [], citations: [
  { section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" },
  { section: "decision", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }
], limitations: [] }, "ollama", "synthetic");

test("summary input includes real source segment IDs, times and artifact hashes without fabricating word timing", () => {
  const evidence = buildSummaryEvidence(transcript, "a".repeat(64));
  const input = JSON.parse(buildSummaryUserContent(transcript.text, undefined, evidence));
  expect(input.evidence.segments).toEqual([{ id: "s000000", start: 12, end: 18, text: transcript.text }]);
  expect(evidence.transcriptSha256).toBe(createHash("sha256").update(JSON.stringify(transcript,null,2)).digest("hex"));
  expect(evidence.timingQuality).toBe("segment");
  expect(buildSummaryEvidence({ ...transcript, provider: "openai" }, "a".repeat(64)).timingQuality).toBe("approximate-block");
  expect(buildSummaryEvidence({ ...transcript, segments: [{ start: 0, end: 0, text: "unresolved" }] }, "a".repeat(64)).timingQuality).toBe("none");
});

test("valid references survive summary storage/formatting, while missing or uncertain claims require review", () => {
  const evidence = buildSummaryEvidence(transcript,"a".repeat(64));
  const supported = attachSummarySupport(summary(),evidence);
  expect(supported.support?.reviewRequired).toBe(false);
  expect(validateSummary(JSON.parse(JSON.stringify(supported)),"ollama","synthetic").support).toEqual(supported.support);
  expect(formatSummaryMarkdown(supported)).toContain("s000000 [0:12–0:18]");
  expect(attachSummarySupport({ ...summary(), citations: undefined }, evidence).support?.reviewRequired).toBe(true);
  expect(attachSummarySupport({ ...summary(), citations: [{ ...summary().citations![0], uncertainty: "uncertain" }] }, evidence).support?.reviewRequired).toBe(true);
});

test("invented segments and references to nonexistent claims are rejected before publication", () => {
  const bad = { ...summary(), citations: [{ ...summary().citations![0], segmentIds: ["s999999"] }] };
  expect(() => attachSummarySupport(bad,buildSummaryEvidence(transcript,"a".repeat(64)))).toThrow("does not exist");
  expect(() => validateSummary({ ...summary(), citations: [{ ...summary().citations![0], index: 9 }] },"ollama","synthetic")).toThrow("missing claim");
  expect(() => attachSummarySupport(summary(), buildSummaryEvidence({ ...transcript, segments: [{ start: 12, end: 18, text: " " }] },"a".repeat(64)))).toThrow("does not exist");
});

test("oversized input and cancelled summary invoke no provider", async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected provider"); }) as unknown as typeof fetch;
  try {
    await expect(summarizeWithOllama(DEFAULT_CONFIG,"x".repeat(24_001),"synthetic")).rejects.toThrow("budget");
    const abort = new AbortController(); abort.abort(new Error("fixture cancelled"));
    await expect(summarizeWithOllama(DEFAULT_CONFIG,transcript.text,"synthetic",undefined,undefined,abort.signal)).rejects.toThrow("cancelled");
    expect(requests).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("legacy summaries remain readable and oversized segment sets require explicit chunking", () => {
  expect(validateSummary({ title: "Legado", overview: "Sintético", topics: [], decisions: [], actionItems: [] },"ollama","synthetic").support).toBeUndefined();
  expect(() => buildSummaryEvidence({ ...transcript, segments: Array(1001).fill(transcript.segments[0]) },"a".repeat(64))).toThrow("chunking");
});
