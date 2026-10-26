import type { BetaMessageParam, BetaMessageStreamParams, BetaOutputConfig } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AppConfig } from "../../config/defaults";
import { readSecret, type SecretName } from "../../config/secrets";
import { type ChatProvider, type ChatRequest, type ChatResult, type ChatStopReason, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import { COMMON_PROVIDER_MESSAGES, Deadline, MAX_ANSWER_CHARACTERS, type ProviderTimeouts, type ReadSecretFn, throwIfCancelled, validateChatRequest } from "./common";
import { missingKeyMessage } from "./openai-compatible";

// Claude API through the official SDK. Current models reject temperature/top_p/top_k and
// prefill, think adaptively when `thinking` is omitted, and take depth from output_config.effort.

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Server-side retry on a substitute model when the requested one declines; pairs only with fallbacks: "default". */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const KEY_NAME: SecretName = "ANTHROPIC_API_KEY";
/** Chat answers are short: 8000 output tokens leave room for adaptive thinking and bound cost. */
const DEFAULT_MAX_TOKENS = 8_000;
const MAX_TOKENS_CAP = 64_000;
const DEFAULT_TIMEOUTS = { totalMs: 5 * 60_000, idleMs: 120_000, checkMs: 5_000 };

export const ANTHROPIC_MESSAGES = {
  auth: "A Anthropic recusou a chave. Confira ANTHROPIC_API_KEY em Configurações › Chaves de API.",
  forbidden: "A chave da Anthropic não tem permissão para este modelo.",
  rateLimit: "A Anthropic recusou por limite de uso. Tente mais tarde.",
  notFound: "A Anthropic não encontrou o modelo escolhido. Confira o nome do modelo.",
  badRequest: "A Anthropic recusou o pedido. Confira o modelo e o tamanho do contexto.",
  unavailable: "A Anthropic está indisponível no momento. Tente de novo em alguns minutos.",
  unreachable: "Não foi possível falar com a Anthropic. Confira a conexão.",
  incomplete: "A resposta do Claude veio incompleta. Tente de novo."
} as const;

export const ANTHROPIC_KNOWN_ERRORS: string[] = [...Object.values(ANTHROPIC_MESSAGES), missingKeyMessage(KEY_NAME)];

export type AnthropicEffort = NonNullable<BetaOutputConfig["effort"]>;

/** The SDK class; loaded with the first request so importing this provider (Studio bridge, CLI) stays fast. */
type AnthropicSdk = typeof import("@anthropic-ai/sdk").default;
let anthropicSdk: Promise<AnthropicSdk> | undefined;
const loadAnthropicSdk = (): Promise<AnthropicSdk> => {
  anthropicSdk ??= import("@anthropic-ai/sdk").then((module) => module.default);
  return anthropicSdk;
};

export type AnthropicDeps = {
  fetch?: typeof fetch;
  readSecret?: ReadSecretFn;
  timeouts?: ProviderTimeouts;
  /** Thinking depth; "low" suits chat questions. */
  effort?: AnthropicEffort;
};

/**
 * Typed SDK errors, most specific first. Connection and abort errors extend APIError in this SDK, so they come before it.
 * `Anthropic` is the loaded SDK; without it (it failed to load) nothing can be an SDK error.
 */
export const mapAnthropicError = (error: unknown, Anthropic?: AnthropicSdk): ProviderError => {
  if (error instanceof ProviderError) return error;
  if (!Anthropic) return new ProviderError(ANTHROPIC_MESSAGES.unavailable, "unavailable");
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError(COMMON_PROVIDER_MESSAGES.timeout, "timeout");
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError(ANTHROPIC_MESSAGES.unreachable, "unavailable");
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError(ANTHROPIC_MESSAGES.auth, "auth");
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError(ANTHROPIC_MESSAGES.forbidden, "auth");
  if (error instanceof Anthropic.RateLimitError) return new ProviderError(ANTHROPIC_MESSAGES.rateLimit, "rate-limit");
  if (error instanceof Anthropic.NotFoundError) return new ProviderError(ANTHROPIC_MESSAGES.notFound, "bad-request");
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) return new ProviderError(ANTHROPIC_MESSAGES.badRequest, "bad-request");
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    if (status >= 400 && status < 500 && status !== 408 && status !== 409) return new ProviderError(ANTHROPIC_MESSAGES.badRequest, "bad-request");
    return new ProviderError(ANTHROPIC_MESSAGES.unavailable, "unavailable");
  }
  return new ProviderError(ANTHROPIC_MESSAGES.unavailable, "unavailable");
};

const stopReasonOf = (value: string | null | undefined): ChatStopReason => {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "refusal";
    default:
      // tool_use, pause_turn and compaction never apply to a tool-less chat turn.
      throw new ProviderError(ANTHROPIC_MESSAGES.incomplete, "protocol");
  }
};

export const createAnthropicProvider = (config: AppConfig, deps: AnthropicDeps = {}): ChatProvider => {
  const readKey = deps.readSecret ?? ((name: SecretName) => readSecret(name));
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const model = config.assistant.apiModel || ANTHROPIC_DEFAULT_MODEL;
  const destination: ProviderDestination = {
    kind: "api",
    id: "anthropic",
    label: `Anthropic · ${model}`,
    endpoint: `${ANTHROPIC_BASE_URL}/v1/messages`,
    model,
    external: true
  };

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    if (!(await readKey(KEY_NAME))) return { ready: false, problem: "missing-key", message: missingKeyMessage(KEY_NAME) };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    const apiKey = await readKey(KEY_NAME);
    if (!apiKey) throw new ProviderError(missingKeyMessage(KEY_NAME), "auth");
    const deadline = new Deadline(request.signal, { totalMs: timeouts.totalMs, idleMs: timeouts.idleMs });
    let Anthropic: AnthropicSdk | undefined;
    try {
      Anthropic = await loadAnthropicSdk();
      // Explicit key and base URL: ANTHROPIC_BASE_URL/AUTH_TOKEN from the environment must not redirect the request.
      // Logging off: ANTHROPIC_LOG=debug would print the request (meeting text) to stdout, where the Studio bridge talks.
      const client = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, timeout: timeouts.totalMs, logLevel: "off", ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      // Empty turns are refused by the API; the last turn is the question (checked above).
      const messages: BetaMessageParam[] = request.messages.filter((message) => message.content.trim()).map((message) => ({ role: message.role, content: message.content }));
      const params: BetaMessageStreamParams = {
        model,
        max_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP),
        messages,
        ...(request.system.trim() ? { system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }] } : {}),
        output_config: { effort: deps.effort ?? "low" },
        betas: [ANTHROPIC_FALLBACK_BETA],
        fallbacks: "default"
      };
      const stream = client.beta.messages.stream(params, { signal: deadline.signal });
      let text = "";
      let overflow = false;
      for await (const event of stream) {
        deadline.touch();
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const piece = event.delta.text;
          if (!piece) continue;
          if (text.length + piece.length > MAX_ANSWER_CHARACTERS) {
            overflow = true;
            stream.abort();
            break;
          }
          text += piece;
          request.onDelta?.(piece);
        }
      }
      deadline.throwIfFired();
      if (overflow) return { text, stopReason: "length" };
      const message = await stream.finalMessage();
      const stopReason = stopReasonOf(message.stop_reason);
      return { text, stopReason, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
    } catch (error) {
      throw deadline.failure() ?? mapAnthropicError(error, Anthropic);
    } finally {
      deadline.dispose();
    }
  };

  return { destination, check, run };
};
