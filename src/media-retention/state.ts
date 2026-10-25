import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { ArchiveRecord } from "../archive/store";
import type { JobRecord } from "../jobs/types";
import { MediaRetentionStore, retainedAudioPathOf, type MediaRetentionTombstone, type RetainedMode } from "./store";

/** What the recording still allows once retention ran; the UI disables the rest with an explanation. */
export type MediaFeatures = {
  playback: boolean;
  frames: boolean;
  diarize: boolean;
  speakersMic: boolean;
  voices: boolean;
  subtitles: boolean;
  reprocess: boolean;
};

export type MediaState = {
  state: "present" | "removed" | "audio-only" | "missing";
  removedAt?: string;
  reason?: MediaRetentionTombstone["reason"];
  mode?: RetainedMode;
  /** Verified copies elsewhere (archive), which playback and speaker work can still use. */
  copies: { vaio: boolean; proton: boolean };
  features: MediaFeatures;
};

export type MediaStateEntry = { sourcePath: string; jobs?: Pick<JobRecord, "source">[]; archive?: ArchiveRecord };

const ALL: MediaFeatures = { playback: true, frames: true, diarize: true, speakersMic: true, voices: true, subtitles: true, reprocess: true };

const archiveCopies = (archive: ArchiveRecord | undefined, sourcePath: string, sha256: string | undefined): { vaio: boolean; proton: boolean } => {
  if (!archive || resolve(archive.sourcePath) !== sourcePath || !archive.source.sha256 || (sha256 && archive.source.sha256 !== sha256)) return { vaio: false, proton: false };
  return { vaio: archive.vaio.state === "completed", proton: archive.proton.state === "completed" };
};

/** Without local video: frames and reprocessing are gone; aligned subtitles need the VAIO copy. */
const withoutVideo = (audio: boolean, copies: { vaio: boolean; proton: boolean }): MediaFeatures => {
  const remote = copies.vaio || copies.proton;
  return { playback: audio || remote, frames: false, diarize: audio || remote, speakersMic: audio || remote, voices: audio || remote,
    subtitles: copies.vaio, reprocess: false };
};

/**
 * Cheap media status for library listings: one lstat and one small read per entry, no hashing.
 * A tombstone that is invalid or names other media is ignored, so the entry reads as "missing".
 */
export const mediaStateOf = async (entry: MediaStateEntry, deps: { store?: MediaRetentionStore } = {}): Promise<MediaState> => {
  const sourcePath = resolve(entry.sourcePath);
  const jobSha = entry.jobs?.[0]?.source.sha256;
  const local = await fs.lstat(sourcePath).catch(() => undefined);
  if (local?.isFile() && !local.isSymbolicLink()) return { state: "present", copies: archiveCopies(entry.archive, sourcePath, jobSha), features: { ...ALL } };

  const tombstone = await (deps.store ?? new MediaRetentionStore()).read(sourcePath).then((stored) => stored?.tombstone, () => undefined);
  const bound = tombstone && (entry.jobs ?? []).every((job) => job.source.sha256 === tombstone.source.sha256);
  if (!tombstone || !bound) {
    const copies = archiveCopies(entry.archive, sourcePath, jobSha);
    return { state: "missing", copies, features: withoutVideo(false, copies) };
  }
  const recorded = archiveCopies(entry.archive, sourcePath, tombstone.source.sha256);
  const copies = { vaio: recorded.vaio || !!tombstone.verified.backups.vaio, proton: recorded.proton || !!tombstone.verified.backups.proton };
  let audio = false;
  if (tombstone.mode === "audio-only" && tombstone.audio) {
    const retained = await fs.lstat(retainedAudioPathOf(sourcePath)).catch(() => undefined);
    audio = !!retained?.isFile() && !retained.isSymbolicLink() && retained.size === tombstone.audio.size;
  }
  return {
    state: audio ? "audio-only" : "removed",
    removedAt: tombstone.removedAt ?? tombstone.startedAt,
    reason: tombstone.reason,
    mode: tombstone.mode,
    copies,
    features: withoutVideo(audio, copies)
  };
};
