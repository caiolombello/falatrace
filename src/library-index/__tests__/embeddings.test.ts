import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { decodeVector, dot, embeddingTarget, embedTexts, encodeVector, normalizeVector, reciprocalRankFusion } from "../embeddings";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const configWith = (url: string, model = "nomic-embed-text") => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.ollamaUrl = url;
  config.assistant.embeddingModel = model;
  return config;
};

describe("embeddingTarget", () => {
  test("is off without a model", () => {
    expect(embeddingTarget(configWith("http://127.0.0.1:11434", ""))).toBeUndefined();
    expect(embeddingTarget(configWith("http://127.0.0.1:11434", "   "))).toBeUndefined();
  });

  test("only uses Ollama on this computer", () => {
    expect(embeddingTarget(configWith("http://127.0.0.1:11434"))?.url.href).toBe("http://127.0.0.1:11434/api/embed");
    expect(embeddingTarget(configWith("http://localhost:8080/base/"))?.url.href).toBe("http://localhost:8080/api/embed");
    expect(embeddingTarget(configWith("http://[::1]:11434"))).toBeDefined();
    expect(embeddingTarget(configWith("https://ollama.example.com"))).toBeUndefined();
    expect(embeddingTarget(configWith("http://192.168.0.10:11434"))).toBeUndefined();
    expect(embeddingTarget(configWith("http://user:pw@127.0.0.1:11434"))).toBeUndefined();
    expect(embeddingTarget(configWith("file:///tmp/x"))).toBeUndefined();
    expect(embeddingTarget(configWith("not a url"))).toBeUndefined();
  });
});

describe("vectors", () => {
  test("encode/decode round trip and unit normalization", () => {
    const vector = normalizeVector(new Float32Array([3, 4]));
    expect(vector[0]).toBeCloseTo(0.6);
    expect(dot(vector, vector)).toBeCloseTo(1);
    const decoded = decodeVector(encodeVector(vector), 2);
    expect([...decoded]).toEqual([...vector]);
    expect(() => decodeVector(encodeVector(vector), 3)).toThrow();
    expect(dot(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0);
    expect([...normalizeVector(new Float32Array([0, 0]))]).toEqual([0, 0]);
  });

  test("reciprocal-rank fusion favours items ranked well in both lists", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["b", "c", "a"]]);
    const order = [...fused.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
    expect(order[0]).toBe("b");
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 63);
  });
});

describe("embedTexts", () => {
  const serve = (handler: (body: { model: string; input: string[] }) => Response | Promise<Response>) => {
    const requests: Array<{ model: string; input: string[] }> = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
      const body = await request.json() as { model: string; input: string[] };
      requests.push(body);
      return handler(body);
    } });
    servers.push(server);
    return { target: { url: new URL(`http://127.0.0.1:${server.port}/api/embed`), model: "m" }, requests };
  };

  test("batches inputs, truncates long texts and normalizes vectors", async () => {
    const { target, requests } = serve((body) => Response.json({ embeddings: body.input.map((_text, index) => [index + 1, 0, 0]) }));
    const texts = Array.from({ length: 20 }, (_value, index) => `texto ${index} ${"x".repeat(index === 0 ? 5_000 : 0)}`);
    const vectors = await embedTexts(target, texts);
    expect(vectors).toHaveLength(20);
    expect(requests.map((request) => request.input.length)).toEqual([16, 4]);
    expect(requests[0]!.input[0]!.length).toBe(2_000);
    expect(requests[0]!.model).toBe("m");
    expect(vectors[3]![0]).toBeCloseTo(1);
  });

  test("rejects malformed answers", async () => {
    for (const reply of [
      { embeddings: [[1, 2]] },
      { embeddings: [[1, 2], [1]] },
      { embeddings: [[1, "x"], [1, 2]] },
      { embeddings: [[], []] },
      { nothing: true },
      [1, 2]
    ]) {
      const { target } = serve(() => Response.json(reply));
      await expect(embedTexts(target, ["a", "b"])).rejects.toThrow();
    }
    const { target } = serve(() => new Response("{", { status: 200 }));
    await expect(embedTexts(target, ["a"])).rejects.toThrow("inválida");
  });

  test("reports HTTP errors and honours abort", async () => {
    const { target } = serve(() => new Response("no", { status: 500 }));
    await expect(embedTexts(target, ["a"])).rejects.toThrow("HTTP 500");
    const controller = new AbortController();
    controller.abort();
    await expect(embedTexts(target, ["a"], { signal: controller.signal })).rejects.toThrow();
  });

  test("uses the injected fetch and keeps vector dimensions consistent across batches", async () => {
    let call = 0;
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      call++;
      return Response.json({ embeddings: body.input.map(() => call === 1 ? [1, 2] : [1, 2, 3]) });
    }) as typeof fetch;
    await expect(embedTexts({ url: new URL("http://127.0.0.1:1/api/embed"), model: "m" }, Array.from({ length: 17 }, () => "a"), { deps: { fetch: fake } }))
      .rejects.toThrow("inválida");
  });
});
