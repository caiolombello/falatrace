import type { AppConfig } from "../../config/defaults";
import {
  COMMON_PROVIDER_MESSAGES,
  Deadline,
  isRecord,
  MAX_ANSWER_CHARACTERS,
  type ProviderTimeouts,
  readBounded,
  readLines,
  throwIfCancelled,
  validateChatRequest
} from "../providers/common";
import { type ChatProvider, type ChatRequest, type ChatResult, type ChatStopReason, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import { CHATGPT_DIRECT_SCOPE, CHATGPT_MESSAGES, type ChatGptOAuthDeps, chatGptStatus, getChatGptAccessToken } from "./oauth";

// Questions on the user's ChatGPT plan: POST /v1/responses with the signed-in user's bearer
// token. Plan usage requires store:false and stream:true, takes the system prompt as
// `instructions`, and refuses sampling fields, so none are sent.

export const CHATGPT_API_BASE = "https://api.openai.com/v1";
/** Used when assistant.chatgptModel is empty (the model OpenAI's plan-usage examples use). */
export const DEFAULT_CHATGPT_MODEL = "gpt-6.1-sol";

export const CHATGPT_API_MESSAGES = {
  notEligible: "Sua conta do ChatGPT não pode usar o plano no FalaTrace (é preciso Plus ou Pro).",
  usageLimit: "Você atingiu o limite de uso do plano do ChatGPT para o FalaTrace. Veja em ChatGPT › Configurações › Uso.",
  usageUnavailable: "O uso do plano do ChatGPT está indisponível agora. Tente de novo em alguns minutos.",
  invalidUser: "O ChatGPT não aceitou mais a sua sessão. Entre de novo com o ChatGPT em Configurações › Perguntar e receitas.",
  modelUnavailable: "O modelo escolhido não está disponível no seu plano do ChatGPT.",
  badRequest: "O ChatGPT recusou o pedido. Confira o modelo e o tamanho do contexto.",
  unavailable: "O ChatGPT está indisponível no momento. Tente de novo em alguns minutos.",
  interrupted: "A resposta do ChatGPT foi interrompida. Tente de novo."
} as const;

export type ChatGptProviderDeps = {
  fetch?: typeof fetch;
  oauth?: ChatGptOAuthDeps;
  /** API base for tests; the destination shows whatever is used. */
  apiBase?: string;
  timeouts?: ProviderTimeouts;
};

const DEFAULT_TIMEOUTS = { totalMs: 5 * 60_000, idleMs: 90_000, checkMs: 5_000 };
const MAX_EVENT_BYTES = 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** Maps plan-usage errors (by code first, then HTTP status) to Portuguese provider errors. */
export const mapChatGptError = (status: number, code: unknown): ProviderError => {
  switch (code) {
    case "subscription_sharing_user_not_eligible":
      return new ProviderError(CHATGPT_API_MESSAGES.notEligible, "auth");
    case "subscription_sharing_usage_limit_exceeded":
      return new ProviderError(CHATGPT_API_MESSAGES.usageLimit, "rate-limit");
    case "subscription_sharing_usage_unavailable":
      return new ProviderError(CHATGPT_API_MESSAGES.usageUnavailable, "unavailable");
    case "subscription_sharing_invalid_user":
      return new ProviderError(CHATGPT_API_MESSAGES.invalidUser, "auth");
    case "model_not_found":
      return new ProviderError(CHATGPT_API_MESSAGES.modelUnavailable, "bad-request");
  }
  if (status === 401) return new ProviderError(CHATGPT_API_MESSAGES.invalidUser, "auth");
  if (status === 403) return new ProviderError(CHATGPT_API_MESSAGES.notEligible, "auth");
  if (status === 429) return new ProviderError(CHATGPT_API_MESSAGES.usageLimit, "rate-limit");
  if (status === 503) return new ProviderError(CHATGPT_API_MESSAGES.usageUnavailable, "unavailable");
  if (status === 404) return new ProviderError(CHATGPT_API_MESSAGES.modelUnavailable, "bad-request");
  if (status >= 400 && status < 500) return new ProviderError(CHATGPT_API_MESSAGES.badRequest, "bad-request");
  return new ProviderError(CHATGPT_API_MESSAGES.unavailable, "unavailable");
};

const errorCode = (body: unknown): unknown => {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error)) return body.error.code ?? body.error.type;
  return body.code;
};

