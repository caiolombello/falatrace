import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./command";

export const probeMedia = async (path: string, signal?: AbortSignal): Promise<number> => {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    path
  ], { signal });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe did not find a valid media duration");
  }
  return duration;
};

export const extractAudioMp3 = async (sourcePath: string, workDir: string, signal?: AbortSignal): Promise<string> => {
  const outputPath = join(workDir, "audio.mp3");
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    outputPath
  ], { signal });
  return outputPath;
};

export const extractAudioWav = async (sourcePath: string, workDir: string, signal?: AbortSignal): Promise<string> => {
  const outputPath = join(workDir, "audio.wav");
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath
  ], { signal });
  return outputPath;
};

export const extractAudioChunk = async (
  audioPath: string,
  workDir: string,
  start: number,
  duration: number,
  index: number,
  signal?: AbortSignal
): Promise<string> => {
  const chunkPath = join(workDir, `chunk-${index}.mp3`);
  await runCommand("ffmpeg", [
    "-y",
    "-ss",
    String(start),
    "-i",
    audioPath,
    "-t",
    String(duration),
    "-c",
    "copy",
    chunkPath
  ], { signal });
  return chunkPath;
};

export const removeTemporaryAudio = async (workDir: string): Promise<void> => {
  const names = await fs.readdir(workDir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name === "audio.mp3" || name === "audio.wav" || /^chunk-\d+\.mp3$/.test(name))
      .map((name) => fs.unlink(join(workDir, name)).catch(() => undefined))
  );
};
