import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../jobs/command";

// FalaTrace's own captures keep the microphone and the computer audio apart:
// ffmpeg writes titled [Mixed, Microphone, Desktop] tracks and GPU Screen Recorder
// writes the same three tracks in that order without titles. Speech that is loud on
// the microphone while the computer track is quiet comes from the person recording.
// This is a local energy comparison, never a voice identity.

export const ENVELOPE_STEP_SECONDS = 0.1;
export const SILENCE_DB = -120;
const MAX_AUDIO_STREAMS = 16;
const MAX_ENVELOPE_BYTES = 80 * 1024 * 1024;
const MAX_ENVELOPE_FRAMES = 24 * 60 * 60 * 10;

export const MICROPHONE_THRESHOLDS = {
  /** A track counts as active this far above its own quiet level. */
  activeAboveFloorDb: 12,
  /** Never treat anything quieter than this as speech, whatever the floor. */
  minimumActiveDb: -60,
  /** Anything this loud is active even on a track that never goes quiet. */
  alwaysActiveDb: -35,
  /** The microphone must beat the computer audio by this much to count as local speech. */
  localMarginDb: 6,
  selfMinimumSeconds: 3,
  selfMinimumShare: 0.7,
  /** Without this much computer audio there is nothing to compare the microphone with. */
  minimumDesktopSeconds: 5,
  /** One person split in two by the diarizer is common; more is not a single owner. */
  maxSelfSpeakers: 2
} as const;

export type AudioStreamInfo = { title?: string; channels?: number };
export type TrackLayout = { source: "titled" | "ordered"; microphone: number; desktop: number; mix?: number };
export type SpeakerMicrophoneShare = { speakerId: string; localSeconds: number; remoteSeconds: number; localShare: number };
export type MicrophoneReason = "no-separate-tracks" | "unrecognized-tracks" | "no-desktop-audio" | "no-microphone-speech" | "no-match" | "ambiguous";
export type MicrophoneScore = { selfSpeakers: string[]; speakers: SpeakerMicrophoneShare[]; reason?: Extract<MicrophoneReason, "no-desktop-audio" | "no-microphone-speech" | "no-match" | "ambiguous"> };
export type MicrophoneAnalysis =
  | ({ state: "ready"; layout: TrackLayout["source"] } & MicrophoneScore)
  | { state: "unavailable"; reason: Extract<MicrophoneReason, "no-separate-tracks" | "unrecognized-tracks"> };
type Run = typeof runCommand;

export const probeAudioStreams = async (path: string, run: Run = runCommand, signal?: AbortSignal): Promise<AudioStreamInfo[]> => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index,channels:stream_tags=title", "-of", "json", path], { timeoutMs: 60_000, signal });
  const streams = (JSON.parse(stdout) as { streams?: unknown }).streams;
  if (!Array.isArray(streams) || streams.length > MAX_AUDIO_STREAMS) throw new Error("ffprobe returned an invalid audio stream list");
  return streams.map((value) => {
    const stream = value && typeof value === "object" ? value as { channels?: unknown; tags?: { title?: unknown } } : {};
    const title = typeof stream.tags?.title === "string" ? stream.tags.title.trim().slice(0, 100) : "";
    return { ...(title ? { title } : {}), ...(Number.isSafeInteger(stream.channels) ? { channels: stream.channels as number } : {}) };
  });
};

export const resolveTrackLayout = (streams: AudioStreamInfo[]): TrackLayout | undefined => {
  const titled = (name: string): number => streams.findIndex((stream) => stream.title?.toLowerCase() === name);
  const microphone = titled("microphone"), desktop = titled("desktop");
  if (microphone >= 0 && desktop >= 0) {
    const mix = titled("mixed");
    return { source: "titled", microphone, desktop, ...(mix >= 0 ? { mix } : {}) };
  }
  // Only FalaTrace's GPU Screen Recorder layout; checked against the audio before use.
  if (streams.length === 3 && streams.every((stream) => !stream.title)) return { source: "ordered", mix: 0, microphone: 1, desktop: 2 };
  return undefined;
};

/** Parses ffmpeg `ametadata=print` output of astats RMS levels into one dB value per step. */
export const parseEnvelope = (text: string, step = ENVELOPE_STEP_SECONDS): Float32Array => {
  const values: number[] = [];
  let time: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) {
      const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
      time = match ? Number(match[1]) : undefined;
      continue;
    }
    if (time === undefined || !line.startsWith("lavfi.astats.Overall.RMS_level=")) continue;
    const index = Math.round(time / step);
    time = undefined;
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_ENVELOPE_FRAMES) continue;
    const level = Number(line.slice(line.indexOf("=") + 1).trim());
    while (values.length < index) values.push(SILENCE_DB);
    values[index] = Number.isFinite(level) ? Math.max(SILENCE_DB, Math.min(0, level)) : SILENCE_DB;
  }
  return Float32Array.from(values);
};

const envelopeChain = (track: number, file: string, label: string): string =>
  `[0:a:${track}]aformat=channel_layouts=mono,aresample=8000,asetnsamples=n=800:p=0,` +
  `astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${file}[${label}]`;

export type Envelopes = { microphone: Float32Array; desktop: Float32Array; mix?: Float32Array };

