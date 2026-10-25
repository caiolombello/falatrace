import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AppConfig, AssistantApiPreset } from "../../config/defaults";
import { readSecret, type SecretName } from "../../config/secrets";
import { type ChatProvider, type ChatRequest, type ChatResult, type ChatStopReason, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import {
  COMMON_PROVIDER_MESSAGES,
  Deadline,
  isLoopbackHost,
  MAX_ANSWER_CHARACTERS,
  type ProviderTimeouts,
  publicEndpoint,
  type ReadSecretFn,
  throwIfCancelled,
  validateChatRequest
} from "./common";

// API providers that speak OpenAI Chat Completions. One code path with a small profile per
// preset (base URL, key name, default model, attribution headers, token parameter).

export type OpenAiCompatiblePreset = Exclude<AssistantApiPreset, "anthropic">;

export type ApiPresetProfile = {
  label: string;
  /** Empty for "custom": the base URL comes from assistant.apiBaseUrl. */
  baseURL: string;
  keyName: SecretName;
  /** Empty for "custom": the model must be set. */
  defaultModel: string;
  headers?: Record<string, string>;
  /** OpenAI reasoning models refuse max_tokens; most compatible APIs only know max_tokens. */
  tokenParam: "max_completion_tokens" | "max_tokens";
  /** Ask for a usage chunk at the end of the stream (only where it is documented). */
  streamUsage: boolean;
};

export const API_PRESETS: Record<OpenAiCompatiblePreset, ApiPresetProfile> = {
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY", defaultModel: "gpt-6-luna", tokenParam: "max_completion_tokens", streamUsage: true },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyName: "OPENROUTER_API_KEY",
    defaultModel: "deepseek/deepseek-v4.1-flash-1017",
    headers: { "HTTP-Referer": "https://caiolombello.github.io/falatrace/", "X-OpenRouter-Title": "FalaTrace" },
    tokenParam: "max_tokens",
    streamUsage: true
  },
  gemini: { label: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", keyName: "GEMINI_API_KEY", defaultModel: "gemini-3.8-flash", tokenParam: "max_tokens", streamUsage: false },
  xai: { label: "xAI", baseURL: "https://api.x.ai/v1", keyName: "XAI_API_KEY", defaultModel: "grok-4.3", tokenParam: "max_tokens", streamUsage: false },
  groq: { label: "Groq", baseURL: "https://api.groq.com/openai/v1", keyName: "GROQ_API_KEY", defaultModel: "openai/gpt-oss-120b", tokenParam: "max_tokens", streamUsage: false },
  mistral: { label: "Mistral", baseURL: "https://api.mistral.ai/v1", keyName: "MISTRAL_API_KEY", defaultModel: "mistral-small-latest", tokenParam: "max_tokens", streamUsage: false },
  deepseek: { label: "DeepSeek", baseURL: "https://api.deepseek.com", keyName: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash", tokenParam: "max_tokens", streamUsage: false },
  together: { label: "Together AI", baseURL: "https://api.together.ai/v1", keyName: "TOGETHER_API_KEY", defaultModel: "openai/gpt-oss-120b", tokenParam: "max_tokens", streamUsage: false },
  custom: { label: "API compatível", baseURL: "", keyName: "CUSTOM_API_KEY", defaultModel: "", tokenParam: "max_tokens", streamUsage: false }
};

export const missingKeyMessage = (keyName: SecretName): string => `Configure a chave ${keyName} em Configurações › Chaves de API.`;

export const API_MESSAGES = {
  invalidBaseUrl: "O endereço da API compatível é inválido: use HTTPS (ou HTTP só neste computador), sem usuário, senha ou parâmetros.",
  modelRequired: "Informe o modelo da API compatível em Configurações › Assistente.",
  auth: "A API recusou a chave. Confira a chave em Configurações › Chaves de API.",
  forbidden: "A chave da API não tem permissão para este modelo.",
  rateLimit: "A API recusou por limite de uso ou falta de créditos. Tente mais tarde.",
  notFound: "A API não encontrou o modelo escolhido. Confira o nome do modelo.",
  badRequest: "A API recusou o pedido. Confira o modelo e o tamanho do contexto.",
  unavailable: "A API está indisponível no momento. Tente de novo em alguns minutos.",
  unreachable: "Não foi possível falar com a API. Confira a conexão."
} as const;

export const API_KNOWN_ERRORS: string[] = [...Object.values(API_MESSAGES), ...Object.values(API_PRESETS).map((preset) => missingKeyMessage(preset.keyName))];

export type OpenAiCompatibleDeps = { fetch?: typeof fetch; readSecret?: ReadSecretFn; timeouts?: ProviderTimeouts };

const DEFAULT_TIMEOUTS = { totalMs: 5 * 60_000, idleMs: 90_000, checkMs: 5_000 };
/** A local server (llama.cpp, LM Studio…) often needs no key; the SDK still wants one. */
const LOOPBACK_PLACEHOLDER_KEY = "falatrace-local-no-key";

/** The custom base URL, or undefined when it is not acceptable. */
export const parseCustomBaseUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
    return undefined;
  } catch {
    return undefined;
  }
};

const finishReason = (value: unknown): ChatStopReason | undefined => {
  if (value === "length") return "length";
  if (value === "content_filter") return "refusal";
  if (typeof value === "string" && value) return "end";
  return undefined;
};

