import { createHash } from "node:crypto";
import type { AppConfig } from "../config/defaults";
import { validateJobId, type JobRecord } from "../jobs/types";
import { templateName } from "../templates/catalog";
import { SUMMARY_LABELS, type ContentLanguage } from "./language";
import {
  cancelReviewedSummary, planReviewedSummary, regenerateReviewedSummary,
  reviewedSummaryProviderForConfig, REVIEWED_SUMMARY_LIMITS,
  type ReviewedInputScope, type ReviewedSummaryAdapter, type ReviewedSummaryArtifact, type ReviewedSummaryPlan,
} from "./reviewed";
import type { SummaryInputSources } from "./v2";

export const STUDIO_SUMMARY_LIMITS = Object.freeze({ activeJobs: 16, finishedRuns: 64, finishedRunMs: 10 * 60 * 1000 });
type PlanInput = { requestId: string; maxRequests: number; templateId?: string; language?: string; useNotes?: boolean };
type RunInput = { requestId: string; consent: boolean; consentKey: string };
type ProviderPresentation = { provider: "ollama" | "openai"; model: string; endpoint?: string };
/** Where the summary input goes, in the words of the processing plan ("Ollama neste computador"). */
export type StudioSummaryDestination = { provider: "ollama" | "openai"; model: string; where: string };
/** The template of the plan: a fixed one, or "auto" when the model picks it from the conversation. */
export type StudioSummaryTemplate = { id: string; name: string; mode: "fixed" | "model-choice"; source: string };
export type StudioSummaryPlan = {
  status: "planned"; jobId: string; requestId: string; consentKey: string; snapshotSha256: string; revision: number;
  provider: ProviderPresentation; chunkCount: number; maxRequests: number; inputCharacters: number;
  inputScope: ReviewedInputScope; requiresConsent: true; contextIncluded: boolean; notesUsed: boolean; notesCount: number; acousticLabelsUsed: false;
  /** True when the input leaves this computer. */
  external: boolean; destination: StudioSummaryDestination;
  /** Null only for plans stored before templates existed. */
  template: StudioSummaryTemplate | null; language: ContentLanguage;
  cost: { state: "unknown"; estimatedUsd: null; description: string };
  budget: { scope: "job"; period: "lifetime"; requestLimit: number; providerRequestsLimit: number };
};
export type StudioSummaryReceipt = {
  status: "completed"; jobId: string; requestId: string; generatedAt: string; revision: number;
  snapshotSha256: string; summarySha256: string; provider: ProviderPresentation;
  requiresReview: boolean; authorship: "model"; inputScope: ReviewedInputScope; notesUsed: boolean;
};
/** State of a run started with `start`; kept for a while after it ends so the Studio can poll it. */
export type StudioSummaryRunStatus = {
  jobId: string; requestId: string; status: "running" | "completed" | "failed" | "cancelled";
  receipt?: StudioSummaryReceipt; error?: string;
};
export type StudioSummaryCancellation = { jobId: string; requestId: string; status: "cancelled" | "completed"; persisted: boolean };
type Item = {
  job: JobRecord; requestId: string; controller: AbortController; stage: "planning" | "planned" | "running" | "cancelling";
  planIdentity?: string; runIdentity?: string; planWork?: Promise<StudioSummaryPlan>; planPromise?: Promise<StudioSummaryPlan>;
  runWork?: Promise<StudioSummaryReceipt>; runPromise?: Promise<StudioSummaryReceipt>; cancelPromise?: Promise<StudioSummaryCancellation>;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const requestId = (id: unknown): string => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error("Invalid Studio summary request id");
  return id;
};
const providerPresentation = (provider: ReviewedSummaryPlan["provider"]): ProviderPresentation => ({
  provider: provider.provider, model: provider.model, ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
});
const loopback = (endpoint: string | undefined): boolean => {
  try { return endpoint !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname); } catch { return false; }
};
const destinationOf = (provider: ReviewedSummaryPlan["provider"]): { external: boolean; destination: StudioSummaryDestination } => {
  const external = provider.provider === "openai" || !loopback(provider.endpoint);
  let host = "";
  try { host = provider.endpoint ? new URL(provider.endpoint).host : ""; } catch { host = ""; }
  const where = provider.provider === "openai" ? "OpenAI, serviço externo" : !external ? "Ollama neste computador" : host ? `Ollama em ${host}` : "Endereço do Ollama inválido";
  return { external, destination: { provider: provider.provider, model: provider.model, where } };
};
const templateOf = (plan: ReviewedSummaryPlan): StudioSummaryTemplate | null => {
  if (plan.version !== 2) return null;
  const { selection, language } = plan.request;
  return selection.mode === "fixed" && selection.template
    ? { id: selection.template.id, name: templateName(selection.template, language), mode: "fixed", source: selection.source }
    : { id: "auto", name: SUMMARY_LABELS[language].autoTemplate, mode: "model-choice", source: "ai" };
};
const presentPlan = (plan: ReviewedSummaryPlan): StudioSummaryPlan => ({
  status: "planned", jobId: plan.jobId, requestId: plan.requestId, consentKey: plan.consentKey,
  snapshotSha256: plan.snapshotSha256, revision: plan.snapshot.revision.revision,
  provider: providerPresentation(plan.provider), chunkCount: plan.chunkCount, maxRequests: plan.maxRequests,
  inputCharacters: plan.snapshot.transcript.text.trim() ? plan.snapshot.transcript.text.length : plan.snapshot.transcript.segments.map(segment => segment.text.trim()).filter(Boolean).join("\n").length,
  inputScope: plan.inputScope, requiresConsent: true,
  contextIncluded: plan.context !== undefined, notesUsed: plan.inputScope === "reviewed-transcript-and-notes",
  notesCount: plan.version === 2 && plan.inputScope === "reviewed-transcript-and-notes" ? plan.request.notes.length : 0, acousticLabelsUsed: false,
  ...destinationOf(plan.provider), template: templateOf(plan), language: plan.version === 2 ? plan.request.language : "pt-BR",
  cost: { state: "unknown", estimatedUsd: null, description: "Local compute usage is not priced; no monetary estimate or financial cap." },
  budget: { scope: "job", period: "lifetime", requestLimit: REVIEWED_SUMMARY_LIMITS.requests, providerRequestsLimit: REVIEWED_SUMMARY_LIMITS.providerRequests },
});
const presentResult = (result: ReviewedSummaryArtifact): StudioSummaryReceipt => ({
  status: "completed", jobId: result.jobId, requestId: result.requestId, generatedAt: result.generatedAt,
  revision: result.revision.revision, snapshotSha256: result.snapshotSha256, summarySha256: result.summarySha256,
  provider: providerPresentation(result.provenance.provider), requiresReview: result.summary.support?.reviewRequired !== false,
  authorship: "model", inputScope: result.provenance.inputScope, notesUsed: result.provenance.humanNotesUsed === true,
});
export class StudioSummaryCancelledError extends Error {
  constructor() { super("Studio summary request cancelled; no late result accepted"); this.name = "StudioSummaryCancelledError"; }
}
type RunRecord = { jobId: string; promise: Promise<StudioSummaryReceipt>; status: StudioSummaryRunStatus["status"]; receipt?: StudioSummaryReceipt; error?: string; finishedAt?: number };
/** Abort presentation promptly even when transport ignores abort; production still guards publication. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const stop = () => reject(signal.reason || new StudioSummaryCancelledError());
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  work.then(value => { signal.aborted ? stop() : resolve(value); }, reject)
    .finally(() => signal.removeEventListener("abort", stop));
});

/**
 * Studio composes the persisted reviewed-summary contracts. The optional adapter is
 * constructor-only dependency injection for offline tests; there is no UI/provider override.
 * Only in-flight/prepared requests are retained here. Persistent production evidence owns
 * lifetime request counts, cancelled IDs, checkpoints and completed-result idempotence.
 */
