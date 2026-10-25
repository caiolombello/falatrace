import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig, LiveProvider } from "../config/defaults";
import { readSecret as readConfiguredSecret, type SecretName } from "../config/secrets";
import { runCommandDirect } from "../jobs/command";
import { buildOpenAIChunkPrompt, isDiarizedOpenAIModel, openAITranscriptionParameters, parseOpenAIDiarizedResponse, parseOpenAITextResponse } from "../transcription/openai";
import { parseWhisperCppSegments, type WhisperJson } from "../transcription/whisperCpp";
import { LIVE_MESSAGES, LiveError, readOwnedFile } from "./store";

/** Approximate US$ per hour of meeting for each live provider (vendor price pages, checked on `checkedAt`). */
export const LIVE_COST_PER_HOUR = { openai: 0.27, groq: 0.04, "whisper-cpp": 0, checkedAt: "2026-10-25" } as const;

/** Groq bills at least 10 s per request, so shorter chunks only cost more. */
export const LIVE_GROQ_MIN_CHUNK_SECONDS = 10;

export const LIVE_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1"
} as const;

export const liveChunkSeconds = (live: AppConfig["live"]): number =>
  live.provider === "groq" ? Math.max(live.chunkSeconds, LIVE_GROQ_MIN_CHUNK_SECONDS) : live.chunkSeconds;

/** A segment relative to the start of its chunk, in seconds. */
export type LiveSegment = { start: number; end: number; text: string };

/**
 * How a chunk failed. "auth" and "fatal" stop the worker (they would repeat on every chunk); the
 * others skip the chunk and count towards the consecutive-failure limit.
 */
export type LiveFailureKind = "auth" | "fatal" | "rate" | "unavailable" | "invalid" | "failed" | "aborted";

export class LiveTranscribeError extends LiveError {
  constructor(readonly kind: LiveFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LiveTranscribeError";
  }
}

// ---------------------------------------------------------------------------------------------
// Silence check. Same idea as the paid-audio preflight (ffmpeg astats), computed directly on the
// tap's PCM so no extra process runs per chunk during a call.

export type ChunkLevel = {
  /** dBFS of the loudest sample; -Infinity for digital silence. */
  peakDb: number;
  /** dBFS of the whole chunk. */
  rmsDb: number;
  /** Total duration of 20 ms frames louder than `LIVE_SILENCE.frameDb`. */
  activeSeconds: number;
  durationSeconds: number;
};

export const LIVE_SILENCE = {
  /** Below this peak nothing audible happened. */
  peakDb: -50,
  /** A 20 ms frame counts as active above this RMS. */
  frameDb: -45,
  /** Less activity than this is a click or a breath, not speech worth a request. */
  minActiveSeconds: 0.3
} as const;

const WAV_MAX_BYTES = 16 * 1024 * 1024;

const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude / 32_768) : Number.NEGATIVE_INFINITY);

/** Levels of a 16-bit PCM WAV (the tap's format). Throws on anything else. */
export const analyzeWav = (data: Buffer): ChunkLevel => {
  const invalid = (): never => {
    throw new Error("Invalid live chunk WAV");
  };
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WAVE") invalid();
  let offset = 12;
  let format: { channels: number; sampleRate: number } | undefined;
  let samples: { start: number; length: number } | undefined;
  for (let count = 0; count < 64 && offset + 8 <= data.length; count += 1) {
    const id = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > data.length) invalid();
      const tag = data.readUInt16LE(body);
      const channels = data.readUInt16LE(body + 2);
      const sampleRate = data.readUInt32LE(body + 4);
      const bits = data.readUInt16LE(body + 14);
      const pcm = tag === 1 || (tag === 0xfffe && size >= 40 && body + 26 <= data.length && data.readUInt16LE(body + 24) === 1);
      if (!pcm || bits !== 16 || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 192_000) invalid();
      format = { channels, sampleRate };
    } else if (id === "data") {
      // A streamed header may carry 0 or 0xFFFFFFFF; then the samples run to the end of the file.
      const available = data.length - body;
      const length = size === 0 || size === 0xffffffff || size > available ? available : size;
      samples = { start: body, length: length - (length % 2) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !samples) return invalid();
  const total = samples.length / 2;
  const frameLength = Math.max(1, Math.round(format.sampleRate * 0.02) * format.channels);
  const frameThreshold = 32_768 * 10 ** (LIVE_SILENCE.frameDb / 20);
  let peak = 0;
  let sumSquares = 0;
  let activeFrames = 0;
  let frameSquares = 0;
  let frameCount = 0;
  for (let index = 0; index < total; index += 1) {
    const value = data.readInt16LE(samples.start + index * 2);
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    const square = value * value;
    sumSquares += square;
    frameSquares += square;
    frameCount += 1;
    if (frameCount === frameLength || index === total - 1) {
      if (Math.sqrt(frameSquares / frameCount) > frameThreshold) activeFrames += frameCount;
      frameSquares = 0;
      frameCount = 0;
    }
  }
  const perSecond = format.sampleRate * format.channels;
  return {
    peakDb: toDb(peak),
    rmsDb: total ? toDb(Math.sqrt(sumSquares / total)) : Number.NEGATIVE_INFINITY,
    activeSeconds: activeFrames / perSecond,
    durationSeconds: total / perSecond
  };
};

