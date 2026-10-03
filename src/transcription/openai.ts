import { assertPaidAudioSignal } from "./audio-preflight";
import fs from "node:fs";
import OpenAI from "openai";
import {
  TRANSCRIPTION_PROMPT_MAX_LENGTH,
  type AppConfig
} from "../config/defaults";
import { JOB_VERSION, type Transcript, type TranscriptSegment } from "../jobs/types";
import { extractAudioChunk, extractAudioMp3, probeMedia } from "../jobs/media";

const MAX_CHUNK_DURATION = 600;
export const OPENAI_TRANSCRIPTION_TIMEOUT_MS = 60 * 60 * 1000;
const TRANSCRIPTION_RESPONSE_TEXT_MAX_LENGTH = 1_000_000;

type DiarizedResponse = {
  text?: unknown;
  segments?: unknown;
};

type TextResponse = {
  text?: unknown;
};

export const isGptTranscribeModel = (model: string): boolean =>
  model === "gpt-transcribe";

export const openAILanguageParameters = (
  model: string,
  language: string,
  expectedLanguages: string[] = []
): { language?: string; languages?: string[] } => {
  if (isGptTranscribeModel(model)) {
    const languages =
      expectedLanguages.length > 0
        ? expectedLanguages
        : language === "auto"
          ? []
          : [language.toLowerCase()];
    return languages.length > 0 ? { languages } : {};
  }
  return language === "auto" ? {} : { language };
};

export const isDiarizedOpenAIModel = (model: string): boolean =>
  model.startsWith("gpt-4o-transcribe-diarize");

export const openAITranscriptionParameters = (
  model: string,
  language: string,
  prompt = "",
  expectedLanguages: string[] = [],
  keywords: string[] = []
): Record<string, unknown> => {
  const languageParameters = openAILanguageParameters(
    model,
    language,
    expectedLanguages
  );
  if (isDiarizedOpenAIModel(model)) {
    return {
      ...languageParameters,
      response_format: "diarized_json",
      chunking_strategy: "auto"
    };
  }
  return {
    ...languageParameters,
    response_format: "json",
    ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    ...(isGptTranscribeModel(model) && keywords.length > 0
      ? { keywords }
      : {})
  };
};

export const buildOpenAIChunkPrompt = (basePrompt = "", previousText = ""): string => {
  const base = basePrompt.trim().slice(0, TRANSCRIPTION_PROMPT_MAX_LENGTH);
  const previous = previousText.trim();
  if (!previous) {
    return base;
  }
  const separator = base ? "\n\n" : "";
  const heading = "Contexto imediatamente anterior (não repita este texto):\n";
  const available =
    TRANSCRIPTION_PROMPT_MAX_LENGTH - base.length - separator.length - heading.length;
  if (available <= 0) {
    return base;
  }
  return `${base}${separator}${heading}${previous.slice(-available)}`;
};

export const planOpenAIChunks = (
  duration: number
): Array<{ start: number; duration: number }> => {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("OpenAI transcription duration must be positive");
  }
  return Array.from({ length: Math.ceil(duration / MAX_CHUNK_DURATION) }, (_, index) => {
    const start = index * MAX_CHUNK_DURATION;
    return {
      start,
      duration: Math.min(MAX_CHUNK_DURATION, duration - start)
    };
  });
};

export const parseOpenAIDiarizedResponse = (
  value: DiarizedResponse,
  offset: number,
  speakerNamespace?: string
): TranscriptSegment[] => {
  if (!Array.isArray(value.segments) || value.segments.length > 100_000) {
    throw new Error("OpenAI transcription response did not include segments");
  }
  return value.segments.map((segment) => {
    const data = segment as Record<string, unknown>;
    const start = data?.start;
    const end = data?.end;
    const text = data?.text;
    const speaker = data?.speaker;
    if (
      typeof segment !== "object" ||
      segment === null ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start < 0 ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      end < start ||
      typeof text !== "string" ||
      text.length > 10_000 ||
      (speaker !== undefined && (typeof speaker !== "string" || speaker.length > 200))
    ) {
      throw new Error("OpenAI transcription returned an invalid segment");
    }
    return {
      start: start + offset,
      end: end + offset,
      text,
      speaker:
        speaker === undefined
          ? undefined
          : speakerNamespace
            ? `${speakerNamespace}:${speaker}`
            : speaker
    };
  });
};