export const extractEnvelopes = async (
  path: string, layout: TrackLayout, workDir: string, options: { run?: Run; signal?: AbortSignal } = {}
): Promise<Envelopes> => {
  const tracks: Array<[keyof Envelopes, number]> = [["microphone", layout.microphone], ["desktop", layout.desktop]];
  if (layout.source === "ordered" && layout.mix !== undefined) tracks.push(["mix", layout.mix]);
  // Relative file names: the metadata files land in the private work directory (cwd),
  // so no path ever needs filtergraph escaping.
  const graph = tracks.map(([name, track], index) => envelopeChain(track, `${name}.txt`, `o${index}`)).join(";");
  await (options.run || runCommand)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-filter_complex", graph,
    ...tracks.flatMap((_, index) => ["-map", `[o${index}]`, "-f", "null", "-"])], { cwd: workDir, timeoutMs: 60 * 60 * 1000, signal: options.signal });
  const result: Partial<Envelopes> = {};
  for (const [name] of tracks) {
    const file = join(workDir, `${name}.txt`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENVELOPE_BYTES) throw new Error("Invalid audio level output");
    result[name] = parseEnvelope(await fs.readFile(file, "utf8"));
  }
  return result as Envelopes;
};

const percentile = (values: Float32Array, share: number): number => {
  if (!values.length) return SILENCE_DB;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
};
const audible = (values: Float32Array): Float32Array => values.filter((value) => value > SILENCE_DB + 1);
const activeThreshold = (values: Float32Array): number => Math.min(MICROPHONE_THRESHOLDS.alwaysActiveDb,
  Math.max(percentile(values, 0.1) + MICROPHONE_THRESHOLDS.activeAboveFloorDb, MICROPHONE_THRESHOLDS.minimumActiveDb));

/** FalaTrace's untitled layout is [mix, microphone, desktop]. Accept it only when the
 * first track carries the louder of the other two and the third behaves at least as
 * much like a sink monitor (digital silence while nothing plays) as the second. */
export const verifyOrderedLayout = (envelopes: Envelopes): boolean => {
  const { mix, microphone, desktop } = envelopes;
  if (!mix) return false;
  const frames = Math.min(mix.length, microphone.length, desktop.length);
  let active = 0, consistent = 0, microphoneSilent = 0, desktopSilent = 0;
  for (let index = 0; index < frames; index++) {
    if (microphone[index]! <= SILENCE_DB + 1) microphoneSilent++;
    if (desktop[index]! <= SILENCE_DB + 1) desktopSilent++;
    const loudest = Math.max(microphone[index]!, desktop[index]!);
    if (loudest < MICROPHONE_THRESHOLDS.minimumActiveDb) continue;
    active++;
    if (mix[index]! >= loudest - 3) consistent++;
  }
  return active > 0 && consistent / active >= 0.9 && desktopSilent >= microphoneSilent;
};

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

export const scoreMicrophone = (
  turns: ReadonlyArray<{ start: number; end: number; speaker: string }>,
  microphone: Float32Array, desktop: Float32Array, step = ENVELOPE_STEP_SECONDS
): MicrophoneScore => {
  const limits = MICROPHONE_THRESHOLDS;
  const frames = Math.min(microphone.length, desktop.length);
  const mic = microphone.subarray(0, frames), desk = desktop.subarray(0, frames);
  const micThreshold = activeThreshold(audible(mic));
  const deskThreshold = activeThreshold(desk);
  const local = new Uint8Array(frames), remote = new Uint8Array(frames);
  let localFrames = 0, remoteFrames = 0;
  for (let index = 0; index < frames; index++) {
    if (mic[index]! >= micThreshold && mic[index]! >= desk[index]! + limits.localMarginDb) { local[index] = 1; localFrames++; }
    else if (desk[index]! >= deskThreshold) { remote[index] = 1; remoteFrames++; }
  }
  const totals = new Map<string, { local: number; remote: number }>();
  for (const turn of turns) {
    const total = totals.get(turn.speaker) || { local: 0, remote: 0 };
    totals.set(turn.speaker, total);
    const first = Math.max(0, Math.floor(turn.start / step)), last = Math.min(frames, Math.ceil(turn.end / step));
    for (let index = first; index < last; index++) { total.local += local[index]!; total.remote += remote[index]!; }
  }
  const speakers = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([speakerId, total]) => ({
    speakerId, localSeconds: round(total.local * step, 1), remoteSeconds: round(total.remote * step, 1),
    localShare: total.local + total.remote ? round(total.local / (total.local + total.remote), 3) : 0
  }));
  if (remoteFrames * step < limits.minimumDesktopSeconds) return { selfSpeakers: [], speakers, reason: "no-desktop-audio" };
  if (localFrames * step < limits.selfMinimumSeconds) return { selfSpeakers: [], speakers, reason: "no-microphone-speech" };
  const self = speakers.filter((speaker) => speaker.localSeconds >= limits.selfMinimumSeconds && speaker.localShare >= limits.selfMinimumShare);
  if (!self.length) return { selfSpeakers: [], speakers, reason: "no-match" };
  if (self.length > limits.maxSelfSpeakers) return { selfSpeakers: [], speakers, reason: "ambiguous" };
  return { selfSpeakers: self.map((speaker) => speaker.speakerId), speakers };
};

/** Reads the separate tracks of a FalaTrace capture and scores each diarized speaker. */
export const analyzeMicrophone = async (
  path: string, turns: ReadonlyArray<{ start: number; end: number; speaker: string }>, workDir: string,
  options: { run?: Run; signal?: AbortSignal } = {}
): Promise<MicrophoneAnalysis> => {
  const streams = await probeAudioStreams(path, options.run, options.signal);
  const layout = resolveTrackLayout(streams);
  if (!layout) return { state: "unavailable", reason: streams.length < 2 ? "no-separate-tracks" : "unrecognized-tracks" };
  const envelopes = await extractEnvelopes(path, layout, workDir, options);
  if (layout.source === "ordered" && !verifyOrderedLayout(envelopes)) return { state: "unavailable", reason: "unrecognized-tracks" };
  return { state: "ready", layout: layout.source, ...scoreMicrophone(turns, envelopes.microphone, envelopes.desktop) };
};
