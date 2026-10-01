import { resolve } from "node:path";
import { runCommand } from "../jobs/command";

type AudioTrackCheck = {
  index: number;
  title?: string;
  hasSignal: boolean;
  peakDb: number | null;
  longestSilenceSeconds: number;
};

/** Checks the first minute of each audio track without uploading or changing the media. */
export const checkRecordingAudio = async (path: string): Promise<{
  durationSeconds: number;
  sampledSeconds: number;
  tracks: AudioTrackCheck[];
  warnings: string[];
}> => {
  const source = resolve(path);
  const { stdout } = await runCommand("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=index,codec_type:stream_tags=title", "-of", "json", source], { timeoutMs: 15_000 });
  const media = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { index: number; codec_type: string; tags?: { title?: string } }[];
  };
  const durationSeconds = Number(media.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Recording has no valid duration");
  const streams = (media.streams || []).filter((stream) => stream.codec_type === "audio");
  if (streams.length > 8) throw new Error("Audio check supports up to eight tracks");
  const sampledSeconds = Math.min(60, durationSeconds);
  const tracks: AudioTrackCheck[] = [];
  const warnings: string[] = [];
  if (!streams.length) warnings.push("Recording has no audio for transcription");
  for (const stream of streams) {
    const { stderr } = await runCommand("ffmpeg", ["-hide_banner", "-nostdin", "-i", source,
      "-t", String(sampledSeconds), "-map", `0:${stream.index}`, "-vn",
      "-af", "silencedetect=noise=-50dB:d=10,volumedetect", "-f", "null", "-"], { timeoutMs: 30_000 });
    const peak = stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/);
    const peakDb = peak && peak[1] !== "-inf" ? Number(peak[1]) : null;
    const silenceDurations = [...stderr.matchAll(/silence_duration:\s*([\d.]+)/g)].map((match) => Number(match[1]));
    const hasSignal = peakDb !== null && peakDb > -50;
    const longestSilenceSeconds = Math.max(0, ...silenceDurations);
    tracks.push({ index: stream.index, title: stream.tags?.title, hasSignal, peakDb, longestSilenceSeconds });
    if (!hasSignal) warnings.push(`Track ${stream.index}${tracks.length === 1 ? " (transcription)" : ""} has no signal above -50 dB in the sample`);
    else if (longestSilenceSeconds >= 30) warnings.push(`Track ${stream.index} contains at least 30 seconds of silence in the sample`);
  }
  return { durationSeconds, sampledSeconds, tracks, warnings };
};
