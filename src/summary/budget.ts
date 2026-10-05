import type { AppConfig, SummaryProvider } from "../config/defaults";

/** Upper bound for a single summary request payload, whatever the model. */
export const MAX_SUMMARY_INPUT_CHARACTERS = 2_000_000;
/** Explicit per-request output cap; leaves room for reasoning tokens on reasoning models. */
export const OPENAI_SUMMARY_OUTPUT_TOKENS = 16_384;

// Context windows from the official model pages (developers.openai.com, checked 2026-10-05).
// Unknown models assume 128k tokens, the smallest window among OpenAI chat models with
// structured outputs, so a user's model choice never needs a code change to stay in bounds.
const OPENAI_CONTEXT_TOKENS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^gpt-6([.-]|$)/, 1_050_000]
];
const DEFAULT_OPENAI_CONTEXT_TOKENS = 128_000;
const PROMPT_RESERVE_TOKENS = 4_000;
// Conservative: Portuguese text runs about four characters per token; JSON evidence is denser.
const CHARACTERS_PER_TOKEN = 2;

/** An OpenAI summary cannot be split without an explicit paid-budget policy, so its
 * input budget follows the chosen model's context window. A smaller configured value
 * could only make the request fail. Local Ollama keeps the configured budget because
 * its usable context depends on the local runtime. */
export const summaryInputBudget = (config: AppConfig, provider: SummaryProvider, model: string): number => {
  const configured = config.summary.maxInputCharacters;
  if (provider !== "openai") return configured;
  const contextTokens = OPENAI_CONTEXT_TOKENS.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_OPENAI_CONTEXT_TOKENS;
  const modelBudget = (contextTokens - OPENAI_SUMMARY_OUTPUT_TOKENS - PROMPT_RESERVE_TOKENS) * CHARACTERS_PER_TOKEN;
  return Math.min(MAX_SUMMARY_INPUT_CHARACTERS, Math.max(configured, modelBudget));
};
