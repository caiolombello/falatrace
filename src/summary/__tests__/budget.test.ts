import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { Transcript } from "../../jobs/types";
import { MAX_SUMMARY_INPUT_CHARACTERS, summaryInputBudget } from "../budget";
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

test("OpenAI budget follows the chosen model; unknown models assume a 128k window; Ollama keeps its configured budget", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  expect(summaryInputBudget(config, "ollama", "qwen3.5:9b")).toBe(24_000);
  for (const model of ["gpt-4o-mini", "future-unknown-model"]) expect(summaryInputBudget(config, "openai", model)).toBe(215_232);
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna-2026-09-01"]) expect(summaryInputBudget(config, "openai", model)).toBe(MAX_SUMMARY_INPUT_CHARACTERS);
  config.summary.maxInputCharacters = 4096;
  expect(summaryInputBudget(config, "openai", "gpt-4o-mini")).toBe(215_232);
  expect(summaryInputBudget(config, "ollama", "qwen3.5:9b")).toBe(4096);
});

test("a meeting over the configured budget is one OpenAI request instead of a refused paid split", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const mediaHash = "a".repeat(64);
  expect(planSummaryChunks(transcript, mediaHash, undefined, config.summary.maxInputCharacters).length).toBeGreaterThan(1);
  const root = await fs.mkdtemp(join(tmpdir(), "summary-budget-"));
  let calls = 0;
  try {
    const options = { transcript, mediaHash, maxCharacters: summaryInputBudget(config, "openai", "gpt-4o-mini"), provider: "openai" as const, model: "gpt-4o-mini",
      adapterIdentity: "fixture", cacheDir: root, adapter: async () => { calls++; return { version: 1 as const, provider: "openai" as const, model: "gpt-4o-mini", title: "Revisão", overview: "Resumo.", topics: [], decisions: [], actionItems: [] }; } };
    await summarizeInChunks(options);
    expect(calls).toBe(1);
    await expect(summarizeInChunks({ ...options, maxCharacters: config.summary.maxInputCharacters, cacheDir: join(root, "small") })).rejects.toThrow("paid-budget");
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
