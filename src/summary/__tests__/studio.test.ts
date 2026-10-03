import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore, hashFile } from "../../jobs/store";
import type { RecordingSummary, Transcript } from "../../jobs/types";
import { readReviewedView, saveRevision, RevisionConflictError } from "../../revisions";
import { withHeavyAdmission, readHeavyStatus } from "../../runtime/heavy-admission";
import { getReviewedSummaryJobDir, readReviewedSummary, reviewedSummaryProviderForConfig } from "../reviewed";
import { StudioSummaryFlow, StudioSummaryCancelledError, STUDIO_SUMMARY_LIMITS } from "../studio";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const rejected = <T>(promise: Promise<T>) => promise.then(() => undefined, error => error);
const fixture = async (long = false) => {
  const root = await fs.mkdtemp(join(tmpdir(), "studio-summary-")); roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG); config.recordingsDir = root; config.summary.ollamaModel = "synthetic-fixture-model";
  config.processing.autoEnqueue = false; config.aiContext.enabled = false; config.aiContext.autoBuild = false;
  config.callDetection.enabled = false; config.callDetection.enqueueOnStop = false; config.openai.autoTranscribe = false;
  if (long) config.summary.maxInputCharacters = 4096;
  const media = join(root, "synthetic.wav"); await fs.writeFile(media, "SYNTHETIC FIXTURE: NOT CAPTURED MEDIA");
  const jobs = new JobStore(), created = await jobs.enqueue(config, media), job = await jobs.update(created.id, "completed");
  await fs.mkdir(job.artifactDir, { recursive: true });
  const texts = long ? Array.from({ length: 3 }, (_, i) => `${i}:` + "conteúdo sintético ".repeat(80)) : ["Primeiro trecho sintético.", "Segundo trecho sintético."];
  const transcript: Transcript = { version: 1, provider: job.transcription.provider, model: job.transcription.model,
    language: job.transcription.language, text: texts.join("\n"), segments: texts.map((text, i) => ({ start: i * 2, end: i * 2 + 2, text })) };
  const transcriptPath = join(job.artifactDir, "transcript.json"), summaryPath = join(job.artifactDir, "summary.json");
  await fs.writeFile(transcriptPath, JSON.stringify(transcript));
  await fs.writeFile(summaryPath, JSON.stringify({ version: 1, provider: "ollama", model: config.summary.ollamaModel,
    title: "Original sintético", overview: "Resumo original preservado", topics: [], decisions: [], actionItems: [] }));
  const response = (): RecordingSummary => ({ version: 1, provider: "ollama", model: config.summary.ollamaModel,
    title: "Fixture", overview: "Novo resumo sintético", topics: [], decisions: [], actionItems: [],
    citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }] });
  const flow = (summarize = async () => response()) => new StudioSummaryFlow({ identity: reviewedSummaryProviderForConfig(config), summarize });
  const edit = async () => { const view = await readReviewedView(job); await saveRevision(job, {
    expectedRevision: view.revision.revision, base: view.revision.base,
    operations: [{ kind: "segment-text", segmentId: "s000000", text: "Texto sintético corrigido durante a espera" }],
  }); };
  const dir = getReviewedSummaryJobDir(job.id);
  const index = async () => JSON.parse(await fs.readFile(join(dir, "index.json"), "utf8"));
  const originals = () => Promise.all([media, transcriptPath, summaryPath].map(hashFile));
  const absentResults = async () => expect(await fs.readdir(join(dir, "results")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).toEqual([]);
  return { root, job, jobs, config, transcript, transcriptPath, summaryPath, dir, response, flow, edit, index, originals, absentResults };
};
const runInput = (plan: { requestId: string; consentKey: string }) => ({ requestId: plan.requestId, consent: true, consentKey: plan.consentKey });
const until = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error("Synthetic QA wait timed out"); await new Promise(resolve => setTimeout(resolve, 15)); }
};

