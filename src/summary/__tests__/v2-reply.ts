// Test helper for fake summary servers: answers a v2 request with v2 JSON and a legacy
// request with the legacy fields, so one fake serves both prompts.

type SchemaCarrier = { format?: unknown; response_format?: { json_schema?: { schema?: unknown } } };

const enumOf = (schema: unknown): string[] => {
  const templateId = (schema as { properties?: { templateId?: { enum?: unknown } } } | undefined)?.properties?.templateId;
  return Array.isArray(templateId?.enum) ? templateId.enum.filter((id): id is string => typeof id === "string") : [];
};

/** Template ids a request offers (Ollama `format` or OpenAI `json_schema`); empty for the legacy prompt. */
export const offeredTemplates = (body: unknown): string[] => {
  const carrier = (body || {}) as SchemaCarrier;
  return enumOf(carrier.format).length ? enumOf(carrier.format) : enumOf(carrier.response_format?.json_schema?.schema);
};

/** The notes a v2 request sent (from the user message). */
export const sentNotes = (body: unknown): Array<{ id: string; text: string; at: string | null; nearSegmentIds: string[] }> => {
  const messages = (body as { messages?: Array<{ role: string; content: string }> })?.messages || [];
  const user = messages.find((message) => message.role === "user");
  return user ? JSON.parse(user.content).notes || [] : [];
};

/** A model answer that fits the request: for v2, the first offered template, no sections, empty
 * citations and limitations around the given fields; for the legacy prompt, the fields as given. */
export const fakeSummaryAnswer = (body: unknown, fields: Record<string, unknown>): Record<string, unknown> => {
  const offered = offeredTemplates(body);
  if (!offered.length) return fields;
  return { templateId: offered[0], sections: [], citations: [], limitations: [], ...fields };
};
