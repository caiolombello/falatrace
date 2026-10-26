import type { AppConfig } from "../../config/defaults";
import { validateOllamaUrl } from "../../summary/ollama";
import { isOllamaCloudModel, probeOllamaLocality } from "../../summary/ollama-locality";
import { type ChatProvider, type ChatRequest, type ChatResult, type ChatStopReason, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import {
  COMMON_PROVIDER_MESSAGES,
  Deadline,
  isLoopbackHost,
  isRecord,
  MAX_ANSWER_CHARACTERS,
  type ProviderTimeouts,
  publicEndpoint,
  readBounded,
  readLines,
  validateChatRequest
} from "./common";

// Questions through the user's Ollama server (the one the summary settings point to), with
// the native /api/chat endpoint streaming NDJSON.

export const LOCAL_MESSAGES = {
  invalidUrl: "O endereço do Ollama é inválido: use HTTPS, ou HTTP só em 127.0.0.1.",
  unreachable: "Não foi possível falar com o Ollama. Confira se ele está rodando e o endereço em Configurações.",
  modelMissing: "O modelo do assistente não está instalado no Ollama. Baixe-o em Configurações › Modelos ou escolha outro.",
  rejected: "O Ollama recusou o pedido. Confira o modelo do assistente em Configurações.",
  failed: "O Ollama interrompeu a resposta. Tente de novo.",
  cloudModel: "Esse modelo roda na nuvem do Ollama, não neste computador. Escolha um modelo baixado em Configurações."
} as const;

export type LocalProviderDeps = { fetch?: typeof fetch; timeouts?: ProviderTimeouts };

const DEFAULT_TIMEOUTS = { totalMs: 10 * 60_000, idleMs: 3 * 60_000, checkMs: 5_000 };
const MAX_LINE_BYTES = 1024 * 1024;
/** /api/tags lists every installed model; a few thousand entries fit easily. */
const MAX_TAGS_BYTES = 4 * 1024 * 1024;

const parseBase = (config: AppConfig): URL | undefined => {
  try {
    return validateOllamaUrl(config.summary.ollamaUrl);
  } catch {
    return undefined;
  }
};

const sameModel = (installed: string, wanted: string): boolean => installed === wanted || (!wanted.includes(":") && installed === `${wanted}:latest`);

export const createLocalProvider = (config: AppConfig, deps: LocalProviderDeps = {}): ChatProvider => {
  const fetchImpl = deps.fetch ?? fetch;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const model = config.assistant.localModel;
  const base = parseBase(config);
  const chatUrl = base ? new URL("/api/chat", base) : undefined;
  const destination: ProviderDestination = {
    kind: "local",
    id: "ollama",
    label: `Ollama · ${model}`,
    endpoint: chatUrl ? publicEndpoint(chatUrl) : "",
    model,
    // A cloud model ("…-cloud") goes to ollama.com even through a loopback server.
    external: base ? !isLoopbackHost(base.hostname) || isOllamaCloudModel(model) : true
  };

  /**
   * A destination presented as this computer is confirmed with the server before anything is sent:
   * a copy of a cloud model under another name is refused, never sent without the consent.
   */
  const confirmLocal = async (signal: AbortSignal): Promise<ProviderReadiness> => {
    if (destination.external || !base) return { ready: true };
    const locality = await probeOllamaLocality(base, model, { fetch: fetchImpl, signal });
    if (locality === "local") return { ready: true };
    if (locality === "missing") return { ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.modelMissing };
    if (locality === "cloud") return { ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.cloudModel };
    return { ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable };
  };

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    if (!base) return { ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.invalidUrl };
    const deadline = new Deadline(signal, { totalMs: timeouts.checkMs });
    try {
      const response = await fetchImpl(new URL("/api/tags", base), { redirect: "error", signal: deadline.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable };
      }
      const raw = await readBounded(response.body, MAX_TAGS_BYTES, "head", { stopWhenFull: true });
      if (raw.truncated) return { ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable };
      const body = JSON.parse(raw.text) as unknown;
      const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
      const names = models.slice(0, 2000).flatMap((entry) => (isRecord(entry) ? [entry.name, entry.model] : [])).filter((name): name is string => typeof name === "string");
      if (!names.some((name) => sameModel(name, model))) return { ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.modelMissing };
      return await confirmLocal(deadline.signal);
    } catch {
      if (deadline.fired === "cancelled") throw new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      return { ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable };
    } finally {
      deadline.dispose();
    }
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    if (!chatUrl) throw new ProviderError(LOCAL_MESSAGES.invalidUrl, "bad-request");
    const deadline = new Deadline(request.signal, { totalMs: timeouts.totalMs, idleMs: timeouts.idleMs });
    try {
      const local = await confirmLocal(deadline.signal);
      if (!local.ready) throw new ProviderError(local.message, local.problem === "unreachable" ? "unavailable" : "bad-request");
      let response: Response;
      try {
        response = await fetchImpl(chatUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "system", content: request.system }, ...request.messages.map((message) => ({ role: message.role, content: message.content }))],
            options: { temperature: 0.3, ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}) }
          }),
          signal: deadline.signal
        });
      } catch {
        deadline.throwIfFired();
        throw new ProviderError(LOCAL_MESSAGES.unreachable, "unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404) throw new ProviderError(LOCAL_MESSAGES.modelMissing, "bad-request");
        if (response.status >= 400 && response.status < 500) throw new ProviderError(LOCAL_MESSAGES.rejected, "bad-request");
        throw new ProviderError(LOCAL_MESSAGES.failed, "unavailable");
      }
      if (!response.body) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      let text = "";
      let stopReason: ChatStopReason = "end";
      let finished = false;
      let usage: ChatResult["usage"];
      for await (const line of readLines(response.body, { maxLineBytes: MAX_LINE_BYTES, signal: deadline.signal })) {
        deadline.touch();
        if (!line.trim()) continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(line);
        } catch {
          throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
        }
        if (!isRecord(chunk)) throw new ProviderError(COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
        if (chunk.error !== undefined) throw new ProviderError(LOCAL_MESSAGES.failed, "unavailable");
        const piece = isRecord(chunk.message) ? chunk.message.content : undefined;
        if (typeof piece === "string" && piece) {
          if (text.length + piece.length > MAX_ANSWER_CHARACTERS) {
            stopReason = "length";
            finished = true;
            break;
          }
          text += piece;
          request.onDelta?.(piece);
        }
        if (chunk.done === true) {
          finished = true;
          if (chunk.done_reason === "length") stopReason = "length";
          const inputTokens = typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined;
          const outputTokens = typeof chunk.eval_count === "number" ? chunk.eval_count : undefined;
          if (inputTokens !== undefined || outputTokens !== undefined) usage = { inputTokens, outputTokens };
          break;
        }
      }
      deadline.throwIfFired();
      if (!finished) throw new ProviderError(LOCAL_MESSAGES.failed, "unavailable");
      return { text, stopReason, ...(usage ? { usage } : {}) };
    } catch (error) {
      throw deadline.failure() ?? (error instanceof ProviderError ? error : new ProviderError(LOCAL_MESSAGES.failed, "unavailable"));
    } finally {
      deadline.dispose();
    }
  };

  return { destination, check, run };
};