const readErrorCode = async (response: Response): Promise<unknown> => {
  try {
    return errorCode(JSON.parse((await readBounded(response.body, 64 * 1024, "head", { stopWhenFull: true })).text));
  } catch {
    return undefined;
  }
};

type SseEvent = { event?: string; data: string };

/** Server-sent events: `event:`/`data:` fields, a blank line ends each event. */
async function* readSse(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  let size = 0;
  for await (const line of readLines(stream, { maxLineBytes: MAX_EVENT_BYTES, signal })) {
    if (line === "") {
      if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
      event = undefined;
      data = [];
      size = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") {
      size += value.length;
      if (size > MAX_EVENT_BYTES) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      data.push(value);
    }
  }
  if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
}

const tokenUsage = (response: unknown): ChatResult["usage"] | undefined => {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  const { input_tokens: input, output_tokens: output } = response.usage;
  return { inputTokens: typeof input === "number" ? input : undefined, outputTokens: typeof output === "number" ? output : undefined };
};

export const createChatGptProvider = (config: AppConfig, deps: ChatGptProviderDeps = {}): ChatProvider => {
  const fetchImpl = deps.fetch ?? deps.oauth?.fetch ?? fetch;
  const oauth: ChatGptOAuthDeps = { ...deps.oauth, fetch: deps.oauth?.fetch ?? fetchImpl };
  const apiBase = (deps.apiBase ?? CHATGPT_API_BASE).replace(/\/+$/, "");
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const model = config.assistant.chatgptModel || DEFAULT_CHATGPT_MODEL;
  const destination: ProviderDestination = {
    kind: "chatgpt",
    id: "chatgpt",
    label: `ChatGPT (seu plano) · ${model}`,
    endpoint: `${apiBase}/responses`,
    model,
    external: true,
    subscription: "plano do ChatGPT (Plus ou Pro)"
  };

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    const status = await chatGptStatus(oauth).catch(() => undefined);
    if (!status?.signedIn) return { ready: false, problem: "signed-out", message: CHATGPT_MESSAGES.signedOut };
    if (!status.scopes.includes(CHATGPT_DIRECT_SCOPE)) return { ready: false, problem: "signed-out", message: CHATGPT_MESSAGES.scopeDeclined };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    const deadline = new Deadline(request.signal, { totalMs: timeouts.totalMs, idleMs: timeouts.idleMs });
    try {
      const body = JSON.stringify({
        model,
        instructions: request.system,
        input: request.messages.map((message) => ({ role: message.role, content: message.content })),
        store: false,
        stream: true
      });
      let token = await getChatGptAccessToken({ signal: deadline.signal }, oauth);
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetchImpl(`${apiBase}/responses`, {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
            body,
            signal: deadline.signal
          });
        } catch {
          deadline.throwIfFired();
          throw new ProviderError(CHATGPT_MESSAGES.unreachable, "unavailable");
        }
        if (response.status !== 401 || attempt > 0) break;
        // The token may have been revoked or rotated early: refresh once and retry.
        await response.body?.cancel().catch(() => undefined);
        token = await getChatGptAccessToken({ signal: deadline.signal, forceRefresh: true }, oauth);
      }
      if (!response) throw new ProviderError(CHATGPT_API_MESSAGES.unavailable, "unavailable");
      if (!response.ok) throw mapChatGptError(response.status, await readErrorCode(response));
      if (!response.body) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      let text = "";
      let stopReason: ChatStopReason | undefined;
      let usage: ChatResult["usage"];
      let refused = false;
      for await (const event of readSse(response.body, deadline.signal)) {
        deadline.touch();
        if (event.data === "[DONE]") break;
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
        }
        if (!isRecord(data)) continue;
        const type = typeof data.type === "string" ? data.type : event.event;
        if (type === "response.output_text.delta" && typeof data.delta === "string") {
          if (text.length + data.delta.length > MAX_ANSWER_CHARACTERS) {
            stopReason = "length";
            break;
          }
          text += data.delta;
          request.onDelta?.(data.delta);
        } else if (type === "response.refusal.delta" || type === "response.refusal.done") {
          refused = true;
        } else if (type === "response.completed") {
          usage = tokenUsage(data.response);
          stopReason = refused ? "refusal" : "end";
          break;
        } else if (type === "response.incomplete") {
          const details = isRecord(data.response) && isRecord(data.response.incomplete_details) ? data.response.incomplete_details : undefined;
          usage = tokenUsage(data.response);
          stopReason = details?.reason === "content_filter" || refused ? "refusal" : "length";
          break;
        } else if (type === "response.failed") {
          const failed = isRecord(data.response) ? data.response.error : undefined;
          throw mapChatGptError(0, isRecord(failed) ? failed.code : undefined);
        } else if (type === "error") {
          throw mapChatGptError(0, errorCode(data) ?? data.code);
        }
      }
      deadline.throwIfFired();
      // Only response.completed (or incomplete) means the answer is whole.
      if (!stopReason) throw new ProviderError(CHATGPT_API_MESSAGES.interrupted, "unavailable");
      return { text, stopReason, ...(usage ? { usage } : {}) };
    } catch (error) {
      throw deadline.failure() ?? (error instanceof ProviderError ? error : new ProviderError(CHATGPT_API_MESSAGES.interrupted, "unavailable"));
    } finally {
      deadline.dispose();
    }
  };

  return { destination, check, run };
};

