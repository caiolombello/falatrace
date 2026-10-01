import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { assertDiarizationUpload, DIARIZATION_UPLOAD_MAX_BYTES, parseDiarizationResponse, normalizeDiarizationResponse, providerErrorDiagnostic, diarizeAudioWithOpenAI } from "../openai";
import type { AppConfig } from "../../config/defaults";

test("diarization survives transport inactivity while retaining the SDK deadline", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "diarization-timeout-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const path = join(root, "audio.webm");
    await fs.writeFile(path, "fixture");
    globalThis.fetch = (async (input, init) => {
      if (String(input).startsWith("data:")) return originalFetch(input, init);
      calls += 1;
      // Model Bun's idle timeout independently of the SDK's AbortSignal.
      if ((init as RequestInit & { timeout?: boolean })?.timeout !== false) {
        throw new Error("The socket connection timed out.");
      }
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ segments: [{ start: 0, end: 1, text: "Olá", speaker: "A" }] });
    }) as typeof fetch;
    const config = { openai: { apiKey: "test-only-key" } } as AppConfig;
    expect(await diarizeAudioWithOpenAI(config, path, 2, "pt")).toEqual([
      { start: 0, end: 1, text: "Olá", speaker: "S01" }
    ]);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a real request timeout is explained without retrying the billable operation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "diarization-timeout-error-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const path = join(root, "audio.webm");
    await fs.writeFile(path, "fixture");
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("data:")) return originalFetch(input, init);
      calls += 1;
      throw new DOMException("Request timed out", "TimeoutError");
    }) as typeof fetch;
    await expect(diarizeAudioWithOpenAI({ openai: { apiKey: "test-only-key" } } as AppConfig, path, 2, "pt"))
      .rejects.toThrow("A OpenAI não concluiu a diarização: tempo de espera excedido");
    expect(calls).toBe(1);
    expect(JSON.parse(await fs.readFile(join(root, "provider-response.json"), "utf8")).error.message).toBe("Request timed out.");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps acoustic speaker identity across the complete recording", () => {
  const result = parseDiarizationResponse({ segments: [
    { start: 0.5, end: 2, text: "Olá.", speaker: "A" },
    { start: 602, end: 604, text: "Tudo bem?", speaker: "B" },
    { start: 1201, end: 1203, text: "Sim.", speaker: "A" }
  ] }, 1210);
  expect(result).toEqual([
    { start: 0.5, end: 2, text: "Olá.", speaker: "S01" },
    { start: 602, end: 604, text: "Tudo bem?", speaker: "S02" },
    { start: 1201, end: 1203, text: "Sim.", speaker: "S01" }
  ]);
});

test("rejects invalid acoustic turns instead of publishing false speaker timing", () => {
  const valid = {start:1,end:2,text:"Olá",speaker:"A"};
  for (const invalid of [{end:0.5},{end:20},{start:-1},{start:NaN},{text:null},{speaker:""},{speaker:"A\nB"}]) {
    expect(() => parseDiarizationResponse({segments:[{...valid,...invalid}]},3)).toThrow("fala inválida");
  }
  expect(() => parseDiarizationResponse({segments:[]},3)).toThrow("falas válidas");
});

test("omits zero-duration provider points without fabricating voice timing", () => {
  const point = { start: 1, end: 1, text: "Sim", speaker: "A" };
  const turn = { start: 2, end: 3, text: "Olá", speaker: "B" };
  expect(normalizeDiarizationResponse({ segments: [point, turn] }, 4)).toEqual({
    ignoredZeroDurationTurns: 1, ignoredEmptyTextTurns: 0, turns: [{ ...turn, speaker: "S01" }]
  });
  expect(() => parseDiarizationResponse({ segments: [point] }, 4)).toThrow("falas válidas");
  expect(normalizeDiarizationResponse({ segments: [{ ...point, end: 1.05, text: "" }, turn] }, 4).ignoredEmptyTextTurns).toBe(1);
});

test("upload boundary rejects oversized, empty and symlink inputs before any API request", async () => {
  const root = await fs.mkdtemp(join(tmpdir(),"diarization-upload-"));
  try {
    const path = join(root,"audio.webm");
    await fs.writeFile(path,"");
    await expect(assertDiarizationUpload(path)).rejects.toThrow("inválido");
    await fs.truncate(path,DIARIZATION_UPLOAD_MAX_BYTES);
    await expect(assertDiarizationUpload(path)).resolves.toBeUndefined();
    await fs.truncate(path,DIARIZATION_UPLOAD_MAX_BYTES+1);
    await expect(assertDiarizationUpload(path)).rejects.toThrow("excede 24 MB");
    await fs.truncate(path,1);
    await fs.symlink(path,join(root,"link.webm"));
    await expect(assertDiarizationUpload(join(root,"link.webm"))).rejects.toThrow("inválido");
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("provider diagnostics retain reason and status without credentials or headers", () => {
  const key = "test-api-secret";
  const error = new OpenAI.APIError(400,{message:`duration too long ${key} sk-masked_123 Bearer private`,code:"audio_too_long"},"failure",new Headers({authorization:"Bearer secret"}));
  const diagnostic = providerErrorDiagnostic(error,key);
  expect(diagnostic.status).toBe(400);
  expect(diagnostic.code).toBe("audio_too_long");
  expect(String(diagnostic.message)).toContain("duration too long");
  for (const secret of [key,"sk-masked_123","private","secret"]) expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(diagnostic).not.toHaveProperty("headers");
});
