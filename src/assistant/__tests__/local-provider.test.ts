import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { COMMON_PROVIDER_MESSAGES } from "../providers/common";
import { createLocalProvider, LOCAL_MESSAGES } from "../providers/local";
import { ProviderError } from "../types";
import { chatRequest, configWith } from "./provider-helpers";

type Behaviour = { status?: number; lines?: string[]; delayMs?: number; hang?: boolean; tags?: unknown; tagsStatus?: number; show?: unknown; showStatus?: number };

let behaviour: Behaviour = {};
const bodies: Array<Record<string, unknown>> = [];
const shown: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json(behaviour.tags ?? { models: [] }, { status: behaviour.tagsStatus ?? 200 });
      if (url.pathname === "/api/show" && request.method === "POST") {
        shown.push(String(((await request.json()) as { model?: unknown }).model));
        return Response.json(behaviour.show ?? { model_info: { "general.architecture": "synthetic" } }, { status: behaviour.showStatus ?? 200 });
      }
      if (url.pathname !== "/api/chat" || request.method !== "POST") return new Response("not found", { status: 404 });
      bodies.push((await request.json()) as Record<string, unknown>);
      if (behaviour.status && behaviour.status !== 200) return Response.json({ error: "model 'x' not found" }, { status: behaviour.status });
      const encoder = new TextEncoder();
      const lines = behaviour.lines ?? [];
      const current = behaviour;
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const line of lines) {
              if (current.delayMs) await Bun.sleep(current.delayMs);
              controller.enqueue(encoder.encode(line));
            }
            if (!current.hang) controller.close();
          }
        }),
        { headers: { "content-type": "application/x-ndjson" } }
      );
    }
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const ndjson = (value: unknown) => `${JSON.stringify(value)}\n`;
const provider = (timeouts?: { totalMs?: number; idleMs?: number; checkMs?: number }) =>
  createLocalProvider(configWith({ provider: "local", localModel: "qwen3.5:9b" }, { ollamaUrl: base }), { timeouts });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).message).toBe(message);
  expect((error as ProviderError).code).toBe(code);
};

