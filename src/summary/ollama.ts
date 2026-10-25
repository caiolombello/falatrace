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
import type { SummaryInputEvidence } from "./evidence";
import { LEGACY_SUMMARY_SPEC } from "./prompt";
import { summaryFromV2Response, type SummaryChunkRequest } from "./v2";

export const validateOllamaUrl = (value: string): URL => {
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
  signal?: AbortSignal,
  /** v2 request (template spec, language, notes of this part); the legacy prompt without it. */
  request?: SummaryChunkRequest
): Promise<RecordingSummary> => {
  signal?.throwIfAborted();
  const spec = request?.spec ?? LEGACY_SUMMARY_SPEC;
  const userContent = buildSummaryUserContent(transcript, context, evidence, config.summary.maxInputCharacters, "characters",
    request?.spec.notesIncluded ? request.notes : undefined);
  const url = new URL("/api/chat", validateOllamaUrl(config.summary.ollamaUrl));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    body: JSON.stringify({
      model,
      stream: false,
      format: spec.schema,
      messages: [
        { role: "system", content: spec.system },
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
  const parsed: unknown = JSON.parse(body.message.content);
  return canonicalizeSummary(
    request ? summaryFromV2Response(parsed, request, evidence, "ollama", model) : validateSummary(parsed, "ollama", model),
    context,
    "ollama",
    model
  );
};
