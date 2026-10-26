import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_KEY_MISSING, CUSTOM_BASE_URL_MISSING, testProviderKey } from "../credential-test";
import { setSecret, type SecretFiles } from "../secrets";

const withFiles = async (run: (files: SecretFiles) => Promise<void>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-keytest-"));
  const files: SecretFiles = { "secrets.env": join(root, "secrets.env"), "worker.env": join(root, "worker.env"), "calls.env": join(root, "calls.env") };
  try { await run(files); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

const respond = (status: number, seen: Array<{ url: string; headers: Headers }>) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  seen.push({ url: request.url, headers: request.headers });
  return new Response(status === 200 ? JSON.stringify({ object: "list", data: [] }) : JSON.stringify({ error: { message: "x" } }), {
    status, headers: { "content-type": "application/json" }
  });
}) as typeof fetch;

test("without the user manager's environment the key processing uses is unknown, and nothing is tested", async () => {
  await withFiles(async (files) => {
    await setSecret("OPENAI_API_KEY", "sk-synthetic-test", files);
    const seen: Array<{ url: string; headers: Headers }> = [];
    // The manager may hold a key that wins over the Studio's: testing the Studio's could confirm the wrong one.
    for (const managerEnv of [async () => null, async () => { throw new Error("Failed to connect to bus"); }]) {
      const result = await testProviderKey("openai", { fetch: respond(200, seen), managerEnv, files });
      expect(result).toMatchObject({ provider: "openai", status: "unknown", detail: expect.stringContaining("ambiente dos serviços") });
    }
    expect(seen).toHaveLength(0);
  });
});

test("a missing key is reported without any request", async () => {
  await withFiles(async (files) => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const result = await testProviderKey("openai", { fetch: respond(200, seen), managerEnv: async () => ({}), files });
    expect(result).toMatchObject({ status: "missing", source: "missing" });
    expect(seen).toHaveLength(0);
  });
});

test("OpenAI and Gemini outcomes map to accepted, rejected, limited and unreachable", async () => {
  await withFiles(async (files) => {
    await setSecret("OPENAI_API_KEY", "sk-synthetic-test", files);
    await setSecret("GEMINI_API_KEY", "g-synthetic-test", files);
    for (const [status, expected] of [[200, "ok"], [401, "rejected"], [429, "limited"], [500, "unreachable"]] as const) {
      const seen: Array<{ url: string; headers: Headers }> = [];
      const openai = await testProviderKey("openai", { fetch: respond(status, seen), managerEnv: async () => ({}), files });
      expect(openai).toMatchObject({ provider: "openai", status: expected, source: "secrets.env" });
      expect(seen[0].url).toContain("/models");
      expect(seen[0].headers.get("authorization")).toBe("Bearer sk-synthetic-test");
      const gemini = await testProviderKey("gemini", { fetch: respond(status, seen), managerEnv: async () => ({}), files });
      expect(gemini).toMatchObject({ provider: "gemini", status: expected });
      expect(seen[seen.length - 1].headers.get("x-goog-api-key")).toBe("g-synthetic-test");
      expect(JSON.stringify([openai, gemini])).not.toContain("synthetic-test");
    }
    const offline = await testProviderKey("gemini", { fetch: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch, managerEnv: async () => ({}), files });
    expect(offline.status).toBe("unreachable");
  });
});

test("the legacy key in config.json is still tested for OpenAI", async () => {
  await withFiles(async (files) => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const result = await testProviderKey("openai", { fetch: respond(200, seen), managerEnv: async () => ({}), files, configApiKey: "sk-config" });
    expect(result).toMatchObject({ status: "ok", source: "config" });
  });
});

test("assistant API keys are tested as the Studio's assistant reads them, with one read-only request each", async () => {
  await withFiles(async (files) => {
    for (const [name, provider] of [["OPENROUTER_API_KEY", "openrouter"], ["XAI_API_KEY", "xai"], ["GROQ_API_KEY", "groq"], ["MISTRAL_API_KEY", "mistral"],
      ["DEEPSEEK_API_KEY", "deepseek"], ["TOGETHER_API_KEY", "together"], ["ANTHROPIC_API_KEY", "anthropic"]] as const) {
      await setSecret(name, `${provider}-synthetic-key`, files);
    }
    // The user manager's environment is not consulted: the assistant runs inside the Studio.
    const managerEnv = async () => { throw new Error("unexpected manager read"); };
    for (const [status, expected] of [[200, "ok"], [401, "rejected"], [429, "limited"], [503, "unreachable"]] as const) {
      for (const provider of ["openrouter", "xai", "groq", "mistral", "deepseek", "together"] as const) {
        const seen: Array<{ url: string; headers: Headers }> = [];
        const result = await testProviderKey(provider, { fetch: respond(status, seen), managerEnv, files, env: {} });
        expect(result).toMatchObject({ provider, status: expected, source: "secrets.env" });
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toMatch(provider === "openrouter" ? /^https:\/\/openrouter\.ai\/api\/v1\/key$/ : /\/models$/);
        expect(seen[0].headers.get("authorization")).toBe(`Bearer ${provider}-synthetic-key`);
        expect(JSON.stringify(result)).not.toContain("synthetic-key");
      }
      const seen: Array<{ url: string; headers: Headers }> = [];
      const anthropic = await testProviderKey("anthropic", { fetch: respond(status, seen), managerEnv, files, env: {} });
      expect(anthropic).toMatchObject({ provider: "anthropic", status: expected });
      expect(seen[0].url).toContain("api.anthropic.com/v1/models");
      expect(seen[0].headers.get("authorization")).toBe("Bearer anthropic-synthetic-key");
    }
  });
});

test("assistant keys: a key in the Studio's environment wins; missing keys and an unusable custom address send nothing", async () => {
  await withFiles(async (files) => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const managerEnv = async () => ({});
    expect(await testProviderKey("groq", { fetch: respond(200, seen), managerEnv, files, env: {} })).toMatchObject({ status: "missing", source: "missing", detail: ASSISTANT_KEY_MISSING });
    expect(await testProviderKey("groq", { fetch: respond(200, seen), managerEnv, files, env: { GROQ_API_KEY: "groq-environment" } })).toMatchObject({ status: "ok", source: "environment" });
    expect(seen[0].headers.get("authorization")).toBe("Bearer groq-environment");
    await setSecret("CUSTOM_API_KEY", "custom-synthetic-key", files);
    for (const customBaseUrl of [undefined, "http://192.0.2.10:8080/v1", "https://user:pass@example.invalid/v1", "not a url"]) {
      expect(await testProviderKey("custom", { fetch: respond(200, seen), managerEnv, files, env: {}, ...(customBaseUrl ? { customBaseUrl } : {}) }))
        .toMatchObject({ status: "unknown", detail: CUSTOM_BASE_URL_MISSING });
    }
    expect(seen).toHaveLength(1);
    const local = await testProviderKey("custom", { fetch: respond(200, seen), managerEnv, files, env: {}, customBaseUrl: "http://127.0.0.1:8080/v1/" });
    expect(local).toMatchObject({ provider: "custom", status: "ok" });
    expect(seen[1].url).toBe("http://127.0.0.1:8080/v1/models");
  });
});
