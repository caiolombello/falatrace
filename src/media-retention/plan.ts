import { promises as fs, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { ArchiveStore, type ArchiveRecord } from "../archive/store";
import { getArchiveDataDir } from "../archive/proton";
import { DiarizationStore } from "../diarization/store";
import { runCommand } from "../jobs/command";
import { JobStore, getDefaultJobStateDir, hashFile } from "../jobs/store";
import { readBoundedArtifact, readTranscriptArtifact, type TranscriptArtifact } from "../jobs/transcript-access";
import { type JobRecord, type Transcript, validateJobId, validateSummary } from "../jobs/types";
import { readVoiceInstallation } from "../models/voice";
import { ProtonBackupStore, type ProtonBackupRecord } from "../proton/backup";
import { RecordingSessionStore, type RecordingSession } from "../recording/session";
import { isSingletonHeld } from "../runtime/singleton";
import { readDiarizationContext } from "../speakers/record";
import { SpeakerSuggestionStore } from "../speakers/store";
import { VoiceRecordStore } from "../speakers/voices";
import { summaryEvidenceMatches } from "../summary/evidence";
import { getReviewedSummaryRoot } from "../summary/reviewed";
import { assertExistingJobArtifactPath, assertExistingManagedPath } from "../tui/library";
import {
  MEDIA_RETENTION_LIMITS, MEDIA_RETENTION_MESSAGES, MediaRetentionStore, assertRecordingRoot, digestText, hasControlCharacters, recordingRootOf, tombstonePathOf,
  type MediaRetentionMessage, type MediaRetentionVerified, type RetainedAudioStream, type RetainedMode, type StoredTombstone
} from "./store";

const DAY_MS = 86_400_000;
const MAX_VISUAL_SESSIONS = 10_000;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_PROBE_OUTPUT = 1024 * 1024;
const MAX_PROBED_STREAMS = 64;
const SHA256 = /^[a-f0-9]{64}$/;

export type CommandRunner = (command: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

/** A library entry, or anything shaped like one (the jobs list is reread from the job store). */
export type MediaRetentionEntry = { sourcePath: string; jobs?: JobRecord[]; archive?: ArchiveRecord };

/** lstat identity of the media; any change (even of ctime) between planning and removal is a conflict. */
export type MediaFingerprint = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
/** A hash computed earlier for this exact inode; reused only while the fingerprint is unchanged. */
export type KnownMediaHash = MediaFingerprint & { sha256: string };

/** Everything that reads the outside world; tests pass temporary stores and fakes. */
export type MediaRetentionDeps = {
  jobStore?: JobStore;
  sessions?: { read(): Promise<RecordingSession | null> };
  diarization?: DiarizationStore;
  speakers?: SpeakerSuggestionStore;
  voiceRecords?: VoiceRecordStore;
  voiceInstalled?: () => Promise<boolean>;
  archives?: { list(): Promise<ArchiveRecord[]> };
  protonBackups?: { get(jobId: string): Promise<ProtonBackupRecord | null> };
  reviewedSummaryRoot?: string;
  visualSessionsRoot?: string;
  archiveDataDir?: string;
  /** Whether a transient systemd unit is active or activating. */
  unitActive?: (unit: string) => Promise<boolean>;
  /** Whether another process holds a singleton lease (diarization, speakers, processing, visual). */
  leaseHeld?: (name: string) => Promise<boolean>;
  hashFile?: (path: string) => Promise<string>;
  run?: CommandRunner;
  store?: MediaRetentionStore;
  readTranscript?: (job: JobRecord) => Promise<TranscriptArtifact>;
  now?: () => number;
  signal?: AbortSignal;
};

export type MediaRetentionBlockerCode =
  | "mode-keep" | "tombstone-invalid" | "already-removed" | "no-jobs" | "jobs-unreadable" | "job-not-settled" | "media-identity-conflict"
  | "capture-active" | "capture-unreadable" | "diarization-running" | "speakers-running" | "summary-running" | "summary-state-unreadable"
  | "visual-running" | "transcript-missing" | "transcript-legacy" | "summary-invalid" | "steps-pending" | "backup-pending" | "backup-mismatch"
  | "proton-backup-pending" | "media-missing" | "media-unsafe" | "media-size-mismatch" | "media-hash-mismatch" | "media-changed"
  | "recording-root-unsafe" | "no-video" | "no-audio" | "probe-failed";

const BLOCKER_MESSAGES: Record<MediaRetentionBlockerCode, MediaRetentionMessage> = {
  "mode-keep": MEDIA_RETENTION_MESSAGES.modeKeep,
  "tombstone-invalid": MEDIA_RETENTION_MESSAGES.tombstoneInvalid,
  "already-removed": MEDIA_RETENTION_MESSAGES.alreadyRemoved,
  "no-jobs": MEDIA_RETENTION_MESSAGES.noJobs,
  "jobs-unreadable": MEDIA_RETENTION_MESSAGES.jobsUnreadable,
  "job-not-settled": MEDIA_RETENTION_MESSAGES.jobNotSettled,
  "media-identity-conflict": MEDIA_RETENTION_MESSAGES.mediaIdentityConflict,
  "capture-active": MEDIA_RETENTION_MESSAGES.captureActive,
  "capture-unreadable": MEDIA_RETENTION_MESSAGES.captureUnreadable,
  "diarization-running": MEDIA_RETENTION_MESSAGES.diarizationRunning,
  "speakers-running": MEDIA_RETENTION_MESSAGES.speakersRunning,
  "summary-running": MEDIA_RETENTION_MESSAGES.summaryRunning,
  "summary-state-unreadable": MEDIA_RETENTION_MESSAGES.summaryStateUnreadable,
  "visual-running": MEDIA_RETENTION_MESSAGES.visualRunning,
  "transcript-missing": MEDIA_RETENTION_MESSAGES.transcriptMissing,
  "transcript-legacy": MEDIA_RETENTION_MESSAGES.transcriptLegacy,
  "summary-invalid": MEDIA_RETENTION_MESSAGES.summaryInvalid,
  "steps-pending": MEDIA_RETENTION_MESSAGES.stepsPending,
  "backup-pending": MEDIA_RETENTION_MESSAGES.backupPending,
  "backup-mismatch": MEDIA_RETENTION_MESSAGES.backupMismatch,
  "proton-backup-pending": MEDIA_RETENTION_MESSAGES.protonBackupPending,
  "media-missing": MEDIA_RETENTION_MESSAGES.mediaMissing,
  "media-unsafe": MEDIA_RETENTION_MESSAGES.mediaUnsafe,
  "media-size-mismatch": MEDIA_RETENTION_MESSAGES.mediaSizeMismatch,
  "media-hash-mismatch": MEDIA_RETENTION_MESSAGES.mediaHashMismatch,
  "media-changed": MEDIA_RETENTION_MESSAGES.mediaChanged,
  "recording-root-unsafe": MEDIA_RETENTION_MESSAGES.recordingRootUnsafe,
  "no-video": MEDIA_RETENTION_MESSAGES.noVideo,
  "no-audio": MEDIA_RETENTION_MESSAGES.noAudio,
  "probe-failed": MEDIA_RETENTION_MESSAGES.probeFailed
};

export type MediaRetentionBlocker = { code: MediaRetentionBlockerCode; message: MediaRetentionMessage; jobId?: string };

export type MediaRetentionSteps = {
  diarization: "ready" | "pending" | "skipped";
  microphone: "ready" | "failed" | "pending" | "skipped";
  voices: "ready" | "failed" | "pending" | "skipped" | "not-applicable";
};

export type MediaRetentionScope = {
  media: "delete";
  copiesElsewhere: "local-only" | "total";
  remoteCopies: "preserved-not-contacted";
  archiveCatalog: "preserved";
  jobRecords: "preserved";
  artifacts: "preserved";
  revisions: "preserved";
  reviewedSummaries: "preserved";
  managedExports: "preserved";
  trash: "not-used";
};

export type MediaRetentionPlan = {
  version: 1;
  /** remove: run the removal (or resume one); finalize: the media is gone, finish purging; none: nothing to do. */
  action: "remove" | "finalize" | "none";
  mode: RetainedMode | "keep";
  reason: "policy" | "manual";
  sourcePath: string;
  recordingRoot: string;
  tombstonePath: string;
  plannedAt: string;
  eligible: boolean;
  blockers: MediaRetentionBlocker[];
  /** A "removing" tombstone from an interrupted attempt exists. */
  resume: boolean;
  /** When the grace period for speaker work ends (only while steps are pending). */
  waitUntil?: string;
  jobs: { id: string; state: JobRecord["state"]; target: JobRecord["target"]; updatedAt: string }[];
  media: { exists: boolean; verified: boolean; fileName: string; size?: number; sha256?: string; mtimeMs?: number; fingerprint?: MediaFingerprint };
  /** Source audio layout (audio-only only); the retained copy must match it exactly. */
  audioStreams?: RetainedAudioStream[];
  durationSeconds?: number;
  verified?: MediaRetentionVerified;
  steps: MediaRetentionSteps;
  backups: { archive: "disabled" | "none" | "pending" | "completed"; vaio?: string; proton?: string; protonJobBackup?: string };
  purge: { protonRestoreCache?: string; visualSessions: string[]; workDirs: string[] };
  scope: MediaRetentionScope;
  /** Present for finalize plans: the tombstone this plan was computed from. */
  tombstoneSha256?: string;
  /** sha256 of the canonical plan without plannedAt/resume; the executor compares it (CAS). */
  digest: string;
};

export type PlanMediaRetentionOptions = {
  now?: number | Date;
  /** Explicit mode (manual removal); defaults to `config.media.retention`. */
  mode?: RetainedMode;
  reason?: "policy" | "manual";
  /** Manual removals only: accept a completed transcript without a verification receipt. */
  allowLegacyTranscript?: boolean;
  /** Hash the media only when every other condition holds (default), always, or never (a cheap preview that is never eligible). */
  verifyMedia?: "when-eligible" | "always" | "never";
  deps?: MediaRetentionDeps;
  /** Executor internals: leases it already holds and a hash it already verified. */
  internal?: { heldLeases?: ReadonlySet<string>; knownHash?: KnownMediaHash };
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  return sorted;
};
export const canonicalPlanJson = (value: unknown): string => JSON.stringify(sortKeys(value));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
/** Archive ids name a folder under media-archive/restored/ that the executor removes. */
export const validArchiveId = (id: unknown): id is string => {
  try { return typeof id === "string" && validateJobId(id) === id; } catch { return false; }
};
const timestamp = (value: number | Date | undefined, deps: MediaRetentionDeps): number => {
  const raw = value instanceof Date ? value.getTime() : value ?? deps.now?.() ?? Date.now();
  if (!Number.isFinite(raw)) throw new Error("Invalid planning clock");
  return raw;
};

export const diarizationUnitName = (jobId: string): string => `recording-cli-diarization-${jobId}.service`;
export const speakersUnitName = (jobId: string): string => `recording-cli-speakers-${jobId}.service`;
export const processLeaseName = (store: Pick<JobStore, "stateDir">, jobId: string): string =>
  `process-${digestText(`${resolve(store.stateDir)}:${jobId}`).slice(0, 32)}`;
/** The leases that media-reading work holds for one job; the executor takes them before removing. */
export const jobWorkLeases = (store: Pick<JobStore, "stateDir">, jobId: string): string[] => [
  `diarization-create-${jobId}`, `diarization-queue-${jobId}`, `speakers-${jobId}`, `speakers-queue-${jobId}`, `job-queue-${jobId}`, processLeaseName(store, jobId)
];
export const visualSessionLease = (key: string): string => `visual-session-${key.slice(0, 32)}`;

export const defaultUnitActive = async (unit: string): Promise<boolean> => {
  const result = await runCommand("systemctl", ["--user", "show", unit, "--property=ActiveState"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }));
  return /^ActiveState=(active|activating)$/m.test(result.stdout);
};

/** Probes without taking the lease, so a concurrent acquirer never fails because of us. */
export const defaultLeaseHeld = (name: string): Promise<boolean> => isSingletonHeld(name).catch(() => true);

export const defaultVisualSessionsRoot = (): string => join(dirname(getDefaultJobStateDir()), "visual-review", "sessions");

export type ResolvedDeps = Required<Omit<MediaRetentionDeps, "now" | "signal">> & Pick<MediaRetentionDeps, "now" | "signal">;
export const resolveDeps = (deps: MediaRetentionDeps = {}): ResolvedDeps => {
  const jobStore = deps.jobStore ?? new JobStore();
  const diarization = deps.diarization ?? new DiarizationStore();
  return {
    jobStore,
    sessions: deps.sessions ?? new RecordingSessionStore(),
    diarization,
    speakers: deps.speakers ?? new SpeakerSuggestionStore(diarization),
    voiceRecords: deps.voiceRecords ?? new VoiceRecordStore(diarization),
    voiceInstalled: deps.voiceInstalled ?? (async () => !!(await readVoiceInstallation())),
    archives: deps.archives ?? new ArchiveStore(),
    protonBackups: deps.protonBackups ?? new ProtonBackupStore(),
    reviewedSummaryRoot: deps.reviewedSummaryRoot ?? getReviewedSummaryRoot(),
    visualSessionsRoot: deps.visualSessionsRoot ?? defaultVisualSessionsRoot(),
    archiveDataDir: deps.archiveDataDir ?? getArchiveDataDir(),
    unitActive: deps.unitActive ?? defaultUnitActive,
    leaseHeld: deps.leaseHeld ?? defaultLeaseHeld,
    hashFile: deps.hashFile ?? hashFile,
    run: deps.run ?? runCommand,
    store: deps.store ?? new MediaRetentionStore(),
    readTranscript: deps.readTranscript ?? ((job) => readTranscriptArtifact(job, jobStore)),
    now: deps.now,
    signal: deps.signal
  };
};

export type ProbedMedia = { audio: RetainedAudioStream[]; videoStreams: number; durationSeconds: number };

/** Strictly parsed ffprobe view of the streams; titles and channels are compared exactly later. */
export const probeMediaStreams = async (run: CommandRunner, path: string, signal?: AbortSignal): Promise<ProbedMedia> => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries",
    "stream=index,codec_type,codec_name,channels:stream_tags=title:stream_disposition=attached_pic:format=duration", "-of", "json", path],
  { timeoutMs: 60_000, signal });
  if (stdout.length > MAX_PROBE_OUTPUT) throw new Error("ffprobe output too large");
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value) || !Array.isArray(value.streams) || value.streams.length > MAX_PROBED_STREAMS || !isRecord(value.format)) throw new Error("Invalid ffprobe output");
  const audio: RetainedAudioStream[] = [];
  let videoStreams = 0;
  for (const stream of value.streams) {
    if (!isRecord(stream) || typeof stream.codec_type !== "string") throw new Error("Invalid ffprobe stream");
    if (stream.codec_type === "video") {
      const picture = isRecord(stream.disposition) && stream.disposition.attached_pic === 1;
      if (!picture) videoStreams += 1;
      continue;
    }
    if (stream.codec_type !== "audio") continue;
    const tags = isRecord(stream.tags) ? stream.tags : {};
    const title = typeof tags.title === "string" ? tags.title : typeof tags.TITLE === "string" ? tags.TITLE : undefined;
    if (typeof stream.codec_name !== "string" || !/^[a-z0-9_]{1,40}$/.test(stream.codec_name) || typeof stream.channels !== "number" ||
      !Number.isSafeInteger(stream.channels) || stream.channels < 1 || stream.channels > 64 ||
      (title !== undefined && (title.length > MEDIA_RETENTION_LIMITS.titleCharacters || hasControlCharacters(title)))) throw new Error("Invalid ffprobe audio stream");
    audio.push({ index: audio.length, ...(title ? { title } : {}), channels: stream.channels, codec: stream.codec_name });
  }
  if (audio.length > MEDIA_RETENTION_LIMITS.audioStreams) throw new Error("Too many audio streams");
  const durationSeconds = Number(value.format.duration);
  if (typeof value.format.duration !== "string" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Invalid ffprobe duration");
  return { audio, videoStreams, durationSeconds };
};

