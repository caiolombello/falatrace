import { createHash } from "node:crypto";
import type { AssistantProvider } from "../config/defaults";

/**
 * Contracts shared by the assistant (questions, chat, recipes): providers, destinations
 * and citations. Providers only move text; retrieval, consent and citation checks live
 * in the runner, so every provider is held to the same rules.
 */

export type ChatRole = "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

/** Where a question goes. Never carries a secret: endpoint is a URL or a command name. */
export type ProviderDestination = {
  kind: AssistantProvider;
  /** Stable id: "ollama", "openrouter", "anthropic", "acp:codex", "cli:claude", "chatgpt"… */
  id: string;
  /** Human label, e.g. "OpenRouter · deepseek/deepseek-v4.1-flash". */
  label: string;
  /** URL of the API or the command started (no arguments that hold data). */
  endpoint: string;
  /** Model asked for; empty when the agent or tool picks its own. */
  model: string;
  /** True when the question and excerpts leave this computer. */
  external: boolean;
  /** Plan whose limits the request uses, when it is a subscription (ChatGPT Plus/Pro, Claude, Gemini…). */
  subscription?: string;
};

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Called with each new piece of text, in order. */
  onDelta?: (text: string) => void;
  maxOutputTokens?: number;
};

export type ChatStopReason = "end" | "length" | "refusal" | "cancelled";

export type ChatResult = {
  text: string;
  stopReason: ChatStopReason;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type ProviderProblem = "missing-key" | "missing-binary" | "signed-out" | "unreachable" | "unsupported" | "misconfigured";

export type ProviderReadiness = { ready: true } | { ready: false; problem: ProviderProblem; message: string };

export interface ChatProvider {
  readonly destination: ProviderDestination;
  /** Readiness without sending meeting content: key present, binary found, signed in. */
  check(signal?: AbortSignal): Promise<ProviderReadiness>;
  run(request: ChatRequest): Promise<ChatResult>;
}

export type ProviderErrorCode = "auth" | "rate-limit" | "unavailable" | "bad-request" | "refusal" | "cancelled" | "timeout" | "protocol";

/** A provider failure with a Portuguese message that is safe to show as it is. */
export class ProviderError extends Error {
  constructor(message: string, readonly code: ProviderErrorCode) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Binds consent to the destination: a different provider, endpoint or model asks again. */
export const destinationKey = (destination: ProviderDestination): string =>
  createHash("sha256")
    .update(JSON.stringify(["falatrace:assistant:destination:v1", destination.kind, destination.id, destination.endpoint, destination.model]))
    .digest("hex");

/** Where a question looks: one meeting, the whole library, or the meetings of a person or client. */
export type AssistantScope =
  | { kind: "meeting"; jobId: string }
  | { kind: "library" }
  | { kind: "person"; personId: string }
  | { kind: "client"; clientCode: string };

/** A checked citation: the segment exists in what was sent and points to a moment of a recording. */
export type ChatCitation = {
  /** Marker as written in the answer, e.g. "m2:s000123" or "s000123". */
  ref: string;
  jobId: string;
  segmentId: string;
  start?: number;
  end?: number;
  title: string;
};

export type ChatAnswer = {
  text: string;
  citations: ChatCitation[];
  /** Markers the model wrote that did not match anything sent; removed from text. */
  droppedRefs: string[];
};
