import OpenAI from "openai";
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
import { OPENAI_SUMMARY_OUTPUT_TOKENS, summaryInputLimit } from "./budget";
import type { SummaryInputEvidence } from "./evidence";

export const summarizeWithOpenAI = async (
  config: AppConfig,
  transcript: string,
  model: string,
  context?: SummaryContext,
  evidence?: SummaryInputEvidence,
  signal?: AbortSignal
): Promise<RecordingSummary> => {
  signal?.throwIfAborted();
  const limit = summaryInputLimit(config, "openai", model);
  const userContent = buildSummaryUserContent(transcript, context, evidence, limit.max, limit.unit);
  const apiKey = process.env.OPENAI_API_KEY || config.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 });
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: OPENAI_SUMMARY_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "recording_summary",
        strict: true,
        schema: SUMMARY_JSON_SCHEMA
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
  return canonicalizeSummary(
    validateSummary(JSON.parse(content), "openai", model),
    context,
    "openai",
    model
  );
};
