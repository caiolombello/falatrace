import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import type { runCommandDirect } from "../../jobs/command";
import { LIVE_MESSAGES } from "../store";
import {
  analyzeWav,
  cleanLiveText,
  isSilentChunk,
  LIVE_COST_PER_HOUR,
  LIVE_ENDPOINTS,
  type LiveChunkInput,
  LiveTranscribeError,
  liveChunkSeconds,
  liveLanguage,
  liveProviderKey,
  measureWavLevel,
  parseGroqResponse,
  transcribeLiveChunk,
  validateLiveEndpoint
} from "../transcribe";
import { makeWav, silence, sine } from "./helpers";

let dir: string;
let config: AppConfig;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "live-transcribe-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.live.enabled = true;
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const writeChunk = async (samples = sine(1)): Promise<string> => {
  const path = join(dir, "chunk-00000.wav");
  await writeFile(path, makeWav(samples));
  return path;
};

const input = (overrides: Partial<LiveChunkInput>): LiveChunkInput => ({
  provider: "whisper-cpp",
  config,
  wavPath: join(dir, "chunk-00000.wav"),
  workDir: dir,
  durationSeconds: 15,
  ...overrides
});

const expectFailure = async (promise: Promise<unknown>, kind: string, message?: string): Promise<LiveTranscribeError> => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(LiveTranscribeError);
  expect((error as LiveTranscribeError).kind).toBe(kind as LiveTranscribeError["kind"]);
  if (message) expect((error as Error).message).toBe(message);
  return error as LiveTranscribeError;
};

type Captured = { headers: Headers; form: FormData; path: string };

