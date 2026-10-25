import { afterEach, describe, expect, test } from "bun:test";
import type { SecretName } from "../../config/secrets";
import { COMMON_PROVIDER_MESSAGES } from "../providers/common";
import { API_MESSAGES, API_PRESETS, createOpenAiCompatibleProvider, missingKeyMessage, parseCustomBaseUrl } from "../providers/openai-compatible";
import { ProviderError } from "../types";
import { type SeenRequest, chatRequest, configWith, jsonResponse, recordingFetch, sse, streamOf } from "./provider-helpers";

const KEY = "sk-test-0123456789abcdef";
const secrets = (values: Partial<Record<SecretName, string>>) => async (name: SecretName) => values[name];

const chunk = (content: string | null, finish: string | null = null, usage?: object) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: content === null && finish === null ? [] : [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
  ...(usage ? { usage } : {})
});

const streamResponse = (events: object[], options: { delayMs?: number; hangAfter?: boolean; done?: boolean } = {}) =>
  new Response(streamOf([...sse(events.map((data) => ({ data }))), ...(options.done === false ? [] : ["data: [DONE]\n\n"])], options), { headers: { "content-type": "text/event-stream" } });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: (error as Error).message, code: (error as ProviderError).code }).toEqual({ message, code });
};

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_LOG"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("OpenAI-compatible presets", () => {
  test("OpenRouter: URL, key, attribution headers, default model and streamed text", async () => {
    // Environment settings meant for OpenAI must not leak into another provider's request.
    process.env.OPENAI_ORG_ID = "org-should-not-leak";
    process.env.OPENAI_PROJECT_ID = "proj-should-not-leak";
    process.env.OPENAI_BASE_URL = "https://evil.example.com/v1";
    const seen: SeenRequest[] = [];
    const fetch = recordingFetch(() => streamResponse([chunk("A Ana "), chunk("decidiu."), chunk(null, "stop"), chunk(null, null, { prompt_tokens: 50, completion_tokens: 4, total_tokens: 54 })]), seen);
    const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "openrouter" }), { fetch, readSecret: secrets({ OPENROUTER_API_KEY: KEY }) });
    const request = chatRequest();
    const result = await provider.run(request);
    expect(result).toEqual({ text: "A Ana decidiu.", stopReason: "end", usage: { inputTokens: 50, outputTokens: 4 } });
    expect(request.deltas).toEqual(["A Ana ", "decidiu."]);
    expect(seen).toHaveLength(1);
    const sent = seen[0] as SeenRequest;
    expect(sent.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent.headers.get("http-referer")).toBe("https://caiolombello.github.io/falatrace/");
    expect(sent.headers.get("x-openrouter-title")).toBe("FalaTrace");
    expect(sent.headers.get("openai-organization")).toBeNull();
    expect(sent.headers.get("openai-project")).toBeNull();
    const body = JSON.parse(sent.body);
    expect(body).toEqual({
      model: "deepseek/deepseek-v4.1-flash-1017",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: "Primeira pergunta?" },
        { role: "assistant", content: "Primeira resposta." },
        { role: "user", content: "Quem decidiu o prazo?" }
      ],
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(provider.destination).toEqual({
      kind: "api",
      id: "openrouter",
      label: "OpenRouter · deepseek/deepseek-v4.1-flash-1017",
      endpoint: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      external: true
    });
    expect(JSON.stringify(provider.destination)).not.toContain(KEY);
  });

  test("every preset reaches its own base URL with its own key; output caps use the right parameter", async () => {
    for (const [name, preset] of Object.entries(API_PRESETS)) {
      if (name === "custom") continue;
      const seen: SeenRequest[] = [];
      const fetch = recordingFetch(() => streamResponse([chunk("ok", "stop")]), seen);
      const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: name as never, apiModel: "" }), { fetch, readSecret: secrets({ [preset.keyName]: `${name}-key` }) });
      await provider.run(chatRequest({ maxOutputTokens: 900 }));
      const sent = seen[0] as SeenRequest;
      expect(sent.url).toBe(`${preset.baseURL.replace(/\/$/, "")}/chat/completions`);
      expect(sent.headers.get("authorization")).toBe(`Bearer ${name}-key`);
      const body = JSON.parse(sent.body);
      expect(body.model).toBe(preset.defaultModel);
      expect(body[preset.tokenParam]).toBe(900);
      expect(body[preset.tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens"]).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    }
  });

  test("SDK debug logging from the environment never prints the request", async () => {
    process.env.OPENAI_LOG = "debug";
    const printed: string[] = [];
    const methods = ["log", "debug", "info", "warn", "error"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    try {
      const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "openai" }), { fetch: recordingFetch(() => streamResponse([chunk("ok", "stop")])), readSecret: secrets({ OPENAI_API_KEY: KEY }) });
      await provider.run(chatRequest());
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
    expect(printed.filter((line) => line.includes("Quem decidiu") || line.includes(KEY))).toEqual([]);
  });

  test("a configured model replaces the preset default", async () => {
    const seen: SeenRequest[] = [];
    const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "groq", apiModel: "openai/gpt-oss-20b" }), {
      fetch: recordingFetch(() => streamResponse([chunk("ok", "stop")]), seen),
      readSecret: secrets({ GROQ_API_KEY: KEY })
    });
    await provider.run(chatRequest());
    expect(JSON.parse((seen[0] as SeenRequest).body).model).toBe("openai/gpt-oss-20b");
    expect(provider.destination.label).toBe("Groq · openai/gpt-oss-20b");
  });

  test("finish reasons map to stop reasons", async () => {
    const run = (events: object[], options?: { done?: boolean }) =>
      createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "openai" }), { fetch: recordingFetch(() => streamResponse(events, options)), readSecret: secrets({ OPENAI_API_KEY: KEY }) }).run(chatRequest());
    expect((await run([chunk("cortado"), chunk(null, "length")])).stopReason).toBe("length");
    expect((await run([chunk(null, "content_filter")])).stopReason).toBe("refusal");
    expect((await run([chunk("sem fim")], { done: false })).stopReason).toBe("end");
    await expectProviderError(run([], { done: false }), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
  });

  test("typed SDK errors become Portuguese provider errors", async () => {
    const run = (response: () => Response | Promise<Response>) =>
      createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "xai" }), { fetch: recordingFetch(response), readSecret: secrets({ XAI_API_KEY: KEY }) }).run(chatRequest());
    const error = (status: number) => () => jsonResponse(status, { error: { message: `upstream says ${KEY}`, type: "x" } });
    await expectProviderError(run(error(401)), API_MESSAGES.auth, "auth");
    await expectProviderError(run(error(403)), API_MESSAGES.forbidden, "auth");
    await expectProviderError(run(error(429)), API_MESSAGES.rateLimit, "rate-limit");
    await expectProviderError(run(error(402)), API_MESSAGES.rateLimit, "rate-limit");
    await expectProviderError(run(error(404)), API_MESSAGES.notFound, "bad-request");
    await expectProviderError(run(error(400)), API_MESSAGES.badRequest, "bad-request");
    await expectProviderError(run(error(422)), API_MESSAGES.badRequest, "bad-request");
    await expectProviderError(run(error(500)), API_MESSAGES.unavailable, "unavailable");
    await expectProviderError(run(error(503)), API_MESSAGES.unavailable, "unavailable");
    await expectProviderError(run(() => { throw new TypeError("connect ECONNREFUSED"); }), API_MESSAGES.unreachable, "unavailable");
    // An error object inside the stream (OpenRouter does this) is an upstream failure.
    await expectProviderError(run(() => streamResponse([chunk("a"), { error: { message: "boom", code: 502 } }])), API_MESSAGES.unavailable, "unavailable");
  });

  test("a missing key is reported before any request", async () => {
    const seen: SeenRequest[] = [];
    const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "mistral" }), { fetch: recordingFetch(() => streamResponse([]), seen), readSecret: secrets({}) });
    expect(await provider.check()).toEqual({ ready: false, problem: "missing-key", message: missingKeyMessage("MISTRAL_API_KEY") });
    await expectProviderError(provider.run(chatRequest()), missingKeyMessage("MISTRAL_API_KEY"), "auth");
    expect(seen).toHaveLength(0);
    const ready = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "mistral" }), { readSecret: secrets({ MISTRAL_API_KEY: KEY }) });
    expect(await ready.check()).toEqual({ ready: true });
  });

  test("cancel and silence stop the stream", async () => {
    const hanging = () => streamResponse([chunk("começo")], { hangAfter: true, done: false });
    const controller = new AbortController();
    const request = chatRequest({ signal: controller.signal });
    const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "together" }), { fetch: recordingFetch(hanging), readSecret: secrets({ TOGETHER_API_KEY: KEY }) });
    const running = provider.run(request);
    setTimeout(() => controller.abort(), 100);
    await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
    expect(request.deltas).toEqual(["começo"]);
    const slow = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "together" }), { fetch: recordingFetch(hanging), readSecret: secrets({ TOGETHER_API_KEY: KEY }), timeouts: { idleMs: 100 } });
    await expectProviderError(slow.run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
  });
});