test("Studio plan presents current production destination, unknown cost and transcript scope without reenabling configuration", async () => {
  const f = await fixture(), configBefore = structuredClone(f.config), hashes = await f.originals();
  const view = await readReviewedView(f.job); await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base,
    operations: [{ kind: "note", text: "Nota humana sem tempo, fora da entrada do modelo" }] });
  const flow = new StudioSummaryFlow(), plan = await flow.plan(f.job, f.config, { requestId: "presentation", maxRequests: 1 });
  expect(plan).toMatchObject({ status: "planned", jobId: f.job.id, requestId: "presentation", revision: 1,
    provider: { provider: "ollama", model: f.config.summary.ollamaModel, endpoint: "http://127.0.0.1:11434/" },
    chunkCount: 1, maxRequests: 1, inputCharacters: f.transcript.text.length, inputScope: "reviewed-transcript-only", requiresConsent: true,
    contextIncluded: false, notesUsed: false, acousticLabelsUsed: false,
    cost: { state: "unknown", estimatedUsd: null }, budget: { scope: "job", period: "lifetime", requestLimit: 32, providerRequestsLimit: 8 } });
  expect(plan.consentKey).toMatch(/^[a-f0-9]{64}$/); expect(plan.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(plan)).not.toContain(f.root); expect(JSON.stringify(plan)).not.toContain(f.transcript.text);
  expect(JSON.stringify(plan)).not.toContain("Nota humana"); expect(f.config).toEqual(configBefore);
  expect(await f.originals()).toEqual(hashes); expect(await flow.cancel(f.job, plan.requestId)).toMatchObject({ persisted: true, status: "cancelled" });
});

test("unsupported or unconfigured production provider rejects before planning and hidden input overrides are refused", async () => {
  const f = await fixture(), flow = new StudioSummaryFlow();
  for (const mutate of [
    (config: typeof f.config) => { config.summary.provider = "openai"; },
    (config: typeof f.config) => { config.summary.ollamaModel = ""; },
    (config: typeof f.config) => { config.summary.ollamaUrl = "https://remote.example.invalid"; },
  ]) { const config = structuredClone(f.config); mutate(config); await expect(flow.plan(f.job, config, { requestId: "bad-provider", maxRequests: 1 })).rejects.toThrow(); }
  await expect(flow.plan(f.job, f.config, { requestId: "override", maxRequests: 1, provider: "openai" } as any)).rejects.toThrow("fields");
  await expect(flow.plan(f.job, f.config, { requestId: "budget" } as any)).rejects.toThrow("budget");
  expect(await fs.access(join(f.dir, "index.json")).then(() => true, () => false)).toBe(false);
  expect(f.config.summary.provider).toBe("ollama"); expect(f.config.processing.autoEnqueue).toBe(false);
});

test("consent is explicit and tied to current plan, provider and configuration before any adapter call", async () => {
  const f = await fixture(); let calls = 0; const flow = f.flow(async () => { calls++; return f.response(); });
  const p = await flow.plan(f.job, f.config, { requestId: "consent", maxRequests: 1 });
  for (const consent of [false, undefined, 1]) await expect(flow.run(f.job, f.config, { ...runInput(p), consent: consent as boolean })).rejects.toThrow("consent");
  await expect(flow.run(f.job, f.config, { ...runInput(p), consentKey: "0".repeat(64) })).rejects.toThrow("consent");
  const changed = structuredClone(f.config); changed.summary.ollamaModel = "changed-model";
  await expect(flow.run(f.job, changed, runInput(p))).rejects.toThrow("identity mismatch");
  expect(calls).toBe(0); expect((await f.index()).requests[0].requestsSpent).toBe(0); await f.absentResults();
});

test("double-click plan/run is idempotent; distinct request is refused while active and receipt excludes raw/private content", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(), flow = f.flow(async () => { calls++; entered.resolve(); await gate.promise; return f.response(); });
  let calls = 0; const configBefore = structuredClone(f.config), before = await f.originals();
  const [p, duplicate] = await Promise.all([flow.plan(f.job, f.config, { requestId: "double", maxRequests: 1 }), flow.plan(f.job, f.config, { requestId: "double", maxRequests: 1 })]);
  expect(duplicate).toEqual(p); expect((await f.index()).requests).toHaveLength(1);
  const first = flow.run(f.job, f.config, runInput(p)); await entered.promise;
  const second = flow.run(f.job, f.config, runInput(p));
  await expect(flow.plan(f.job, f.config, { requestId: "different", maxRequests: 1 })).rejects.toThrow("already");
  await expect(flow.run(f.job, f.config, { ...runInput(p), requestId: "different" })).rejects.toThrow("already");
  gate.resolve(); const [receipt, repeat] = await Promise.all([first, second]); expect(repeat).toEqual(receipt);
  expect(receipt).toMatchObject({ status: "completed", jobId: f.job.id, requestId: p.requestId, revision: p.revision,
    snapshotSha256: p.snapshotSha256, authorship: "model", notesUsed: false, inputScope: "reviewed-transcript-only" });
  expect(JSON.stringify(receipt)).not.toContain(f.root); expect(JSON.stringify(receipt)).not.toContain("Novo resumo");
  expect(await flow.run(f.job, f.config, runInput(p))).toEqual(receipt); expect(calls).toBe(1);
  expect(await f.originals()).toEqual(before); expect(f.config).toEqual(configBefore);
});

