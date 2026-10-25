import type { ArchiveRecord } from "../archive/store";
import { ArchiveStore } from "../archive/store";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { buildLibrary } from "../tui/library";
import { type ApplyMediaRetentionDeps, type MediaRetentionResult, applyMediaRetention } from "./apply";
import { type MediaRetentionBlockerCode, type MediaRetentionDeps, type MediaRetentionEntry, planMediaRetention } from "./plan";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionError } from "./store";

export * from "./store";
export * from "./plan";
export * from "./apply";
export * from "./evidence";
export * from "./state";

/** Fixed Portuguese messages this module can show (bridge whitelist and i18n keys). */
export const MEDIA_RETENTION_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(MEDIA_RETENTION_MESSAGES));

export type MediaRetentionPassItem = {
  sourcePath: string;
  outcome: "removed" | "finalized" | "waiting" | "blocked" | "deferred" | "failed";
  blockers?: MediaRetentionBlockerCode[];
  waitUntil?: string;
  result?: MediaRetentionResult;
  error?: string;
};

export type MediaRetentionPassOptions = {
  entries?: MediaRetentionEntry[];
  now?: number;
  /** Most recordings whose media is hashed in one pass (hashing large videos is the costly part); the rest are deferred. */
  limit?: number;
  deps?: MediaRetentionDeps & Omit<ApplyMediaRetentionDeps, "config">;
};

/** Screening reads the job list once per pass; the executor re-plans with fresh reads and compares digests. */
class ListOnceJobStore extends JobStore {
  private listed?: Promise<JobRecord[]>;
  override list(): Promise<JobRecord[]> {
    this.listed ??= super.list();
    return this.listed;
  }
}

const HASH_BLOCKERS = new Set<MediaRetentionBlockerCode>(["media-hash-mismatch", "media-changed"]);
const WAITING = new Set<MediaRetentionBlockerCode>(["steps-pending", "backup-pending", "proton-backup-pending"]);

/**
 * The automatic policy: plans every entry and applies the eligible ones. Unfinished removals
 * (a "removing" tombstone whose media is gone) are finished even when the policy is now "keep".
 * Never throws for one entry; each outcome is reported.
 */
export const runMediaRetentionPass = async (config: AppConfig, options: MediaRetentionPassOptions = {}): Promise<MediaRetentionPassItem[]> => {
  const limit = options.limit ?? 3;
  const entries = options.entries ?? await buildLibrary(config, options.deps?.jobStore);
  const items: MediaRetentionPassItem[] = [];
  let hashed = 0;
  const deps = { ...options.deps, ...(options.now !== undefined ? { now: () => options.now as number } : {}) };
  const jobs = deps.jobStore ?? new JobStore();
  const archives = deps.archives ?? new ArchiveStore();
  let archiveList: Promise<ArchiveRecord[]> | undefined;
  const screening = { ...deps, jobStore: new ListOnceJobStore(jobs.stateDir, jobs.dataDir), archives: { list: () => (archiveList ??= archives.list()) } };
  for (const entry of entries) {
    try {
      const plan = await planMediaRetention(config, entry, { reason: "policy", deps: screening, now: options.now, verifyMedia: hashed < limit ? "when-eligible" : "never" });
      if (plan.media.verified || plan.blockers.some((item) => HASH_BLOCKERS.has(item.code))) hashed += 1;
      const blockers = plan.blockers.map((item) => item.code);
      if (plan.eligible) {
        const result = await applyMediaRetention(entry, plan, { ...deps, config });
        items.push({ sourcePath: plan.sourcePath, outcome: plan.action === "finalize" ? "finalized" : "removed", result });
      } else if (plan.action === "remove" && !blockers.length) {
        items.push({ sourcePath: plan.sourcePath, outcome: "deferred" });
      } else {
        const waiting = blockers.length > 0 && blockers.every((code) => WAITING.has(code));
        items.push({ sourcePath: plan.sourcePath, outcome: waiting ? "waiting" : "blocked", blockers, ...(plan.waitUntil ? { waitUntil: plan.waitUntil } : {}) });
      }
    } catch (error) {
      items.push({ sourcePath: entry.sourcePath, outcome: "failed",
        error: error instanceof MediaRetentionError ? error.message : MEDIA_RETENTION_MESSAGES.removeFailed });
    }
  }
  return items;
};