describe("local Ollama provider", () => {
  test("streams /api/chat NDJSON, split across reads, to onDelta", async () => {
    const answer = ndjson({ message: { role: "assistant", content: "A Ana " } }) + ndjson({ message: { role: "assistant", content: "decidiu." } });
    behaviour = {
      lines: [answer.slice(0, 10), answer.slice(10, 31), answer.slice(31), ndjson({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 7 })],
      delayMs: 5
    };
    const request = chatRequest({ maxOutputTokens: 300 });
    const result = await provider().run(request);
    expect(result).toEqual({ text: "A Ana decidiu.", stopReason: "end", usage: { inputTokens: 120, outputTokens: 7 } });
    expect(request.deltas).toEqual(["A Ana ", "decidiu."]);
    const body = bodies[bodies.length - 1] as Record<string, unknown>;
    expect(body).toEqual({
      model: "qwen3.5:9b",
      stream: true,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: "Primeira pergunta?" },
        { role: "assistant", content: "Primeira resposta." },
        { role: "user", content: "Quem decidiu o prazo?" }
      ],
      options: { temperature: 0.3, num_predict: 300 }
    });
  });

  test("done_reason length is reported as a cut answer", async () => {
    behaviour = { lines: [ndjson({ message: { content: "parcial" } }), ndjson({ done: true, done_reason: "length" })] };
    expect(await provider().run(chatRequest())).toMatchObject({ text: "parcial", stopReason: "length" });
  });

  test("maps HTTP and stream failures to Portuguese errors", async () => {
    behaviour = { status: 404 };
    await expectProviderError(provider().run(chatRequest()), LOCAL_MESSAGES.modelMissing, "bad-request");
    behaviour = { status: 400 };
    await expectProviderError(provider().run(chatRequest()), LOCAL_MESSAGES.rejected, "bad-request");
    behaviour = { status: 500 };
    await expectProviderError(provider().run(chatRequest()), LOCAL_MESSAGES.failed, "unavailable");
    behaviour = { lines: [ndjson({ message: { content: "a" } }), ndjson({ error: "out of memory" })] };
    await expectProviderError(provider().run(chatRequest()), LOCAL_MESSAGES.failed, "unavailable");
    behaviour = { lines: [ndjson({ message: { content: "a" } })] };
    await expectProviderError(provider().run(chatRequest()), LOCAL_MESSAGES.failed, "unavailable");
    behaviour = { lines: ["{not json\n"] };
    await expectProviderError(provider().run(chatRequest()), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
    behaviour = { lines: ["[1,2]\n"] };
    await expectProviderError(provider().run(chatRequest()), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
    behaviour = { lines: [`${"x".repeat(1024 * 1024 + 10)}`] };
    await expectProviderError(provider().run(chatRequest()), COMMON_PROVIDER_MESSAGES.malformedStream, "protocol");
  });

  test("an unreachable server is reported, not thrown raw", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    const unreachable = createLocalProvider(configWith({ provider: "local" }, { ollamaUrl: url }));
    await expectProviderError(unreachable.run(chatRequest()), LOCAL_MESSAGES.unreachable, "unavailable");
    expect(await unreachable.check()).toEqual({ ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable });
  });

  test("cancel and silence stop the request", async () => {
    behaviour = { lines: [ndjson({ message: { content: "começo" } })], hang: true };
    const controller = new AbortController();
    const request = chatRequest({ signal: controller.signal });
    const running = provider().run(request);
    setTimeout(() => controller.abort(), 100);
    await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
    expect(request.deltas).toEqual(["começo"]);

    await expectProviderError(provider({ idleMs: 100 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
    behaviour = { lines: [ndjson({ message: { content: "a" } }), ndjson({ message: { content: "b" } }), ndjson({ message: { content: "c" } })], delayMs: 60, hang: true };
    await expectProviderError(provider({ totalMs: 100, idleMs: 1_000 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");

    const aborted = new AbortController();
    aborted.abort();
    await expectProviderError(provider().run(chatRequest({ signal: aborted.signal })), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
  });

  test("check() looks the model up in /api/tags", async () => {
    behaviour = { tags: { models: [{ name: "llama3:latest" }, { name: "qwen3.5:9b", model: "qwen3.5:9b" }] } };
    expect(await provider().check()).toEqual({ ready: true });
    behaviour = { tags: { models: [{ name: "llama3:latest" }] } };
    expect(await provider().check()).toEqual({ ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.modelMissing });
    const untagged = createLocalProvider(configWith({ provider: "local", localModel: "llama3" }, { ollamaUrl: base }));
    expect(await untagged.check()).toEqual({ ready: true });
    behaviour = { tags: "garbage" };
    expect((await provider().check()).ready).toBe(false);
    behaviour = { tagsStatus: 500 };
    expect(await provider().check()).toEqual({ ready: false, problem: "unreachable", message: LOCAL_MESSAGES.unreachable });
    const controller = new AbortController();
    controller.abort();
    await expectProviderError(provider().check(controller.signal), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
  });

  test("the destination is loopback-aware and never carries credentials", () => {
    const local = provider();
    expect(local.destination).toEqual({ kind: "local", id: "ollama", label: "Ollama · qwen3.5:9b", endpoint: `${base}/api/chat`, model: "qwen3.5:9b", external: false });
    const remote = createLocalProvider(configWith({ provider: "local" }, { ollamaUrl: "https://ana:segredo@ollama.example.com/?token=abc" }));
    expect(remote.destination.external).toBe(true);
    expect(remote.destination.endpoint).toBe("https://ollama.example.com/api/chat");
    expect(JSON.stringify(remote.destination)).not.toContain("segredo");
    expect(JSON.stringify(remote.destination)).not.toContain("abc");
  });

  test("a cloud model is external even through a loopback server, and a renamed cloud copy is refused before sending", async () => {
    // Named as a cloud model: the destination says it leaves, so the runner asks for consent.
    const cloud = createLocalProvider(configWith({ provider: "local", localModel: "gpt-oss:120b-cloud" }, { ollamaUrl: base }));
    expect(cloud.destination.external).toBe(true);
    for (const name of ["glm-4.6:cloud", "qwen3-coder:480b-cloud", "deepseek-v3.1:671b-cloud-preview"]) {
      expect(createLocalProvider(configWith({ provider: "local", localModel: name }, { ollamaUrl: base })).destination.external).toBe(true);
    }
    behaviour = { tags: { models: [{ name: "gpt-oss:120b-cloud" }] }, lines: [ndjson({ message: { content: "ok" }, done: true })] };
    shown.length = 0;
    expect(await cloud.check()).toEqual({ ready: true });
    expect(await cloud.run(chatRequest())).toMatchObject({ text: "ok" });
    expect(shown).toEqual([]);

    // Another name for a cloud model: the server says it forwards it, so nothing is sent.
    const renamed = createLocalProvider(configWith({ provider: "local", localModel: "meu-modelo" }, { ollamaUrl: base }));
    expect(renamed.destination.external).toBe(false);
    behaviour = { tags: { models: [{ name: "meu-modelo:latest" }] }, show: { remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b", model_info: {} } };
    expect(await renamed.check()).toEqual({ ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.cloudModel });
    const before = bodies.length;
    await expectProviderError(renamed.run(chatRequest()), LOCAL_MESSAGES.cloudModel, "bad-request");
    // Details the server does not give are not proof of a local model either.
    behaviour = { tags: { models: [{ name: "meu-modelo:latest" }] }, show: { capabilities: ["completion"] } };
    expect(await renamed.check()).toEqual({ ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.cloudModel });
    await expectProviderError(renamed.run(chatRequest()), LOCAL_MESSAGES.cloudModel, "bad-request");
    behaviour = { tags: { models: [{ name: "meu-modelo:latest" }] }, showStatus: 404, show: { error: "not found" } };
    await expectProviderError(renamed.run(chatRequest()), LOCAL_MESSAGES.modelMissing, "bad-request");
    expect(bodies.length).toBe(before);
    expect(shown.every((name) => name === "meu-modelo")).toBe(true);
  });

  test("an unsafe Ollama address is refused before any request", async () => {
    const unsafe = createLocalProvider(configWith({ provider: "local" }, { ollamaUrl: "http://192.168.0.10:11434" }));
    expect(unsafe.destination.endpoint).toBe("");
    expect(unsafe.destination.external).toBe(true);
    expect(await unsafe.check()).toEqual({ ready: false, problem: "misconfigured", message: LOCAL_MESSAGES.invalidUrl });
    await expectProviderError(unsafe.run(chatRequest()), LOCAL_MESSAGES.invalidUrl, "bad-request");
    await expectProviderError(provider().run(chatRequest({ messages: [{ role: "assistant", content: "x" }] })), COMMON_PROVIDER_MESSAGES.lastNotUser, "bad-request");
  });
});