test("cancel rejects promptly and persists cancellation even when adapter ignores abort, without accepting late publication", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); let calls = 0;
  const flow = f.flow(async () => { calls++; entered.resolve(); await gate.promise; return f.response(); });
  const p = await flow.plan(f.job, f.config, { requestId: "ignored-abort", maxRequests: 1 }), pending = flow.run(f.job, f.config, runInput(p)), outcome = rejected(pending);
  await entered.promise; const cancellation = await flow.cancel(f.job, p.requestId);
  expect(await outcome).toBeInstanceOf(StudioSummaryCancelledError); expect(cancellation).toMatchObject({ status: "cancelled", persisted: true });
  expect((await f.index()).requests[0].status).toBe("cancelled");
  await expect(flow.plan(f.job, f.config, { requestId: "next", maxRequests: 1 })).rejects.toThrow("already");
  gate.resolve(); await until(async () => !(await readHeavyStatus()).active); await f.absentResults();
  await until(async () => (await flow.cancelAll()).length === 0);
  expect(await readReviewedSummary(f.job)).toBeUndefined();
  await expect(flow.run(f.job, f.config, runInput(p))).rejects.toThrow("cancelled"); expect(calls).toBe(1);
});

test("cancelling queued admission prevents adapter execution and preserves request evidence", async () => {
  const f = await fixture(), hold = deferred(), occupied = deferred(); let calls = 0;
  const blocker = withHeavyAdmission("pipeline", "synthetic-other-job", async () => { occupied.resolve(); await hold.promise; }, { policy: { pause: "off", unknown: "allow" } });
  await occupied.promise;
  try {
    const flow = f.flow(async () => { calls++; return f.response(); }), p = await flow.plan(f.job, f.config, { requestId: "queued", maxRequests: 1 });
    const pending = flow.run(f.job, f.config, runInput(p)), outcome = rejected(pending);
    await until(async () => (await readHeavyStatus()).waiting.length > 0);
    expect(await flow.cancel(f.job, p.requestId)).toMatchObject({ status: "cancelled", persisted: true });
    expect(await outcome).toBeInstanceOf(StudioSummaryCancelledError); expect(calls).toBe(0);
    expect((await f.index()).requests[0].requestsSpent).toBe(0); await f.absentResults();
  } finally { hold.resolve(); await blocker; }
});

test("cancellation during final plan publication waits for its persistent receipt and never returns a late plan", async () => {
  const f = await fixture(), flow = f.flow(), gate = deferred(), entered = deferred(), originalRename = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === join(f.dir, "index.json")) { entered.resolve(); await gate.promise; }
    return originalRename(from, to);
  });
  try {
    const pending = flow.plan(f.job, f.config, { requestId: "late-plan", maxRequests: 1 }), outcome = rejected(pending);
    await entered.promise; const cancelled = flow.cancel(f.job, "late-plan");
    expect(await outcome).toBeInstanceOf(StudioSummaryCancelledError);
    gate.resolve(); expect(await cancelled).toMatchObject({ status: "cancelled", persisted: true });
    expect((await f.index()).requests[0].status).toBe("cancelled"); await f.absentResults();
    await expect(flow.run(f.job, f.config, { requestId: "late-plan", consent: true, consentKey: "0".repeat(64) })).rejects.toThrow("cancelled");
  } finally { gate.resolve(); rename.mockRestore(); }
});

test("cancellation before a plan exists reports no persistent request rather than fabricating a receipt", async () => {
  const f = await fixture(), flow = f.flow(), gate = deferred(), entered = deferred(), originalLstat = fs.lstat.bind(fs);
  const lstat = spyOn(fs, "lstat").mockImplementation(async (...args: any[]) => {
    if (String(args[0]) === f.job.sourcePath) { entered.resolve(); await gate.promise; }
    return (originalLstat as any)(...args);
  });
  try {
    const pending = flow.plan(f.job, f.config, { requestId: "early-plan", maxRequests: 1 }), outcome = rejected(pending);
    await entered.promise; const cancelled = flow.cancel(f.job, "early-plan");
    expect(await outcome).toBeInstanceOf(StudioSummaryCancelledError); gate.resolve();
    expect(await cancelled).toMatchObject({ status: "cancelled", persisted: false });
    expect(await fs.access(join(f.dir, "index.json")).then(() => true, () => false)).toBe(false);
  } finally { gate.resolve(); lstat.mockRestore(); }
});

