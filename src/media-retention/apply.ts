import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { withRevisionLease } from "../revisions";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";
import {
  type MediaRetentionDeps, type MediaRetentionEntry, type MediaRetentionPlan, type MediaRetentionScope, type ResolvedDeps,
  findVisualSessions, hashStable, jobWorkLeases, planDigest, planMediaRetention, probeMediaStreams, resolveDeps, validArchiveId, visualSessionLease
} from "./plan";
import { verifyRetainedAudio } from "./evidence";
import {
  MEDIA_RETENTION_MESSAGES, MediaRetentionError, PURGE_KINDS, RETAINED_AUDIO_FILE, assertRecordingRoot, digestText, recordingRootOf,
  type MediaRetentionTombstone, type PurgeKind, type RetainedAudio, type RetainedAudioStream, type StoredTombstone
} from "./store";

const AUDIO_COPY_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TEMPORARY_AUDIO = /^audio\.(mp3|wav)$|^chunk-\d+\.mp3$/;

export type ApplyStep = "tombstone-removing" | "audio-retained" | "source-removed" | "purged";

export type ApplyMediaRetentionDeps = MediaRetentionDeps & {
  config: AppConfig;
  withRevisionLease?: <T>(jobId: string, action: () => Promise<T>) => Promise<T>;
  acquireLease?: (name: string) => Promise<SingletonLease>;
  /** Called after each durable step; tests throw here to simulate a crash. */
  checkpoint?: (step: ApplyStep) => Promise<void>;
};

export type MediaRetentionResult = {
  status: "removed" | "already-removed";
  sourcePath: string;
  mode: MediaRetentionTombstone["mode"];
  tombstone: MediaRetentionTombstone;
  /** Size of the original removed by this call (0 when it only finished an earlier attempt). */
  bytesFreed: number;
  retainedAudio?: { path: string; size: number; sha256: string };
  purged: PurgeKind[];
  scope: MediaRetentionScope;
};

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
type Message = (typeof MEDIA_RETENTION_MESSAGES)[keyof typeof MEDIA_RETENTION_MESSAGES];
function fail(message: Message, cause?: unknown): never {
  throw new MediaRetentionError(message, cause === undefined ? undefined : { cause });
}
const asRetentionError = (error: unknown, fallback: Message): MediaRetentionError =>
  error instanceof MediaRetentionError ? error : new MediaRetentionError(fallback, { cause: error });

/**
 * One lease per recording folder, because that folder holds the tombstone, the retained audio and
 * the temporary files this executor owns. Media files that share a name stem (`talk.mkv` and
 * `talk.mp4`) share `talk.recording/`, so they must not run concurrently.
 */
export const recordingLeaseName = (sourcePath: string): string => `media-retention-${digestText(recordingRootOf(sourcePath)).slice(0, 32)}`;

const scopeOf = (tombstone: MediaRetentionTombstone): MediaRetentionScope => ({
  media: "delete", copiesElsewhere: Object.keys(tombstone.verified.backups).length ? "local-only" : "total", remoteCopies: "preserved-not-contacted",
  archiveCatalog: "preserved", jobRecords: "preserved", artifacts: "preserved", revisions: "preserved", reviewedSummaries: "preserved",
  managedExports: "preserved", trash: "not-used"
});

const withLeases = async <T>(ids: string[], lease: NonNullable<ApplyMediaRetentionDeps["withRevisionLease"]>, action: () => Promise<T>): Promise<T> => {
  const [first, ...rest] = ids;
  return first === undefined ? action() : lease(first, () => withLeases(rest, lease, action));
};

const sameStreams = (left: RetainedAudioStream[], right: RetainedAudioStream[]): boolean =>
  left.length === right.length && left.every((stream, index) => {
    const other = right[index];
    return !!other && stream.index === other.index && stream.codec === other.codec && stream.channels === other.channels && stream.title === other.title;
  });

