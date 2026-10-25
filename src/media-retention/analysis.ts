import type { JobRecord } from "../jobs/types";
import { resolveMediaEvidence } from "./evidence";
import { MediaRetentionError, type MediaRetentionStore } from "./store";

/** The file an audio analysis reads, with the size and SHA-256 that file must have right now. */
export type AnalysisMedia = {
  path: string;
  /** original: this computer or a verified copy elsewhere; retained-audio: what an audio-only removal kept. */
  kind: "original" | "retained-audio";
  size: number;
  sha256: string;
};

export type ResolveAnalysisMediaOptions = {
  /**
   * The existing lookup of the original: this computer first, then verified archive copies
   * (VAIO, Proton). Speaker identification, microphone analysis and voices pass their own.
   */
  original: () => Promise<string>;
  store?: MediaRetentionStore;
};

/**
 * Media for speaker identification, microphone analysis and voices. The original keeps
 * its existing lookup (local, then archive copies). When retention removed the local file,
 * the audio-only copy bound to `job.source.sha256` through the tombstone serves instead; if
 * there is none and no copy elsewhere, the refusal says the media was removed by retention.
 * Results stay bound to `job.source.sha256`; callers verify `size` and `sha256` of the file.
 */
export const resolveAnalysisMedia = async (job: Pick<JobRecord, "sourcePath" | "source">, options: ResolveAnalysisMediaOptions): Promise<AnalysisMedia> => {
  const evidence = await resolveMediaEvidence(job, { needs: "audio", verifyHash: false, deps: { ...(options.store ? { store: options.store } : {}) } });
  if (evidence.ok && evidence.kind === "retained-audio") return { path: evidence.path, kind: "retained-audio", size: evidence.size, sha256: evidence.audioSha256 };
  const original = (path: string): AnalysisMedia => ({ path, kind: "original", size: job.source.size, sha256: job.source.sha256 });
  if (!evidence.ok && evidence.reason !== "missing" && evidence.reason !== "changed") {
    // Removed by retention (or its record is unusable here): a verified copy elsewhere still serves.
    try { return original(await options.original()); }
    catch (error) { throw new MediaRetentionError(evidence.message, { cause: error }); }
  }
  // Present, changed or missing without a tombstone: exactly the lookup and errors of before.
  return original(await options.original());
};