const serve = (respond: (captured: Captured) => Response | Promise<Response>) => {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const entry = { headers: request.headers, form: await request.formData(), path: new URL(request.url).pathname };
      captured.push(entry);
      return respond(entry);
    }
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}/v1`, captured };
};

describe("cost, chunk size, language", () => {
  test("cost table with its check date", () => {
    expect(LIVE_COST_PER_HOUR).toEqual({ openai: 0.27, groq: 0.04, "whisper-cpp": 0, checkedAt: "2026-10-25" });
  });

  test("Groq chunks are at least 10 seconds; others keep the setting", () => {
    expect(liveChunkSeconds({ ...config.live, provider: "groq", chunkSeconds: 5 })).toBe(10);
    expect(liveChunkSeconds({ ...config.live, provider: "groq", chunkSeconds: 20 })).toBe(20);
    expect(liveChunkSeconds({ ...config.live, provider: "openai", chunkSeconds: 5 })).toBe(5);
    expect(liveChunkSeconds({ ...config.live, provider: "whisper-cpp", chunkSeconds: 7 })).toBe(7);
  });

  test("language codes are reduced to the primary subtag", () => {
    expect(liveLanguage("pt-BR")).toBe("pt");
    expect(liveLanguage("pt")).toBe("pt");
    expect(liveLanguage("auto")).toBe("auto");
  });
});

describe("silence check", () => {
  test("digital silence, faint noise and a lone click are silent; speech-level audio is not", () => {
    const zero = analyzeWav(makeWav(silence(1)));
    expect(zero.peakDb).toBe(Number.NEGATIVE_INFINITY);
    expect(isSilentChunk(zero)).toBe(true);

    const faint = analyzeWav(makeWav(sine(1, -60)));
    expect(faint.peakDb).toBeLessThan(-55);
    expect(isSilentChunk(faint)).toBe(true);

    const click = silence(2);
    click.set(sine(0.05, -6), 8_000);
    const clickLevel = analyzeWav(makeWav(click));
    expect(clickLevel.peakDb).toBeGreaterThan(-10);
    expect(clickLevel.activeSeconds).toBeLessThan(0.3);
    expect(isSilentChunk(clickLevel)).toBe(true);

    const speech = analyzeWav(makeWav(sine(1, -20)));
    expect(speech.peakDb).toBeCloseTo(-20, 0);
    expect(speech.rmsDb).toBeCloseTo(-23, 0);
    expect(speech.activeSeconds).toBeCloseTo(1, 1);
    expect(speech.durationSeconds).toBeCloseTo(1, 3);
    expect(isSilentChunk(speech)).toBe(false);
  });

  test("reads ffmpeg-style headers: LIST chunk, streamed size, extensible format, stereo", () => {
    expect(isSilentChunk(analyzeWav(makeWav(sine(1), { list: true })))).toBe(false);
    expect(analyzeWav(makeWav(sine(1), { dataSize: 0xffffffff })).durationSeconds).toBeCloseTo(1, 3);
    expect(analyzeWav(makeWav(sine(1), { dataSize: 0 })).durationSeconds).toBeCloseTo(1, 3);
    expect(isSilentChunk(analyzeWav(makeWav(sine(1), { extensible: true })))).toBe(false);
    expect(analyzeWav(makeWav(sine(1), { channels: 2 })).durationSeconds).toBeCloseTo(0.5, 3);
  });

  test("anything else is refused", () => {
    expect(() => analyzeWav(Buffer.from("not a wav file at all"))).toThrow();
    expect(() => analyzeWav(makeWav(sine(1), { bits: 24 }))).toThrow();
    expect(() => analyzeWav(makeWav(sine(1), { rate: 4_000 }))).toThrow();
    const noData = makeWav(sine(0.1)).subarray(0, 36);
    expect(() => analyzeWav(noData)).toThrow();
  });

  test("measureWavLevel reads the file and refuses a missing one", async () => {
    const path = await writeChunk(sine(1));
    expect(isSilentChunk(await measureWavLevel(path))).toBe(false);
    await expect(measureWavLevel(join(dir, "missing.wav"))).rejects.toThrow();
  });
});

describe("cleanLiveText", () => {
  test("drops noise tags and stock hallucinations, keeps speech", () => {
    expect(cleanLiveText("[BLANK_AUDIO]")).toBe("");
    expect(cleanLiveText(" (música) ")).toBe("");
    expect(cleanLiveText("♪ ♪")).toBe("");
    expect(cleanLiveText("Legendas pela comunidade Amara.org")).toBe("");
    expect(cleanLiveText("Obrigado por assistir!")).toBe("");
    expect(cleanLiveText("Obrigado.")).toBe("Obrigado.");
    expect(cleanLiveText("  Vamos   revisar o\tprazo [risos] do contrato. ")).toBe("Vamos revisar o prazo do contrato.");
    expect(cleanLiveText(`texto${String.fromCharCode(0x202e)}escondido`)).toBe("texto escondido");
  });
});

describe("validateLiveEndpoint", () => {
  test("https, or http on loopback only, without credentials", () => {
    expect(validateLiveEndpoint(LIVE_ENDPOINTS.groq)).toBe("https://api.groq.com/openai/v1");
    expect(validateLiveEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(validateLiveEndpoint("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    for (const bad of ["http://api.groq.com/openai/v1", "https://user:pass@api.groq.com/v1", "ftp://x", "not a url", "https://api.groq.com/v1?x=1"]) {
      expect(() => validateLiveEndpoint(bad)).toThrow(LIVE_MESSAGES.invalidEndpoint);
    }
  });
});

describe("whisper-cpp", () => {
  const whisperOutput = (segments: Array<{ from: number; to: number; text: string }>) =>
    JSON.stringify({ result: { language: "pt" }, transcription: segments.map((segment) => ({ offsets: { from: segment.from, to: segment.to }, text: segment.text })) });

  test("runs whisper-cli with the live model and threads, parses and removes its JSON", async () => {
    config.transcription.language = "pt-BR";
    config.live.whisperThreads = 3;
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const run = (async (command: string, args: string[], options?: { timeoutMs?: number }) => {
      calls.push({ command, args, options });
      const prefix = args[args.indexOf("-of") + 1];
      await writeFile(`${prefix}.json`, whisperOutput([{ from: 0, to: 2400, text: " Bom dia a todos." }, { from: 2400, to: 99_000, text: "[BLANK_AUDIO]" }, { from: 3000, to: 99_000, text: "Até o fim" }]));
      return { stdout: "", stderr: "" };
    }) as typeof runCommandDirect;
    const segments = await transcribeLiveChunk(input({}), { run });
    expect(segments).toEqual([
      { start: 0, end: 2.4, text: "Bom dia a todos." },
      { start: 3, end: 15, text: "Até o fim" }
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("whisper-cli");
    const args = calls[0].args;
    expect(args.slice(0, 8)).toEqual(["-m", config.live.whisperModelPath, "-f", join(dir, "chunk-00000.wav"), "-l", "pt", "-t", "3"]);
    expect(args.slice(8, 10)).toEqual(["-oj", "-of"]);
    expect(args[10].startsWith(join(dir, "whisper-"))).toBe(true);
    expect((calls[0].options as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  test("a missing whisper-cli is fatal; other failures skip the chunk; output is validated", async () => {
    const missing = (async () => {
      throw Object.assign(new Error("spawn whisper-cli ENOENT"), { code: "ENOENT" });
    }) as typeof runCommandDirect;
    await expectFailure(transcribeLiveChunk(input({}), { run: missing }), "fatal", LIVE_MESSAGES.whisperMissing);

    const crash = (async () => {
      throw new Error("whisper-cli failed with code 1");
    }) as typeof runCommandDirect;
    await expectFailure(transcribeLiveChunk(input({}), { run: crash }), "failed", LIVE_MESSAGES.chunkFailed);

    const writes = (content: string) => (async (_command: string, args: string[]) => {
      await writeFile(`${args[args.indexOf("-of") + 1]}.json`, content);
      return { stdout: "", stderr: "" };
    }) as typeof runCommandDirect;
    await expectFailure(transcribeLiveChunk(input({}), { run: writes("{") }), "invalid");
    await expectFailure(transcribeLiveChunk(input({}), { run: writes("[]") }), "invalid");
    await expectFailure(transcribeLiveChunk(input({}), { run: writes(JSON.stringify({ transcription: [{ offsets: { from: 5, to: 1 }, text: "x" }] })) }), "invalid");
    const silentRun = (async () => ({ stdout: "", stderr: "" })) as typeof runCommandDirect;
    await expectFailure(transcribeLiveChunk(input({}), { run: silentRun }), "failed");
    expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  test("abort is reported as aborted", async () => {
    const controller = new AbortController();
    const run = (async (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      throw new Error("whisper-cli cancelled");
    }) as typeof runCommandDirect;
    await expectFailure(transcribeLiveChunk(input({ signal: controller.signal }), { run }), "aborted");
    await expectFailure(transcribeLiveChunk(input({ signal: controller.signal }), { run }), "aborted");
  });
});

describe("openai", () => {
  test("posts the chunk like the batch transcription (gpt-transcribe: languages[], json) with context", async () => {
    await writeChunk();
    const server = serve(() => Response.json({ text: " Vamos começar pela pauta. " }));
    const segments = await transcribeLiveChunk(
      input({ provider: "openai", apiKey: "sk-test-live-0000000000000000", previousText: "fala anterior", durationSeconds: 12 }),
      { endpoints: { openai: server.base } }
    );
    expect(segments).toEqual([{ start: 0, end: 12, text: "Vamos começar pela pauta." }]);
    const request = server.captured[0];
    expect(request.path).toBe("/v1/audio/transcriptions");
    expect(request.headers.get("authorization")).toBe("Bearer sk-test-live-0000000000000000");
    expect(request.form.get("model")).toBe("gpt-transcribe");
    expect(request.form.getAll("languages[]")).toEqual(["pt"]);
    expect(request.form.get("language")).toBeNull();
    expect(request.form.get("response_format")).toBe("json");
    expect(String(request.form.get("prompt"))).toContain("fala anterior");
    const file = request.form.get("file") as File;
    expect(file.type).toMatch(/^audio\/(x-)?wav$/);
    expect(file.name).toBe("chunk.wav");
    expect(file.size).toBeGreaterThan(44);
  });

  test("other models send language", async () => {
    await writeChunk();
    config.live.openaiModel = "gpt-4o-mini-transcribe";
    const server = serve(() => Response.json({ text: "ok" }));
    await transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { endpoints: { openai: server.base } });
    expect(server.captured[0].form.get("language")).toBe("pt");
  });

  test("maps HTTP failures without leaking bodies or keys", async () => {
    await writeChunk();
    const cases: Array<[number, string, string]> = [
      [401, "auth", LIVE_MESSAGES.providerAuth],
      [403, "auth", LIVE_MESSAGES.providerAuth],
      [429, "rate", LIVE_MESSAGES.providerRateLimited],
      [500, "unavailable", LIVE_MESSAGES.providerUnavailable],
      [503, "unavailable", LIVE_MESSAGES.providerUnavailable],
      [400, "invalid", LIVE_MESSAGES.providerInvalidResponse],
      [413, "invalid", LIVE_MESSAGES.providerInvalidResponse],
      [404, "failed", LIVE_MESSAGES.chunkFailed]
    ];
    for (const [status, kind, message] of cases) {
      const server = serve(() => new Response(JSON.stringify({ error: { message: "secret detail sk-test-key" } }), { status }));
      const error = await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "sk-test-key" }), { endpoints: { openai: server.base } }), kind, message);
      expect(error.message).not.toContain("sk-test-key");
      expect(error.message).not.toContain("secret detail");
    }
  });

  test("invalid, oversized or empty answers are refused or empty", async () => {
    await writeChunk();
    for (const body of ["{", "[]", JSON.stringify({ text: 5 })]) {
      const server = serve(() => new Response(body, { headers: { "content-type": "application/json" } }));
      await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { endpoints: { openai: server.base } }), "invalid");
    }
    const huge = serve(() => new Response(JSON.stringify({ text: "a".repeat(3 * 1024 * 1024) })));
    await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { endpoints: { openai: huge.base } }), "invalid");
    const empty = serve(() => Response.json({ text: "   " }));
    expect(await transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { endpoints: { openai: empty.base } })).toEqual([]);
  });

  test("missing key is fatal; unreachable or slow servers are unavailable; abort is aborted", async () => {
    await writeChunk();
    await expectFailure(transcribeLiveChunk(input({ provider: "openai" })), "fatal", LIVE_MESSAGES.openaiKeyMissing);
    const refused = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { fetch: refused }), "unavailable");
    const slow = serve(async () => {
      await Bun.sleep(2_000);
      return Response.json({ text: "late" });
    });
    await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { endpoints: { openai: slow.base }, requestTimeoutMs: 100 }), "unavailable");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k", signal: controller.signal }), { endpoints: { openai: slow.base } }), "aborted");
  });

  test("a non-https endpoint is refused before sending audio", async () => {
    await writeChunk();
    let called = false;
    const spy = (async () => {
      called = true;
      return Response.json({ text: "x" });
    }) as unknown as typeof fetch;
    await expectFailure(transcribeLiveChunk(input({ provider: "openai", apiKey: "k" }), { fetch: spy, endpoints: { openai: "http://example.com/v1" } }), "fatal", LIVE_MESSAGES.invalidEndpoint);
    expect(called).toBe(false);
  });
});

describe("groq", () => {
  test("verbose_json with language and segment timestamps; drops likely-silence segments", async () => {
    await writeChunk();
    config.transcription.language = "pt-BR";
    const server = serve(() =>
      Response.json({
        text: "ignored",
        segments: [
          { start: 0.5, end: 3.2, text: " Primeiro ponto.", no_speech_prob: 0.01, avg_logprob: -0.2 },
          { start: 3.2, end: 9, text: " Legendas pela comunidade Amara.org", no_speech_prob: 0.2, avg_logprob: -0.3 },
          { start: 9, end: 10, text: " ruído", no_speech_prob: 0.9, avg_logprob: -1.4 },
          { start: 10, end: 12, text: " Segundo ponto." }
        ]
      }));
    const segments = await transcribeLiveChunk(
      input({ provider: "groq", apiKey: "gsk_test", previousText: "x".repeat(1_000), durationSeconds: 10 }),
      { endpoints: { groq: server.base } }
    );
    expect(segments).toEqual([
      { start: 0.5, end: 3.2, text: "Primeiro ponto." },
      { start: 10, end: 10, text: "Segundo ponto." }
    ]);
    const form = server.captured[0].form;
    expect(server.captured[0].headers.get("authorization")).toBe("Bearer gsk_test");
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("pt");
    expect(form.get("temperature")).toBe("0");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    expect(String(form.get("prompt")).length).toBe(400);
  });

  test("auto language is omitted; text-only answers become one segment", async () => {
    await writeChunk();
    config.transcription.language = "auto";
    const server = serve(() => Response.json({ text: " Só texto. " }));
    expect(await transcribeLiveChunk(input({ provider: "groq", apiKey: "k", durationSeconds: 10 }), { endpoints: { groq: server.base } }))
      .toEqual([{ start: 0, end: 10, text: "Só texto." }]);
    expect(server.captured[0].form.get("language")).toBeNull();
    expect(server.captured[0].form.get("prompt")).toBeNull();
  });

  test("malformed segments are refused", () => {
    expect(() => parseGroqResponse({ segments: [{ start: 2, end: 1, text: "x" }] }, 10)).toThrow(LIVE_MESSAGES.providerInvalidResponse);
    expect(() => parseGroqResponse({ segments: "x" }, 10)).toThrow();
    expect(() => parseGroqResponse({ segments: [null] }, 10)).toThrow();
    expect(() => parseGroqResponse("x", 10)).toThrow();
    expect(() => parseGroqResponse({}, 10)).toThrow();
  });

  test("missing key is fatal", async () => {
    await writeChunk();
    await expectFailure(transcribeLiveChunk(input({ provider: "groq" })), "fatal", LIVE_MESSAGES.groqKeyMissing);
  });
});

test("liveProviderKey reads the right secret", async () => {
  const asked: string[] = [];
  const readSecret = async (name: string) => {
    asked.push(name);
    return name === "GROQ_API_KEY" ? "gsk" : undefined;
  };
  expect(await liveProviderKey("groq", config, readSecret)).toBe("gsk");
  expect(await liveProviderKey("openai", config, readSecret)).toBeUndefined();
  config.openai.apiKey = "legacy";
  expect(await liveProviderKey("openai", config, readSecret)).toBe("legacy");
  expect(await liveProviderKey("whisper-cpp", config, readSecret)).toBeUndefined();
  expect(asked).toEqual(["GROQ_API_KEY", "OPENAI_API_KEY", "OPENAI_API_KEY"]);
});
