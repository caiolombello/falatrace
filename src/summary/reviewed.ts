import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig, SummaryProvider } from "../config/defaults";
import { validateConfig } from "../config/load";
import { JobStore, hashFile } from "../jobs/store";
import { readBoundedArtifact } from "../jobs/transcript-access";
import { validateJobId, validateSummary, type JobRecord, type RecordingSummary, type SummaryContext, type Transcript } from "../jobs/types";
import { aiContextRoot, invalidateAiContextOwned, withContextPublicationLease } from "../knowledge/invalidation";
import { readReviewedView, RevisionConflictError, withRevisionLease, type ReviewedView, type RevisionHead } from "../revisions";
import { acquireSingleton } from "../runtime/singleton";
import { cliAdmissionWait, withHeavyAdmission } from "../runtime/heavy-admission";
import { planSummaryChunks, type SummaryAdapter, type SummaryChunk } from "./chunks";
import { attachSummarySupport, buildSummaryEvidence, summaryEvidenceMatches, summaryTranscriptEvidenceSha256 } from "./evidence";
import { summarizeWithOllama } from "./ollama";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "./schema";

export const REVIEWED_SUMMARY_LIMITS = Object.freeze({ requests: 32, providerRequests: 8, planBytes: 4 * 1024 * 1024, artifactBytes: 2 * 1024 * 1024, indexBytes: 64 * 1024 });
export type ReviewedSummaryProvider = { provider: SummaryProvider; model: string; adapterIdentity: string; endpoint?: string };
export type ReviewedSummaryAdapter = { identity: ReviewedSummaryProvider; summarize: SummaryAdapter };
export type ReviewedSummarySnapshot = {
  revision: RevisionHead; sourceIdentity: string; transcript: Transcript; transcriptSha256: string;
  original: { path: string; origin: "published" | "work"; receipt: "verified" | "legacy-unverified"; receiptSha256?: string };
  human: { reviewed: boolean; notes: string[]; segments: Array<{ id: string; humanEdited: boolean; humanSpeakerEdited: boolean }>; labels?: Record<string, string>; turns?: Array<{ id: string; speaker?: string; label?: string; humanSpeakerEdited: boolean }> };
};
export type ReviewedSummaryPlan = {
  version: 1; jobId: string; requestId: string; createdAt: string; snapshot: ReviewedSummarySnapshot; snapshotSha256: string;
  provider: ReviewedSummaryProvider; context?: SummaryContext; maxCharacters: number; maxRequests: number; chunkCount: number;
  inputIdentity: string; consentKey: string; requiresConsent: true; inputScope: "reviewed-transcript-only";
};
export type ReviewedSummaryProvenance = {
  authorship: "model"; humanReviewedInput: boolean; provider: ReviewedSummaryProvider; inputScope: "reviewed-transcript-only";
  humanNotesUsed: false; acousticLabelsUsed: false; originalTranscriptReceipt: "verified" | "legacy-unverified";
};
type StoredResult = {
  version: 1; jobId: string; requestId: string; generatedAt: string; revision: RevisionHead; snapshotSha256: string;
  transcriptSha256: string; summarySha256: string; summary: RecordingSummary; provenance: ReviewedSummaryProvenance;
};
export type ReviewedSummaryArtifact = StoredResult & { path: string; raw: string };
type RequestState = { requestId: string; planSha256: string; status: "planned" | "running" | "cancelled" | "completed"; requestsSpent: number; resultSha256?: string; sequence?: number };
type Index = { version: 1; jobId: string; sequence: number; requests: RequestState[] };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const requestId = (id: string): string => { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error("Invalid reviewed summary request id"); return id; };
export const getReviewedSummaryRoot = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli/reviewed-summaries");
export const getReviewedSummaryJobDir = (jobId: string): string => join(getReviewedSummaryRoot(), validateJobId(jobId));
const planPath = (jobId: string, id: string): string => join(getReviewedSummaryJobDir(jobId), "plans", `${requestId(id)}.json`);
const resultPath = (jobId: string, id: string): string => join(getReviewedSummaryJobDir(jobId), "results", `${requestId(id)}.json`);
const sourceIdentity = (job: JobRecord): string => hash({ id: job.id, source: job.source, sourcePath: job.sourcePath, artifactDir: job.artifactDir, target: job.target, transcription: job.transcription, summary: job.summary });