/** Hashes with lstat before and after: dev, inode, size and mtime must not move while reading. */
export const hashStable = async (
  path: string, hash: (path: string) => Promise<string>
): Promise<{ sha256: string; stat: Stats } | "changed"> => {
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) return "changed";
  const sha256 = await hash(path);
  const after = await fs.lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return "changed";
  return { sha256, stat: after };
};

const readReviewedRunning = async (root: string, jobId: string): Promise<"running" | "idle" | "unreadable"> => {
  try {
    const directory = join(root, jobId);
    for (const path of [root, directory]) {
      const stat = await fs.lstat(path).catch((error) => { if (missing(error)) return undefined; throw error; });
      if (!stat) return "idle";
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "unreadable";
    }
    let raw: string;
    try { raw = await readBoundedArtifact(join(directory, "index.json"), 64 * 1024); }
    catch (error) { return missing(error) ? "idle" : "unreadable"; }
    const index: unknown = JSON.parse(raw);
    if (!isRecord(index) || index.version !== 1 || index.jobId !== jobId || !Array.isArray(index.requests) || index.requests.length > 32) return "unreadable";
    let running = false;
    for (const request of index.requests) {
      if (!isRecord(request) || !["planned", "running", "cancelled", "completed"].includes(String(request.status))) return "unreadable";
      running ||= request.status === "running";
    }
    return running ? "running" : "idle";
  } catch { return "unreadable"; }
};

