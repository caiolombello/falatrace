import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { JobRecord } from "../jobs/types";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionError, MediaRetentionStore, type MediaRetentionTombstone } from "./store";

// Small, dependency-light helpers for the code that reads media (summaries, agent context,
// removal plans, archive and backups). They import only the tombstone store, so modules the
// retention planner itself depends on can use them without an import cycle.

export type RetiredMediaOptions = {
  /** Tombstone states accepted; a finished removal by default. */
  states?: readonly MediaRetentionTombstone["state"][];
  store?: Pick<MediaRetentionStore, "read">;
};

/**
 * The tombstone that explains why this media is absent. Returned only when the original is
 * gone (ENOENT), the tombstone is valid, in an accepted state and names exactly this media
 * (SHA-256 and/or size, at least one of them). Anything else (media present, no tombstone, an
 * invalid or foreign one) is undefined, so callers keep their "missing media" behaviour.
 */
export const retiredMediaTombstone = async (
  sourcePath: string, expected: { sha256?: string; size?: number }, options: RetiredMediaOptions = {}
): Promise<MediaRetentionTombstone | undefined> => {
  if (expected.sha256 === undefined && expected.size === undefined) return undefined;
  const path = resolve(sourcePath);
  const absent = await fs.lstat(path).then(() => false, (error: NodeJS.ErrnoException) => error?.code === "ENOENT");
  if (!absent) return undefined;
  const stored = await (options.store ?? new MediaRetentionStore()).read(path).catch(() => null);
  const tombstone = stored?.tombstone;
  if (!tombstone || !(options.states ?? ["removed"]).includes(tombstone.state)) return undefined;
  if (expected.sha256 !== undefined && tombstone.source.sha256 !== expected.sha256) return undefined;
  if (expected.size !== undefined && tombstone.source.size !== expected.size) return undefined;
  return tombstone;
};

/** The finished removal of this job's media, bound to its hash and size; undefined otherwise. */
export const jobMediaTombstone = (job: Pick<JobRecord, "sourcePath" | "source">, options: RetiredMediaOptions = {}): Promise<MediaRetentionTombstone | undefined> =>
  retiredMediaTombstone(job.sourcePath, { sha256: job.source.sha256, size: job.source.size }, options);

/**
 * Reprocessing needs the original bytes. When retention removed them (or is removing them),
 * refuse with a clear message instead of a file-system error; otherwise do nothing.
 */
export const assertMediaNotRetired = async (job: Pick<JobRecord, "sourcePath" | "source">, options: Omit<RetiredMediaOptions, "states"> = {}): Promise<void> => {
  if (await jobMediaTombstone(job, { ...options, states: ["removing", "removed"] })) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.reprocessRefused);
};
