import { afterEach, describe, expect, test } from "bun:test";
import type { SecretName } from "../../config/secrets";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_FALLBACK_BETA, ANTHROPIC_MESSAGES, createAnthropicProvider } from "../providers/anthropic";
import { COMMON_PROVIDER_MESSAGES } from "../providers/common";
import { missingKeyMessage } from "../providers/openai-compatible";
import { ProviderError } from "../types";
import { type SeenRequest, chatRequest, configWith, jsonResponse, recordingFetch, sse, streamOf } from "./provider-helpers";

const KEY = "sk-ant-test-0123456789";
const secrets = (values: Partial<Record<SecretName, string>>) => async (name: SecretName) => values[name];

const messageStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: ANTHROPIC_DEFAULT_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } };
const textDelta = (text: string, index = 1) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const messageDelta = (stopReason: string, extra: object = {}) => ({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 9 } });

/** A complete Messages stream: an adaptive thinking block (ignored), then text. */
const events = (texts: string[], stopReason = "end_turn", extra: object = {}) => [
  messageStart,
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "RACIOCINIO-INTERNO" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  ...texts.map((text) => textDelta(text)),
  { type: "content_block_stop", index: 1 },
  messageDelta(stopReason, extra),
  { type: "message_stop" }
];

const streamResponse = (data: Array<{ type: string; [key: string]: unknown }>, options: { hangAfter?: boolean } = {}) =>
  new Response(streamOf(sse(data.map((entry) => ({ event: entry.type, data: entry }))), options), { headers: { "content-type": "text/event-stream", "request-id": "req_1" } });