/** Visual sessions whose ledger names this media; frames there are image copies of the video. */
export const findVisualSessions = async (root: string, mediaSha256: string): Promise<string[]> => {
  const stat = await fs.lstat(root).catch((error) => { if (missing(error)) return undefined; throw error; });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe visual sessions root");
  const names = (await fs.readdir(root)).filter((name) => SHA256.test(name)).sort();
  if (names.length > MAX_VISUAL_SESSIONS) throw new Error("Too many visual sessions");
  const found: string[] = [];
  for (const name of names) {
    const directory = join(root, name);
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const stored: unknown = JSON.parse(await readBoundedArtifact(join(directory, ".visual-session.json"), MAX_LEDGER_BYTES));
      if (isRecord(stored) && isRecord(stored.ledger) && stored.ledger.key === name && stored.ledger.mediaSha256 === mediaSha256) found.push(directory);
    } catch { /* unreadable ledgers belong to the visual module; it keeps them */ }
  }
  return found;
};

type SummaryState = { state: "absent" } | { state: "valid"; sha256: string } | { state: "invalid" };
const readSummaryState = async (job: JobRecord, transcript: Transcript): Promise<SummaryState> => {
  const path = join(job.artifactDir, "summary.json");
  try { await assertExistingJobArtifactPath(job, path); }
  catch (error) { return missing(error) ? { state: "absent" } : { state: "invalid" }; }
  try {
    const raw = await readBoundedArtifact(path, 2 * 1024 * 1024);
    const summary = validateSummary(JSON.parse(raw), job.summary.provider, job.summary.model);
    return summaryEvidenceMatches(summary, job.source.sha256, transcript) ? { state: "valid", sha256: digestText(raw) } : { state: "invalid" };
  } catch { return { state: "invalid" }; }
};