export const measureWavLevel = async (path: string): Promise<ChunkLevel> => {
  const read = await readOwnedFile(path, WAV_MAX_BYTES);
  if (!read) throw new Error("Live chunk is missing");
  return analyzeWav(read.data);
};

export const isSilentChunk = (level: ChunkLevel): boolean =>
  !(level.durationSeconds > 0) || !(level.peakDb >= LIVE_SILENCE.peakDb) || level.activeSeconds < LIVE_SILENCE.minActiveSeconds;

// ---------------------------------------------------------------------------------------------
// Text cleanup: whisper models print tags or stock phrases on noise.

const fold = (value: string): string =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const STOCK_PHRASES = [
  "legendas pela comunidade amara org",
  "legenda pela comunidade amara org",
  "legendas pela comunidade de amara org",
  "subtitles by the amara org community",
  "obrigado por assistir",
  "obrigada por assistir",
  "inscreva se no canal",
  "thanks for watching",
  "thank you for watching",
  "gracias por ver el video"
];

/** Tags such as [BLANK_AUDIO], [MUSIC], (música), ♪ ♪ that carry no speech. */
const TAG = /\[[^\]]{0,40}\]|\((?:m[uú]sica|music|risos|aplausos|sil[eê]ncio|silence|applause|laughter|inaud[ií]vel)[^)]{0,20}\)|[♪♫]+/giu;

/** Live text to show, or "" when the segment is only noise tags or a stock hallucination. */
export const cleanLiveText = (value: string): string => {
  const text = value
    .replace(TAG, " ")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const folded = fold(text);
  if (!folded) return "";
  if (STOCK_PHRASES.some((phrase) => folded === phrase || (phrase.includes("amara") && folded.includes("amara org")))) return "";
  return text.slice(0, 2_000);
};

const clampSegments = (segments: LiveSegment[], duration: number): LiveSegment[] => {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const result: LiveSegment[] = [];
  for (const segment of segments) {
    const text = cleanLiveText(segment.text);
    if (!text) continue;
    const start = Math.min(Math.max(0, segment.start), limit);
    result.push({ start, end: Math.min(Math.max(start, segment.end), limit), text });
  }
  return result;
};

/** whisper.cpp wants a bare language code ("pt"); OpenAI and Groq take ISO-639-1 too. */
export const liveLanguage = (language: string): string =>
  language === "auto" ? "auto" : language.split("-")[0].toLowerCase();

// ---------------------------------------------------------------------------------------------
// Providers.

export type LiveTranscribeDeps = {
  /** Runs whisper-cli. Never `runCommand`: that one waits for heavy admission during calls. */
  run?: typeof runCommandDirect;
  fetch?: typeof fetch;
  endpoints?: Partial<Record<"openai" | "groq", string>>;
  /** Per-request timeout for the cloud providers. */
  requestTimeoutMs?: number;
};

export type LiveChunkInput = {
  provider: LiveProvider;
  config: AppConfig;
  wavPath: string;
  /** Private folder for whisper's output file. */
  workDir: string;
  durationSeconds: number;
  /** Text of the previous chunk, as context for the cloud models. */
  previousText?: string;
  /** Required for openai and groq. */
  apiKey?: string;
  signal?: AbortSignal;
};

const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const WHISPER_JSON_MAX_BYTES = 4 * 1024 * 1024;

const isLoopbackHost = (host: string): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(host);

/** https only (http just for loopback test servers); no credentials in the URL. Trailing slash removed. */
export const validateLiveEndpoint = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new LiveError(LIVE_MESSAGES.invalidEndpoint, { cause: error });
  }
  if (
    url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) {
    throw new LiveError(LIVE_MESSAGES.invalidEndpoint);
  }
  return url.toString().replace(/\/+$/, "");
};

const appendFormValue = (form: FormData, key: string, value: unknown): void => {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    // Same encoding as the OpenAI SDK: key[] per entry.
    for (const entry of value) appendFormValue(form, `${key}[]`, entry);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") form.append(key, String(value));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const failureForStatus = (status: number): LiveTranscribeError => {
  if (status === 401 || status === 403) return new LiveTranscribeError("auth", LIVE_MESSAGES.providerAuth);
  if (status === 429) return new LiveTranscribeError("rate", LIVE_MESSAGES.providerRateLimited);
  if (status === 408 || status >= 500) return new LiveTranscribeError("unavailable", LIVE_MESSAGES.providerUnavailable);
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse);
  }
  return new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed);
};

