import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CHATGPT_MESSAGES } from "../chatgpt/oauth";
import { CHATGPT_API_BASE, CHATGPT_API_MESSAGES, createChatGptProvider, DEFAULT_CHATGPT_MODEL, listChatGptModels, mapChatGptError } from "../chatgpt/responses";
import { type ChatGptCredentials, ChatGptStore } from "../chatgpt/store";
import { COMMON_PROVIDER_MESSAGES, MAX_ANSWER_CHARACTERS } from "../providers/common";
import { ProviderError } from "../types";
import { chatRequest, configWith, jsonResponse, recordingFetch, type SeenRequest, sse, streamOf, withTempDir } from "./provider-helpers";

const TOKEN_URL = "https://auth.test.invalid/token";
const DIRECT = "chatgpt.tokens.use.direct";

/** A store holding a signed-in record (expiring in an hour unless told otherwise). */
const signedInStore = async (dir: string, patch: Partial<ChatGptCredentials> = {}): Promise<ChatGptStore> => {
  const store = new ChatGptStore(join(dir, "chatgpt"));
  await store.ensureHostId();
  await store.transaction((current) => ({
    next: {
      ...(current as ChatGptCredentials),
      clientId: "oaiapp_1",
      accessToken: "at-current",
      refreshToken: "rt-current",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["openid", "offline_access", DIRECT],
      ...patch
    },
    result: undefined
  }));
  return store;
};

const events = (texts: string[], end: object | null = { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 30, output_tokens: 5 } } }) =>
  sse([
    { event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress" } } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "message" } } },
    ...texts.map((delta) => ({ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta } })),
    ...(end ? [{ event: (end as { type: string }).type, data: end }] : [])
  ]);

const streamResponse = (pieces: string[], options: { hangAfter?: boolean } = {}) => new Response(streamOf(pieces, options), { headers: { "content-type": "text/event-stream" } });

type Route = (request: SeenRequest, index: number) => Response | Promise<Response>;

const router = (routes: { responses?: Route; models?: Route; token?: Route }, seen: SeenRequest[] = []) =>
  recordingFetch((request, index) => {
    const url = new URL(request.url);
    if (request.url === TOKEN_URL && routes.token) return routes.token(request, index);
    if (url.pathname.endsWith("/responses") && routes.responses) return routes.responses(request, index);
    if (url.pathname.endsWith("/models") && routes.models) return routes.models(request, index);
    return new Response("unexpected", { status: 599 });
  }, seen);

const provider = (store: ChatGptStore, fetch: typeof globalThis.fetch, model = "", timeouts?: { idleMs?: number; totalMs?: number }) =>
  createChatGptProvider(configWith({ provider: "chatgpt", chatgptModel: model }), { fetch, oauth: { store, endpoints: { tokenUrl: TOKEN_URL } }, timeouts });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: (error as Error).message, code: (error as ProviderError).code }).toEqual({ message, code });
};

const refreshed = () => jsonResponse(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, token_type: "Bearer", scope: `openid offline_access ${DIRECT}` });

