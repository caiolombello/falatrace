import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { Transcript } from "../../jobs/types";
import { MAX_SUMMARY_INPUT_CHARACTERS, summaryInputLimit } from "../budget";
import { buildSummaryUserContent } from "../context";
import { planSummaryChunks, summarizeInChunks } from "../chunks";
import { summarizeWithOpenAI } from "../openai";

// About 56 minutes of speech: over the 24k default budget once evidence is included.
const transcript: Transcript = { version: 1, provider: "openai", model: "synthetic", language: "pt", text: "",
  segments: Array.from({ length: 6 }, (_, i) => ({ start: i * 560, end: (i + 1) * 560, text: `Bloco ${i} revisar proposta sintética. `.repeat(110) })) };
const completion = (content: string | null, finishReason = "stop") => Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: "fixture",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content, refusal: null } }] });
const summaryJson = JSON.stringify({ title: "Revisão", overview: "Resumo sintético.", topics: [], decisions: [], actionItems: [], citations: [], limitations: [] });
const withFetch = async (stub: (body: Record<string, unknown>) => Response, run: () => Promise<void>) => {
  const original = fetch;
  globalThis.fetch = (async (_url: URL | RequestInfo, init?: RequestInit) => stub(JSON.parse(String(init?.body)))) as unknown as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
};

test("OpenAI limit follows the chosen model in UTF-8 bytes; unknown models assume a 128k window; Ollama keeps its configured budget", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  expect(summaryInputLimit(config, "ollama", "qwen3.5:9b")).toEqual({ max: 24_000, unit: "characters" });
  const small = summaryInputLimit(config, "openai", "gpt-4o-mini");
  expect(summaryInputLimit(config, "openai", "future-unknown-model")).toEqual(small);
  // Each token covers at least one byte, so the limit stays under the window minus the output cap.
  expect(small.unit).toBe("utf8-bytes");
  expect(small.max).toBeLessThan(128_000 - 16_384);
  expect(small.max).toBeGreaterThan(90_000);
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna-2026-09-01"]) {
    const large = summaryInputLimit(config, "openai", model);
    expect(large.unit).toBe("utf8-bytes");
    expect(large.max).toBeLessThan(1_050_000 - 16_384);
    expect(large.max).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARACTERS);
  }
  // Verified long-context windows; near-miss IDs (e.g. chat aliases) keep the safe default.
  const window = (model: string) => summaryInputLimit(config, "openai", model).max - small.max + 128_000;
  for (const model of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.1-2025-04-14"]) expect(window(model)).toBe(1_047_576);
  for (const model of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-mini-2025-08-07"]) expect(window(model)).toBe(400_000);
  for (const model of ["gpt-5-chat-latest", "gpt-4.10", "gpt-50"]) expect(summaryInputLimit(config, "openai", model)).toEqual(small);
  config.summary.maxInputCharacters = 4096;
  expect(summaryInputLimit(config, "openai", "gpt-4o-mini")).toEqual(small);
  expect(summaryInputLimit(config, "ollama", "qwen3.5:9b")).toEqual({ max: 4096, unit: "characters" });
});

test("token-dense text is measured in bytes, so a payload under the character count cannot exceed the window", () => {
  const limit = summaryInputLimit(structuredClone(DEFAULT_CONFIG), "openai", "gpt-4o-mini");
  const dense = "会议记录".repeat(10_000);
  expect(dense.length).toBeLessThan(limit.max);
  expect(() => buildSummaryUserContent(dense, undefined, undefined, limit.max, limit.unit)).toThrow("budget");
  expect(buildSummaryUserContent(dense, undefined, undefined, limit.max, "characters").length).toBeGreaterThan(0);
});

test("a meeting over the configured budget is one OpenAI request instead of a refused paid split", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const mediaHash = "a".repeat(64);
  expect(planSummaryChunks(transcript, mediaHash, undefined, config.summary.maxInputCharacters).length).toBeGreaterThan(1);
  const root = await fs.mkdtemp(join(tmpdir(), "summary-budget-"));
  let calls = 0;
  try {
    const limit = summaryInputLimit(config, "openai", "gpt-4o-mini");
    const options = { transcript, mediaHash, maxCharacters: limit.max, inputUnit: limit.unit, provider: "openai" as const, model: "gpt-4o-mini",
      adapterIdentity: "fixture", cacheDir: root, adapter: async () => { calls++; return { version: 1 as const, provider: "openai" as const, model: "gpt-4o-mini", title: "Revisão", overview: "Resumo.", topics: [], decisions: [], actionItems: [] }; } };
    await summarizeInChunks(options);
    expect(calls).toBe(1);
    await expect(summarizeInChunks({ ...options, maxCharacters: config.summary.maxInputCharacters, inputUnit: "characters" as const, cacheDir: join(root, "small") })).rejects.toThrow("paid-budget");
    expect(calls).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("OpenAI adapter accepts model-sized input and rejects a truncated reply without parsing it", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.openai.apiKey = "synthetic-not-a-real-key";
  const text = "Revisar proposta sintética. ".repeat(1500);
  expect(text.length).toBeGreaterThan(config.summary.maxInputCharacters);
  let model = "";
  await withFetch(body => { model = String(body.model); return completion(summaryJson); }, async () => {
    expect((await summarizeWithOpenAI(config, text, "gpt-6-luna")).title).toBe("Revisão");
  });
  expect(model).toBe("gpt-6-luna");
  await withFetch(() => completion(summaryJson.slice(0, 20), "length"), async () => {
    await expect(summarizeWithOpenAI(config, "Fixture.", "gpt-6-luna")).rejects.toThrow("output token limit");
  });
});

test("a checkpoint saved under the earlier character budget is reused instead of paying again", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const short: Transcript = { ...transcript, segments: transcript.segments.slice(0, 1).map(segment => ({ ...segment, text: "Revisar proposta sintética." })) };
  const root = await fs.mkdtemp(join(tmpdir(), "summary-legacy-"));
  let calls = 0;
  const adapter = async () => { calls++; return { version: 1 as const, provider: "openai" as const, model: "gpt-4o-mini", title: "Revisão", overview: "Resumo.", topics: [], decisions: [], actionItems: [] }; };
  const base = { transcript: short, mediaHash: "a".repeat(64), provider: "openai" as const, model: "gpt-4o-mini", adapterIdentity: "openai-chat", cacheDir: root, adapter };
  try {
    await summarizeInChunks({ ...base, maxCharacters: config.summary.maxInputCharacters });
    expect(calls).toBe(1);
    const limit = summaryInputLimit(config, "openai", "gpt-4o-mini");
    await summarizeInChunks({ ...base, maxCharacters: limit.max, inputUnit: limit.unit, legacyMaxCharacters: config.summary.maxInputCharacters });
    expect(calls).toBe(1);
    await summarizeInChunks({ ...base, maxCharacters: limit.max, inputUnit: limit.unit });
    expect(calls).toBe(2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