/** One multipart POST with a timeout tied to the caller's signal. Bodies of error responses are never surfaced. */
const postTranscription = async (
  url: string,
  apiKey: string,
  form: FormData,
  options: { fetch: typeof fetch; signal?: AbortSignal; timeoutMs: number }
): Promise<unknown> => {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        body: form,
        signal: controller.signal,
        redirect: "error"
      });
    } catch (error) {
      if (options.signal?.aborted && !timedOut) throw new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed, { cause: error });
      throw new LiveTranscribeError("unavailable", LIVE_MESSAGES.providerUnavailable);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failureForStatus(response.status);
    }
    let text: string;
    try {
      text = await readBoundedText(response, RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error instanceof LiveTranscribeError) throw error;
      if (options.signal?.aborted && !timedOut) throw new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed);
      throw new LiveTranscribeError("unavailable", LIVE_MESSAGES.providerUnavailable);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

const readChunkBlob = async (wavPath: string): Promise<Blob> => {
  const read = await readOwnedFile(wavPath, WAV_MAX_BYTES);
  if (!read) throw new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed);
  return new Blob([new Uint8Array(read.data)], { type: "audio/wav" });
};

const requireKey = (input: LiveChunkInput): string => {
  if (!input.apiKey) {
    throw new LiveTranscribeError("fatal", input.provider === "groq" ? LIVE_MESSAGES.groqKeyMissing : LIVE_MESSAGES.openaiKeyMissing);
  }
  return input.apiKey;
};

const requestTimeout = (input: LiveChunkInput, deps: LiveTranscribeDeps): number =>
  deps.requestTimeoutMs ?? Math.max(30_000, Math.ceil(input.durationSeconds * 4_000));

const transcribeOpenAI = async (input: LiveChunkInput, deps: LiveTranscribeDeps): Promise<LiveSegment[]> => {
  const apiKey = requireKey(input);
  const { config } = input;
  const model = config.live.openaiModel;
  const base = validateLiveEndpoint(deps.endpoints?.openai ?? LIVE_ENDPOINTS.openai);
  const form = new FormData();
  form.append("file", await readChunkBlob(input.wavPath), "chunk.wav");
  form.append("model", model);
  const diarized = isDiarizedOpenAIModel(model);
  const prompt = diarized ? "" : buildOpenAIChunkPrompt(config.transcription.openaiPrompt, (input.previousText ?? "").slice(-1_000));
  const parameters = openAITranscriptionParameters(model, liveLanguage(config.transcription.language), prompt, config.transcription.expectedLanguages);
  for (const [key, value] of Object.entries(parameters)) appendFormValue(form, key, value);
  const body = await postTranscription(`${base}/audio/transcriptions`, apiKey, form, {
    fetch: deps.fetch ?? fetch, signal: input.signal, timeoutMs: requestTimeout(input, deps)
  });
  if (!isRecord(body)) throw new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse);
  try {
    const segments = diarized ? parseOpenAIDiarizedResponse(body, 0) : parseOpenAITextResponse(body, 0, input.durationSeconds);
    return segments.map((segment) => ({ start: segment.start, end: segment.end, text: segment.text }));
  } catch (error) {
    throw new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse, { cause: error });
  }
};

/** Groq verbose_json: segments with times; drops segments the model itself marks as non-speech. */
export const parseGroqResponse = (body: unknown, duration: number): LiveSegment[] => {
  const invalid = (): never => {
    throw new LiveTranscribeError("invalid", LIVE_MESSAGES.providerInvalidResponse);
  };
  if (!isRecord(body)) return invalid();
  if (body.segments === undefined || body.segments === null) {
    if (typeof body.text !== "string" || body.text.length > 100_000) return invalid();
    const text = body.text.trim();
    return text ? [{ start: 0, end: duration, text }] : [];
  }
  if (!Array.isArray(body.segments) || body.segments.length > 10_000) return invalid();
  const segments: LiveSegment[] = [];
  for (const value of body.segments) {
    if (!isRecord(value)) return invalid();
    const { start, end, text, no_speech_prob: noSpeech, avg_logprob: logProb } = value;
    if (
      typeof start !== "number" || !Number.isFinite(start) || start < 0 ||
      typeof end !== "number" || !Number.isFinite(end) || end < start ||
      typeof text !== "string" || text.length > 10_000
    ) {
      return invalid();
    }
    // Whisper's own hallucination heuristic: likely silence and low confidence.
    if (typeof noSpeech === "number" && typeof logProb === "number" && noSpeech >= 0.6 && logProb <= -1) continue;
    segments.push({ start, end, text });
  }
  return segments;
};