export class StudioSummaryFlow {
  private readonly items = new Map<string, Item>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly adapter?: ReviewedSummaryAdapter;
  private readonly sources?: SummaryInputSources;
  private closed = false;
  /** `options.sources` (tests) replaces where notes, saved choices and templates are read from. */
  constructor(adapter?: ReviewedSummaryAdapter, options: { sources?: SummaryInputSources } = {}) {
    this.adapter = adapter ? { identity: structuredClone(adapter.identity), summarize: adapter.summarize } : undefined;
    this.sources = options.sources;
  }
  private configIdentity(config: AppConfig): string {
    const provider = reviewedSummaryProviderForConfig(config);
    if (this.adapter && hash(this.adapter.identity) !== hash(provider)) throw Error("Studio summary test adapter/config identity mismatch");
    return hash({ provider, maxCharacters: config.summary.maxInputCharacters });
  }
  private item(job: JobRecord, id: string): Item {
    if (this.closed) throw Error("Studio summary flow is closed; no new request accepted");
    validateJobId(job.id);
    const existing = this.items.get(job.id);
    if (existing) {
      if (existing.requestId !== id || existing.stage === "cancelling") throw Error("Studio summary for this job is already pending or running");
      return existing;
    }
    if (this.items.size >= STUDIO_SUMMARY_LIMITS.activeJobs) throw Error("Studio summary pending request limit reached");
    const item: Item = { job: structuredClone(job), requestId: id, controller: new AbortController(), stage: "planning" };
    this.items.set(job.id, item);
    return item;
  }
  private forget(item: Item): void { if (this.items.get(item.job.id) === item) this.items.delete(item.job.id); }
  async plan(job: JobRecord, config: AppConfig, input: PlanInput): Promise<StudioSummaryPlan> {
    if (this.closed) throw Error("Studio summary flow is closed; no new request accepted");
    if (!object(input) || Object.keys(input).some(key => !["requestId", "maxRequests", "templateId", "language", "useNotes"].includes(key))) throw Error("Invalid Studio summary plan fields");
    const id = requestId(input.requestId);
    if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests < 1 || input.maxRequests > REVIEWED_SUMMARY_LIMITS.providerRequests) throw Error("Studio summary request budget must be explicit and bounded by eight");
    const choices = {
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.useNotes !== undefined ? { useNotes: input.useNotes } : {})
    };
    job = structuredClone(job); config = structuredClone(config);
    const identity = hash({ job, config: this.configIdentity(config), maxRequests: input.maxRequests, choices }), item = this.item(job, id);
    if (item.planPromise) {
      if (item.planIdentity !== identity || item.stage === "running") throw Error("Studio summary plan changed or execution already pending; fresh plan required");
      return structuredClone(await item.planPromise);
    }
    if (item.runWork) throw Error("Studio summary execution already pending");
    item.planIdentity = identity;
    item.planWork = (async () => {
      try {
        const plan = await planReviewedSummary(job, { requestId: id, config, maxRequests: input.maxRequests, signal: item.controller.signal, ...choices,
          ...(this.sources ? { sources: this.sources } : {}) });
        item.controller.signal.throwIfAborted();
        item.stage = "planned";
        return presentPlan(plan);
      } catch (error) {
        if (!item.cancelPromise) this.forget(item);
        throw error;
      }
    })();
    item.planPromise = abortable(item.planWork, item.controller.signal);
    return structuredClone(await item.planPromise);
  }
  /** Runs a planned request and waits for its receipt (the bridge's current awaited path). */
  async run(job: JobRecord, config: AppConfig, input: RunInput): Promise<StudioSummaryReceipt> {
    return structuredClone(await this.launch(job, config, input));
  }
  /**
   * Starts a planned request and returns at once; poll `status(requestId)` for the outcome. The
   * same checks as `run` apply first, so a refused request rejects here instead of starting.
   */
  async start(job: JobRecord, config: AppConfig, input: RunInput): Promise<{ jobId: string; requestId: string; status: "running" }> {
    const promise = this.launch(job, config, input), id = input.requestId, existing = this.runs.get(id);
    if (existing?.promise !== promise) {
      const record: RunRecord = { jobId: job.id, promise, status: "running" };
      this.runs.set(id, record);
      this.pruneRuns();
      promise.then(receipt => {
        if (this.runs.get(id) === record) Object.assign(record, { status: "completed", receipt: structuredClone(receipt), finishedAt: Date.now() });
      }, error => {
        if (this.runs.get(id) !== record) return;
        const cancelled = error instanceof StudioSummaryCancelledError;
        Object.assign(record, { status: cancelled ? "cancelled" : "failed", finishedAt: Date.now(),
          ...(cancelled ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }) });
      });
    }
    return { jobId: job.id, requestId: id, status: "running" };
  }
  /** Outcome of a request started with `start`: running, completed (with its receipt), failed or cancelled. */
  status(id: string): StudioSummaryRunStatus {
    this.pruneRuns();
    const record = this.runs.get(requestId(id));
    if (!record) throw Error("Studio summary request is unavailable");
    return structuredClone({ jobId: record.jobId, requestId: id, status: record.status,
      ...(record.receipt ? { receipt: record.receipt } : {}), ...(record.error ? { error: record.error } : {}) });
  }
  private pruneRuns(): void {
    const now = Date.now();
    for (const [id, record] of this.runs) if (record.finishedAt !== undefined && now - record.finishedAt > STUDIO_SUMMARY_LIMITS.finishedRunMs) this.runs.delete(id);
    const finished = [...this.runs.entries()].filter(([, record]) => record.finishedAt !== undefined).sort((a, b) => a[1].finishedAt! - b[1].finishedAt!);
    while (finished.length > STUDIO_SUMMARY_LIMITS.finishedRuns) this.runs.delete(finished.shift()![0]);
  }
  private launch(job: JobRecord, config: AppConfig, input: RunInput): Promise<StudioSummaryReceipt> {
    if (this.closed) throw Error("Studio summary flow is closed; no new request accepted");
    if (!object(input) || Object.keys(input).some(key => !["requestId", "consent", "consentKey"].includes(key))) throw Error("Invalid Studio summary run fields");
    const id = requestId(input.requestId);
    if (input.consent !== true || typeof input.consentKey !== "string" || !/^[a-f0-9]{64}$/.test(input.consentKey)) throw Error("Explicit current Studio summary consent required");
    job = structuredClone(job); config = structuredClone(config);
    const identity = hash({ job, config: this.configIdentity(config), consentKey: input.consentKey }), existing = this.items.get(job.id);
    if (existing?.requestId === id && existing.stage === "planning" && existing.planWork) throw Error("Studio summary plan is still pending");
    const item = this.item(job, id);
    if (item.runPromise) {
      if (item.runIdentity !== identity) throw Error("Studio summary execution identity changed; fresh consent required");
      return item.runPromise;
    }
    item.stage = "running"; item.runIdentity = identity;
    item.runWork = (async () => {
      try {
        const result = await regenerateReviewedSummary(job, { requestId: id, config, consent: true, consentKey: input.consentKey,
          ...(this.adapter ? { adapter: this.adapter } : {}), signal: item.controller.signal });
        item.controller.signal.throwIfAborted();
        return presentResult(result);
      } finally { this.forget(item); }
    })();
    item.runPromise = abortable(item.runWork, item.controller.signal);
    return item.runPromise;
  }
  async cancel(job: JobRecord, id: string): Promise<StudioSummaryCancellation> {
    requestId(id); validateJobId(job.id);
    const item = this.items.get(job.id);
    if (item && item.requestId === id) {
      if (item.cancelPromise) return item.cancelPromise;
      const planning = item.stage === "planning";
      item.stage = "cancelling"; item.controller.abort(new StudioSummaryCancelledError());
      item.cancelPromise = (async () => {
        // A cancelled plan can publish just before its final signal check. Wait for its
        // production operation, then cancel the persisted request if it exists.
        if (planning) await item.planWork?.catch(() => undefined);
        try {
          const result = await cancelReviewedSummary(item.job, id);
          return { jobId: item.job.id, ...result, persisted: true };
        } catch (error) {
          if (planning && error instanceof Error && error.message === "Reviewed summary request is unavailable") return { jobId: item.job.id, requestId: id, status: "cancelled" as const, persisted: false };
          throw error;
        } finally { if (!item.runWork) this.forget(item); }
      })();
      return item.cancelPromise;
    }
    const result = await cancelReviewedSummary(structuredClone(job), id);
    return { jobId: job.id, ...result, persisted: true };
  }
  async cancelAll(): Promise<StudioSummaryCancellation[]> {
    const items = [...this.items.values()];
    // Abort all before awaiting any disk operation or late plan; one slow plan cannot
    // keep a different request's adapter alive after Studio disconnects.
    for (const item of items) item.controller.abort(new StudioSummaryCancelledError());
    const results = await Promise.allSettled(items.map(item => this.cancel(item.job, item.requestId)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return results.map(result => (result as PromiseFulfilledResult<StudioSummaryCancellation>).value);
  }
  /** Terminal bridge EOF/disconnect barrier, including callers still awaiting config/job reads. */
  async shutdown(): Promise<StudioSummaryCancellation[]> {
    this.closed = true;
    return this.cancelAll();
  }
}