test("recording switch cancels only the former job; late response cannot replace the second job's result", async () => {
  const first = await fixture(), second = await fixture(), gate = deferred(), entered = deferred(); let calls = 0;
  const flow = new StudioSummaryFlow({ identity: reviewedSummaryProviderForConfig(first.config), summarize: async () => {
    calls++; if (calls === 1) { entered.resolve(); await gate.promise; } return first.response();
  } });
  const p1 = await flow.plan(first.job, first.config, { requestId: "switch-first", maxRequests: 1 });
  const pending = flow.run(first.job, first.config, runInput(p1)), outcome = rejected(pending); await entered.promise;
  await flow.cancel(first.job, p1.requestId); expect(await outcome).toBeInstanceOf(StudioSummaryCancelledError);
  const p2 = await flow.plan(second.job, second.config, { requestId: "switch-second", maxRequests: 1 });
  gate.resolve(); const receipt = await flow.run(second.job, second.config, runInput(p2));
  expect(receipt.jobId).toBe(second.job.id); expect(receipt.requestId).toBe(p2.requestId);
  expect(await readReviewedSummary(first.job)).toBeUndefined(); expect((await readReviewedSummary(second.job))!.requestId).toBe(p2.requestId);
  await first.absentResults(); expect(calls).toBe(2);
});

test("human edit while a model response is pending fails the production revision guard and preserves originals", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(), before = await f.originals();
  const flow = f.flow(async () => { entered.resolve(); await gate.promise; return f.response(); });
  const p = await flow.plan(f.job, f.config, { requestId: "edit-conflict", maxRequests: 1 }), pending = flow.run(f.job, f.config, runInput(p)), outcome = rejected(pending);
  await entered.promise; await f.edit(); gate.resolve(); expect(await outcome).toBeInstanceOf(RevisionConflictError);
  expect(await f.originals()).toEqual(before); await f.absentResults(); expect(await readReviewedSummary(f.job)).toBeUndefined();
  expect((await f.index()).requests[0].requestsSpent).toBe(1);
});

test("model failure does not auto retry, erase original/checkpoint evidence or reset persistent request budget", async () => {
  const f = await fixture(true), before = await f.originals(); let calls = 0;
  const flow = new StudioSummaryFlow({ identity: reviewedSummaryProviderForConfig(f.config), summarize: async chunk => {
    calls++; if (calls > 1) throw Error("Synthetic provider failure");
    return { ...f.response(), citations: [{ section: "overview", index: 0, segmentIds: [chunk.evidence.segments[0]!.id], uncertainty: "clear" }] };
  } });
  const p = await flow.plan(f.job, f.config, { requestId: "model-error", maxRequests: 8 });
  expect(p.chunkCount).toBeGreaterThan(1); await expect(flow.run(f.job, f.config, runInput(p))).rejects.toThrow("Synthetic provider failure");
  expect(calls).toBe(2); expect((await f.index()).requests[0].requestsSpent).toBe(2);
  const cacheFiles = await fs.readdir(join(f.dir, "cache")); expect(cacheFiles).toHaveLength(1);
  const cacheHash = await hashFile(join(f.dir, "cache", cacheFiles[0]!));
  expect(await f.originals()).toEqual(before); await f.absentResults();
  // A separately constructed Studio retains all production evidence; no implicit retry.
  await new StudioSummaryFlow().cancel(f.job, p.requestId);
  expect((await f.index()).requests[0].requestsSpent).toBe(2); expect(await hashFile(join(f.dir, "cache", cacheFiles[0]!))).toBe(cacheHash);
});

