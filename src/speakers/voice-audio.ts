import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../jobs/command";
import { VOICE_SAMPLE_RATE } from "./voice-engine";

// Which audio represents each diarized speaker: the longest turns that no other
// speaker overlaps, trimmed at the edges. With FalaTrace's separate tracks the owner
// is read from the microphone and everyone else from the computer track, where no
// local voice leaks in; otherwise the mix is used.

export const VOICE_AUDIO_LIMITS = {
  maxSecondsPerSpeaker: 40, maxSegmentSeconds: 12, minSegmentSeconds: 1, edgeTrimSeconds: 0.2, minSpeakerSeconds: 3, maxSegmentsPerSpeaker: 24,
  /** Turns are short; looking this far back is enough to find an overlapping one. */
  overlapLookbackSeconds: 300
} as const;

export type VoiceTrack = "microphone" | "desktop" | "mix";
export type SpeakerAudioPlan = { speakerId: string; track: VoiceTrack; segments: Array<[number, number]>; seconds: number };
type Turn = { start: number; end: number; speaker: string };

const round = (value: number): number => Number(value.toFixed(3));

export const planSpeakerAudio = (turns: ReadonlyArray<Turn>, selfSpeakers: ReadonlySet<string>, separateTracks: boolean): SpeakerAudioPlan[] => {
  const limits = VOICE_AUDIO_LIMITS;
  const sorted = [...turns].filter((turn) => turn.end > turn.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const overlapped = (index: number): boolean => {
    const turn = sorted[index]!;
    for (let other = index - 1; other >= 0 && sorted[other]!.start >= turn.start - limits.overlapLookbackSeconds; other--) {
      if (sorted[other]!.speaker !== turn.speaker && sorted[other]!.end > turn.start) return true;
    }
    for (let other = index + 1; other < sorted.length && sorted[other]!.start < turn.end; other++) {
      if (sorted[other]!.speaker !== turn.speaker) return true;
    }
    return false;
  };
  const candidates = new Map<string, Array<[number, number]>>();
  sorted.forEach((turn, index) => {
    if (overlapped(index)) return;
    let start = turn.start + limits.edgeTrimSeconds, end = turn.end - limits.edgeTrimSeconds;
    if (end - start < limits.minSegmentSeconds) return;
    // Long turns contribute their middle, so one monologue does not stand for the whole voice.
    if (end - start > limits.maxSegmentSeconds) { const middle = (start + end) / 2; start = middle - limits.maxSegmentSeconds / 2; end = middle + limits.maxSegmentSeconds / 2; }
    const list = candidates.get(turn.speaker) || [];
    list.push([round(start), round(end)]);
    candidates.set(turn.speaker, list);
  });
  const plans: SpeakerAudioPlan[] = [];
  for (const [speakerId, segments] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const chosen: Array<[number, number]> = [];
    let seconds = 0;
    for (const segment of [...segments].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0])) {
      if (seconds >= limits.maxSecondsPerSpeaker || chosen.length >= limits.maxSegmentsPerSpeaker) break;
      const take = Math.min(segment[1] - segment[0], limits.maxSecondsPerSpeaker - seconds);
      if (take < limits.minSegmentSeconds) continue;
      chosen.push([segment[0], round(segment[0] + take)]);
      seconds += take;
    }
    if (seconds < limits.minSpeakerSeconds) continue;
    const track: VoiceTrack = separateTracks ? (selfSpeakers.has(speakerId) ? "microphone" : "desktop") : "mix";
    plans.push({ speakerId, track, segments: chosen.sort((a, b) => a[0] - b[0]), seconds: Number(seconds.toFixed(1)) });
  }
  return plans;
};

export type TrackIndexes = { mix: number; microphone?: number; desktop?: number };

/** One decoding pass per track; each speaker's selected segments become one 16 kHz mono buffer. */
export const extractSpeakerAudio = async (
  mediaPath: string, plans: ReadonlyArray<SpeakerAudioPlan>, tracks: TrackIndexes, workDir: string,
  options: { run?: typeof runCommand; signal?: AbortSignal } = {}
): Promise<Map<string, Float32Array>> => {
  const result = new Map<string, Float32Array>();
  for (const track of ["microphone", "desktop", "mix"] as const) {
    const group = plans.filter((plan) => plan.track === track);
    if (!group.length) continue;
    const index = tracks[track];
    if (index === undefined) throw new Error("A faixa de áudio pedida não existe nesta gravação.");
    const split = group.length > 1 ? `,asplit=${group.length}${group.map((_, item) => `[i${item}]`).join("")}` : "[i0]";
    // 20 ms frames: aselect keeps whole frames, so this bounds the error at each segment edge.
    const graph = [`[0:a:${index}]aformat=channel_layouts=mono,aresample=${VOICE_SAMPLE_RATE},asetnsamples=n=320:p=0${split}`,
      ...group.map((plan, item) => `[i${item}]aselect='${plan.segments.map(([start, end]) => `between(t,${start},${end})`).join("+")}',asetpts=N/SR/TB[o${item}]`)].join(";");
    // Relative outputs inside the private work directory; speaker IDs are S01-style codes.
    await (options.run || runCommand)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", mediaPath, "-filter_complex", graph,
      ...group.flatMap((plan, item) => ["-map", `[o${item}]`, "-f", "f32le", "-c:a", "pcm_f32le", `${track}-${plan.speakerId}.f32`])],
      { cwd: workDir, timeoutMs: 60 * 60 * 1000, signal: options.signal });
    for (const plan of group) {
      const file = join(workDir, `${track}-${plan.speakerId}.f32`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (VOICE_AUDIO_LIMITS.maxSecondsPerSpeaker + 5) * VOICE_SAMPLE_RATE * 4) throw new Error("Áudio de voz inválido");
      const bytes = await fs.readFile(file);
      result.set(plan.speakerId, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4))));
    }
  }
  return result;
};