/** Every managed directory and file is private, owned and no-follow; never repairs unsafe state. */
const directory = async (path: string, create = false): Promise<boolean> => {
  let parent = resolve(path);
  while (parent !== dirname(parent)) {
    const stat = await fs.lstat(parent).catch(error => { if (missing(error)) return undefined; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error("Unsafe reviewed summary directory");
    parent = dirname(parent);
  }
  if (create) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!stat) return false;
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || await fs.realpath(path) !== resolve(path)) throw Error("Reviewed summary directory must be private");
  return true;
};
const readPrivate = async (path: string, maximum: number): Promise<string> => {
  await directory(dirname(path));
  const stat = await fs.lstat(path);
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw Error("Reviewed summary artifact must be private");
  return readBoundedArtifact(path, maximum);
};
const publishImmutable = async (path: string, value: unknown, maximum: number): Promise<void> => {
  const raw = JSON.stringify(value); if (Buffer.byteLength(raw) > maximum) throw Error("Reviewed summary artifact exceeds byte budget");
  await directory(dirname(path), true);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, raw, { flag: "wx", mode: 0o600 });
    await directory(dirname(path));
    try { await fs.link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readPrivate(path, maximum) !== raw) throw Error("Reviewed summary artifact already exists with different content; preserved");
    }
  } finally { await fs.rm(temporary, { force: true }); }
};
const readIndex = async (jobId: string): Promise<{ index: Index; raw?: string }> => {
  const root = getReviewedSummaryJobDir(jobId), path = join(root, "index.json");
  if (!await directory(getReviewedSummaryRoot()) || !await directory(root)) return { index: { version: 1, jobId, sequence: 0, requests: [] } };
  let raw: string; try { raw = await readPrivate(path, REVIEWED_SUMMARY_LIMITS.indexBytes); } catch (error) { if (missing(error)) return { index: { version: 1, jobId, sequence: 0, requests: [] } }; throw error; }
  const value = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || value.jobId !== jobId || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || Number(value.sequence) > REVIEWED_SUMMARY_LIMITS.requests || !Array.isArray(value.requests) || value.requests.length > REVIEWED_SUMMARY_LIMITS.requests) throw Error("Invalid reviewed summary index");
  const ids = new Set<string>(), sequences = new Set<number>();
  for (const item of value.requests) {
    if (!object(item) || typeof item.requestId !== "string" || !digest(item.planSha256) || !["planned", "running", "cancelled", "completed"].includes(String(item.status)) || !Number.isSafeInteger(item.requestsSpent) || Number(item.requestsSpent) < 0 || Number(item.requestsSpent) > REVIEWED_SUMMARY_LIMITS.providerRequests) throw Error("Invalid reviewed summary request state");
    requestId(item.requestId); if (ids.has(item.requestId)) throw Error("Duplicate reviewed summary request"); ids.add(item.requestId);
    if (item.status === "completed") {
      if (!digest(item.resultSha256) || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || Number(item.sequence) > Number(value.sequence) || sequences.has(Number(item.sequence))) throw Error("Invalid reviewed summary publication state");
      sequences.add(Number(item.sequence));
    } else if (item.resultSha256 !== undefined || item.sequence !== undefined) throw Error("Uncommitted reviewed summary publication");
  }
  if (sequences.size !== value.sequence) throw Error("Reviewed summary publication sequence mismatch");
  return { index: value as Index, raw };
};
/** Caller holds the revision lease. This is a CAS of our bounded index, never a summary overwrite. */
const writeIndex = async (jobId: string, index: Index, previous?: string, beforeCommit?: () => Promise<void>): Promise<void> => {
  const root = getReviewedSummaryJobDir(jobId); await directory(root, true);
  const path = join(root, "index.json"), temporary = join(root, `.${randomUUID()}.tmp`), raw = JSON.stringify(index);
  if (Buffer.byteLength(raw) > REVIEWED_SUMMARY_LIMITS.indexBytes) throw Error("Reviewed summary index exceeds byte budget");
  try {
    await fs.writeFile(temporary, raw, { flag: "wx", mode: 0o600 });
    const current = await readPrivate(path, REVIEWED_SUMMARY_LIMITS.indexBytes).catch(error => { if (missing(error)) return undefined; throw error; });
    if (current !== previous) throw Error("Reviewed summary index changed; preserved");
    await beforeCommit?.();
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
};
const snapshotFor = (job: JobRecord, view: ReviewedView): ReviewedSummarySnapshot => ({
  revision: { version: 1, revision: view.revision.revision, base: structuredClone(view.revision.base) }, sourceIdentity: sourceIdentity(job),
  transcript: structuredClone(view.transcript), transcriptSha256: summaryTranscriptEvidenceSha256(view.transcript),
  original: { path: view.original.path, origin: view.original.provenance.origin, receipt: view.original.provenance.receipt, ...(view.original.provenance.receiptSha256 ? { receiptSha256: view.original.provenance.receiptSha256 } : {}) },
  human: { reviewed: view.revision.humanReviewed, notes: [...view.notes], segments: view.segments.map(({ id, humanEdited, humanSpeakerEdited }) => ({ id, humanEdited, humanSpeakerEdited })),
    ...(view.diarization ? { labels: { ...view.diarization.labels }, turns: view.diarization.turns.map(({ id, speaker, label, humanSpeakerEdited }) => ({ id, speaker, label, humanSpeakerEdited })) } : {}) }
});
const currentSnapshot = async (job: JobRecord): Promise<ReviewedSummarySnapshot> => {
  const current = await new JobStore().get(validateJobId(job.id));
  if (sourceIdentity(current) !== sourceIdentity(job)) throw new RevisionConflictError("Summary job/source settings changed");
  const media = await fs.lstat(current.sourcePath);
  if (!media.isFile() || media.isSymbolicLink() || media.size !== current.source.size || await hashFile(current.sourcePath) !== current.source.sha256) throw new RevisionConflictError("Summary media source changed or is unavailable");
  const view = await readReviewedView(current);
  if (sourceIdentity(await new JobStore().get(job.id)) !== sourceIdentity(current)) throw new RevisionConflictError("Summary source changed during reading");
  return snapshotFor(current, view);
};
const assertCurrent = async (job: JobRecord, plan: ReviewedSummaryPlan): Promise<void> => {
  if (hash(await currentSnapshot(job)) !== plan.snapshotSha256) throw new RevisionConflictError("Summary reviewed snapshot changed; no summary published");
};
const loopbackEndpoint = (value: string): string => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("Reviewed summary production adapter requires an explicit loopback Ollama endpoint");
  return url.href;
};
export const reviewedSummaryProviderForConfig = (config: AppConfig): ReviewedSummaryProvider => {
  validateConfig(config);
  if (config.summary.provider !== "ollama") throw Error("Reviewed summary production regeneration supports explicit local Ollama only");
  const endpoint = loopbackEndpoint(config.summary.ollamaUrl), model = config.summary.ollamaModel;
  return { provider: "ollama", model, endpoint, adapterIdentity: `ollama-chat-v1:${hash({ endpoint, model })}` };
};
const validateProvider = (provider: ReviewedSummaryProvider): ReviewedSummaryProvider => {
  if (!object(provider) || Object.keys(provider).some(key => !["provider", "model", "adapterIdentity", "endpoint"].includes(key)) || !["ollama", "openai"].includes(provider.provider) || [provider.model, provider.adapterIdentity].some(value => typeof value !== "string" || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) || (provider.endpoint !== undefined && (typeof provider.endpoint !== "string" || provider.endpoint.length > 1000))) throw Error("Invalid reviewed summary provider identity");
  const copy = structuredClone(provider);
  if (copy.endpoint !== undefined) { const url = new URL(copy.endpoint); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error("Reviewed summary endpoint cannot contain credentials or query/fragment secrets"); copy.endpoint = url.href; }
  return copy;
};
const chunksFor = (plan: ReviewedSummaryPlan): SummaryChunk[] => planSummaryChunks(plan.snapshot.transcript, plan.snapshot.revision.base.mediaSha256, plan.context, plan.maxCharacters);
const inputIdentity = (snapshotSha256: string, provider: ReviewedSummaryProvider, context: SummaryContext | undefined, maxCharacters: number, maxRequests: number): string => hash({ snapshotSha256, provider, context, maxCharacters, maxRequests, prompt: SUMMARY_SYSTEM_PROMPT, schema: SUMMARY_JSON_SCHEMA });
const readPlan = async (jobId: string, id: string, state: RequestState): Promise<ReviewedSummaryPlan> => {
  const envelope = JSON.parse(await readPrivate(planPath(jobId, id), REVIEWED_SUMMARY_LIMITS.planBytes)), plan = envelope.plan as ReviewedSummaryPlan;
  if (envelope.kind !== "falatrace-reviewed-summary-plan" || envelope.sha256 !== state.planSha256 || hash(plan) !== state.planSha256 || !object(plan) || plan.version !== 1 || plan.jobId !== jobId || plan.requestId !== id || !object(plan.snapshot) || hash(plan.snapshot) !== plan.snapshotSha256 || plan.snapshot.revision.base.jobId !== jobId || !Number.isSafeInteger(plan.snapshot.revision.revision) || plan.snapshot.revision.revision < 0 || plan.snapshot.transcriptSha256 !== summaryTranscriptEvidenceSha256(plan.snapshot.transcript) || !Number.isSafeInteger(plan.maxCharacters) || plan.maxCharacters < 4096 || plan.maxCharacters > 200000 || !Number.isSafeInteger(plan.maxRequests) || plan.maxRequests < 1 || plan.maxRequests > REVIEWED_SUMMARY_LIMITS.providerRequests || plan.requiresConsent !== true || plan.inputScope !== "reviewed-transcript-only") throw Error("Invalid reviewed summary plan fingerprint");
  validateProvider(plan.provider);
  const { consentKey, ...fields } = plan;
  if (consentKey !== hash(fields) || plan.inputIdentity !== inputIdentity(plan.snapshotSha256, plan.provider, plan.context, plan.maxCharacters, plan.maxRequests) || chunksFor(plan).length !== plan.chunkCount || plan.chunkCount > plan.maxRequests) throw Error("Reviewed summary consent/budget fingerprint mismatch");
  return plan;
};
export const planReviewedSummary = async (job: JobRecord, input: { requestId: string; config: AppConfig; provider?: ReviewedSummaryProvider; maxRequests?: number; signal?: AbortSignal }): Promise<ReviewedSummaryPlan> => {
  if (!object(input) || Object.keys(input).some(key => !["requestId", "config", "provider", "maxRequests", "signal"].includes(key))) throw Error("Invalid reviewed summary plan fields");
  job = structuredClone(job);
  input = { ...input, config: structuredClone(input.config), ...(input.provider ? { provider: structuredClone(input.provider) } : {}) };
  requestId(input.requestId); validateConfig(input.config); input.signal?.throwIfAborted();
  const provider = validateProvider(input.provider || reviewedSummaryProviderForConfig(input.config)), maxCharacters = input.config.summary.maxInputCharacters, maxRequests = input.maxRequests ?? 1;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > REVIEWED_SUMMARY_LIMITS.providerRequests) throw Error("Reviewed summary request budget must be explicit and bounded by eight");
  return withRevisionLease(job.id, async () => {
    const snapshot = await currentSnapshot(job), snapshotSha256 = hash(snapshot), context = job.summary.context ? structuredClone(job.summary.context) : undefined;
    const identity = inputIdentity(snapshotSha256, provider, context, maxCharacters, maxRequests), { index, raw } = await readIndex(job.id), existing = index.requests.find(item => item.requestId === input.requestId);
    if (existing) {
      const plan = await readPlan(job.id, input.requestId, existing);
      if (plan.inputIdentity !== identity) throw new RevisionConflictError("Request id already belongs to another summary snapshot/provider/budget; preserved");
      return plan;
    }
    if (index.requests.length >= REVIEWED_SUMMARY_LIMITS.requests) throw Error("Reviewed summary history reached 32 requests; prior evidence preserved");
    const chunks = planSummaryChunks(snapshot.transcript, snapshot.revision.base.mediaSha256, context, maxCharacters);
    if (chunks.length > maxRequests) throw Error("Summary chunk plan exceeds explicit request budget; no provider called");
    const fields = { version: 1 as const, jobId: job.id, requestId: input.requestId, createdAt: new Date().toISOString(), snapshot, snapshotSha256, provider, ...(context ? { context } : {}), maxCharacters, maxRequests, chunkCount: chunks.length, inputIdentity: identity, requiresConsent: true as const, inputScope: "reviewed-transcript-only" as const };
    let plan: ReviewedSummaryPlan = { ...fields, consentKey: hash(fields) };
    input.signal?.throwIfAborted(); await assertCurrent(job, plan);
    await directory(getReviewedSummaryRoot(), true); await directory(getReviewedSummaryJobDir(job.id), true);
    // Recover a complete immutable plan left by an index CAS failure, preserving its consent/timestamp.
    const orphan = await readPrivate(planPath(job.id, input.requestId), REVIEWED_SUMMARY_LIMITS.planBytes).catch(error => { if (missing(error)) return undefined; throw error; });
    if (orphan) {
      const envelope = JSON.parse(orphan);
      const recovered = await readPlan(job.id, input.requestId, { requestId: input.requestId, planSha256: envelope.sha256, status: "planned", requestsSpent: 0 });
      if (recovered.inputIdentity !== identity) throw new RevisionConflictError("Uncommitted request id belongs to another summary plan; preserved");
      plan = recovered;
    } else {
      const plansDirectory = dirname(planPath(job.id, input.requestId));
      if (await directory(plansDirectory) && (await fs.readdir(plansDirectory)).length >= REVIEWED_SUMMARY_LIMITS.requests) throw Error("Reviewed summary plan storage reached 32 requests; uncommitted evidence preserved");
      await publishImmutable(planPath(job.id, input.requestId), { kind: "falatrace-reviewed-summary-plan", plan, sha256: hash(plan) }, REVIEWED_SUMMARY_LIMITS.planBytes);
    }
    index.requests.push({ requestId: input.requestId, planSha256: hash(plan), status: "planned", requestsSpent: 0 });
    await writeIndex(job.id, index, raw); return structuredClone(plan);
  });
};
const stateFor = (index: Index, id: string): RequestState => { const state = index.requests.find(item => item.requestId === id); if (!state) throw Error("Reviewed summary request is unavailable; create a plan first"); if (state.status === "cancelled") throw Error("Reviewed summary request was cancelled; fresh plan/consent required"); return state; };
const checkpointKey = (plan: ReviewedSummaryPlan, chunk: SummaryChunk): string => hash({ inputIdentity: plan.inputIdentity, chunk: chunk.key });
const attachChunkSupport = (summary: RecordingSummary, chunk: SummaryChunk): RecordingSummary => {
  const supported = attachSummarySupport(summary, chunk.evidence), seen = new Set<string>();
  // Text fragments share the canonical segment/time; a support reference is unique per ID.
  supported.support!.references = supported.support!.references.filter(reference => { if (seen.has(reference.id)) return false; seen.add(reference.id); return true; });
  return supported;
};
const readCheckpoint = async (plan: ReviewedSummaryPlan, chunk: SummaryChunk): Promise<RecordingSummary | undefined> => {
  const key = checkpointKey(plan, chunk), path = join(getReviewedSummaryJobDir(plan.jobId), "cache", `${key}.json`);
  let raw: string; try { raw = await readPrivate(path, REVIEWED_SUMMARY_LIMITS.artifactBytes); } catch (error) { if (missing(error)) return undefined; throw error; }
  const stored = JSON.parse(raw);
  if (stored.version !== 1 || stored.key !== key || stored.snapshotSha256 !== plan.snapshotSha256 || hash(stored.provider) !== hash(plan.provider) || stored.summary?.provider !== plan.provider.provider || stored.summary?.model !== plan.provider.model || hash(stored.summary) !== stored.summarySha256) throw Error("Reviewed summary checkpoint fingerprint mismatch");
  return attachChunkSupport(validateSummary(stored.summary, plan.provider.provider, plan.provider.model), chunk);
};
const merge = (plan: ReviewedSummaryPlan, summaries: RecordingSummary[]): RecordingSummary => {
  if (summaries.length === 1) return summaries[0]!;
  const combined: RecordingSummary = { ...summaries[0]!, support: undefined, overview: summaries.map(summary => summary.overview).join("\n\n"), topics: [], decisions: [], actionItems: [], citations: [], limitations: [] };
  for (const summary of summaries) {
    for (const citation of summary.citations || []) { const offset = citation.section === "topic" ? combined.topics.length : citation.section === "decision" ? combined.decisions.length : citation.section === "action" ? combined.actionItems.length : 0; combined.citations!.push({ ...citation, index: citation.section === "overview" ? 0 : citation.index + offset }); }
    combined.topics.push(...summary.topics); combined.decisions.push(...summary.decisions); combined.actionItems.push(...summary.actionItems); combined.limitations!.push(...summary.limitations || []);
  }
  combined.limitations = [...new Set(combined.limitations)].slice(0, 98).concat("Resumo montado por partes: revisar contexto global, redundâncias e conflitos; intervalos dos segmentos originais preservados.");
  const output = attachSummarySupport(validateSummary(combined, plan.provider.provider, plan.provider.model), buildSummaryEvidence(plan.snapshot.transcript, plan.snapshot.revision.base.mediaSha256, 8000)); output.support!.reviewRequired = true; return output;
};
const readResult = async (jobId: string, state: RequestState, plan: ReviewedSummaryPlan): Promise<ReviewedSummaryArtifact> => {
  const path = resultPath(jobId, state.requestId), raw = await readPrivate(path, REVIEWED_SUMMARY_LIMITS.artifactBytes), result = JSON.parse(raw) as StoredResult;
  if (state.status !== "completed" || hash(result) !== state.resultSha256 || result.version !== 1 || result.jobId !== jobId || result.requestId !== state.requestId || hash(result.revision) !== hash(plan.snapshot.revision) || result.snapshotSha256 !== plan.snapshotSha256 || result.transcriptSha256 !== plan.snapshot.transcriptSha256 || hash(result.summary) !== result.summarySha256 || result.summary.provider !== plan.provider.provider || result.summary.model !== plan.provider.model || result.provenance.authorship !== "model" || hash(result.provenance.provider) !== hash(plan.provider) || result.provenance.humanReviewedInput !== plan.snapshot.human.reviewed || result.provenance.inputScope !== "reviewed-transcript-only" || result.provenance.humanNotesUsed !== false || result.provenance.acousticLabelsUsed !== false) throw Error("Reviewed summary result fingerprint mismatch");
  const summary = validateSummary(result.summary, plan.provider.provider, plan.provider.model);
  if (!Number.isFinite(Date.parse(result.generatedAt)) || result.provenance.originalTranscriptReceipt !== plan.snapshot.original.receipt) throw Error("Reviewed summary provenance fingerprint mismatch");
  if (!summary.support || !summaryEvidenceMatches(summary, plan.snapshot.revision.base.mediaSha256, plan.snapshot.transcript)) throw Error("Reviewed summary support fingerprint mismatch");
  return { ...result, summary, path, raw };
};

