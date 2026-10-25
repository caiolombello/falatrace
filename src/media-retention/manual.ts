import { resolve } from "node:path";
import { applyMediaRetention, type ApplyMediaRetentionDeps, type MediaRetentionResult } from "./apply";
import { canonicalPlanJson, planMediaRetention, type KnownMediaHash, type MediaRetentionBlockerCode, type MediaRetentionEntry, type MediaRetentionPlan } from "./plan";
import { MEDIA_RETENTION_MESSAGES, MediaRetentionError, digestText, type RetainedMode } from "./store";

// "Remover mídia agora…": the person chooses what to keep, sees what blocks it, and confirms
// with a consent key bound to the exact plans shown (media hash, jobs, backups, purge scope).

export const MANUAL_MEDIA_MODES: readonly RetainedMode[] = Object.freeze(["transcript-only", "audio-only"]);

export type MediaRemovalOption = {
  mode: RetainedMode;
  eligible: boolean;
  /** Bytes of the original that go away; null when it depends on the audio kept (audio-only). */
  bytesFreed: number | null;
  reasons: string[];
  blockers: MediaRetentionBlockerCode[];
};

export type MediaRemovalPlan = {
  key: string;
  eligible: boolean;
  /** Why nothing can be removed now (empty when some option is eligible). */
  reasons: string[];
  options: MediaRemovalOption[];
  /** total: no verified copy elsewhere, the media is gone for good; local-only: archive copies stay. */
  scope: "total" | "local-only";
  /** The transcript has no verification receipt; removing still keeps it, but the UI should say so. */
  legacyTranscript: boolean;
  consentKey: string;
};

/** Everything the planner and executor read; `config` is the configuration in effect. */
export type MediaRemovalDeps = ApplyMediaRetentionDeps;

const unique = (values: string[]): string[] => [...new Set(values)];

/** Plans every mode, hashing the media at most once (the second plan reuses the verified hash). */
const planModes = async (entry: MediaRetentionEntry, deps: MediaRemovalDeps): Promise<MediaRetentionPlan[]> => {
  const now = deps.now?.() ?? Date.now();
  const base = { reason: "manual" as const, allowLegacyTranscript: true, now, deps };
  const plans: MediaRetentionPlan[] = [];
  let knownHash: KnownMediaHash | undefined;
  for (const mode of MANUAL_MEDIA_MODES) {
    const plan = await planMediaRetention(deps.config, entry, { ...base, mode, ...(knownHash ? { internal: { knownHash } } : {}) });
    // An unfinished removal whose media is already gone has one way forward: finishing it.
    if (plan.action === "finalize") return [plan];
    if (plan.media.verified && plan.media.fingerprint && plan.media.sha256) knownHash ??= { ...plan.media.fingerprint, sha256: plan.media.sha256 };
    plans.push(plan);
  }
  return plans;
};

const consentKeyOf = (sourcePath: string, plans: MediaRetentionPlan[]): string => digestText(canonicalPlanJson({
  version: 1, op: "media-remove", sourcePath, plans: plans.map((plan) => ({ mode: plan.mode, action: plan.action, eligible: plan.eligible, digest: plan.digest }))
}));

const optionOf = (plan: MediaRetentionPlan): MediaRemovalOption => ({
  mode: plan.mode === "keep" ? "transcript-only" : plan.mode,
  eligible: plan.eligible,
  bytesFreed: plan.action === "finalize" ? 0 : plan.mode === "audio-only" ? null : plan.media.size ?? null,
  reasons: unique(plan.blockers.map((blocker) => blocker.message)),
  blockers: [...new Set(plan.blockers.map((blocker) => blocker.code))]
});

/** Dry run for the Studio's "Remover mídia agora…": reads and hashes, never writes. */
export const planMediaRemoval = async (entry: MediaRetentionEntry, deps: MediaRemovalDeps): Promise<MediaRemovalPlan> => {
  const sourcePath = resolve(entry.sourcePath);
  const plans = await planModes(entry, deps);
  const options = plans.map(optionOf);
  const eligible = options.some((option) => option.eligible);
  return {
    key: sourcePath,
    eligible,
    reasons: eligible ? [] : unique(options.flatMap((option) => option.reasons)),
    options,
    scope: plans.some((plan) => plan.scope.copiesElsewhere === "local-only") ? "local-only" : "total",
    legacyTranscript: plans.some((plan) => plan.verified?.receipt === "legacy-unverified"),
    consentKey: consentKeyOf(sourcePath, plans)
  };
};

/**
 * Removes the media now, keeping the transcript (and the audio for audio-only). The consent
 * key must come from `planMediaRemoval` over the same, unchanged state; any change asks again.
 */
export const removeMediaNow = async (
  entry: MediaRetentionEntry, mode: RetainedMode, consentKey: string, deps: MediaRemovalDeps
): Promise<MediaRetentionResult> => {
  if (!MANUAL_MEDIA_MODES.includes(mode)) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.modeInvalid);
  if (typeof consentKey !== "string" || !/^[a-f0-9]{64}$/.test(consentKey)) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.consentRequired);
  const sourcePath = resolve(entry.sourcePath);
  const plans = await planModes(entry, deps);
  if (consentKeyOf(sourcePath, plans) !== consentKey) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.planChanged);
  const [first] = plans;
  const plan = first?.action === "finalize" ? first : plans.find((item) => item.mode === mode);
  if (!plan) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.planChanged);
  if (!plan.eligible) throw new MediaRetentionError(plan.blockers[0]?.message ?? MEDIA_RETENTION_MESSAGES.planChanged);
  return applyMediaRetention(entry, plan, deps);
};