/** Typed SDK errors to Portuguese messages; specific classes first (connection errors extend APIError). */
export const mapOpenAiError = (error: unknown): ProviderError => {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError(COMMON_PROVIDER_MESSAGES.timeout, "timeout");
  if (error instanceof OpenAI.APIConnectionError) return new ProviderError(API_MESSAGES.unreachable, "unavailable");
  if (error instanceof OpenAI.AuthenticationError) return new ProviderError(API_MESSAGES.auth, "auth");
  if (error instanceof OpenAI.PermissionDeniedError) return new ProviderError(API_MESSAGES.forbidden, "auth");
  if (error instanceof OpenAI.RateLimitError) return new ProviderError(API_MESSAGES.rateLimit, "rate-limit");
  if (error instanceof OpenAI.NotFoundError) return new ProviderError(API_MESSAGES.notFound, "bad-request");
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.UnprocessableEntityError) return new ProviderError(API_MESSAGES.badRequest, "bad-request");
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    if (status === 402) return new ProviderError(API_MESSAGES.rateLimit, "rate-limit");
    if (status >= 400 && status < 500) return new ProviderError(API_MESSAGES.badRequest, "bad-request");
    return new ProviderError(API_MESSAGES.unavailable, "unavailable");
  }
  return new ProviderError(API_MESSAGES.unavailable, "unavailable");
};

export const createOpenAiCompatibleProvider = (config: AppConfig, deps: OpenAiCompatibleDeps = {}): ChatProvider => {
  const presetName = (config.assistant.apiPreset === "anthropic" ? "custom" : config.assistant.apiPreset) as OpenAiCompatiblePreset;
  const preset = API_PRESETS[presetName];
  const readKey = deps.readSecret ?? ((name: SecretName) => readSecret(name));
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const base = presetName === "custom" ? parseCustomBaseUrl(config.assistant.apiBaseUrl) : new URL(preset.baseURL);
  const model = config.assistant.apiModel || preset.defaultModel;
  const local = presetName === "custom" && base !== undefined && isLoopbackHost(base.hostname);
  const destination: ProviderDestination = {
    kind: "api",
    id: presetName,
    label: model ? `${preset.label} · ${model}` : preset.label,
    endpoint: base ? publicEndpoint(base) : "",
    model,
    external: !local
  };

  const configurationProblem = (): string | undefined => {
    if (!base) return API_MESSAGES.invalidBaseUrl;
    if (!model) return API_MESSAGES.modelRequired;
    return undefined;
  };

  const resolveKey = async (): Promise<string | undefined> => {
    const key = await readKey(preset.keyName);
    if (key) return key;
    return local ? LOOPBACK_PLACEHOLDER_KEY : undefined;
  };

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    const problem = configurationProblem();
    if (problem) return { ready: false, problem: "misconfigured", message: problem };
    if (!(await resolveKey())) return { ready: false, problem: "missing-key", message: missingKeyMessage(preset.keyName) };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    const problem = configurationProblem();
    if (problem || !base) throw new ProviderError(problem ?? API_MESSAGES.invalidBaseUrl, "bad-request");
    const apiKey = await resolveKey();
    if (!apiKey) throw new ProviderError(missingKeyMessage(preset.keyName), "auth");
    const deadline = new Deadline(request.signal, { totalMs: timeouts.totalMs, idleMs: timeouts.idleMs });
    try {
      // Explicit nulls keep OPENAI_ORG_ID/PROJECT/BASE_URL from the environment out of other providers' requests.
      // Logging off: OPENAI_LOG=debug would print the request (meeting text) to stdout, where the Studio bridge talks.
      const client = new OpenAI({
        logLevel: "off",
        apiKey,
        baseURL: base.toString(),
        organization: null,
        project: null,
        adminAPIKey: null,
        webhookSecret: null,
        defaultHeaders: preset.headers,
        maxRetries: 0,
        timeout: timeouts.totalMs,
        ...(deps.fetch ? { fetch: deps.fetch } : {})
      });
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: request.system },
        ...request.messages.map((message): ChatCompletionMessageParam => (message.role === "user" ? { role: "user", content: message.content } : { role: "assistant", content: message.content }))
      ];
      const params: ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        stream: true,
        ...(preset.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(request.maxOutputTokens ? { [preset.tokenParam]: request.maxOutputTokens } : {})
      };
      const stream = await client.chat.completions.create(params, { signal: deadline.signal });
      let text = "";
      let stopReason: ChatStopReason | undefined;
      let usage: ChatResult["usage"];
      for await (const chunk of stream) {
        deadline.touch();
        const choice = chunk.choices?.[0];
        const piece = choice?.delta?.content;
        if (typeof piece === "string" && piece) {
          if (text.length + piece.length > MAX_ANSWER_CHARACTERS) {
            stopReason = "length";
            break;
          }
          text += piece;
          request.onDelta?.(piece);
        }
        stopReason = finishReason(choice?.finish_reason) ?? stopReason;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      deadline.throwIfFired();
      // Some compatible servers end the stream without a finish reason; text means it answered.
      if (!stopReason && !text) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      return { text, stopReason: stopReason ?? "end", ...(usage ? { usage } : {}) };
    } catch (error) {
      throw deadline.failure() ?? mapOpenAiError(error);
    } finally {
      deadline.dispose();
    }
  };

  return { destination, check, run };
};