describe("ChatGPT plan (Responses API)", () => {
  test("sends a plan-usage request and streams output text deltas", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const seen: SeenRequest[] = [];
      const chat = provider(store, router({ responses: () => streamResponse(events(["A Ana ", "decidiu."])) }, seen));
      const request = chatRequest({ maxOutputTokens: 500 });
      expect(await chat.run(request)).toEqual({ text: "A Ana decidiu.", stopReason: "end", usage: { inputTokens: 30, outputTokens: 5 } });
      expect(request.deltas).toEqual(["A Ana ", "decidiu."]);
      const sent = seen[0] as SeenRequest;
      expect(sent.url).toBe("https://api.openai.com/v1/responses");
      expect(sent.method).toBe("POST");
      expect(sent.headers.get("authorization")).toBe("Bearer at-current");
      expect(sent.headers.get("accept")).toBe("text/event-stream");
      // store:false and stream:true are required; sampling and output caps are refused by plan usage.
      expect(JSON.parse(sent.body)).toEqual({
        model: DEFAULT_CHATGPT_MODEL,
        instructions: request.system,
        input: [
          { role: "user", content: "Primeira pergunta?" },
          { role: "assistant", content: "Primeira resposta." },
          { role: "user", content: "Quem decidiu o prazo?" }
        ],
        store: false,
        stream: true
      });
      expect(chat.destination).toEqual({
        kind: "chatgpt",
        id: "chatgpt",
        label: `ChatGPT (seu plano) · ${DEFAULT_CHATGPT_MODEL}`,
        endpoint: `${CHATGPT_API_BASE}/responses`,
        model: DEFAULT_CHATGPT_MODEL,
        external: true,
        subscription: "plano do ChatGPT (Plus ou Pro)"
      });
      expect(JSON.stringify(chat.destination)).not.toContain("at-current");
    });
  });

  test("a configured model is used; data-only events (no event: line) are understood", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const seen: SeenRequest[] = [];
      const dataOnly = sse([
        { data: { type: "response.output_text.delta", delta: "Oi" } },
        { data: { type: "response.completed", response: {} } }
      ]);
      const chat = provider(store, router({ responses: () => streamResponse([": keep-alive\n\n", ...dataOnly]) }, seen), "gpt-6-luna");
      expect(await chat.run(chatRequest())).toEqual({ text: "Oi", stopReason: "end" });
      expect(JSON.parse((seen[0] as SeenRequest).body).model).toBe("gpt-6-luna");
    });
  });

  test("refusals and incomplete answers are reported as such", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const run = (pieces: string[]) => provider(store, router({ responses: () => streamResponse(pieces) })).run(chatRequest());
      const refusal = sse([
        { data: { type: "response.refusal.delta", delta: "Não posso." } },
        { data: { type: "response.completed", response: {} } }
      ]);
      expect((await run(refusal)).stopReason).toBe("refusal");
      expect((await run(events(["meio"], { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }))).stopReason).toBe("length");
      expect((await run(events([], { type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }))).stopReason).toBe("refusal");
    });
  });

  test("a stream that ends before response.completed, or is not JSON, is not a whole answer", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const run = (pieces: string[]) => provider(store, router({ responses: () => streamResponse(pieces) })).run(chatRequest());
      await expectProviderError(run(events(["parcial"], null)), CHATGPT_API_MESSAGES.interrupted, "unavailable");
      await expectProviderError(run([...events(["parcial"], null), "data: [DONE]\n\n"]), CHATGPT_API_MESSAGES.interrupted, "unavailable");
      await expectProviderError(run(["data: {not json\n\n"]), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      await expectProviderError(run([`data: ${"x".repeat(1024 * 1024 + 10)}\n\n`]), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
      await expectProviderError(
        run(sse([{ data: { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } } }])),
        CHATGPT_API_MESSAGES.usageLimit,
        "rate-limit"
      );
      await expectProviderError(run(sse([{ data: { type: "error", error: { code: "subscription_sharing_usage_unavailable" } } }])), CHATGPT_API_MESSAGES.usageUnavailable, "unavailable");
    });
  });

  test("plan-usage errors map to Portuguese provider errors", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const failing = (status: number, code?: string) =>
        provider(store, router({ responses: () => jsonResponse(status, { error: { message: "upstream detail at-current", type: "x", ...(code ? { code } : {}) } }), token: refreshed })).run(chatRequest());
      await expectProviderError(failing(403, "subscription_sharing_user_not_eligible"), CHATGPT_API_MESSAGES.notEligible, "auth");
      await expectProviderError(failing(429, "subscription_sharing_usage_limit_exceeded"), CHATGPT_API_MESSAGES.usageLimit, "rate-limit");
      await expectProviderError(failing(503, "subscription_sharing_usage_unavailable"), CHATGPT_API_MESSAGES.usageUnavailable, "unavailable");
      await expectProviderError(failing(404, "model_not_found"), CHATGPT_API_MESSAGES.modelUnavailable, "bad-request");
      await expectProviderError(failing(400), CHATGPT_API_MESSAGES.badRequest, "bad-request");
      await expectProviderError(failing(500), CHATGPT_API_MESSAGES.unavailable, "unavailable");
      await expectProviderError(failing(401, "subscription_sharing_invalid_user"), CHATGPT_API_MESSAGES.invalidUser, "auth");
      await expectProviderError(
        provider(store, recordingFetch(() => {
          throw new TypeError("ECONNREFUSED");
        })).run(chatRequest()),
        CHATGPT_MESSAGES.unreachable,
        "unavailable"
      );
    });
  });

  test("mapChatGptError prefers the error code, then the HTTP status", () => {
    expect(mapChatGptError(500, "subscription_sharing_user_not_eligible").message).toBe(CHATGPT_API_MESSAGES.notEligible);
    expect(mapChatGptError(401, undefined).code).toBe("auth");
    expect(mapChatGptError(403, undefined).message).toBe(CHATGPT_API_MESSAGES.notEligible);
    expect(mapChatGptError(429, undefined).code).toBe("rate-limit");
    expect(mapChatGptError(503, undefined).message).toBe(CHATGPT_API_MESSAGES.usageUnavailable);
    expect(mapChatGptError(0, "something_new").message).toBe(CHATGPT_API_MESSAGES.unavailable);
  });

  test("a 401 refreshes the token once and retries; a second 401 asks for a new sign-in", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const seen: SeenRequest[] = [];
      const responses: Route = (request) =>
        request.headers.get("authorization") === "Bearer at-new" ? streamResponse(events(["ok"])) : jsonResponse(401, { error: { code: "invalid_token" } });
      expect((await provider(store, router({ responses, token: refreshed }, seen)).run(chatRequest())).text).toBe("ok");
      expect(seen.map((request) => request.url)).toEqual([`${CHATGPT_API_BASE}/responses`, TOKEN_URL, `${CHATGPT_API_BASE}/responses`]);
      expect(new URLSearchParams((seen[1] as SeenRequest).body).get("refresh_token")).toBe("rt-current");
      expect(await store.read()).toMatchObject({ accessToken: "at-new", refreshToken: "rt-new" });

      const always401: Route = () => jsonResponse(401, { error: { code: "invalid_token" } });
      await expectProviderError(provider(store, router({ responses: always401, token: refreshed })).run(chatRequest()), CHATGPT_API_MESSAGES.invalidUser, "auth");
    });
  });

  test("an expired token is refreshed before the request", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const seen: SeenRequest[] = [];
      await provider(store, router({ responses: () => streamResponse(events(["ok"])), token: refreshed }, seen)).run(chatRequest());
      expect(seen.map((request) => request.url)).toEqual([TOKEN_URL, `${CHATGPT_API_BASE}/responses`]);
      expect((seen[1] as SeenRequest).headers.get("authorization")).toBe("Bearer at-new");
    });
  });

  test("signed out, or without plan usage: no request leaves the computer", async () => {
    await withTempDir(async (dir) => {
      const seen: SeenRequest[] = [];
      const fetch = router({ responses: () => streamResponse(events(["x"])) }, seen);
      const empty = new ChatGptStore(join(dir, "empty"));
      expect(await provider(empty, fetch).check()).toEqual({ ready: false, problem: "signed-out", message: CHATGPT_MESSAGES.signedOut });
      await expectProviderError(provider(empty, fetch).run(chatRequest()), CHATGPT_MESSAGES.signedOut, "auth");
      const noPlan = await signedInStore(join(dir, "noplan"), { scopes: ["openid"] });
      expect(await provider(noPlan, fetch).check()).toEqual({ ready: false, problem: "signed-out", message: CHATGPT_MESSAGES.scopeDeclined });
      await expectProviderError(provider(noPlan, fetch).run(chatRequest()), CHATGPT_MESSAGES.scopeDeclined, "auth");
      expect(seen).toHaveLength(0);
      expect(await provider(await signedInStore(join(dir, "ok")), fetch).check()).toEqual({ ready: true });
    });
  });

  test("cancel, silence and oversized answers stop the stream", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const hanging = () => streamResponse(events(["começo"], null), { hangAfter: true });
      const controller = new AbortController();
      const request = chatRequest({ signal: controller.signal });
      const running = provider(store, router({ responses: hanging })).run(request);
      setTimeout(() => controller.abort(), 100);
      await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      expect(request.deltas).toEqual(["começo"]);
      await expectProviderError(provider(store, router({ responses: hanging }), "", { idleMs: 100 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      const aborted = new AbortController();
      aborted.abort();
      await expectProviderError(provider(store, router({ responses: hanging })).run(chatRequest({ signal: aborted.signal })), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      const big = "x".repeat(MAX_ANSWER_CHARACTERS - 2);
      const overflow = await provider(store, router({ responses: () => streamResponse(events([big, "abcd", "never"])) })).run(chatRequest());
      expect(overflow).toEqual({ text: big, stopReason: "length" });
      await expectProviderError(provider(store, router({ responses: hanging })).run(chatRequest({ messages: [{ role: "assistant", content: "x" }] })), COMMON_PROVIDER_MESSAGES.lastNotUser, "bad-request");
    });
  });
});