describe("custom OpenAI-compatible API", () => {
  test("only HTTPS, or plain HTTP on this computer, without credentials or parameters", () => {
    expect(parseCustomBaseUrl("https://llm.example.com/v1")?.toString()).toBe("https://llm.example.com/v1");
    expect(parseCustomBaseUrl("http://127.0.0.1:8080/v1")?.hostname).toBe("127.0.0.1");
    expect(parseCustomBaseUrl("http://localhost:1234/v1")?.hostname).toBe("localhost");
    expect(parseCustomBaseUrl("http://[::1]:1234/v1")?.hostname).toBe("[::1]");
    for (const bad of ["http://192.168.1.5/v1", "https://user:pass@llm.example.com/v1", "https://llm.example.com/v1?key=x", "https://llm.example.com/v1#x", "ftp://llm.example.com", "not a url", ""]) {
      expect(parseCustomBaseUrl(bad)).toBeUndefined();
    }
  });

  test("a local server needs no key and stays on this computer", async () => {
    const seen: SeenRequest[] = [];
    const provider = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "http://127.0.0.1:8080/v1", apiModel: "llama-local" }), {
      fetch: recordingFetch(() => streamResponse([chunk("local", "stop")]), seen),
      readSecret: secrets({})
    });
    expect(provider.destination).toMatchObject({ id: "custom", endpoint: "http://127.0.0.1:8080/v1", external: false, model: "llama-local" });
    expect(await provider.check()).toEqual({ ready: true });
    expect((await provider.run(chatRequest())).text).toBe("local");
    expect((seen[0] as SeenRequest).url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect((seen[0] as SeenRequest).headers.get("authorization")).toBe("Bearer falatrace-local-no-key");
  });

  test("a remote custom API needs CUSTOM_API_KEY and a model", async () => {
    const remote = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "https://llm.example.com/v1", apiModel: "m" }), { readSecret: secrets({}) });
    expect(remote.destination.external).toBe(true);
    expect(await remote.check()).toEqual({ ready: false, problem: "missing-key", message: missingKeyMessage("CUSTOM_API_KEY") });
    const noModel = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "https://llm.example.com/v1", apiModel: "" }), { readSecret: secrets({ CUSTOM_API_KEY: KEY }) });
    expect(await noModel.check()).toEqual({ ready: false, problem: "misconfigured", message: API_MESSAGES.modelRequired });
    await expectProviderError(noModel.run(chatRequest()), API_MESSAGES.modelRequired, "bad-request");
    const badUrl = createOpenAiCompatibleProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "http://10.0.0.2/v1", apiModel: "m" }), { readSecret: secrets({ CUSTOM_API_KEY: KEY }) });
    expect(badUrl.destination.endpoint).toBe("");
    expect(await badUrl.check()).toEqual({ ready: false, problem: "misconfigured", message: API_MESSAGES.invalidBaseUrl });
    await expectProviderError(badUrl.run(chatRequest()), API_MESSAGES.invalidBaseUrl, "bad-request");
  });
});