/** Copies every audio stream (order, titles, channels, codec) into a private Matroska file, then verifies it. */
const retainAudio = async (
  sourcePath: string, root: string, expected: { streams: RetainedAudioStream[]; durationSeconds: number }, deps: ResolvedDeps
): Promise<RetainedAudio> => {
  const temporaryDir = await fs.mkdtemp(join(root, ".retained-audio-"));
  await fs.chmod(temporaryDir, 0o700);
  const output = join(temporaryDir, "audio.mka");
  try {
    try {
      await deps.run("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-n", "-i", sourcePath, "-map", "0:a", "-c", "copy", "-vn", "-sn", "-dn",
        "-map_metadata", "0", "-f", "matroska", output], { timeoutMs: AUDIO_COPY_TIMEOUT_MS, signal: deps.signal });
    } catch (error) { return fail(MEDIA_RETENTION_MESSAGES.audioFailed, error); }
    const written = await fs.lstat(output).catch((error) => fail(MEDIA_RETENTION_MESSAGES.audioFailed, error));
    if (!written.isFile() || written.isSymbolicLink() || written.size <= 0) fail(MEDIA_RETENTION_MESSAGES.audioFailed);
    await fs.chmod(output, 0o600);
    const probed = await probeMediaStreams(deps.run, output, deps.signal).catch((error) => fail(MEDIA_RETENTION_MESSAGES.audioMismatch, error));
    const tolerance = Math.max(2, expected.durationSeconds * 0.01);
    if (probed.videoStreams !== 0 || !sameStreams(probed.audio, expected.streams) || Math.abs(probed.durationSeconds - expected.durationSeconds) > tolerance) {
      fail(MEDIA_RETENTION_MESSAGES.audioMismatch);
    }
    const hashed = await hashStable(output, deps.hashFile).catch(() => "changed" as const);
    if (hashed === "changed") return fail(MEDIA_RETENTION_MESSAGES.audioFailed);
    const finalPath = join(root, RETAINED_AUDIO_FILE);
    const existing = await fs.lstat(finalPath).catch((error) => { if (missing(error)) return undefined; return fail(MEDIA_RETENTION_MESSAGES.audioFailed, error); });
    if (existing?.isDirectory()) fail(MEDIA_RETENTION_MESSAGES.audioFailed);
    await fs.rename(output, finalPath);
    const placed = await fs.lstat(finalPath);
    if (placed.ino !== hashed.stat.ino || placed.dev !== hashed.stat.dev || placed.size !== hashed.stat.size) fail(MEDIA_RETENTION_MESSAGES.audioFailed);
    return { fileName: RETAINED_AUDIO_FILE, size: hashed.stat.size, sha256: hashed.sha256, streams: probed.audio, durationSeconds: probed.durationSeconds };
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Leftovers of an interrupted attempt: temporary audio folders and tombstone temp files we own by name. */
const removeLeftovers = async (root: string): Promise<void> => {
  for (const name of await fs.readdir(root)) {
    const path = join(root, name);
    if (/^\.retained-audio-/.test(name)) {
      const stat = await fs.lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(path, { recursive: true, force: true });
    } else if (/^\.media-retention\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) {
      const stat = await fs.lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(path);
    }
  }
};

const realDirectory = async (path: string): Promise<boolean> => {
  const stat = await fs.lstat(path).catch((error) => { if (missing(error)) return undefined; throw error; });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`);
  return true;
};

const purgeProtonRestoreCache = async (entry: MediaRetentionEntry, sourcePath: string, deps: ResolvedDeps): Promise<void> => {
  // Every catalog record of this media (and the caller's, when it names it) may have a restored copy.
  const records = [...(entry.archive ? [entry.archive] : []), ...await deps.archives.list()]
    .filter((record) => resolve(record.sourcePath) === sourcePath);
  // Each id becomes a path segment of a recursive removal: never let it climb out of restored/.
  // Restores only ever create folders named by a valid id, so an invalid one has nothing to purge.
  const ids = [...new Set(records.map((record) => record.id).filter(validArchiveId))];
  if (!ids.length) return;
  const restored = join(deps.archiveDataDir, "restored");
  if (!await realDirectory(deps.archiveDataDir) || !await realDirectory(restored)) return;
  for (const id of ids) {
    const cache = join(restored, id);
    if (await realDirectory(cache)) await fs.rm(cache, { recursive: true, force: false });
  }
};

const purgeVisualFrames = async (sha256: string, deps: ResolvedDeps, acquire: (name: string) => Promise<SingletonLease>): Promise<void> => {
  for (const directory of await findVisualSessions(deps.visualSessionsRoot, sha256)) {
    // The visual module holds this lease while it extracts or reads frames.
    const lease = await acquire(visualSessionLease(basename(directory)));
    try {
      const frames = join(directory, "frames");
      if (await realDirectory(frames)) await fs.rm(frames, { recursive: true, force: false });
    } finally { await lease.release(); }
  }
};

const purgeWorkAudio = async (jobIds: string[], deps: ResolvedDeps): Promise<void> => {
  for (const id of jobIds) {
    const workDir = deps.jobStore.getWorkDir(id);
    if (!await realDirectory(workDir)) continue;
    for (const name of await fs.readdir(workDir)) {
      const path = join(workDir, name);
      if (TEMPORARY_AUDIO.test(name)) {
        const stat = await fs.lstat(path);
        if (stat.isFile() || stat.isSymbolicLink()) await fs.unlink(path);
      } else if (name.startsWith(".transcription-")) {
        if (await realDirectory(path)) await fs.rm(path, { recursive: true, force: false });
      }
    }
  }
};

/** The original is gone: purge derived copies, then mark the tombstone removed. Safe to repeat. */
const finalize = async (
  entry: MediaRetentionEntry, stored: StoredTombstone, now: number, deps: ApplyMediaRetentionDeps, resolved: ResolvedDeps, bytesFreed: number
): Promise<MediaRetentionResult> => {
  const { tombstone } = stored;
  const sourcePath = tombstone.sourcePath;
  const retainedPath = tombstone.mode === "audio-only"
    ? tombstone.audio ? await verifyRetainedAudio(sourcePath, tombstone.audio, resolved.hashFile) : fail(MEDIA_RETENTION_MESSAGES.retainedAudioInvalid)
    : undefined;
  const purged = new Set<PurgeKind>(tombstone.purged);
  let current = stored;
  const steps: Record<PurgeKind, () => Promise<void>> = {
    "proton-restore-cache": () => purgeProtonRestoreCache(entry, sourcePath, resolved),
    "visual-frames": () => purgeVisualFrames(tombstone.source.sha256, resolved, deps.acquireLease ?? acquireSingleton),
    "work-temp-audio": () => purgeWorkAudio(tombstone.jobs, resolved)
  };
  let failure: unknown;
  for (const kind of PURGE_KINDS) {
    if (purged.has(kind)) continue;
    try { await steps[kind](); purged.add(kind); }
    catch (error) { failure ??= error; }
  }
  const purgedList = PURGE_KINDS.filter((kind) => purged.has(kind));
  if (failure !== undefined) {
    // Keep what did succeed, so the next run retries only the rest.
    if (purgedList.length !== tombstone.purged.length) await resolved.store.write({ ...tombstone, purged: purgedList }, current.raw).catch(() => undefined);
    fail(MEDIA_RETENTION_MESSAGES.purgeFailed, failure);
  }
  await deps.checkpoint?.("purged");
  const { removedAt: _previous, ...rest } = tombstone;
  current = await resolved.store.write({ ...rest, state: "removed", removedAt: new Date(now).toISOString(), purged: purgedList }, current.raw);
  return {
    status: "removed", sourcePath, mode: tombstone.mode, tombstone: current.tombstone, bytesFreed,
    ...(retainedPath && tombstone.audio ? { retainedAudio: { path: retainedPath, size: tombstone.audio.size, sha256: tombstone.audio.sha256 } } : {}),
    purged: purgedList, scope: scopeOf(current.tombstone)
  };
};

/**
 * Executes a plan from `planMediaRetention`: re-plans and compares the digest (CAS), records a
 * "removing" tombstone, keeps the audio when asked, removes the original under the revision and
 * work leases, purges derived copies and marks the tombstone "removed". An interrupted run is
 * resumed by planning and applying again. Job records, artifacts, revisions, reviewed summaries,
 * exports and remote copies are never touched.
 */
export const applyMediaRetention = async (
  entry: MediaRetentionEntry, plan: MediaRetentionPlan, deps: ApplyMediaRetentionDeps
): Promise<MediaRetentionResult> => {
  const resolved = resolveDeps(deps);
  const config = deps.config;
  const now = deps.now?.() ?? Date.now();
  const sourcePath = resolve(entry.sourcePath);
  if (plan?.version !== 1 || plan.sourcePath !== sourcePath || plan.digest !== planDigest(plan)) fail(MEDIA_RETENTION_MESSAGES.planChanged);
  if (!plan.eligible) throw new MediaRetentionError(plan.blockers[0]?.message ?? MEDIA_RETENTION_MESSAGES.planChanged);
  const acquire = deps.acquireLease ?? acquireSingleton;
  const revisionLease = deps.withRevisionLease ?? withRevisionLease;
  const recordingLease = await acquire(recordingLeaseName(sourcePath)).catch((error) => fail(MEDIA_RETENTION_MESSAGES.busy, error));
  // Whether the original is gone; any unexpected failure maps to a fixed message for the person.
  let sourceRemoved = false;
  try {
    const stored = await resolved.store.read(sourcePath);
    if (stored?.tombstone.state === "removed") {
      return { status: "already-removed", sourcePath, mode: stored.tombstone.mode, tombstone: stored.tombstone, bytesFreed: 0,
        purged: stored.tombstone.purged, scope: scopeOf(stored.tombstone) };
    }
    const replanOptions = {
      now, mode: plan.mode === "keep" ? undefined : plan.mode, reason: plan.reason,
      allowLegacyTranscript: plan.verified?.receipt === "legacy-unverified", deps
    };
    const fresh = await planMediaRetention(config, entry, replanOptions);
    if (fresh.digest !== plan.digest) throw new MediaRetentionError(fresh.eligible ? MEDIA_RETENTION_MESSAGES.planChanged : fresh.blockers[0]?.message ?? MEDIA_RETENTION_MESSAGES.planChanged);
    if (fresh.action === "finalize") {
      if (!stored) return fail(MEDIA_RETENTION_MESSAGES.planChanged);
      sourceRemoved = true;
      return await finalize(entry, stored, now, deps, resolved, 0);
    }
    if (fresh.action !== "remove" || plan.mode === "keep" || !fresh.verified || !fresh.media.verified || !fresh.media.fingerprint || !fresh.media.sha256) {
      return fail(MEDIA_RETENTION_MESSAGES.planChanged);
    }
    const mode = plan.mode;
    const fingerprint = fresh.media.fingerprint;
    const root = await assertRecordingRoot(sourcePath);
    await removeLeftovers(root);
    const jobIds = fresh.jobs.map((job) => job.id).sort();
    const removing: MediaRetentionTombstone = {
      version: 1, sourcePath,
      source: { fileName: basename(sourcePath), size: fingerprint.size, sha256: fresh.media.sha256, mtimeMs: fingerprint.mtimeMs },
      jobs: jobIds, mode, reason: plan.reason, state: "removing", startedAt: new Date(now).toISOString(), verified: fresh.verified, purged: []
    };
    let current = await resolved.store.write(removing, stored?.raw ?? null);
    try {
      await deps.checkpoint?.("tombstone-removing");
      if (mode === "audio-only") {
        if (!fresh.audioStreams?.length || !fresh.durationSeconds) fail(MEDIA_RETENTION_MESSAGES.audioFailed);
        const retained = await retainAudio(sourcePath, root, { streams: fresh.audioStreams, durationSeconds: fresh.durationSeconds }, resolved);
        current = await resolved.store.write({ ...removing, audio: retained }, current.raw);
        await deps.checkpoint?.("audio-retained");
      } else if (stored?.tombstone.mode === "audio-only") {
        // An earlier audio-only attempt left a copy; transcript-only keeps no audio.
        const leftover = join(root, RETAINED_AUDIO_FILE);
        const stat = await fs.lstat(leftover).catch((error) => { if (missing(error)) return undefined; throw error; });
        if (stat && (stat.isFile() || stat.isSymbolicLink())) await fs.unlink(leftover);
      }
      const knownHash = { ...fingerprint, sha256: fresh.media.sha256 };
      await withLeases(jobIds, revisionLease, async () => {
        const leaseNames = jobIds.flatMap((id) => jobWorkLeases(resolved.jobStore, id));
        const held: SingletonLease[] = [];
        try {
          for (const name of leaseNames) held.push(await acquire(name).catch((error) => fail(MEDIA_RETENTION_MESSAGES.workStarted, error)));
          const last = await planMediaRetention(config, entry, { ...replanOptions, internal: { heldLeases: new Set(leaseNames), knownHash } });
          if (last.digest !== plan.digest) throw new MediaRetentionError(last.eligible ? MEDIA_RETENTION_MESSAGES.planChanged : last.blockers[0]?.message ?? MEDIA_RETENTION_MESSAGES.planChanged);
          const stat = await fs.lstat(sourcePath).catch((error) => fail(MEDIA_RETENTION_MESSAGES.mediaChanged, error));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== fingerprint.dev || stat.ino !== fingerprint.ino || stat.size !== fingerprint.size ||
            stat.mtimeMs !== fingerprint.mtimeMs || stat.ctimeMs !== fingerprint.ctimeMs) fail(MEDIA_RETENTION_MESSAGES.mediaChanged);
          await fs.unlink(sourcePath).catch((error) => fail(MEDIA_RETENTION_MESSAGES.removeFailed, error));
          sourceRemoved = true;
        } finally {
          for (const lease of held.reverse()) await lease.release().catch(() => undefined);
        }
      }).catch((error) => { throw asRetentionError(error, MEDIA_RETENTION_MESSAGES.workStarted); });
      await deps.checkpoint?.("source-removed");
    } catch (error) {
      // The "removing" tombstone stays: the next plan resumes (media present) or finalizes (media gone).
      throw asRetentionError(error, sourceRemoved ? MEDIA_RETENTION_MESSAGES.purgeFailed : MEDIA_RETENTION_MESSAGES.removeFailed);
    }
    return await finalize(entry, current, now, deps, resolved, fingerprint.size);
  } catch (error) {
    throw asRetentionError(error, sourceRemoved ? MEDIA_RETENTION_MESSAGES.purgeFailed : MEDIA_RETENTION_MESSAGES.removeFailed);
  } finally {
    await recordingLease.release().catch(() => undefined);
  }
};
