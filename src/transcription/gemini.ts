import { assertPaidAudioSignal } from "./audio-preflight";
import { promises as fs } from "node:fs";
import { JOB_VERSION, type Transcript, type TranscriptSegment } from "../jobs/types";
import { extractAudioMp3, probeMedia } from "../jobs/media";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_AUDIO_DURATION = 1_800;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;

type GeminiAudioOptions = {
  model: string;
  language: string;
  duration: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const spokenCharacters = (text: string): string =>
  text.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");

const wordOffset = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value)) {
    throw new Error("Gemini retornou um tempo de palavra inválido");
  }
  const offset = Number(value.slice(0, -1));
  if (!Number.isFinite(offset)) throw new Error("Gemini retornou um tempo de palavra inválido");
  return offset;
};

const readableSegments = (words: TranscriptSegment[]): TranscriptSegment[] => {
  const segments: TranscriptSegment[] = [];
  for (const word of words) {
    const previous = segments[segments.length - 1];
    if (
      previous && previous.speaker === word.speaker &&
      word.start - previous.end <= 0.8 &&
      word.end - previous.start <= 5 &&
      previous.text.length + word.text.length + 1 <= 84
    ) {
      previous.text += /^[,.;:!?]/.test(word.text) ? word.text : ` ${word.text}`;
      previous.end = Math.max(previous.end, word.end);
    } else {
      segments.push({ ...word });
    }
  }
  return segments;
};

const parseGeminiResponse = (value: unknown, options: GeminiAudioOptions): Transcript => {
  if (!isObject(value) || value.status !== "completed" || !Array.isArray(value.steps)) {
    throw new Error("Gemini não concluiu a transcrição");
  }
  const words: TranscriptSegment[] = [];
  for (const step of value.steps) {
    if (!isObject(step) || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const content of step.content) {
      if (!isObject(content) || content.type !== "text") continue;
      if (typeof content.text !== "string" || content.text.length > 1_000_000) {
        throw new Error("Gemini retornou texto inválido");
      }
      if (!content.text.trim()) continue;
      if (!Array.isArray(content.annotations)) {
        throw new Error("Gemini retornou texto sem tempos por palavra");
      }
      const countBefore = words.length;
      for (const annotation of content.annotations) {
        if (!isObject(annotation) || annotation.type !== "word_info") continue;
        const start = wordOffset(annotation.start_offset);
        const end = wordOffset(annotation.end_offset);
        const text = annotation.text;
        const speaker = annotation.speaker;
        if (
          typeof text !== "string" || !text.trim() || text.length > 10_000 ||
          typeof speaker !== "string" || !speaker || speaker.length > 200 ||
          /[\u0000-\u001f\u007f-\u009f]/.test(speaker) || end < start ||
          end > options.duration + 1 || words.length >= 100_000
        ) {
          throw new Error("Gemini retornou uma palavra, falante ou intervalo inválido");
        }
        words.push({ start, end, text: text.trim(), speaker });
      }
      if (words.length === countBefore) throw new Error("Gemini retornou texto sem tempos por palavra");
      const annotatedText = words.slice(countBefore).map((word) => word.text).join(" ");
      if (spokenCharacters(annotatedText) !== spokenCharacters(content.text)) {
        throw new Error("Os tempos por palavra do Gemini não cobrem todo o texto");
      }
    }
  }
  if (!words.length) throw new Error("Gemini retornou uma transcrição vazia ou sem palavras alinhadas");
  // Overlapping replies can be listed after the speaker's complete turn.
  // Preserve reading order in text; group captions only after ordering word timings.
  const text = readableSegments(words).map((segment) => segment.text).join(" ");
  words.sort((left, right) => left.start - right.start || left.end - right.end);
  const segments = readableSegments(words);
  return {
    version: JOB_VERSION,
    provider: "gemini",
    model: options.model,
    language: options.language,
    text,
    segments,
    words
  };
};

export const transcribeGeminiAudio = async (
  audio: Uint8Array,
  options: GeminiAudioOptions,
  request: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<Transcript> => {
  signal?.throwIfAborted();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY não está configurada");
  if (!Number.isFinite(options.duration) || options.duration <= 0 || options.duration > MAX_AUDIO_DURATION) {
    throw new Error("Cada trecho enviado ao Gemini deve ter no máximo 30 minutos");
  }
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("O áudio enviado ao Gemini deve ter entre 1 byte e 20 MiB");
  }
  const language = options.language === "pt" ? "pt-BR" : options.language;
  // Official REST contract: ai.google.dev/gemini-api/docs/transcribe and api/interactions-api.
  // Inline audio avoids a Files API upload; store:false disables Interaction storage.
  let response: Response;
  try {
    response = await request(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: options.model,
        store: false,
        input: [{ type: "audio", data: Buffer.from(audio).toString("base64"), mime_type: "audio/mp3" }],
        generation_config: {
          transcription_config: {
            language_codes: language === "auto" ? [] : [language],
            mode: {
              type: "verbatim",
              diarization_mode: "speaker",
              timestamp_granularities: ["word"]
            }
          }
        }
      })
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error("Não foi possível conectar ao Gemini; verifique a rede ou o tempo limite");
  }
  if (!response.ok) throw new Error(`Gemini recusou a transcrição (HTTP ${response.status})`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Gemini retornou uma resposta JSON inválida");
  }
  return parseGeminiResponse(value, options);
};

export const transcribeWithGemini = async (
  sourcePath: string,
  workDir: string,
  model: string,
  language: string,
  signal?: AbortSignal
): Promise<Transcript> => {
  signal?.throwIfAborted();
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não está configurada");
  const duration = await probeMedia(sourcePath, signal);
  if (duration > MAX_AUDIO_DURATION) {
    throw new Error("O provedor Gemini experimental aceita arquivos de até 30 minutos");
  }
  const audioPath = await extractAudioMp3(sourcePath, workDir, signal);
  await assertPaidAudioSignal(audioPath, signal);
  return transcribeGeminiAudio(await fs.readFile(audioPath), { model, language, duration }, fetch, signal);
};
