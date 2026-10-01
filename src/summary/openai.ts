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
  const userContent = buildSummaryUserContent(transcript, context, evidence, config.summary.maxInputCharacters);
  const apiKey = process.env.OPENAI_API_KEY || config.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 });
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: 4096,
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
  const content = response.choices[0]?.message.content;
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