export type ChatGptModel = { id: string; label: string };

/** Models the signed-in plan lists (visibility "list"), for the model picker. */
export const listChatGptModels = async (deps: ChatGptProviderDeps & { signal?: AbortSignal } = {}): Promise<ChatGptModel[]> => {
  const fetchImpl = deps.fetch ?? deps.oauth?.fetch ?? fetch;
  const oauth: ChatGptOAuthDeps = { ...deps.oauth, fetch: deps.oauth?.fetch ?? fetchImpl };
  const apiBase = (deps.apiBase ?? CHATGPT_API_BASE).replace(/\/+$/, "");
  const deadline = new Deadline(deps.signal, { totalMs: deps.timeouts?.checkMs ?? 15_000 });
  try {
    let token = await getChatGptAccessToken({ signal: deadline.signal }, oauth);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(`${apiBase}/models`, { redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: deadline.signal });
      } catch {
        deadline.throwIfFired();
        throw new ProviderError(CHATGPT_MESSAGES.unreachable, "unavailable");
      }
      if (response.status !== 401 || attempt > 0) break;
      await response.body?.cancel().catch(() => undefined);
      token = await getChatGptAccessToken({ signal: deadline.signal, forceRefresh: true }, oauth);
    }
    if (!response) throw new ProviderError(CHATGPT_API_MESSAGES.unavailable, "unavailable");
    if (!response.ok) throw mapChatGptError(response.status, await readErrorCode(response));
    const raw = await readBounded(response.body, 1024 * 1024, "head", { stopWhenFull: true });
    if (raw.truncated) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
    }
    const entries = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const models: ChatGptModel[] = [];
    const seen = new Set<string>();
    for (const entry of entries.slice(0, 1000)) {
      if (!isRecord(entry)) continue;
      if (entry.visibility !== undefined && entry.visibility !== "list") continue;
      const id = typeof entry.slug === "string" ? entry.slug : entry.id;
      if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      const name = typeof entry.display_name === "string" && entry.display_name.length <= 200 && !/\p{Cc}/u.test(entry.display_name) ? entry.display_name : id;
      models.push({ id, label: name });
      if (models.length >= 200) break;
    }
    return models;
  } catch (error) {
    throw deadline.failure() ?? (error instanceof ProviderError ? error : new ProviderError(CHATGPT_API_MESSAGES.unavailable, "unavailable"));
  } finally {
    deadline.dispose();
  }
};
