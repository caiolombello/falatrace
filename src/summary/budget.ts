import type { AppConfig, SummaryProvider } from "../config/defaults";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "./schema";

/** Upper bound for a single summary request payload, whatever the model. */
export const MAX_SUMMARY_INPUT_CHARACTERS = 2_000_000;
/** Explicit per-request output cap; leaves room for reasoning tokens on reasoning models. */
export const OPENAI_SUMMARY_OUTPUT_TOKENS = 16_384;

export type SummaryInputUnit = "characters" | "utf8-bytes";
export type SummaryInputLimit = { max: number; unit: SummaryInputUnit };

// Context windows from the official model pages (developers.openai.com, checked 2026-10-05).
// Unknown models assume 128k tokens, the smallest window among OpenAI chat models with
// structured outputs, so a user's model choice never needs a code change to stay in bounds.
const OPENAI_CONTEXT_TOKENS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^gpt-6([.-]|$)/, 1_050_000],
  [/^gpt-4\.1(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/, 1_047_576],
  [/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/, 400_000]
];
const DEFAULT_OPENAI_CONTEXT_TOKENS = 128_000;
// Byte-level BPE tokens each cover at least one UTF-8 byte, so a payload's byte length
// bounds its token count for any language. The fixed prompt and schema are reserved the
// same way, plus slack for message framing.
const PROMPT_RESERVE_TOKENS = Buffer.byteLength(SUMMARY_SYSTEM_PROMPT, "utf8") +
  Buffer.byteLength(JSON.stringify(SUMMARY_JSON_SCHEMA), "utf8") + 1_024;

/** An OpenAI summary cannot be split without an explicit paid-budget policy, so its
 * input limit follows the chosen model's context window, measured in UTF-8 bytes so a
 * single request can never exceed it. Local Ollama keeps the configured character
 * budget because its usable context depends on the local runtime. */
export const summaryInputLimit = (config: AppConfig, provider: SummaryProvider, model: string): SummaryInputLimit => {
  if (provider !== "openai") return { max: config.summary.maxInputCharacters, unit: "characters" };
  const contextTokens = OPENAI_CONTEXT_TOKENS.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_OPENAI_CONTEXT_TOKENS;
  return { max: Math.min(MAX_SUMMARY_INPUT_CHARACTERS, contextTokens - OPENAI_SUMMARY_OUTPUT_TOKENS - PROMPT_RESERVE_TOKENS), unit: "utf8-bytes" };
};

/** Size of a summary payload in the unit its limit is expressed in. */
export const summaryInputSize = (content: string, unit: SummaryInputUnit): number =>
  unit === "utf8-bytes" ? Buffer.byteLength(content, "utf8") : content.length;
