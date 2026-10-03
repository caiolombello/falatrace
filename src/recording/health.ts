import { resolve } from "node:path";
import { runCommand } from "../jobs/command";

type AudioSampleWindow = {
  kind: "initial" | "recent";
  startSeconds: number;
  sampledSeconds: number;
};

type AudioChannelCheck = {
  index: number;
  measurement: "available" | "unavailable";
  hasSignal: boolean | null;
  peakDb: number | null;
};

type AudioWindowCheck = AudioSampleWindow & {
  hasSignal: boolean;
  peakDb: number | null;
  longestSilenceSeconds: number;
  channelAnalysis: "measured" | "unavailable" | "unsupported";
  channels: AudioChannelCheck[];
};

type AudioTrackCheck = {
  index: number;
  /** Container metadata only; this does not validate an audio source role. */
  title?: string;
  sourceRole: "unverified";
  /** These existing summary fields describe the initial window. */
  hasSignal: boolean;
  peakDb: number | null;
  longestSilenceSeconds: number;
  windows: AudioWindowCheck[];
};

const parsePeak = (value: string | undefined): number | null | undefined => {
  if (value === "-inf") return null;
  if (!value || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return undefined;
  const peak = Number(value);
  return Number.isFinite(peak) ? peak : undefined;
};

const checkChannels = (stderr: string, count: number | undefined): Pick<AudioWindowCheck, "channelAnalysis" | "channels"> => {
  if (count === undefined) return { channelAnalysis: "unavailable", channels: [] };
  if (count > 8) return { channelAnalysis: "unsupported", channels: [] };
  const peaks = new Map<number, number | null>();
  let channel: number | undefined;
  for (const line of stderr.split("\n")) {
    // Read astats' channel sections only; its Overall peak is not a channel.
    const metric = line.match(/^\[(?:Parsed_)?astats(?:_\d+)?\s+@\s*[^\]]+\]\s*(.*)$/)?.[1];
    if (!metric) continue;
    const header = metric.match(/^Channel:\s*(\d+)\s*$/);
    if (header) {
      const index = Number(header[1]) - 1;
      channel = index >= 0 && index < count ? index : undefined;
    } else if (/^Overall\s*$/.test(metric)) {
      channel = undefined;
    } else if (channel !== undefined) {
      const peak = parsePeak(metric.match(/^Peak level dB:\s*(\S+)\s*$/)?.[1]);
      if (peak !== undefined) peaks.set(channel, peak);
    }
  }
  const channels = Array.from({ length: count }, (_, index): AudioChannelCheck => {
    if (!peaks.has(index)) return { index, measurement: "unavailable", hasSignal: null, peakDb: null };
    const peakDb = peaks.get(index)!;
    return { index, measurement: "available", hasSignal: peakDb !== null && peakDb > -50, peakDb };
  });
  return { channelAnalysis: peaks.size === count ? "measured" : "unavailable", channels };
};

/**
 * Manual file check only: sample the first minute and, for longer media, the
 * most recent minute of each audio track. This does not monitor live capture.
 * Existing track summaries and sampledSeconds retain their initial-window
 * meaning; windows and warnings include the recent evidence. Sampled silence
 * does not establish whether a source failed or was intentionally quiet.
 * Titles are container metadata, and capture continuity is not verified by
 * these bounded windows; the intervening audio is not checked. Window offsets
 * and lengths describe requested slices, not proof of full decoded coverage.
 */
export const checkRecordingAudio = async (path: string, run = runCommand): Promise<{
  durationSeconds: number;
  sampledSeconds: number;
  windows: AudioSampleWindow[];
  tracks: AudioTrackCheck[];
  warnings: string[];
}> => {
  const source = resolve(path);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=index,codec_type,channels:stream_tags=title", "-of", "json", source], { timeoutMs: 15_000 });
  const media = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { index: number; codec_type: string; channels?: number; tags?: { title?: string } }[];
  };
  const durationSeconds = Number(media.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Recording has no valid duration");
  const streams = (media.streams || []).filter((stream) => stream.codec_type === "audio");
  if (streams.length > 8) throw new Error("Audio check supports up to eight tracks");
  const sampledSeconds = Math.min(60, durationSeconds);
  const windows: AudioSampleWindow[] = [{ kind: "initial", startSeconds: 0, sampledSeconds }];
  if (durationSeconds > 60) windows.push({ kind: "recent", startSeconds: durationSeconds - 60, sampledSeconds: 60 });
  const tracks: AudioTrackCheck[] = [];
  const warnings: string[] = [];
  if (!streams.length) warnings.push("Recording has no audio for transcription");
  for (const stream of streams) {
    if (!Number.isInteger(stream.index) || stream.index < 0) throw new Error("Recording has an invalid audio stream index");
    const count = Number.isInteger(stream.channels) && stream.channels! > 0 ? stream.channels : undefined;
    const filters = ["silencedetect=noise=-50dB:d=10",
      ...(count !== undefined && count <= 8 ? ["astats=metadata=0:reset=0"] : []), "volumedetect"];
    const trackWindows: AudioWindowCheck[] = [];
    const title = stream.tags?.title;
    const label = `Track ${stream.index}${title ? ` (${title.replace(/[\r\n\0]+/g, " ").slice(0, 120)})` : ""}${tracks.length === 0 ? " (transcription)" : ""}`;
    for (const window of windows) {
      const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin",
        ...(window.startSeconds > 0 ? ["-ss", String(window.startSeconds)] : []), "-i", source,
        "-t", String(window.sampledSeconds), "-map", `0:${stream.index}`, "-vn",
        "-af", filters.join(","), "-f", "null", "-"], { timeoutMs: 30_000 });
      const peakDb = parsePeak(stderr.match(/max_volume:\s*(\S+)\s*dB/)?.[1]);
      if (peakDb === undefined) throw new Error(`Audio measurement unavailable for track ${stream.index} in the ${window.kind} window`);
      const silenceDurations = [...stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
      const hasSignal = peakDb !== null && peakDb > -50;
      const longestSilenceSeconds = Math.min(window.sampledSeconds, Math.max(0, ...silenceDurations));
      const channels = checkChannels(stderr, count);
      trackWindows.push({ ...window, hasSignal, peakDb, longestSilenceSeconds, ...channels });
      const sample = `${window.kind} sample (${window.startSeconds}–${window.startSeconds + window.sampledSeconds} seconds)`;
      if (!hasSignal) warnings.push(`${label} has no signal above -50 dB in the ${sample}`);
      else if (longestSilenceSeconds >= 30) warnings.push(`${label} contains at least 30 seconds of silence in the ${sample}`);
      if (hasSignal) {
        for (const channel of channels.channels) {
          if (channel.hasSignal === false) warnings.push(`${label} channel ${channel.index + 1} has no signal above -50 dB in the ${sample}`);
        }
      }
    }
    const initial = trackWindows[0];
    tracks.push({ index: stream.index, title, sourceRole: "unverified", hasSignal: initial.hasSignal, peakDb: initial.peakDb,
      longestSilenceSeconds: initial.longestSilenceSeconds, windows: trackWindows });
  }
  return { durationSeconds, sampledSeconds, windows, tracks, warnings };
};
