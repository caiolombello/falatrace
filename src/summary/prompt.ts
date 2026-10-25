import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "./schema";

/** System prompt and JSON schema of one summary request. Version 1 is the legacy Portuguese
 * prompt (stored reviewed plans and checkpoints hash it); version 2 specs come from spec.ts. */
export type SummaryPromptSpec = {
  id: string;
  version: 1 | 2;
  system: string;
  schema: Readonly<Record<string, unknown>>;
};

export const LEGACY_SUMMARY_SPEC_ID = "v1:legacy";

export const LEGACY_SUMMARY_SPEC: SummaryPromptSpec = Object.freeze({
  id: LEGACY_SUMMARY_SPEC_ID,
  version: 1,
  system: SUMMARY_SYSTEM_PROMPT,
  schema: SUMMARY_JSON_SCHEMA
});

/** Name of the OpenAI structured-output schema for each prompt version. */
export const summarySchemaName = (spec: SummaryPromptSpec): string =>
  spec.version === 2 ? "recording_summary_v2" : "recording_summary";