const emptySteps = (): MediaRetentionSteps => ({ diarization: "pending", microphone: "pending", voices: "not-applicable" });
const scopeFor = (copies: boolean): MediaRetentionScope => ({
  media: "delete", copiesElsewhere: copies ? "local-only" : "total", remoteCopies: "preserved-not-contacted", archiveCatalog: "preserved",
  jobRecords: "preserved", artifacts: "preserved", revisions: "preserved", reviewedSummaries: "preserved", managedExports: "preserved", trash: "not-used"
});

export const planDigest = (plan: Omit<MediaRetentionPlan, "digest"> | MediaRetentionPlan): string => {
  const { plannedAt: _plannedAt, resume: _resume, digest: _digest, ...core } = plan as MediaRetentionPlan;
  return digestText(canonicalPlanJson(core));
};

/**
 * Dry run: decides whether this recording's media may be dropped now and records
 * exactly what would be verified and purged. It reads (and hashes) but never writes.
 */
export const planMediaRetention = async (
  config: AppConfig, entry: MediaRetentionEntry, options: PlanMediaRetentionOptions = {}
): Promise<MediaRetentionPlan> => {
  const deps = resolveDeps(options.deps);
  const now = timestamp(options.now, options.deps ?? {});
  const sourcePath = resolve(entry.sourcePath);
  const recordingRoot = recordingRootOf(sourcePath);
  const reason = options.reason ?? "policy";
  const mode: RetainedMode | "keep" = options.mode ?? config.media.retention;
  const held = options.internal?.heldLeases ?? new Set<string>();
  const blockers: MediaRetentionBlocker[] = [];
  const block = (code: MediaRetentionBlockerCode, jobId?: string): void => {
    if (!blockers.some((item) => item.code === code && item.jobId === jobId)) blockers.push({ code, message: BLOCKER_MESSAGES[code], ...(jobId ? { jobId } : {}) });
  };
  const leaseHeld = async (name: string): Promise<boolean> => !held.has(name) && deps.leaseHeld(name);
  const plan: Omit<MediaRetentionPlan, "digest"> = {
    version: 1, action: "none", mode, reason, sourcePath, recordingRoot, tombstonePath: tombstonePathOf(sourcePath), plannedAt: new Date(now).toISOString(),
    eligible: false, blockers, resume: false, jobs: [], media: { exists: false, verified: false, fileName: basename(sourcePath) },
    steps: emptySteps(), backups: { archive: config.archive.enabled ? "none" : "disabled" }, purge: { visualSessions: [], workDirs: [] }, scope: scopeFor(false)
  };
  const finish = (): MediaRetentionPlan => {
    // A removal is eligible only with the media hash verified in this very plan.
    plan.eligible = blockers.length === 0 && (plan.action === "finalize" || (plan.action === "remove" && plan.media.verified));
    return { ...plan, digest: planDigest(plan) };
  };

  let mediaStat: Stats | undefined;
  try { mediaStat = await fs.lstat(sourcePath); }
  catch (error) { if (!missing(error)) block("media-unsafe"); }
  plan.media.exists = !!mediaStat;

  let stored: StoredTombstone | null = null;
  try { stored = await deps.store.read(sourcePath); }
  catch (error) {
    block((error as Error)?.message === MEDIA_RETENTION_MESSAGES.recordingRootUnsafe ? "recording-root-unsafe" : "tombstone-invalid");
    return finish();
  }
  if (stored?.tombstone.state === "removed") { block("already-removed"); return finish(); }
  if (stored && !mediaStat && blockers.length === 0) {
    // The source is already gone: only purging and the final state remain.
    const { tombstone } = stored;
    plan.action = "finalize";
    plan.mode = tombstone.mode;
    plan.reason = tombstone.reason;
    plan.resume = true;
    plan.tombstoneSha256 = stored.sha256;
    plan.jobs = [];
    plan.media = { exists: false, verified: false, fileName: tombstone.source.fileName, size: tombstone.source.size, sha256: tombstone.source.sha256, mtimeMs: tombstone.source.mtimeMs };
    plan.verified = tombstone.verified;
    plan.scope = scopeFor(Object.keys(tombstone.verified.backups).length > 0);
    return finish();
  }
  plan.resume = !!stored;
  if (mode === "keep") { block("mode-keep"); return finish(); }
  plan.action = "remove";
  if (!mediaStat) { if (!blockers.length) block("media-missing"); return finish(); }

  // 1. Jobs settled, all describing the same media and recording folder.
  let jobs: JobRecord[];
  try { jobs = (await deps.jobStore.list()).filter((job) => resolve(job.sourcePath) === sourcePath); }
  catch { block("jobs-unreadable"); return finish(); }
  jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  plan.jobs = jobs.map((job) => ({ id: job.id, state: job.state, target: job.target, updatedAt: job.updatedAt }));
  plan.purge.workDirs = jobs.map((job) => deps.jobStore.getWorkDir(job.id));
  const [newest] = jobs;
  if (!newest) { block("no-jobs"); return finish(); }
  if (jobs.length > MEDIA_RETENTION_LIMITS.jobs) { block("jobs-unreadable"); return finish(); }
  const identity = newest.source;
  for (const job of jobs) {
    if (job.state !== "completed" && job.state !== "failed") block("job-not-settled", job.id);
    if (job.source.sha256 !== identity.sha256 || job.source.size !== identity.size) block("media-identity-conflict");
    if (resolve(job.artifactDir) !== join(recordingRoot, job.id)) block("recording-root-unsafe");
  }
  plan.media.size = identity.size;

  // 2. No capture and no work that reads the media.
  try {
    const session = await deps.sessions.read();
    if (session && resolve(session.outputPath) === sourcePath && session.phase !== "stopped") block("capture-active");
  } catch { block("capture-unreadable"); }
  for (const job of jobs) {
    if (await leaseHeld(`job-queue-${job.id}`) || await leaseHeld(processLeaseName(deps.jobStore, job.id))) block("job-not-settled", job.id);
    const diarizing = await leaseHeld(`diarization-create-${job.id}`) || await leaseHeld(`diarization-queue-${job.id}`) ||
      ((await deps.diarization.readOperation(job.id))?.state === "running" && await deps.unitActive(diarizationUnitName(job.id)));
    if (diarizing) block("diarization-running", job.id);
    const suggesting = await leaseHeld(`speakers-${job.id}`) || await leaseHeld(`speakers-queue-${job.id}`) ||
      ((await deps.speakers.readOperation(job.id))?.state === "running" && await deps.unitActive(speakersUnitName(job.id)));
    if (suggesting) block("speakers-running", job.id);
    const reviewed = await readReviewedRunning(deps.reviewedSummaryRoot, job.id);
    if (reviewed === "running") block("summary-running", job.id);
    if (reviewed === "unreadable") block("summary-state-unreadable", job.id);
  }
  try {
    plan.purge.visualSessions = await findVisualSessions(deps.visualSessionsRoot, identity.sha256);
    for (const directory of plan.purge.visualSessions) {
      if (await leaseHeld(visualSessionLease(basename(directory)))) block("visual-running");
    }
  } catch { block("visual-running"); }

  // 3–4. A published transcript with a verification receipt, and a summary that matches it.
  const completed = jobs.filter((job) => job.state === "completed");
  let chosen: { job: JobRecord; artifact: TranscriptArtifact } | undefined;
  let legacy: { job: JobRecord; artifact: TranscriptArtifact } | undefined;
  for (const job of completed) {
    try {
      const artifact = await deps.readTranscript(job);
      if (artifact.provenance.origin !== "published") continue;
      if (artifact.provenance.receipt === "verified") { chosen = { job, artifact }; break; }
      legacy ??= { job, artifact };
    } catch { /* an unreadable transcript simply does not qualify */ }
  }
  if (!chosen && legacy) {
    if (reason === "manual" && options.allowLegacyTranscript === true) chosen = legacy;
    else block("transcript-legacy");
  }
  if (!chosen && !legacy) block("transcript-missing");

  let steps = emptySteps();
  const backups: MediaRetentionVerified["backups"] = {};
  if (chosen) {
    const { job, artifact } = chosen;
    const summary = await readSummaryState(job, artifact.transcript);
    if (summary.state === "invalid") block("summary-invalid", job.id);

    // 5. Media-derived steps: wait for them within the grace period, then record what was skipped.
    const context = await readDiarizationContext(job, artifact.transcript, deps.diarization).catch(() => undefined);
    const suggestions = context ? await deps.speakers.read(context.binding).catch(() => undefined) : undefined;
    const voicesApplicable = config.speakers.voices && await deps.voiceInstalled().catch(() => false);
    const voiceRecord = context && voicesApplicable ? await deps.voiceRecords.read(context.binding).catch(() => undefined) : undefined;
    steps = {
      diarization: context ? "ready" : "pending",
      microphone: !suggestions?.microphone ? "pending" : suggestions.microphone.state === "failed" ? "failed" : "ready",
      voices: !voicesApplicable ? "not-applicable" : voiceRecord ? "ready" : suggestions?.voice?.state === "failed" ? "failed" : "pending"
    };
    const settledAt = Math.max(...jobs.map((item) => Date.parse(item.updatedAt)).filter(Number.isFinite));
    const graceEnds = settledAt + config.media.graceDays * DAY_MS;
    const pending = steps.diarization === "pending" || steps.microphone === "pending" || steps.voices === "pending";
    // A manual removal is an explicit confirmation that pending speaker work may be lost.
    const expired = reason === "manual" || !Number.isFinite(graceEnds) || now >= graceEnds;
    if (pending && !expired) {
      block("steps-pending");
      plan.waitUntil = new Date(graceEnds).toISOString();
    }
    if (expired) {
      steps = {
        diarization: steps.diarization === "pending" ? "skipped" : steps.diarization,
        microphone: steps.microphone === "pending" ? "skipped" : steps.microphone,
        voices: steps.voices === "pending" ? "skipped" : steps.voices
      };
    }
    plan.verified = {
      jobId: job.id,
      receipt: artifact.provenance.receipt,
      transcriptArtifactSha256: artifact.provenance.transcriptSha256,
      ...(artifact.provenance.receipt === "verified" && artifact.provenance.receiptSha256 ? { receiptSha256: artifact.provenance.receiptSha256 } : {}),
      ...(summary.state === "valid" ? { summarySha256: summary.sha256 } : {}),
      ...(context ? { diarizationSha256: context.binding.diarizationSha256 } : {}),
      microphone: steps.microphone === "ready" ? "ready" : steps.microphone === "failed" ? "failed" : "skipped",
      voices: steps.voices === "ready" ? "ready" : "skipped",
      backups
    };
  }
  plan.steps = steps;

  // 6. Backups: every configured archive target done, and the full Proton job backup when that policy is on.
  // With the archive on, the catalog decides (a caller's entry may be a stale snapshot, and the
  // executor's re-plan must see fresh state); with it off, a record only describes extra copies.
  let found: ArchiveRecord | undefined;
  if (config.archive.enabled) {
    try { found = (await deps.archives.list()).find((record) => resolve(record.sourcePath) === sourcePath); }
    catch { block("backup-pending"); }
  } else if (entry.archive && resolve(entry.archive.sourcePath) === sourcePath) {
    found = entry.archive;
  }
  if (found && !validArchiveId(found.id)) {
    if (config.archive.enabled) block("backup-mismatch");
    found = undefined;
  }
  const archive = found;
  if (archive) {
    const matches = archive.source.sha256 === identity.sha256 && archive.source.size === identity.size;
    if (matches && archive.vaio.state === "completed") backups.vaio = archive.vaio.verifiedAt;
    if (matches && archive.proton.state === "completed") backups.proton = archive.proton.verifiedAt;
    plan.purge.protonRestoreCache = join(deps.archiveDataDir, "restored", archive.id);
    if (config.archive.enabled) {
      if (!matches && archive.source.sha256 !== undefined) block("backup-mismatch");
      const waiting = (["vaio", "proton"] as const).some((target) => config.archive[target] && (archive[target].state !== "completed" || !matches));
      if (waiting) block("backup-pending");
      plan.backups.archive = waiting ? "pending" : "completed";
    }
  }
  if (config.proton.enabled && config.proton.policy === "full") {
    for (const job of completed) {
      try {
        const record = await deps.protonBackups.get(job.id);
        const at = record ? Date.parse(record.updatedAt) : Number.NaN;
        if (record?.state !== "completed" || record.policy !== "full" || !Number.isFinite(at)) block("proton-backup-pending", job.id);
        else if (!backups.protonJobBackup || at > Date.parse(backups.protonJobBackup)) backups.protonJobBackup = new Date(at).toISOString();
      } catch { block("proton-backup-pending", job.id); }
    }
  }
  if (backups.vaio) plan.backups.vaio = backups.vaio;
  if (backups.proton) plan.backups.proton = backups.proton;
  if (backups.protonJobBackup) plan.backups.protonJobBackup = backups.protonJobBackup;
  plan.scope = scopeFor(Object.keys(backups).length > 0);

  // 7. Media identity: managed path, regular file, expected size, then the hash with stat checks.
  try { await assertExistingManagedPath(config, sourcePath); }
  catch { block("media-unsafe"); }
  try { await assertRecordingRoot(sourcePath); }
  catch { block("recording-root-unsafe"); }
  if (!mediaStat.isFile() || mediaStat.isSymbolicLink()) { block("media-unsafe"); return finish(); }
  if (mediaStat.size !== identity.size) { block("media-size-mismatch"); return finish(); }

  if (mode === "audio-only") {
    try {
      const probed = await probeMediaStreams(deps.run, sourcePath, deps.signal);
      plan.audioStreams = probed.audio;
      plan.durationSeconds = probed.durationSeconds;
      if (!probed.audio.length) block("no-audio");
      else if (!probed.videoStreams) block("no-video");
    } catch { block("probe-failed"); }
  }

  if (options.verifyMedia === "never" || (blockers.length && options.verifyMedia !== "always")) return finish();
  const known = options.internal?.knownHash;
  let verified: { sha256: string; stat: Stats } | "changed";
  if (known && known.dev === mediaStat.dev && known.ino === mediaStat.ino && known.size === mediaStat.size &&
    known.mtimeMs === mediaStat.mtimeMs && known.ctimeMs === mediaStat.ctimeMs) {
    verified = { sha256: known.sha256, stat: mediaStat };
  } else {
    try { verified = await hashStable(sourcePath, deps.hashFile); }
    catch { verified = "changed"; }
  }
  if (verified === "changed" || verified.stat.dev !== mediaStat.dev || verified.stat.ino !== mediaStat.ino ||
    verified.stat.size !== mediaStat.size || verified.stat.mtimeMs !== mediaStat.mtimeMs || verified.stat.ctimeMs !== mediaStat.ctimeMs) { block("media-changed"); return finish(); }
  if (verified.sha256 !== identity.sha256) { block("media-hash-mismatch"); return finish(); }
  plan.media = {
    exists: true, verified: true, fileName: plan.media.fileName, size: verified.stat.size, sha256: verified.sha256, mtimeMs: verified.stat.mtimeMs,
    fingerprint: { dev: verified.stat.dev, ino: verified.stat.ino, size: verified.stat.size, mtimeMs: verified.stat.mtimeMs, ctimeMs: verified.stat.ctimeMs }
  };
  return finish();
};