const provider = (fetch: typeof globalThis.fetch, model = "", timeouts?: { idleMs?: number }) =>
  createAnthropicProvider(configWith({ provider: "api", apiPreset: "anthropic", apiModel: model }), { fetch, readSecret: secrets({ ANTHROPIC_API_KEY: KEY }), timeouts });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: (error as Error).message, code: (error as ProviderError).code }).toEqual({ message, code });
};

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_LOG"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("Anthropic provider (official SDK)", () => {
  test("sends a chat request the current models accept and streams only text deltas", async () => {
    // Environment variables must not redirect the request or swap the credential.
    process.env.ANTHROPIC_BASE_URL = "https://evil.example.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "token-should-not-be-used";
    const seen: SeenRequest[] = [];
    const request = chatRequest();
    const result = await provider(recordingFetch(() => streamResponse(events(["A Ana ", "decidiu."])), seen)).run(request);
    expect(result).toEqual({ text: "A Ana decidiu.", stopReason: "end", usage: { inputTokens: 42, outputTokens: 9 } });
    expect(request.deltas).toEqual(["A Ana ", "decidiu."]);
    const sent = seen[0] as SeenRequest;
    expect(new URL(sent.url).origin + new URL(sent.url).pathname).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.method).toBe("POST");
    // SDK 1.3.0 sends the API key as a bearer credential; it must be ours, not the environment's token.
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent.headers.get("x-api-key")).toBeNull();
    expect(sent.headers.get("anthropic-version")).toBeTruthy();
    expect(sent.headers.get("anthropic-beta")?.split(",")).toContain(ANTHROPIC_FALLBACK_BETA);
    const body = JSON.parse(sent.body);
    expect(body).toEqual({
      model: ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 8000,
      messages: [
        { role: "user", content: "Primeira pergunta?" },
        { role: "assistant", content: "Primeira resposta." },
        { role: "user", content: "Quem decidiu o prazo?" }
      ],
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low" },
      fallbacks: "default",
      stream: true
    });
    // Rejected by current models, or thinking left to the adaptive default.
    for (const field of ["temperature", "top_p", "top_k", "thinking", "betas"]) expect(body[field]).toBeUndefined();
  });

  test("SDK debug logging from the environment never prints the request", async () => {
    process.env.ANTHROPIC_LOG = "debug";
    const printed: string[] = [];
    const methods = ["log", "debug", "info", "warn", "error"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    try {
      await provider(recordingFetch(() => streamResponse(events(["ok"])))).run(chatRequest());
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
    expect(printed.filter((line) => line.includes("Quem decidiu") || line.includes(KEY))).toEqual([]);
  });

  test("model, output cap and effort are configurable; empty system and empty turns are left out", async () => {
    const seen: SeenRequest[] = [];
    const custom = createAnthropicProvider(configWith({ provider: "api", apiPreset: "anthropic", apiModel: "claude-haiku-5-5" }), {
      fetch: recordingFetch(() => streamResponse(events(["ok"])), seen),
      readSecret: secrets({ ANTHROPIC_API_KEY: KEY }),
      effort: "medium"
    });
    expect(custom.destination).toEqual({ kind: "api", id: "anthropic", label: "Anthropic · claude-haiku-5-5", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-haiku-5-5", external: true });
    await custom.run(chatRequest({ system: "  ", maxOutputTokens: 100_000, messages: [{ role: "assistant", content: "" }, { role: "user", content: "Pergunta?" }] }));
    const body = JSON.parse((seen[0] as SeenRequest).body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(64000);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "Pergunta?" }]);
  });

  test("stop_reason is checked before the answer is used", async () => {
    const run = (stopReason: string, extra: object = {}) => provider(recordingFetch(() => streamResponse(events(["texto"], stopReason, extra)))).run(chatRequest());
    expect((await run("max_tokens")).stopReason).toBe("length");
    expect((await run("model_context_window_exceeded")).stopReason).toBe("length");
    expect((await run("stop_sequence")).stopReason).toBe("end");
    expect((await run("refusal", { stop_details: { type: "refusal", category: null, explanation: null } })).stopReason).toBe("refusal");
    await expectProviderError(run("tool_use"), ANTHROPIC_MESSAGES.incomplete, "protocol");
    await expectProviderError(run("pause_turn"), ANTHROPIC_MESSAGES.incomplete, "protocol");
  });

  test("typed SDK errors map to Portuguese messages", async () => {
    const failing = (status: number, type: string) => provider(recordingFetch(() => jsonResponse(status, { type: "error", error: { type, message: `details with ${KEY}` } }))).run(chatRequest());
    await expectProviderError(failing(401, "authentication_error"), ANTHROPIC_MESSAGES.auth, "auth");
    await expectProviderError(failing(403, "permission_error"), ANTHROPIC_MESSAGES.forbidden, "auth");
    await expectProviderError(failing(429, "rate_limit_error"), ANTHROPIC_MESSAGES.rateLimit, "rate-limit");
    await expectProviderError(failing(400, "invalid_request_error"), ANTHROPIC_MESSAGES.badRequest, "bad-request");
    await expectProviderError(failing(404, "not_found_error"), ANTHROPIC_MESSAGES.notFound, "bad-request");
    await expectProviderError(failing(413, "request_too_large"), ANTHROPIC_MESSAGES.badRequest, "bad-request");
    await expectProviderError(failing(500, "api_error"), ANTHROPIC_MESSAGES.unavailable, "unavailable");
    await expectProviderError(failing(529, "overloaded_error"), ANTHROPIC_MESSAGES.unavailable, "unavailable");
    await expectProviderError(provider(recordingFetch(() => { throw new TypeError("ECONNREFUSED"); })).run(chatRequest()), ANTHROPIC_MESSAGES.unreachable, "unavailable");
    const midStream = [messageStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, textDelta("parcial", 0), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
    await expectProviderError(provider(recordingFetch(() => streamResponse(midStream))).run(chatRequest()), ANTHROPIC_MESSAGES.unavailable, "unavailable");
  });

  test("a missing key is reported without a request", async () => {
    const seen: SeenRequest[] = [];
    const noKey = createAnthropicProvider(configWith({ provider: "api", apiPreset: "anthropic" }), { fetch: recordingFetch(() => streamResponse([]), seen), readSecret: secrets({}) });
    expect(await noKey.check()).toEqual({ ready: false, problem: "missing-key", message: missingKeyMessage("ANTHROPIC_API_KEY") });
    await expectProviderError(noKey.run(chatRequest()), missingKeyMessage("ANTHROPIC_API_KEY"), "auth");
    expect(seen).toHaveLength(0);
    expect(await provider(recordingFetch(() => streamResponse([]))).check()).toEqual({ ready: true });
  });

  test("cancel and silence stop the stream", async () => {
    const hanging = () => streamResponse([messageStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, textDelta("começo", 0)], { hangAfter: true });
    const controller = new AbortController();
    const request = chatRequest({ signal: controller.signal });
    const running = provider(recordingFetch(hanging)).run(request);
    setTimeout(() => controller.abort(), 100);
    await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
    expect(request.deltas).toEqual(["começo"]);
    await expectProviderError(provider(recordingFetch(hanging), "", { idleMs: 100 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
    await expectProviderError(provider(recordingFetch(hanging)).run(chatRequest({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "prefill" }] })), COMMON_PROVIDER_MESSAGES.lastNotUser, "bad-request");
  });
});