test("cancelAll aborts every in-flight request before awaiting slow plan publication and handles prepared plans", async () => {
  const first = await fixture(), second = await fixture(), third = await fixture(), gate = deferred(), entered = deferred(), planGate = deferred(), planEntered = deferred();
  const flow = new StudioSummaryFlow({ identity: reviewedSummaryProviderForConfig(first.config), summarize: async () => { entered.resolve(); await gate.promise; return first.response(); } });
  const p1 = await flow.plan(first.job, first.config, { requestId: "disconnect-run", maxRequests: 1 });
  const p2 = await flow.plan(second.job, second.config, { requestId: "disconnect-prepared", maxRequests: 1 });
  const running = flow.run(first.job, first.config, runInput(p1)), runningOutcome = rejected(running); await entered.promise;
  const originalRename = fs.rename.bind(fs), rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === join(third.dir, "index.json")) { planEntered.resolve(); await planGate.promise; }
    return originalRename(from, to);
  });
  try {
    const planning = flow.plan(third.job, third.config, { requestId: "disconnect-plan", maxRequests: 1 }), planningOutcome = rejected(planning);
    await planEntered.promise; const cancelled = flow.cancelAll();
    expect(await runningOutcome).toBeInstanceOf(StudioSummaryCancelledError); expect(await planningOutcome).toBeInstanceOf(StudioSummaryCancelledError);
    planGate.resolve(); const receipts = await cancelled; expect(receipts).toHaveLength(3);
    expect(receipts.every(receipt => receipt.status === "cancelled" && receipt.persisted)).toBe(true);
    expect((await second.index()).requests[0].requestId).toBe(p2.requestId); expect((await second.index()).requests[0].status).toBe("cancelled");
    gate.resolve(); await until(async () => !(await readHeavyStatus()).active);
    await until(async () => (await flow.cancelAll()).length === 0);
    await first.absentResults(); await second.absentResults(); await third.absentResults();
    expect(await flow.cancelAll()).toEqual([]);
  } finally { planGate.resolve(); gate.resolve(); rename.mockRestore(); }
});

test("controller retains only bounded active jobs, releasing terminal entries while persistent history owns lifetime counts", async () => {
  const f = await fixture(), flow = f.flow();
  for (let i = 0; i < STUDIO_SUMMARY_LIMITS.activeJobs; i++) {
    const media = join(f.root, `bounded-${i}.wav`); await fs.writeFile(media, `SYNTHETIC BOUNDED ${i}`);
    const distinct = await f.jobs.enqueue(f.config, media), actual = await f.jobs.update(distinct.id, "completed");
    await fs.mkdir(actual.artifactDir, { recursive: true }); await fs.writeFile(join(actual.artifactDir, "transcript.json"), JSON.stringify(f.transcript));
    await flow.plan(actual, f.config, { requestId: `active-${i}`, maxRequests: 1 });
  }
  await expect(flow.plan(f.job, f.config, { requestId: "over-limit", maxRequests: 1 })).rejects.toThrow("limit");
  expect(await flow.cancelAll()).toHaveLength(STUDIO_SUMMARY_LIMITS.activeJobs);
  for (let i = 0; i < 20; i++) { const plan = await flow.plan(f.job, f.config, { requestId: `terminal-${i}`, maxRequests: 1 }); await flow.cancel(f.job, plan.requestId); }
  expect((await f.index()).requests).toHaveLength(20); expect(await flow.cancelAll()).toEqual([]);
}, 15000);

test("terminal shutdown rejects an accepted caller delayed before flow registration and cannot dispatch after disconnect", async () => {
  const f = await fixture(), gate = deferred(), accepted = deferred(); let calls = 0;
  const flow = f.flow(async () => { calls++; return f.response(); });
  const p = await flow.plan(f.job, f.config, { requestId: "before-eof", maxRequests: 1 });
  // Bridge-level JobStore/config reads may still be pending after accepting an input
  // line. No controller entry can be registered when those reads finish after EOF.
  const delayed = (async () => { accepted.resolve(); await gate.promise; return flow.run(f.job, f.config, runInput(p)); })(), outcome = rejected(delayed);
  await accepted.promise;
  expect(await flow.shutdown()).toMatchObject([{ requestId: p.requestId, status: "cancelled", persisted: true }]);
  gate.resolve(); expect(String(await outcome)).toContain("closed");
  await expect(flow.plan(f.job, f.config, { requestId: "after-eof", maxRequests: 1 })).rejects.toThrow("closed");
  expect(await flow.shutdown()).toEqual([]); expect(calls).toBe(0);
  expect((await f.index()).requests[0].status).toBe("cancelled"); expect((await f.index()).requests[0].requestsSpent).toBe(0);
  await f.absentResults();
  // Persistent cancellation remains permitted; shutdown does not alter that contract.
  expect(await flow.cancel(f.job, p.requestId)).toMatchObject({ status: "cancelled", persisted: true });
});
