import type { AppConfig } from "../config/defaults";
import {
  validateSummary,
  type RecordingSummary,
  type SummaryContext
} from "../jobs/types";
import {
  buildSummaryUserContent,
  canonicalizeSummary
} from "./context";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "./schema";
import type { SummaryInputEvidence } from "./evidence";

const validateOllamaUrl = (value: string): URL => {
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Ollama URL must use HTTPS or an HTTP loopback address");
  }
  return url;
};

export const summarizeWithOllama = async (
  config: AppConfig,
  transcript: string,
  model: string,
  context?: SummaryContext,
  evidence?: SummaryInputEvidence,
  signal?: AbortSignal
): Promise<RecordingSummary> => {
  signal?.throwIfAborted();
  const userContent = buildSummaryUserContent(transcript, context, evidence, config.summary.maxInputCharacters);
  const url = new URL("/api/chat", validateOllamaUrl(config.summary.ollamaUrl));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: SUMMARY_JSON_SCHEMA,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ],
      options: { temperature: 0.2 }
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) : AbortSignal.timeout(30 * 60 * 1000)
  });
  if (!response.ok) {
    throw new Error(`Ollama request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { message?: { content?: unknown } };
  if (typeof body.message?.content !== "string") {
    throw new Error("Ollama summary response was invalid");
  }
  return canonicalizeSummary(
    validateSummary(JSON.parse(body.message.content), "ollama", model),
    context,
    "ollama",
    model
  );
};
