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
import { OPENAI_SUMMARY_OUTPUT_TOKENS, summaryInputLimit } from "./budget";
import type { SummaryInputEvidence } from "./evidence";
import { readSecret } from "../config/secrets";
import { LEGACY_SUMMARY_SPEC, summarySchemaName } from "./prompt";
import { summaryFromV2Response, type SummaryChunkRequest } from "./v2";

export const summarizeWithOpenAI = async (
  config: AppConfig,
  transcript: string,
  model: string,
  context?: SummaryContext,
  evidence?: SummaryInputEvidence,
  signal?: AbortSignal,
  /** v2 request (template spec, language, notes); the legacy prompt without it. */
  request?: SummaryChunkRequest
): Promise<RecordingSummary> => {
  signal?.throwIfAborted();
  const spec = request?.spec ?? LEGACY_SUMMARY_SPEC;
  const limit = summaryInputLimit(config, "openai", model, request?.spec);
  const userContent = buildSummaryUserContent(transcript, context, evidence, limit.max, limit.unit,
    request?.spec.notesIncluded ? request.notes : undefined);
  const apiKey = (await readSecret("OPENAI_API_KEY")) || config.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  // The SDK loads with the first OpenAI summary, so the Studio bridge and the CLI start without it.
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 });
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: OPENAI_SUMMARY_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: spec.system },
      { role: "user", content: userContent }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: summarySchemaName(spec),
        strict: true,
        schema: spec.schema as Record<string, unknown>
      }
    }
  }, { signal });
  const choice = response.choices[0];
  // Reasoning tokens share the output cap; a truncated reply is never partial JSON to parse.
  if (choice?.finish_reason === "length") {
    throw new Error("OpenAI summary reached the output token limit before completing");
  }
  const content = choice?.message.content;
  if (!content) {
    throw new Error("OpenAI summary response was empty");
  }
  const parsed: unknown = JSON.parse(content);
  return canonicalizeSummary(
    request ? summaryFromV2Response(parsed, request, evidence, "openai", model) : validateSummary(parsed, "openai", model),
    context,
    "openai",
    model
  );
};