const transcribeGroq = async (input: LiveChunkInput, deps: LiveTranscribeDeps): Promise<LiveSegment[]> => {
  const apiKey = requireKey(input);
  const { config } = input;
  const base = validateLiveEndpoint(deps.endpoints?.groq ?? LIVE_ENDPOINTS.groq);
  const form = new FormData();
  form.append("file", await readChunkBlob(input.wavPath), "chunk.wav");
  form.append("model", config.live.groqModel);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  appendFormValue(form, "timestamp_granularities", ["segment"]);
  const language = liveLanguage(config.transcription.language);
  if (language !== "auto") form.append("language", language);
  // Groq caps the prompt at 224 tokens: keep only the tail of the previous chunk.
  const previous = (input.previousText ?? "").trim().slice(-400);
  if (previous) form.append("prompt", previous);
  const body = await postTranscription(`${base}/audio/transcriptions`, apiKey, form, {
    fetch: deps.fetch ?? fetch, signal: input.signal, timeoutMs: requestTimeout(input, deps)
  });
  return parseGroqResponse(body, input.durationSeconds);
};

const transcribeWhisper = async (input: LiveChunkInput, deps: LiveTranscribeDeps): Promise<LiveSegment[]> => {
  const { config } = input;
  const run = deps.run ?? runCommandDirect;
  const prefix = join(input.workDir, `whisper-${randomUUID()}`);
  try {
    try {
      await run(
        config.transcription.whisperCpp.command,
        [
          "-m", config.live.whisperModelPath,
          "-f", input.wavPath,
          "-l", liveLanguage(config.transcription.language),
          "-t", String(config.live.whisperThreads),
          "-oj",
          "-of", prefix
        ],
        { timeoutMs: Math.max(60_000, Math.ceil(input.durationSeconds * 6_000)), signal: input.signal }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LiveTranscribeError("fatal", LIVE_MESSAGES.whisperMissing, { cause: error });
      if (input.signal?.aborted) throw new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed, { cause: error });
      throw new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed, { cause: error });
    }
    input.signal?.throwIfAborted();
    const read = await readOwnedFile(`${prefix}.json`, WHISPER_JSON_MAX_BYTES).catch((error) => {
      throw new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed, { cause: error });
    });
    if (!read) throw new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.data.toString("utf8"));
    } catch (error) {
      throw new LiveTranscribeError("invalid", LIVE_MESSAGES.chunkFailed, { cause: error });
    }
    if (!isRecord(parsed)) throw new LiveTranscribeError("invalid", LIVE_MESSAGES.chunkFailed);
    try {
      return parseWhisperCppSegments(parsed as WhisperJson).map((segment) => ({ start: segment.start, end: segment.end, text: segment.text }));
    } catch (error) {
      throw new LiveTranscribeError("invalid", LIVE_MESSAGES.chunkFailed, { cause: error });
    }
  } finally {
    await fs.rm(`${prefix}.json`, { force: true }).catch(() => undefined);
  }
};

/** Transcribe one chunk; segment times are relative to the chunk, clamped to it, cleaned of noise tags. */
export const transcribeLiveChunk = async (input: LiveChunkInput, deps: LiveTranscribeDeps = {}): Promise<LiveSegment[]> => {
  if (input.signal?.aborted) throw new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed);
  let segments: LiveSegment[];
  try {
    segments = input.provider === "whisper-cpp"
      ? await transcribeWhisper(input, deps)
      : input.provider === "openai"
        ? await transcribeOpenAI(input, deps)
        : await transcribeGroq(input, deps);
  } catch (error) {
    if (error instanceof LiveTranscribeError) throw error;
    if (error instanceof LiveError) throw new LiveTranscribeError("fatal", error.message, { cause: error });
    if (input.signal?.aborted) throw new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed, { cause: error });
    throw new LiveTranscribeError("failed", LIVE_MESSAGES.chunkFailed, { cause: error });
  }
  return clampSegments(segments, input.durationSeconds);
};

/** The key a cloud provider needs (undefined for whisper-cpp or when not configured). */
export const liveProviderKey = async (
  provider: LiveProvider,
  config: AppConfig,
  readSecret: (name: SecretName) => Promise<string | undefined> = (name) => readConfiguredSecret(name)
): Promise<string | undefined> => {
  if (provider === "openai") return (await readSecret("OPENAI_API_KEY")) || config.openai.apiKey || undefined;
  if (provider === "groq") return (await readSecret("GROQ_API_KEY")) || undefined;
  return undefined;
};
