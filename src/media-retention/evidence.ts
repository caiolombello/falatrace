import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { hashFile } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { assertExistingManagedPath } from "../tui/library";
import { hashStable } from "./plan";
import {
  MEDIA_RETENTION_MESSAGES, MediaRetentionError, MediaRetentionStore, RETAINED_AUDIO_FILE, assertRecordingRoot,
  type MediaRetentionMessage, type RetainedAudio, type RetainedAudioStream, type RetainedMode
} from "./store";

export type MediaEvidenceNeeds = "audio" | "video";

export type MediaEvidence =
  | { ok: true; kind: "original"; path: string; mediaSha256: string }
  | {
    ok: true; kind: "retained-audio"; path: string;
    /** Results computed from this file stay bound to the original media hash, through the tombstone. */
    mediaSha256: string; audioSha256: string; streams: RetainedAudioStream[]; durationSeconds: number;
  }
  | {
    ok: false;
    reason: "removed-by-retention" | "video-removed" | "missing" | "changed" | "retained-audio-invalid" | "tombstone-invalid";
    message: MediaRetentionMessage;
    mode?: RetainedMode;
  };

export type ResolveMediaEvidenceOptions = {
  needs: MediaEvidenceNeeds;
  /** When given, the original must also sit inside `recordingsDir` (no symlink escape). */
  config?: AppConfig;
  /** Hash the file (default). Callers that hash it themselves right after may pass false. */
  verifyHash?: boolean;
  deps?: { store?: MediaRetentionStore; hashFile?: (path: string) => Promise<string> };
};

const refuse = (reason: Extract<MediaEvidence, { ok: false }>["reason"], message: MediaRetentionMessage, mode?: RetainedMode): MediaEvidence =>
  ({ ok: false, reason, message, ...(mode ? { mode } : {}) });

/** The retained audio must still be the exact file the tombstone describes; returns its path. */
export const verifyRetainedAudio = async (
  sourcePath: string, audio: RetainedAudio, hash: (path: string) => Promise<string> = hashFile, verifyHash = true
): Promise<string> => {
  const root = await assertRecordingRoot(sourcePath);
  const path = join(root, RETAINED_AUDIO_FILE);
  if (!verifyHash) {
    const stat = await fs.lstat(path).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== audio.size) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.retainedAudioInvalid);
    return path;
  }
  const hashed = await hashStable(path, hash).catch(() => "changed" as const);
  if (hashed === "changed" || hashed.stat.size !== audio.size || hashed.sha256 !== audio.sha256) {
    throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.retainedAudioInvalid);
  }
  return path;
};

/**
 * The media a feature may read for this job: the original when it is present and unchanged,
 * otherwise (audio-only retention) the retained audio bound to `job.source.sha256` by the
 * tombstone, otherwise a refusal with a message for the person. Never swaps `sourcePath`.
 */
export const resolveMediaEvidence = async (
  job: Pick<JobRecord, "sourcePath" | "source">, options: ResolveMediaEvidenceOptions
): Promise<MediaEvidence> => {
  const sourcePath = resolve(job.sourcePath);
  const hash = options.deps?.hashFile ?? hashFile;
  const verifyHash = options.verifyHash !== false;
  const stat = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined));
  if (stat === undefined) return refuse("changed", MEDIA_RETENTION_MESSAGES.evidenceChanged);
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.source.size) return refuse("changed", MEDIA_RETENTION_MESSAGES.evidenceChanged);
    if (options.config) {
      try { await assertExistingManagedPath(options.config, sourcePath); }
      catch { return refuse("changed", MEDIA_RETENTION_MESSAGES.evidenceChanged); }
    }
    if (verifyHash) {
      const hashed = await hashStable(sourcePath, hash).catch(() => "changed" as const);
      if (hashed === "changed" || hashed.sha256 !== job.source.sha256) return refuse("changed", MEDIA_RETENTION_MESSAGES.evidenceChanged);
    }
    return { ok: true, kind: "original", path: sourcePath, mediaSha256: job.source.sha256 };
  }

  let stored: Awaited<ReturnType<MediaRetentionStore["read"]>>;
  try { stored = await (options.deps?.store ?? new MediaRetentionStore()).read(sourcePath); }
  catch { return refuse("tombstone-invalid", MEDIA_RETENTION_MESSAGES.tombstoneInvalid); }
  if (!stored) return refuse("missing", MEDIA_RETENTION_MESSAGES.mediaMissing);
  const { tombstone } = stored;
  if (tombstone.source.sha256 !== job.source.sha256 || tombstone.source.size !== job.source.size) return refuse("changed", MEDIA_RETENTION_MESSAGES.evidenceChanged);
  if (options.needs === "video" || tombstone.mode === "transcript-only") {
    return tombstone.mode === "audio-only"
      ? refuse("video-removed", MEDIA_RETENTION_MESSAGES.evidenceVideoRemoved, tombstone.mode)
      : refuse("removed-by-retention", MEDIA_RETENTION_MESSAGES.evidenceRemoved, tombstone.mode);
  }
  if (!tombstone.audio) return refuse("retained-audio-invalid", MEDIA_RETENTION_MESSAGES.retainedAudioInvalid, tombstone.mode);
  try {
    const path = await verifyRetainedAudio(sourcePath, tombstone.audio, hash, verifyHash);
    return {
      ok: true, kind: "retained-audio", path, mediaSha256: job.source.sha256, audioSha256: tombstone.audio.sha256,
      streams: tombstone.audio.streams.map((stream) => ({ ...stream })), durationSeconds: tombstone.audio.durationSeconds
    };
  } catch {
    return refuse("retained-audio-invalid", MEDIA_RETENTION_MESSAGES.retainedAudioInvalid, tombstone.mode);
  }
};

/** Throwing form for callers that only proceed with usable media. */
export const requireMediaEvidence = async (
  job: Pick<JobRecord, "sourcePath" | "source">, options: ResolveMediaEvidenceOptions
): Promise<Extract<MediaEvidence, { ok: true }>> => {
  const evidence = await resolveMediaEvidence(job, options);
  if (!evidence.ok) throw new MediaRetentionError(evidence.message);
  return evidence;
};
