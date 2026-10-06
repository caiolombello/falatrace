import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testProviderKey } from "../credential-test";
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
      const openai = await testProviderKey("openai", { fetch: respond(status, seen), managerEnv: async () => null, files });
      expect(openai).toMatchObject({ provider: "openai", status: expected, source: "secrets.env" });
      expect(seen[0].url).toContain("/models");
      expect(seen[0].headers.get("authorization")).toBe("Bearer sk-synthetic-test");
      const gemini = await testProviderKey("gemini", { fetch: respond(status, seen), managerEnv: async () => null, files });
      expect(gemini).toMatchObject({ provider: "gemini", status: expected });
      expect(seen[seen.length - 1].headers.get("x-goog-api-key")).toBe("g-synthetic-test");
      expect(JSON.stringify([openai, gemini])).not.toContain("synthetic-test");
    }
    const offline = await testProviderKey("gemini", { fetch: (async () => { throw new TypeError("network"); }) as unknown as typeof fetch, managerEnv: async () => null, files });
    expect(offline.status).toBe("unreachable");
  });
});

test("the legacy key in config.json is still tested for OpenAI", async () => {
  await withFiles(async (files) => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const result = await testProviderKey("openai", { fetch: respond(200, seen), managerEnv: async () => null, files, configApiKey: "sk-config" });
    expect(result).toMatchObject({ status: "ok", source: "config" });
  });
});
