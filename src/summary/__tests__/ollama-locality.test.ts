import { expect, test } from "bun:test";
import { isOllamaCloudModel, ollamaLocalByName, probeOllamaLocality } from "../ollama-locality";

const LOCAL = "http://127.0.0.1:11434";

test("Ollama's cloud model names are recognized; ordinary local names are not", () => {
  for (const name of ["gpt-oss:120b-cloud", "glm-4.6:cloud", "qwen3-coder:480b-cloud", "deepseek-v3.1:671b-cloud", "kimi-k2:1t-cloud", "minimax-m2:cloud", "X:CLOUD", "model-cloud:latest"]) {
    expect(isOllamaCloudModel(name)).toBe(true);
  }
  for (const name of ["qwen3.5:9b", "llama3", "soundcloud-tagger:7b", "cloudy:3b", "gemma3:27b-it-qat", ""]) {
    expect(isOllamaCloudModel(name)).toBe(false);
  }
  expect(ollamaLocalByName(LOCAL, "qwen3.5:9b")).toBe(true);
  expect(ollamaLocalByName(LOCAL, "gpt-oss:120b-cloud")).toBe(false);
  expect(ollamaLocalByName("https://ollama.example.test", "qwen3.5:9b")).toBe(false);
  expect(ollamaLocalByName("not a url", "qwen3.5:9b")).toBe(false);
});

test("/api/show decides: model details and no remote host is local; anything else is not", async () => {
  const asked: Array<{ url: string; body: unknown }> = [];
  const serve = (status: number, body: unknown) => (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const info = { "general.architecture": "qwen3" };
  expect(await probeOllamaLocality(LOCAL, "qwen3.5:9b", { fetch: serve(200, { model_info: info }) })).toBe("local");
  expect(asked).toEqual([{ url: `${LOCAL}/api/show`, body: { model: "qwen3.5:9b" } }]);
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(200, { remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b", model_info: info }) })).toBe("cloud");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(200, { remote_model: "gpt-oss:120b" }) })).toBe("cloud");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(200, { model_info: {} }) })).toBe("cloud");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(200, { capabilities: ["completion"] }) })).toBe("cloud");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(404, { error: "not found" }) })).toBe("missing");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(500, "boom") })).toBe("unreachable");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: serve(200, "{not json") })).toBe("unreachable");
  expect(await probeOllamaLocality(LOCAL, "meu-modelo", { fetch: (async () => { throw new Error("refused"); }) as unknown as typeof fetch })).toBe("unreachable");
  // A cloud name or an address outside this computer is never asked.
  asked.length = 0;
  expect(await probeOllamaLocality(LOCAL, "gpt-oss:120b-cloud", { fetch: serve(200, { model_info: info }) })).toBe("cloud");
  expect(await probeOllamaLocality("https://ollama.example.test", "qwen3.5:9b", { fetch: serve(200, { model_info: info }) })).toBe("cloud");
  expect(asked).toEqual([]);
  // A cancelled check is a cancellation, not an answer.
  const controller = new AbortController();
  controller.abort();
  await expect(probeOllamaLocality(LOCAL, "qwen3.5:9b", { signal: controller.signal, fetch: (async (_: unknown, init?: RequestInit) => { init?.signal?.throwIfAborted(); return new Response("{}"); }) as unknown as typeof fetch })).rejects.toThrow();
});
