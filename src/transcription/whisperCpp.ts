import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { JOB_VERSION, type Transcript, type TranscriptSegment } from "../jobs/types";
import { runCommand } from "../jobs/command";
import { extractAudioWav } from "../jobs/media";

type WhisperJson = {
  result?: { language?: unknown };
  transcription?: unknown;
};

export const transcribeWithWhisperCpp = async (
  config: AppConfig,
  sourcePath: string,
  workDir: string,
  model: string,
  language: string,
  signal?: AbortSignal
): Promise<Transcript> => {
  signal?.throwIfAborted();
  const whisper = config.transcription.whisperCpp;
  await fs.access(whisper.modelPath);
  const audioPath = await extractAudioWav(sourcePath, workDir, signal);
  const outputPrefix = join(workDir, "whisper");
  await runCommand(
    whisper.command,
    [
      "-m",
      whisper.modelPath,
      "-f",
      audioPath,
      "-l",
      language,
      "-t",
      String(whisper.threads),
      "-oj",
      "-of",
      outputPrefix
    ],
    { timeoutMs: 12 * 60 * 60 * 1000, signal }
  );

  signal?.throwIfAborted();
  const parsed = JSON.parse(await fs.readFile(`${outputPrefix}.json`, "utf-8")) as WhisperJson;
  if (!Array.isArray(parsed.transcription) || parsed.transcription.length > 100_000) {
    throw new Error("whisper.cpp output did not include transcription segments");
  }
  let speakerIndex = 1;
  const segments: TranscriptSegment[] = parsed.transcription.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("whisper.cpp returned an invalid segment");
    }
    const segment = value as Record<string, unknown>;
    const offsets = segment.offsets;
    const from = (offsets as Record<string, unknown> | undefined)?.from;
    const to = (offsets as Record<string, unknown> | undefined)?.to;
    const speaker = segment.speaker;
    if (
      typeof offsets !== "object" ||
      offsets === null ||
      typeof from !== "number" ||
      !Number.isFinite(from) ||
      from < 0 ||
      typeof to !== "number" ||
      !Number.isFinite(to) ||
      to < from ||
      typeof segment.text !== "string" ||
      segment.text.length > 10_000 ||
      (speaker !== undefined && (typeof speaker !== "string" || speaker.length > 200))
    ) {
      throw new Error("whisper.cpp returned invalid segment offsets");
    }
    const result: TranscriptSegment = {
      start: from / 1000,
      end: to / 1000,
      text: segment.text,
      speaker
    };
    if (segment.speaker_turn_next === true) {
      result.speaker = result.speaker || `S${speakerIndex}`;
      speakerIndex += 1;
    }
    return result;
  });

  return {
    version: JOB_VERSION,
    provider: "whisper-cpp",
    model,
    language: typeof parsed.result?.language === "string" ? parsed.result.language : language,
    text: segments.map((segment) => segment.text.trim()).join(" ").trim(),
    segments
  };
};