/** No provider, revision mutation, original-artifact writes or implicit reprocessing during reads. */
export const readReviewedSummary = async (job: JobRecord): Promise<ReviewedSummaryArtifact | undefined> => {
  job = structuredClone(job);
  if (!await directory(getReviewedSummaryRoot())) return undefined;
  try {
    const { index } = await readIndex(job.id), candidates = index.requests.filter(item => item.status === "completed").sort((a, b) => b.sequence! - a.sequence!);
    if (!candidates.length) return undefined;
    const before = await currentSnapshot(job), currentHash = hash(before);
    for (const state of candidates) {
      const plan = await readPlan(job.id, state.requestId, state); if (plan.snapshotSha256 !== currentHash) continue;
      const result = await readResult(job.id, state, plan), after = await currentSnapshot(job);
      if (hash(after) !== currentHash) return undefined;
      const latest = await readIndex(job.id), latestState = latest.index.requests.find(item => item.requestId === state.requestId);
      if (latestState?.status !== "completed" || latestState.resultSha256 !== state.resultSha256 || latest.index.sequence !== index.sequence) return undefined;
      return result;
    }
    return undefined;
  } catch (error) { if (error instanceof RevisionConflictError || missing(error)) return undefined; throw error; }
};
/** The compatibility view argument never replaces current filesystem checks. */
export const readCurrentReviewedSummary = (job: JobRecord, _view?: ReviewedView): Promise<ReviewedSummaryArtifact | undefined> => readReviewedSummary(job);

