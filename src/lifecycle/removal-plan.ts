import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { JobStore } from "../jobs/store";
import { validateJobId, validateSummary, validateTranscript, type JobRecord } from "../jobs/types";
import { planSummaryChunks } from "../summary/chunks";
import { summaryEvidenceMatches, summaryTranscriptEvidenceSha256 } from "../summary/evidence";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "../summary/schema";
import type { ReviewedSummaryPlan } from "../summary/reviewed";

/** Planning is deliberately separate from Trash and permanent removal. No writer is exported. */
export const REMOVAL_LIMITS = Object.freeze({ entries: 4096, depth: 3, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
export type RemovalRoots = { recordings: string; jobState: string; jobWork: string; revisions: string; derivedSummaries: string; exports: string };
export type RemovalRequest = { job: JobRecord; roots: RemovalRoots; reason: "manual" | "retention"; retentionDays?: number; now?: number };
type RootKind = keyof RemovalRoots;
export type RemovalObservation = { root: RootKind; path: string; kind: "missing" | "file" | "directory" | "symlink" | "other" | "unsafe-ancestor"; size?: number; mode?: number; uid?: number; device?: number; inode?: number; modifiedAt?: number; sha256?: string; problem?: string };
export type RemovalEntry = { root: RootKind; path: string; kind: "revision" | "derived-summary" | "managed-export" | "job-state" | "work" | "original" | "unknown"; reason: string; sha256?: string };
export type RemovalPlan = {
  version: 1; mode: "dry-run"; executable: false; reason: RemovalRequest["reason"];
  job: { id: string; mediaSha256: string; state: JobRecord["state"]; updatedAt: string; recordSha256: string; transcriptArtifactSha256?: string };
  roots: RemovalRoots; retention: { days?: number; now?: number; eligible: boolean; reason: string };
  candidates: RemovalEntry[]; preserved: RemovalEntry[]; inventory: RemovalObservation[];
  hasSnapshotReferences: boolean; localWorkProtection: { canPruneLegacyWork: boolean; reason: string }; snapshotSha256: string;
  scope: { originals: "preserved"; newSidecars: "planned-only-preserved"; localExecution: "none"; remoteCopies: "preserved-not-contacted"; externalExports: "not-controlled"; archiveCatalog: "preserved"; auxiliaryState: "preserved"; aiContext: "not-invalidated-by-plan"; limitations: string[] };
};

const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
const canonical = (value: unknown): string => JSON.stringify(ordered(value));
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const inside = (root: string, path: string): boolean => { const child = relative(root, path); return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const strictPath = (path: string): void => { if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) throw Error("Removal roots must be explicit absolute normalized paths; no home expansion is performed"); };
const privateOwned = (stat: Pick<RemovalObservation, "mode" | "uid">): boolean => stat.mode !== undefined && (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
const recordIdentity = (job: JobRecord): string => digest(canonical(job));
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const jsonDigest = (value: unknown): string => digest(JSON.stringify(value));

/** Same pure fingerprints as the summary reader; no adapter or provider is called. */
const verifiedSummaryPlan = (value: unknown): ReviewedSummaryPlan | undefined => {
  try {
    if (!object(value) || value.version !== 1 || !object(value.snapshot) || !object(value.snapshot.revision) || value.snapshot.revision.version !== 1 || !Number.isSafeInteger(value.snapshot.revision.revision) || Number(value.snapshot.revision.revision) < 0 || !object(value.snapshot.revision.base) || value.snapshot.revision.base.jobId !== value.jobId || !object(value.snapshot.human) || typeof value.snapshot.human.reviewed !== "boolean" || !object(value.snapshot.original)) return undefined;
    const plan = value as unknown as ReviewedSummaryPlan;
    const transcript = validateTranscript(plan.snapshot.transcript), provider = plan.provider;
    if (!object(provider) || !exact(provider, ["provider", "model", "adapterIdentity", "endpoint"]) || !["openai", "ollama"].includes(provider.provider) || [provider.model, provider.adapterIdentity].some(item => typeof item !== "string" || !item.trim() || item.length > 300 || /[\x00-\x1f\x7f]/.test(item))) return undefined;
    if (provider.endpoint !== undefined) { if (typeof provider.endpoint !== "string" || provider.endpoint.length > 1000) return undefined; const url = new URL(provider.endpoint); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined; }
    if (jsonDigest(plan.snapshot) !== plan.snapshotSha256 || plan.snapshot.transcriptSha256 !== summaryTranscriptEvidenceSha256(transcript) || !Number.isSafeInteger(plan.maxCharacters) || plan.maxCharacters < 4096 || plan.maxCharacters > 200000 || !Number.isSafeInteger(plan.maxRequests) || plan.maxRequests < 1 || plan.maxRequests > 8 || plan.requiresConsent !== true || plan.inputScope !== "reviewed-transcript-only") return undefined;
    const { consentKey, ...fields } = plan;
    if (consentKey !== jsonDigest(fields) || plan.inputIdentity !== jsonDigest({ snapshotSha256: plan.snapshotSha256, provider, context: plan.context, maxCharacters: plan.maxCharacters, maxRequests: plan.maxRequests, prompt: SUMMARY_SYSTEM_PROMPT, schema: SUMMARY_JSON_SCHEMA }) || planSummaryChunks(transcript, plan.snapshot.revision.base.mediaSha256, plan.context, plan.maxCharacters).length !== plan.chunkCount || plan.chunkCount > plan.maxRequests) return undefined;
    return plan;
  } catch { return undefined; }
};

const verifiedSummaryResult = (value: unknown, plan: ReviewedSummaryPlan): boolean => {
  try {
    if (!object(value) || value.version !== 1 || value.jobId !== plan.jobId || value.requestId !== plan.requestId || jsonDigest(value.revision) !== jsonDigest(plan.snapshot.revision) || value.snapshotSha256 !== plan.snapshotSha256 || value.transcriptSha256 !== plan.snapshot.transcriptSha256 || !object(value.summary) || jsonDigest(value.summary) !== value.summarySha256 || value.summary.provider !== plan.provider.provider || value.summary.model !== plan.provider.model || !object(value.provenance) || value.provenance.authorship !== "model" || jsonDigest(value.provenance.provider) !== jsonDigest(plan.provider) || value.provenance.humanReviewedInput !== plan.snapshot.human.reviewed || value.provenance.inputScope !== "reviewed-transcript-only" || value.provenance.humanNotesUsed !== false || value.provenance.acousticLabelsUsed !== false || value.provenance.originalTranscriptReceipt !== plan.snapshot.original.receipt || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) return false;
    const summary = validateSummary(value.summary, plan.provider.provider, plan.provider.model);
    return !!summary.support && summaryEvidenceMatches(summary, plan.snapshot.revision.base.mediaSha256, plan.snapshot.transcript);
  } catch { return false; }
};

export const getRemovalRoots = (recordingsRoot: string, store = new JobStore()): RemovalRoots => {
  strictPath(recordingsRoot);
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const roots = { recordings: recordingsRoot, jobState: store.stateDir, jobWork: store.dataDir,
    revisions: join(data, "recording-cli", "revisions"), derivedSummaries: join(data, "recording-cli", "reviewed-summaries"), exports: join(data, "recording-cli", "exports") };
  for (const path of Object.values(roots)) strictPath(path);
  return roots;
};

export class RemovalPlanConflictError extends Error {
  readonly code = "REMOVAL_PLAN_STALE";
  constructor(message = "Removal plan changed; build and review a fresh dry-run plan") { super(message); this.name = "RemovalPlanConflictError"; }
}

const observation = (root: RootKind, path: string, stat: Stats): RemovalObservation => ({ root, path,
  kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  size: stat.size, mode: stat.mode, uid: stat.uid, device: stat.dev, inode: stat.ino, modifiedAt: stat.mtimeMs });

/** Inspect every parent with lstat; a link is recorded and never traversed. */
const ancestorsSafe = async (path: string): Promise<boolean> => {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  }
  return true;
};

export const buildRemovalPlan = async (request: RemovalRequest): Promise<RemovalPlan> => {
  const { job, roots } = request;
  validateJobId(job.id);
  if (!hash(job.source.sha256)) throw Error("Removal job must have a media SHA-256 identity");
  if (!["manual", "retention"].includes(request.reason)) throw Error("Invalid removal reason");
  for (const path of Object.values(roots)) strictPath(path);
  for (const path of [job.sourcePath, job.artifactDir]) strictPath(path);
  const expectedArtifact = join(dirname(job.sourcePath), `${parse(job.sourcePath).name}.recording`, job.id);
  if (!inside(roots.recordings, job.sourcePath) || job.sourcePath === roots.recordings || job.artifactDir !== expectedArtifact || !inside(roots.recordings, job.artifactDir)) throw Error("Removal job paths do not belong to the explicit recording root/job");
  // Recordings are observed at exact source/artifact paths only. They may contain
  // an explicitly configured state root; managed sidecar roots must remain disjoint.
  const rootPaths = Object.entries(roots).filter(([key]) => key !== "recordings").map(([, path]) => path);
  if (new Set(rootPaths).size !== rootPaths.length || rootPaths.some((left, index) => rootPaths.some((right, other) => index !== other && inside(left, right)))) throw Error("Removal roots must be disjoint; overlapping roots are preserved by refusing the plan");
  const days = request.retentionDays;
  const now = request.now;
  if (request.reason === "retention" && (!Number.isSafeInteger(days) || Number(days) < 0 || !Number.isFinite(now))) throw Error("Retention planning requires nonnegative whole days and an explicit finite time");
  const active = !["completed", "failed"].includes(job.state);
  const expired = job.state === "completed" && Number.isFinite(Date.parse(job.updatedAt)) && Number(days) > 0 && Date.parse(job.updatedAt) <= Number(now) - Number(days) * 86400000;
  const eligible = !active && (request.reason === "manual" || expired);
  const retention = { ...(days !== undefined ? { days } : {}), ...(now !== undefined ? { now } : {}), eligible,
    reason: active ? "active job preserved" : request.reason === "manual" ? "manual dry-run" : days === 0 ? "zero disables retention" : expired ? "completed job exceeds retention age" : "job is not eligible for retention" };
  const inventory: RemovalObservation[] = [], preserved: RemovalEntry[] = [], candidates: RemovalEntry[] = [];
  const rawFiles = new Map<string, string>();
  let bytes = 0;
  const inspect = async (root: RootKind, path: string, read: boolean): Promise<RemovalObservation> => {
    const cached = inventory.find(item => item.root === root && item.path === path);
    if (cached) return cached;
    if (inventory.length >= REMOVAL_LIMITS.entries) throw Error("Removal plan exceeds bounded entry limit; no action performed");
    if (!inside(roots[root], path)) throw Error("Removal path escaped its declared root");
    if (!await ancestorsSafe(dirname(path))) { const item: RemovalObservation = { root, path, kind: "unsafe-ancestor" }; inventory.push(item); return item; }
    let stat: Stats;
    try { stat = await fs.lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const item: RemovalObservation = { root, path, kind: "missing" }; inventory.push(item); return item; }
    const item = observation(root, path, stat); inventory.push(item);
    if (read && item.kind === "file") {
      if (stat.size > REMOVAL_LIMITS.fileBytes || bytes + stat.size > REMOVAL_LIMITS.totalBytes) { item.problem = "oversized content preserved"; return item; }
      const handle = await fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (await fs.realpath(path) !== path || !await ancestorsSafe(dirname(path))) throw new RemovalPlanConflictError("File ancestry changed while planning; no action performed");
        const named = await fs.lstat(path);
        if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size || named.mtimeMs !== opened.mtimeMs) throw new RemovalPlanConflictError("File name changed while planning; no action performed");
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw new RemovalPlanConflictError("File changed while planning; no action performed");
        const buffer = Buffer.alloc(opened.size + 1); let length = 0;
        while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
        const after = await handle.stat();
        const namedAfter = await fs.lstat(path);
        if (!namedAfter.isFile() || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino || namedAfter.size !== after.size || namedAfter.mtimeMs !== after.mtimeMs) throw new RemovalPlanConflictError("File name changed while planning; no action performed");
        if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || await fs.realpath(path) !== path || !await ancestorsSafe(dirname(path))) throw new RemovalPlanConflictError("File changed while planning; no action performed");
        const content = buffer.subarray(0, length); item.sha256 = digest(content); bytes += length; rawFiles.set(path, content.toString("utf8"));
      } finally { await handle.close(); }
    }
    return item;
  };
  const retain = (item: RemovalObservation, kind: RemovalEntry["kind"], reason: string): void => { if (item.kind !== "missing" && !preserved.some(entry => entry.root === item.root && entry.path === item.path)) preserved.push({ root: item.root, path: item.path, kind, reason, ...(item.sha256 ? { sha256: item.sha256 } : {}) }); };
  const rootsObserved = new Map<RootKind, RemovalObservation>();
  for (const key of Object.keys(roots) as RootKind[]) rootsObserved.set(key, await inspect(key, roots[key], false));
  const source = await inspect("recordings", job.sourcePath, true); retain(source, "original", "original media is never removed by this planner");
  const artifact = await inspect("recordings", job.artifactDir, false); retain(artifact, "original", "published originals and unknown artifact files remain under the existing Trash contract");
  const publishedTranscript = await inspect("recordings", join(job.artifactDir, "transcript.json"), true); retain(publishedTranscript, "original", "published original transcript preserved");
  const work = await inspect("jobWork", join(roots.jobWork, job.id), false); retain(work, "work", "work/original copies preserved by this sidecar plan");
  const workTranscript = await inspect("jobWork", join(work.path, "transcript.json"), true); retain(workTranscript, "work", "work canonical transcript preserved");
  const workReceipt = await inspect("jobWork", join(work.path, "transcript-receipt.json"), true); retain(workReceipt, "work", "work transcript receipt preserved");
  const publishedReceipt = await inspect("recordings", join(job.artifactDir, "transcript-receipt.json"), true); retain(publishedReceipt, "original", "published transcript receipt preserved");
  const transcriptUsable = (item: RemovalObservation, receipt: RemovalObservation, legacyAllowed: boolean): boolean => {
    if (!item.sha256) return false;
    try {
      const value = validateTranscript(JSON.parse(rawFiles.get(item.path) || ""));
      if (!value.text.trim() && !value.segments.some(segment => segment.text.trim())) return false;
      if (receipt.kind === "missing") return legacyAllowed;
      const commit = JSON.parse(rawFiles.get(receipt.path) || "");
      return value.provider === job.transcription.provider && value.model === job.transcription.model && value.language === job.transcription.language && commit.version === 1 && commit.identity === digest(JSON.stringify({ media: job.source.sha256, transcription: job.transcription })) && commit.transcriptSha256 === item.sha256;
    } catch { return false; }
  };
  const selectWork = job.target === "local" && (job.state !== "completed" ? workTranscript.kind !== "missing" : publishedTranscript.kind === "missing");
  const transcript = selectWork ? workTranscript : publishedTranscript;
  const transcriptSha = transcriptUsable(transcript, selectWork ? workReceipt : publishedReceipt, !selectWork && job.state === "completed") ? transcript.sha256 : undefined;
  const mediaVerified = source.kind === "file" && source.sha256 === job.source.sha256 && source.size === job.source.size;
  const expectedBase = (value: unknown): boolean => object(value) && value.jobId === job.id && value.mediaSha256 === job.source.sha256 && hash(value.transcriptArtifactSha256) && (!transcriptSha || value.transcriptArtifactSha256 === transcriptSha);
  const owned = (item: RemovalObservation): boolean => item.kind === "file" && !!item.sha256 && privateOwned(item) && privateOwned(rootsObserved.get(item.root)!) && inventory.filter(parent => parent.root === item.root && parent.kind === "directory" && inside(parent.path, item.path)).every(privateOwned);
  const propose = (item: RemovalObservation, kind: RemovalEntry["kind"], identityValid: boolean, reason = "identity or private ownership is unverified"): void => {
    if (!owned(item) || !identityValid || !transcriptSha || !mediaVerified) { retain(item, kind, !mediaVerified ? "original media identity is unavailable or mismatched; preserved" : reason); return; }
    if (!eligible) { retain(item, kind, retention.reason); return; }
    candidates.push({ root: item.root, path: item.path, kind, reason: "verified job/media/transcript identity; planned only, file preserved", sha256: item.sha256 });
  };
  const parsed = (path: string): unknown => { try { return JSON.parse(rawFiles.get(path) || ""); } catch { return undefined; } };
  const list = async (path: string): Promise<string[]> => {
    if (!await ancestorsSafe(path) || await fs.realpath(path) !== path) throw new RemovalPlanConflictError("Directory ancestry changed while planning");
    const names: string[] = [];
    const directory = await fs.opendir(path);
    for await (const child of directory) {
      if (names.length + inventory.length >= REMOVAL_LIMITS.entries) throw Error("Removal plan exceeds bounded directory listing; no action performed");
      names.push(child.name);
    }
    return names.sort();
  };
  const scan = async (root: RootKind, path: string, depth: number): Promise<void> => {
    const current = inventory.find(item => item.path === path && item.root === root) || await inspect(root, path, false);
    if (current.kind !== "directory" || !await ancestorsSafe(path)) { retain(current, "unknown", "unsafe root/link preserved without following"); return; }
    const names = await list(path);
    for (const name of names) {
      const childPath = join(path, name), item = await inspect(root, childPath, true);
      if (item.kind === "directory") {
        // Export/summary bundles have a finite, direct layout; other nested data is preserved.
        if (root === "revisions") retain(item, "unknown", "unknown revision directory preserved without expanding its contents");
        else if (root === "derivedSummaries" && depth === 0 && name !== job.id) retain(item, "unknown", "other-job summary directory preserved without expanding its contents");
        else if (depth < REMOVAL_LIMITS.depth) await scan(root, childPath, depth + 1);
        else retain(item, "unknown", "nested data beyond bounded layout preserved");
      } else if (root === "revisions" && childPath === join(roots.revisions, `${job.id}.json`)) {
        const value = parsed(childPath);
        const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
        const segments = new Set<string>();
        try { const original = validateTranscript(JSON.parse(rawFiles.get(transcript.path) || "")); let cursor = 0; for (const [index, segment] of original.segments.entries()) { const found = segment.text ? original.text.indexOf(segment.text, cursor) : -1; if (found >= 0) { segments.add(`s${String(index).padStart(6, "0")}`); cursor = found + segment.text.length; } } } catch { /* unverifiable canonical segments preserve the journal */ }
        const validEntry = (entry: unknown, index: number): boolean => {
          if (!object(entry) || !exact(entry, ["revision", "action", "createdAt", "base", "operations", "overlay", "restoresRevision"]) || entry.revision !== index + 1 || !["edit", "undo"].includes(String(entry.action)) || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) || !expectedBase(entry.base) || !object(entry.base) || entry.base.diarizationSha256 !== undefined || !exact(entry.base, ["jobId", "mediaSha256", "transcriptArtifactSha256"]) || !Array.isArray(entry.operations) || entry.operations.length > 64 || !object(entry.overlay)) return false;
          if (entry.action === "undo" ? !Number.isSafeInteger(entry.restoresRevision) || Number(entry.restoresRevision) < 0 || Number(entry.restoresRevision) >= index + 1 : entry.restoresRevision !== undefined) return false;
          const overlay = entry.overlay;
          if (!exact(overlay, ["segmentTexts", "segmentSpeakers", "speakerLabels", "turnSpeakers", "notes"]) || !object(overlay.segmentTexts) || !object(overlay.segmentSpeakers) || !object(overlay.speakerLabels) || !object(overlay.turnSpeakers) || [overlay.segmentSpeakers, overlay.speakerLabels, overlay.turnSpeakers].some(map => Object.keys(map).length > 0) || !Array.isArray(overlay.notes) || overlay.notes.length > 20 || overlay.notes.some(note => !safeText(note, 2000) || !note.trim()) || Object.entries(overlay.segmentTexts).some(([id, text]) => !segments.has(id) || !safeText(text, 10000))) return false;
          return entry.operations.every(operation => object(operation) && (operation.kind === "segment-text" ? exact(operation, ["kind", "segmentId", "text"]) && typeof operation.segmentId === "string" && segments.has(operation.segmentId) && safeText(operation.text, 10000) : operation.kind === "note" && exact(operation, ["kind", "text"]) && safeText(operation.text, 2000) && !!operation.text.trim()));
        };
        const valid = Number(item.size) <= 4 * 1024 * 1024 && object(value) && exact(value, ["version", "base", "history"]) && value.version === 1 && expectedBase(value.base) && object(value.base) && exact(value.base, ["jobId", "mediaSha256", "transcriptArtifactSha256"]) && Array.isArray(value.history) && value.history.length > 0 && value.history.length <= 100 && value.history.every(validEntry);
        propose(item, "revision", valid, "journal schema or acoustic identity cannot be verified within these roots; preserved");
      } else retain(item, "unknown", item.kind === "symlink" ? "symbolic link preserved without following" : "unknown or other-job data preserved");
    }
  };
  await scan("revisions", roots.revisions, 0);
  await scan("derivedSummaries", roots.derivedSummaries, 0);
  // A summary request is owned through the index -> immutable plan -> result hash chain.
  // Checkpoints lack a job/base identity and remain explicitly preserved.
  const summaryDir = join(roots.derivedSummaries, job.id), summaryIndexPath = join(summaryDir, "index.json"), summaryIndex = parsed(summaryIndexPath);
  const indexObservation = inventory.find(item => item.path === summaryIndexPath && item.root === "derivedSummaries");
  const states = indexObservation && owned(indexObservation) && Number(indexObservation.size) <= 64 * 1024 && object(summaryIndex) && summaryIndex.version === 1 && summaryIndex.jobId === job.id && Number.isSafeInteger(summaryIndex.sequence) && Number(summaryIndex.sequence) >= 0 && Array.isArray(summaryIndex.requests) && summaryIndex.requests.length <= 32 ? summaryIndex.requests : undefined;
  const recognizedSummary = new Set<string>();
  const sourceIdentity = digest(JSON.stringify({ id: job.id, source: job.source, sourcePath: job.sourcePath, artifactDir: job.artifactDir, target: job.target, transcription: job.transcription, summary: job.summary }));
  let summaryRunning = false;
  let allSummaryStatesValid = !!states;
  const requestIds = new Set<string>();
  const sequences = new Set<number>();
  for (const state of states || []) {
    if (!object(state) || typeof state.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(state.requestId) || requestIds.has(state.requestId) || !hash(state.planSha256) || !["planned", "running", "cancelled", "completed"].includes(String(state.status)) || !Number.isSafeInteger(state.requestsSpent) || Number(state.requestsSpent) < 0 || Number(state.requestsSpent) > 8) { allSummaryStatesValid = false; continue; }
    requestIds.add(state.requestId); summaryRunning ||= state.status === "running";
    if (state.status === "completed") {
      if (!hash(state.resultSha256) || !Number.isSafeInteger(state.sequence) || Number(state.sequence) < 1 || Number(state.sequence) > Number((summaryIndex as Record<string, unknown>).sequence) || sequences.has(Number(state.sequence))) { allSummaryStatesValid = false; continue; }
      sequences.add(Number(state.sequence));
    } else if (state.resultSha256 !== undefined || state.sequence !== undefined) { allSummaryStatesValid = false; continue; }
    const planPath = join(summaryDir, "plans", `${state.requestId}.json`), envelope = parsed(planPath);
    const plan = object(envelope) ? verifiedSummaryPlan(envelope.plan) : undefined;
    const planObservation = inventory.find(item => item.root === "derivedSummaries" && item.path === planPath);
    const validPlan = planObservation && owned(planObservation) && Number(planObservation.size) <= 4 * 1024 * 1024 && object(envelope) && envelope.kind === "falatrace-reviewed-summary-plan" && plan && plan.jobId === job.id && plan.requestId === state.requestId && envelope.sha256 === state.planSha256 && jsonDigest(plan) === state.planSha256 && expectedBase(plan.snapshot.revision.base) && plan.snapshot.sourceIdentity === sourceIdentity;
    if (!validPlan || !plan) { allSummaryStatesValid = false; continue; }
    recognizedSummary.add(planPath);
    if (state.status === "completed") {
      const resultPath = join(summaryDir, "results", `${state.requestId}.json`), result = parsed(resultPath);
      const resultObservation = inventory.find(item => item.root === "derivedSummaries" && item.path === resultPath);
      const validResult = resultObservation && owned(resultObservation) && Number(resultObservation.size) <= 2 * 1024 * 1024 && jsonDigest(result) === state.resultSha256 && verifiedSummaryResult(result, plan);
      if (validResult) recognizedSummary.add(resultPath); else allSummaryStatesValid = false;
    }
  }
  if (!allSummaryStatesValid) recognizedSummary.clear();
  if (allSummaryStatesValid && states?.length) recognizedSummary.add(summaryIndexPath);
  for (const path of recognizedSummary) {
    const item = inventory.find(item => item.root === "derivedSummaries" && item.path === path);
    if (!item) continue;
    const retained = preserved.findIndex(entry => entry.root === "derivedSummaries" && entry.path === path); if (retained >= 0) preserved.splice(retained, 1);
    propose(item, "derived-summary", !summaryRunning, summaryRunning ? "reviewed summary request is running; preserved" : "unverified summary identity preserved");
  }
  // Export ownership is a three-file committed bundle with hashes and a content-addressed directory.
  const exportRoot = rootsObserved.get("exports")!;
  let opaqueExportReference = false;
  if (exportRoot.kind === "directory" && await ancestorsSafe(roots.exports)) {
    const names = await list(roots.exports);
    for (const name of names) {
      const directory = join(roots.exports, name), dir = await inspect("exports", directory, false);
      if (dir.kind !== "directory" || !/^[a-f0-9]{64}$/.test(name) || !privateOwned(dir) || !await ancestorsSafe(directory)) { opaqueExportReference = true; retain(dir, "unknown", "uncommitted, unknown or unsafe export preserved"); continue; }
      const children = await list(directory);
      const items: RemovalObservation[] = [];
      for (const child of children) items.push(await inspect("exports", join(directory, child), true));
      const manifest = parsed(join(directory, "manifest.json")), snapshot = parsed(join(directory, "snapshot.json"));
      if (!object(manifest) || !object(snapshot) || typeof manifest.jobId !== "string" || typeof snapshot.jobId !== "string" || items.some(item => !owned(item))) opaqueExportReference = true;
      const contentName = object(manifest) ? manifest.contentFile : undefined;
      const content = items.find(item => typeof contentName === "string" && item.path === join(directory, contentName));
      const snapshotFile = items.find(item => item.path === join(directory, "snapshot.json"));
      const valid = object(manifest) && manifest.version === 1 && manifest.jobId === job.id && object(manifest.revision) && expectedBase(manifest.revision.base) && object(snapshot) && snapshot.version === 1 && snapshot.jobId === job.id && object(snapshot.revision) && expectedBase(snapshot.revision.base) && canonical(manifest.revision) === canonical(snapshot.revision) && hash(manifest.sha256) && manifest.sha256 === content?.sha256 && manifest.bytes === content?.size && manifest.snapshotSha256 === snapshotFile?.sha256 && manifest.snapshotFile === "snapshot.json" && ["json", "markdown", "srt", "vtt"].includes(String(manifest.format)) && contentName === `export.${manifest.format === "markdown" ? "md" : manifest.format}` && children.length === 3 && items.every(owned) && name === digest(`${JSON.stringify(ordered({ version: 1, format: manifest.format, snapshotSha256: manifest.snapshotSha256, sha256: manifest.sha256 }), null, 2)}\n`);
      for (const item of items) propose(item, "managed-export", valid, "unknown, cross-job, uncommitted or hash-mismatched export bundle preserved");
    }
  } else retain(exportRoot, "unknown", "unsafe export root preserved without following");
  const state = await inspect("jobState", join(roots.jobState, `${job.id}.json`), true); retain(state, "job-state", "job metadata remains under the existing local removal contract");
  const currentRecord = parsed(state.path);
  if (state.kind !== "file" || !object(currentRecord) || digest(canonical(currentRecord)) !== recordIdentity(job)) throw new RemovalPlanConflictError("Current job lookup is missing or differs from the removal request; files preserved");
  if (work.kind === "directory" && await ancestorsSafe(work.path)) {
    for (const name of await list(work.path)) { const item = await inspect("jobWork", join(work.path, name), true); retain(item, "work", "work data and unknown contents explicitly preserved"); }
  }
  if (summaryRunning) {
    for (const entry of candidates.splice(0)) preserved.push({ ...entry, reason: "reviewed summary generation is active; all sidecar candidates preserved" });
    retention.eligible = false; retention.reason = "reviewed summary generation is active";
  }
  // This is intentionally conservative: an unsafe root or in-flight export can
  // conceal a reference, so auto-retention must keep the possibly sole base.
  const unsafeSnapshotRoot = (["revisions", "derivedSummaries", "exports"] as const).some(key => { const item = rootsObserved.get(key)!; return item.kind !== "missing" && (item.kind !== "directory" || !privateOwned(item)); });
  const hasSnapshotReferences = unsafeSnapshotRoot || opaqueExportReference || inventory.some(item => item.kind !== "missing" && ((item.root === "revisions" && item.path === join(roots.revisions, `${job.id}.json`)) || (item.root === "derivedSummaries" && inside(join(roots.derivedSummaries, job.id), item.path)) || (item.root === "exports" && (item.path.startsWith(join(roots.exports, ".export-")) || object(parsed(item.path)) && (parsed(item.path) as Record<string, unknown>).jobId === job.id))));
  const workRoot = rootsObserved.get("jobWork")!;
  const safeWork = workRoot.kind === "directory" && privateOwned(workRoot) && work.kind === "directory" && privateOwned(work) && await ancestorsSafe(work.path);
  const localWorkProtection = { canPruneLegacyWork: safeWork && mediaVerified && !hasSnapshotReferences,
    reason: !safeWork ? "work root/directory is absent or unsafe; preserve work" : !mediaVerified ? "original media identity is unavailable or mismatched; preserve work" : hasSnapshotReferences ? "saved or concealed snapshot reference; preserve its possibly sole canonical base" : "no snapshot reference observed; existing work policy applies" };
  const plan: RemovalPlan = { version: 1, mode: "dry-run", executable: false, reason: request.reason,
    job: { id: job.id, mediaSha256: job.source.sha256, state: job.state, updatedAt: job.updatedAt, recordSha256: recordIdentity(job), ...(transcriptSha ? { transcriptArtifactSha256: transcriptSha } : {}) },
    roots: { ...roots }, retention, candidates, preserved, inventory, hasSnapshotReferences, localWorkProtection,
    scope: { originals: "preserved", newSidecars: "planned-only-preserved", localExecution: "none", remoteCopies: "preserved-not-contacted", externalExports: "not-controlled", archiveCatalog: "preserved", auxiliaryState: "preserved", aiContext: "not-invalidated-by-plan", limitations: ["No Trash writer or permanent purge for revisions, summaries or exports is implemented.", "Caches, grants, contexts, notes, time entries and archive catalog are preserved; no remote is contacted.", "Journals with acoustic identities outside these roots remain preserved instead of claiming verified ownership.", "Unknown, cross-job, unsafe and unverifiable data are preserved. A fresh job lookup and matching snapshot are required for any future writer."] }, snapshotSha256: "" };
  plan.snapshotSha256 = digest(canonical({ ...plan, snapshotSha256: undefined }));
  return plan;
};

/** Re-observe exact declared roots. New paths cause rejection, never silent expansion. */
export const validateRemovalPlan = async (plan: RemovalPlan, request: RemovalRequest): Promise<void> => {
  if (plan.version !== 1 || plan.mode !== "dry-run" || plan.executable !== false || !hash(plan.snapshotSha256) || digest(canonical({ ...plan, snapshotSha256: undefined })) !== plan.snapshotSha256) throw new RemovalPlanConflictError("Removal plan was modified; no action is authorized");
  const latest = await buildRemovalPlan(request);
  if (latest.snapshotSha256 !== plan.snapshotSha256) throw new RemovalPlanConflictError();
};