export const parseOpenAITextResponse = (
  value: TextResponse,
  offset: number,
  duration: number
): TranscriptSegment[] => {
  if (
    typeof value.text !== "string" ||
    value.text.length > TRANSCRIPTION_RESPONSE_TEXT_MAX_LENGTH
  ) {
    throw new Error("OpenAI transcription response did not include valid text");
  }
  const text = value.text.trim();
  if (!text) {
    return [];
  }
  return [{ start: offset, end: offset + duration, text }];
};

const transcribeChunk = async (
  client: OpenAI,
  filePath: string,
  model: string,
  language: string,
  offset: number,
  duration: number,
  prompt: string,
  expectedLanguages: string[],
  keywords: string[],
  speakerNamespace?: string,
  signal?: AbortSignal
): Promise<TranscriptSegment[]> => {
  const response = (await client.audio.transcriptions.create(
    {
      file: fs.createReadStream(filePath),
      model,
      ...openAITranscriptionParameters(
        model,
        language,
        prompt,
        expectedLanguages,
        keywords
      )
    } as unknown as Parameters<typeof client.audio.transcriptions.create>[0],
    { timeout: OPENAI_TRANSCRIPTION_TIMEOUT_MS, signal }
  )) as unknown;
  return isDiarizedOpenAIModel(model)
    ? parseOpenAIDiarizedResponse(response as DiarizedResponse, offset, speakerNamespace)
    : parseOpenAITextResponse(response as TextResponse, offset, duration);
};

export const transcribeWithOpenAI = async (
  config: AppConfig,
  sourcePath: string,
  workDir: string,
  model: string,
  language: string,
  prompt = "",
  expectedLanguages: string[] = [],
  keywords: string[] = [],
  signal?: AbortSignal
): Promise<Transcript> => {
  signal?.throwIfAborted();
  const apiKey = process.env.OPENAI_API_KEY || config.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const client = new OpenAI({ apiKey, maxRetries: 0 });
  const audioPath = await extractAudioMp3(sourcePath, workDir, signal);
  await assertPaidAudioSignal(audioPath, signal);
  const duration = await probeMedia(audioPath, signal);
  const segments: TranscriptSegment[] = [];
  const diarized = isDiarizedOpenAIModel(model);

  if (duration <= MAX_CHUNK_DURATION) {
    segments.push(
      ...(await transcribeChunk(
        client,
        audioPath,
        model,
        language,
        0,
        duration,
        buildOpenAIChunkPrompt(prompt),
        expectedLanguages,
        keywords,
        undefined,
        signal
      ))
    );
  } else {
    const chunks = planOpenAIChunks(duration);
    let previousText = "";
    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = await extractAudioChunk(
        audioPath,
        workDir,
        chunk.start,
        chunk.duration,
        index,
        signal
      );
      const chunkSegments = await transcribeChunk(
        client,
        chunkPath,
        model,
        language,
        chunk.start,
        chunk.duration,
        diarized ? "" : buildOpenAIChunkPrompt(prompt, previousText),
        expectedLanguages,
        keywords,
        diarized ? `C${index + 1}` : undefined,
        signal
      );
      segments.push(...chunkSegments);
      if (!diarized) {
        previousText = chunkSegments.map((segment) => segment.text.trim()).join(" ").trim();
      }
    }
  }

  signal?.throwIfAborted();
  return {
    version: JOB_VERSION,
    provider: "openai",
    model,
    language,
    text: segments.map((segment) => segment.text.trim()).join(" ").trim(),
    segments
  };
};