describe("listChatGptModels", () => {
  test("lists the plan's visible models by slug, without duplicates or unsafe ids", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const seen: SeenRequest[] = [];
      const models = () =>
        jsonResponse(200, {
          data: [
            { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
            { id: "gpt-6-luna", visibility: "list" },
            { slug: "gpt-6.1-sol", display_name: "dup", visibility: "list" },
            { slug: "internal-preview", visibility: "hide" },
            { slug: "-rf", visibility: "list" },
            { slug: "bad\nname", visibility: "list" },
            { slug: "gpt-6-astra", display_name: "line\nbreak" },
            "garbage",
            null
          ]
        });
      expect(await listChatGptModels({ fetch: router({ models }, seen), oauth: { store } })).toEqual([
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
        { id: "gpt-6-luna", label: "gpt-6-luna" },
        { id: "gpt-6-astra", label: "gpt-6-astra" }
      ]);
      expect((seen[0] as SeenRequest).url).toBe(`${CHATGPT_API_BASE}/models`);
      expect((seen[0] as SeenRequest).headers.get("authorization")).toBe("Bearer at-current");
    });
  });

  test("refreshes once on 401 and maps failures", async () => {
    await withTempDir(async (dir) => {
      const store = await signedInStore(dir);
      const models: Route = (request) => (request.headers.get("authorization") === "Bearer at-new" ? jsonResponse(200, { data: [{ slug: "m1" }] }) : jsonResponse(401, {}));
      expect(await listChatGptModels({ fetch: router({ models, token: refreshed }), oauth: { store, endpoints: { tokenUrl: TOKEN_URL } } })).toEqual([{ id: "m1", label: "m1" }]);
      const list = (route: Route) => listChatGptModels({ fetch: router({ models: route }), oauth: { store: new ChatGptStore(store.root) } });
      await expect(list(() => jsonResponse(403, { error: { code: "subscription_sharing_user_not_eligible" } }))).rejects.toThrow(CHATGPT_API_MESSAGES.notEligible);
      await expect(list(() => new Response("not json"))).rejects.toThrow(COMMON_PROVIDER_MESSAGES.malformedStream);
      await expect(list(() => new Response("x".repeat(1024 * 1024 + 1)))).rejects.toThrow(COMMON_PROVIDER_MESSAGES.malformedStream);
      expect(await list(() => jsonResponse(200, { object: "list" }))).toEqual([]);
      await expect(listChatGptModels({ oauth: { store: new ChatGptStore(join(dir, "nobody")) } })).rejects.toThrow(CHATGPT_MESSAGES.signedOut);
    });
  });
});