export const cancelReviewedSummary = async (job: JobRecord, id: string): Promise<{ requestId: string; status: "cancelled" | "completed" }> => {
  requestId(id); const jobId = validateJobId(job.id);
  return withRevisionLease(jobId, async () => {
    const { index, raw } = await readIndex(jobId), state = index.requests.find(item => item.requestId === id);
    if (!state) throw Error("Reviewed summary request is unavailable");
    if (state.status === "completed") return { requestId: id, status: "completed" };
    state.status = "cancelled"; await writeIndex(jobId, index, raw); return { requestId: id, status: "cancelled" };
  });
};
export const regenerateReviewedSummary = async (job: JobRecord, input: { requestId: string; config: AppConfig; consent: boolean; consentKey: string; adapter?: ReviewedSummaryAdapter; signal?: AbortSignal }): Promise<ReviewedSummaryArtifact> => {
  if (!object(input) || Object.keys(input).some(key => !["requestId", "config", "consent", "consentKey", "adapter", "signal"].includes(key)) || (input.adapter !== undefined && (!object(input.adapter) || Object.keys(input.adapter).some(key => !["identity", "summarize"].includes(key)) || typeof input.adapter.summarize !== "function"))) throw Error("Invalid reviewed summary regeneration fields");
  job = structuredClone(job);
  input = { ...input, config: structuredClone(input.config), ...(input.adapter ? { adapter: { ...input.adapter, identity: structuredClone(input.adapter.identity) } } : {}) };
  requestId(input.requestId); validateConfig(input.config); input.signal?.throwIfAborted();
  if (input.consent !== true) throw Error("Explicit current reviewed summary consent required");
  validateJobId(job.id);
  // Admission precedes all request/revision leases and protects real and injected adapters alike.
  return withHeavyAdmission("pipeline", job.id, async () => {
  // The request lease is distinct from the revision lease; human edits remain possible during inference.
  const lease = await acquireSingleton(`reviewed-summary-${hash({ root: getReviewedSummaryRoot(), job: job.id, request: input.requestId }).slice(0, 32)}`);
  try {
    const plan = await withRevisionLease(job.id, async () => {
      const { index } = await readIndex(job.id), state = stateFor(index, input.requestId), plan = await readPlan(job.id, input.requestId, state);
      if (input.consentKey !== plan.consentKey || input.config.summary.maxInputCharacters !== plan.maxCharacters) throw Error("Reviewed summary consent/config changed; fresh plan required");
      const provider = input.adapter ? validateProvider(input.adapter.identity) : reviewedSummaryProviderForConfig(input.config);
      if (hash(provider) !== hash(plan.provider)) throw Error("Reviewed summary provider identity changed; fresh consent required");
      input.signal?.throwIfAborted(); await assertCurrent(job, plan); return plan;
    });
    const initial = await readIndex(job.id), completed = stateFor(initial.index, input.requestId);
    if (completed.status === "completed") { const result = await readResult(job.id, completed, plan); await assertCurrent(job, plan); input.signal?.throwIfAborted(); return result; }
    const config = structuredClone(input.config), adapter = input.adapter?.summarize || ((chunk: SummaryChunk, signal?: AbortSignal) => summarizeWithOllama(config, chunk.text, plan.provider.model, plan.context, chunk.evidence, signal)), chunks = chunksFor(plan), summaries: RecordingSummary[] = [];
    for (const chunk of chunks) {
      input.signal?.throwIfAborted();
      const cached = await withRevisionLease(job.id, async () => {
        const { index, raw } = await readIndex(job.id), state = stateFor(index, input.requestId); await assertCurrent(job, plan); input.signal?.throwIfAborted();
        const cached = await readCheckpoint(plan, chunk); if (cached) return cached;
        if (state.requestsSpent >= plan.maxRequests) throw Error("Reviewed summary provider request budget exhausted; prior evidence preserved");
        state.requestsSpent++; state.status = "running"; await writeIndex(job.id, index, raw); return undefined;
      });
      if (cached) { summaries.push(cached); continue; }
      const response = await adapter(structuredClone(chunk), input.signal); input.signal?.throwIfAborted();
      const summary = attachChunkSupport(validateSummary(structuredClone(response), plan.provider.provider, plan.provider.model), chunk);
      await withRevisionLease(job.id, async () => {
        stateFor((await readIndex(job.id)).index, input.requestId); await assertCurrent(job, plan); input.signal?.throwIfAborted();
        const key = checkpointKey(plan, chunk); await publishImmutable(join(getReviewedSummaryJobDir(job.id), "cache", `${key}.json`), { version: 1, key, snapshotSha256: plan.snapshotSha256, provider: plan.provider, summary, summarySha256: hash(summary) }, REVIEWED_SUMMARY_LIMITS.artifactBytes);
      });
      summaries.push(summary);
    }
    let summary = merge(plan, summaries);
    if (plan.snapshot.human.notes.length || plan.snapshot.human.labels) summary = { ...summary, limitations: [...new Set([...(summary.limitations || []).slice(0, 98), "Notas humanas sem tempo e rótulos acústicos permanecem na revisão; não foram usados como evidência do modelo."])] };
    if (plan.snapshot.original.receipt === "legacy-unverified") { summary.support!.reviewRequired = true; summary.limitations = [...new Set([...(summary.limitations || []).slice(0, 98), "Transcrição original legada sem recibo verificado; resumo requer revisão humana."])]; }
    let result: StoredResult = { version: 1, jobId: job.id, requestId: plan.requestId, generatedAt: new Date().toISOString(), revision: plan.snapshot.revision, snapshotSha256: plan.snapshotSha256, transcriptSha256: plan.snapshot.transcriptSha256, summarySha256: hash(summary), summary,
      provenance: { authorship: "model", humanReviewedInput: plan.snapshot.human.reviewed, provider: plan.provider, inputScope: "reviewed-transcript-only", humanNotesUsed: false, acousticLabelsUsed: false, originalTranscriptReceipt: plan.snapshot.original.receipt } };
    return withRevisionLease(job.id, () => withContextPublicationLease(aiContextRoot(), async () => {
      const { index, raw } = await readIndex(job.id), state = stateFor(index, input.requestId); await assertCurrent(job, plan); input.signal?.throwIfAborted();
      const orphan = await readPrivate(resultPath(job.id, plan.requestId), REVIEWED_SUMMARY_LIMITS.artifactBytes).catch(error => { if (missing(error)) return undefined; throw error; });
      if (orphan) {
        const stored = JSON.parse(orphan) as StoredResult;
        const recovered = await readResult(job.id, { ...state, status: "completed", resultSha256: hash(stored) }, plan);
        if (!Number.isFinite(Date.parse(stored.generatedAt)) || recovered.summarySha256 !== result.summarySha256 || hash(recovered.provenance) !== hash(result.provenance)) throw Error("Uncommitted reviewed summary differs from current checkpoints; preserved");
        const { raw: _raw, path: _path, ...storedResult } = recovered; result = storedResult;
      }
      if (await invalidateAiContextOwned(aiContextRoot(), "reviewed-summary-regeneration") === "failed") throw Error("Could not invalidate AI context; no reviewed summary published");
      // Immutable output first, bounded CAS index last. Orphaned files are never advertised.
      await publishImmutable(resultPath(job.id, plan.requestId), result, REVIEWED_SUMMARY_LIMITS.artifactBytes);
      await assertCurrent(job, plan); input.signal?.throwIfAborted();
      state.status = "completed"; state.resultSha256 = hash(result); state.sequence = ++index.sequence;
      await writeIndex(job.id, index, raw, async () => { await assertCurrent(job, plan); input.signal?.throwIfAborted(); });
      return { ...result, path: resultPath(job.id, plan.requestId), raw: JSON.stringify(result) };
    }));
  } finally { await lease.release(); }
  }, { signal: input.signal, onWait: cliAdmissionWait });
};
