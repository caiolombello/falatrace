import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore, hashFile } from "../../jobs/store";
import { transcriptionIdentity } from "../../jobs/transcript-access";
import type { RecordingSummary, Transcript } from "../../jobs/types";
import { readReviewedView, saveRevision, undoRevision, RevisionConflictError } from "../../revisions";
import { withContextPublicationLease, aiContextRoot, readContextInvalidation } from "../../knowledge/invalidation";
import { DiarizationStore, transcriptChecksum } from "../../diarization/store";
import { getRecordingStateDir } from "../../recording/session";
import { readHeavyStatus } from "../../runtime/heavy-admission";
import { cancelReviewedSummary, getReviewedSummaryJobDir, getReviewedSummaryRoot, planReviewedSummary, readReviewedSummary, readCurrentReviewedSummary, regenerateReviewedSummary, reviewedSummaryProviderForConfig, type ReviewedSummaryAdapter, type ReviewedSummaryProvider } from "../reviewed";
import { summaryTranscriptEvidenceSha256 } from "../evidence";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity: ReviewedSummaryProvider = { provider: "ollama", model: "fixture-summary", adapterIdentity: "synthetic-stub-v1" };
const response = (text = "Resumo sintético"): RecordingSummary => ({ version: 1, provider: "ollama", model: identity.model, title: "Resumo de fixture", overview: text, topics: [], decisions: [], actionItems: [], citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }] });
const fixture = async (options: { verified?: boolean; long?: boolean; diarization?: boolean } = {}) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reviewed-summary-")); roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG); config.recordingsDir = root; config.timesheet.enabled = false; config.processing.defaultTarget = "local"; config.transcription.provider = "whisper-cpp"; config.summary.provider = "ollama";
  if (options.long) config.summary.maxInputCharacters = 4096;
  const media = join(root, "synthetic.wav"); await fs.writeFile(media, "SYNTHETIC FIXTURE, NOT A RECORDING");
  const jobs = new JobStore(), created = await jobs.enqueue(config, media), job = await jobs.update(created.id, "completed");
  await fs.mkdir(job.artifactDir, { recursive: true });
  const texts = options.long ? Array.from({ length: 3 }, (_, i) => `${i}:` + "conteúdo sintético ".repeat(80)) : ["Primeiro trecho.", "Segundo trecho."];
  const transcript: Transcript = { version: 1, provider: job.transcription.provider, model: job.transcription.model, language: job.transcription.language, text: texts.join("\n"), segments: texts.map((text, i) => ({ start: i * 2, end: i * 2 + 2, text })) };
  const transcriptPath = join(job.artifactDir, "transcript.json"), originalSummaryPath = join(job.artifactDir, "summary.json");
  await fs.writeFile(transcriptPath, JSON.stringify(transcript)); await fs.writeFile(originalSummaryPath, JSON.stringify(response("Resumo original preservado")));
  if (options.verified) await fs.writeFile(join(job.artifactDir, "transcript-receipt.json"), JSON.stringify({ version: 1, identity: transcriptionIdentity(job), transcriptSha256: await hashFile(transcriptPath) }));
  if (options.diarization) await new DiarizationStore().save({ version: 1, jobId: job.id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(transcript.text), provider: "openai", model: "gpt-4o-transcribe-diarize", duration: 4, generatedAt: "2026-10-03T00:00:00Z", labels: { S01: "Falante 1", S02: "Falante 2" }, acousticValidation: "pending", turns: transcript.segments.map((segment, i) => ({ ...segment, speaker: i ? "S02" : "S01" })), alignment: { text: transcript.text, matchedTokenRatio: 0, unassignedTokenCount: 4, segments: [{ start: 0, end: 4, text: transcript.text, charStart: 0, charEnd: transcript.text.length, reviewRequired: true }] } });
  const plan = (requestId: string, extra: { provider?: ReviewedSummaryProvider; maxRequests?: number } = {}) => planReviewedSummary(job, { requestId, config, provider: identity, ...extra });
  const generate = async (requestId: string, summarize: ReviewedSummaryAdapter["summarize"] = async () => response(), extra: { signal?: AbortSignal; provider?: ReviewedSummaryProvider } = {}) => {
    const p = await plan(requestId, extra.provider ? { provider: extra.provider } : {});
    return regenerateReviewedSummary(job, { requestId, config, consent: true, consentKey: p.consentKey, adapter: { identity: extra.provider || identity, summarize }, signal: extra.signal });
  };
  const edit = async (text: string) => { const view = await readReviewedView(job); return saveRevision(job, { expectedRevision: view.revision.revision, base: view.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text }] }); };
  return { root, config, jobs, job, media, transcript, transcriptPath, originalSummaryPath, plan, generate, edit, dir: getReviewedSummaryJobDir(job.id) };
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
const absentResults = async (dir: string) => expect(await fs.readdir(join(dir, "results")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).toEqual([]);

test("planning binds exact snapshot/provider/budget and requires explicit current consent without processing", async () => {
  const f = await fixture(); await f.edit("Trecho humano revisado."); const p = await f.plan("plan-only");
  expect(p.snapshot.revision.revision).toBe(1); expect(p.snapshot.transcript.text).toContain("humano revisado"); expect(p.requiresConsent).toBe(true); expect(p.chunkCount).toBe(1); expect(p.maxRequests).toBe(1);
  expect(p.snapshot.transcriptSha256).toBe(summaryTranscriptEvidenceSha256(p.snapshot.transcript));
  const before = await hashFile(join(f.dir, "index.json")); let calls = 0; const adapter = { identity, summarize: async () => { calls++; return response(); } };
  for (const consent of [false, undefined, 1]) await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: consent as boolean, consentKey: p.consentKey, adapter })).rejects.toThrow("consent");
  await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: "wrong", adapter })).rejects.toThrow("consent");
  await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter: { ...adapter, identity: { ...identity, adapterIdentity: "another" } } })).rejects.toThrow("identity changed");
  expect(calls).toBe(0); expect(await hashFile(join(f.dir, "index.json"))).toBe(before); await absentResults(f.dir);
  expect(await f.plan(p.requestId)).toEqual(p);
  await expect(f.plan(p.requestId, { provider: { ...identity, model: "other" } })).rejects.toBeInstanceOf(RevisionConflictError);
});

test("reviewed generation preserves originals, canonical evidence hashes and model/human provenance", async () => {
  const f = await fixture(); const originals = [f.media, f.transcriptPath, f.originalSummaryPath], before = await Promise.all(originals.map(hashFile));
  await f.edit("Texto corrigido por humano."); let input = "";
  const output = await f.generate("reviewed", async chunk => { input = chunk.text; chunk.text = "MUTATED STUB INPUT"; return response("Modelo resumiu texto revisto"); });
  expect(input).toContain("Texto corrigido por humano"); expect(output.revision.revision).toBe(1); expect(output.provenance).toMatchObject({ authorship: "model", humanReviewedInput: true, humanNotesUsed: false });
  expect(output.summary.support!.transcriptSha256).toBe(summaryTranscriptEvidenceSha256((await readReviewedView(f.job)).transcript));
  expect(output.summary.support!.reviewRequired).toBe(true); expect(output.summary.limitations!.join(" ")).toContain("legada");
  expect(await Promise.all(originals.map(hashFile))).toEqual(before);
  expect((await readReviewedSummary(f.job))!.summary.overview).toBe(output.summary.overview);
  expect((await fs.stat(output.path)).mode & 0o777).toBe(0o600); expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(output.raw).summarySha256).toBe(sha(output.summary));
});

test("verified receipts can retain clear support; repeat/cache/new provider identities never overwrite original summaries", async () => {
  const f = await fixture({ verified: true }); let calls = 0; const adapter = async () => { calls++; return response(); };
  const first = await f.generate("first", adapter), repeated = await f.generate("first", adapter), cached = await f.generate("second", adapter);
  expect(calls).toBe(1); expect(repeated.path).toBe(first.path); expect(repeated.raw).toBe(first.raw); expect(cached.path).not.toBe(first.path); expect(first.summary.support!.reviewRequired).toBe(false);
  const index = JSON.parse(await fs.readFile(join(f.dir, "index.json"), "utf8")); expect(index.requests.map((item: any) => item.requestsSpent)).toEqual([1, 0]);
  expect((await readReviewedSummary(f.job))!.requestId).toBe("second");
  await f.generate("third", adapter, { provider: { ...identity, adapterIdentity: "new-fixture" } }); expect(calls).toBe(2);
  expect(await fs.readFile(f.originalSummaryPath, "utf8")).toContain("original preservado");
});

test("an asynchronous human revision during pending adapter rejects checkpoint/publication and preserves prior derivative", async () => {
  const f = await fixture(); await f.edit("Revisão inicial."); const prior = await f.generate("prior"), priorHash = await hashFile(prior.path);
  const gate = deferred(), entered = deferred(), provider = { ...identity, adapterIdentity: "pending-fixture" }, plan = await f.plan("pending", { provider });
  const pending = regenerateReviewedSummary(f.job, { requestId: plan.requestId, config: f.config, consent: true, consentKey: plan.consentKey, adapter: { identity: provider, summarize: async () => { entered.resolve(); await gate.promise; return response(); } } });
  await entered.promise; await f.edit("Editado enquanto o modelo estava pendente."); gate.resolve();
  await expect(pending).rejects.toBeInstanceOf(RevisionConflictError); expect(await hashFile(prior.path)).toBe(priorHash);
  expect(await readReviewedSummary(f.job)).toBeUndefined(); expect(await fs.readdir(join(f.dir, "results"))).toEqual(["prior.json"]);
  expect((await fs.readdir(join(f.dir, "cache"))).length).toBe(1);
});

test("persistent cancellation and AbortSignal prevent publication even when a stub ignores abort", async () => {
  for (const abortOnly of [false, true]) {
    const f = await fixture(), gate = deferred(), entered = deferred(), controller = new AbortController(), p = await f.plan("cancelled");
    const pending = regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, signal: controller.signal, adapter: { identity, summarize: async () => { entered.resolve(); await gate.promise; return response(); } } });
    await entered.promise;
    if (abortOnly) controller.abort(Error("synthetic abort")); else expect((await cancelReviewedSummary(f.job, p.requestId)).status).toBe("cancelled");
    gate.resolve(); await expect(pending).rejects.toThrow(abortOnly ? "synthetic abort" : "cancelled"); await absentResults(f.dir); expect(await readReviewedSummary(f.job)).toBeUndefined();
    if (!abortOnly) await expect(f.generate(p.requestId)).rejects.toThrow("cancelled");
  }
});

test("source bytes, original artifact formatting and current job deletion invalidate exact source binding", async () => {
  for (const drift of ["media", "transcript", "job"] as const) {
    const f = await fixture(), gate = deferred(), entered = deferred(), p = await f.plan(drift), transcriptRaw = await fs.readFile(f.transcriptPath, "utf8");
    const pending = regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter: { identity, summarize: async () => { entered.resolve(); await gate.promise; return response(); } } });
    await entered.promise;
    if (drift === "media") await fs.writeFile(f.media, "OTHER SYNTHETIC SOURCE");
    if (drift === "transcript") await fs.writeFile(f.transcriptPath, transcriptRaw + "\n");
    if (drift === "job") await fs.unlink(join(f.jobs.stateDir, `${f.job.id}.json`));
    gate.resolve(); await expect(pending).rejects.toThrow(); await absentResults(f.dir); expect(await readReviewedSummary(f.job)).toBeUndefined();
  }
});

test("note, speaker metadata and undo heads get distinct snapshots even when transcript text hashes match", async () => {
  const f = await fixture({ diarization: true }); const zero = await f.plan("zero"), generated = await f.generate("zero");
  let view = await readReviewedView(f.job); await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "Nota sem tempo" }] });
  const note = await f.plan("note"); expect(note.snapshot.transcriptSha256).toBe(zero.snapshot.transcriptSha256); expect(note.snapshotSha256).not.toBe(zero.snapshotSha256); expect(await readReviewedSummary(f.job)).toBeUndefined();
  view = await readReviewedView(f.job); await saveRevision(f.job, { expectedRevision: 1, base: view.revision.base, operations: [{ kind: "speaker-label", speakerId: "S01", label: "Rótulo humano" }, { kind: "turn-speaker", turnId: "t000001", speakerId: "S01" }] });
  const speaker = await f.plan("speaker"); expect(speaker.snapshot.transcriptSha256).toBe(note.snapshot.transcriptSha256); expect(speaker.snapshotSha256).not.toBe(note.snapshotSha256);
  const output = await f.generate("speaker"); expect(output.provenance.acousticLabelsUsed).toBe(false); expect(output.summary.limitations!.join(" ")).toContain("sem tempo");
  await undoRevision(f.job, { expectedRevision: 2, base: speaker.snapshot.revision.base }); await undoRevision(f.job, { expectedRevision: 3, base: speaker.snapshot.revision.base });
  const undo = await f.plan("undo"); expect(undo.snapshot.transcriptSha256).toBe(zero.snapshot.transcriptSha256); expect(undo.snapshot.revision.revision).toBe(4); expect(undo.snapshotSha256).not.toBe(zero.snapshotSha256); expect(await readReviewedSummary(f.job)).toBeUndefined(); expect(await fs.access(generated.path).then(() => true)).toBe(true);
});

test("chunk planning rejects unconsented multiple requests and bounded checkpoints resume without repeating completed parts", async () => {
  const f = await fixture({ long: true }); await expect(f.plan("too-small")).rejects.toThrow("budget");
  const p = await f.plan("chunks", { maxRequests: 8 }); expect(p.chunkCount).toBeGreaterThan(1); expect(p.chunkCount).toBeLessThanOrEqual(8);
  let calls = 0, fail = true; const adapter: ReviewedSummaryAdapter = { identity, summarize: async chunk => { calls++; if (fail && calls === 2) throw Error("synthetic provider failure"); return { ...response(), citations: [{ section: "overview", index: 0, segmentIds: [chunk.evidence.segments[0]!.id], uncertainty: "clear" }] }; } };
  const options = { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter };
  await expect(regenerateReviewedSummary(f.job, options)).rejects.toThrow("synthetic provider failure"); expect((await fs.readdir(join(f.dir, "cache"))).length).toBe(1); await absentResults(f.dir);
  fail = false; const output = await regenerateReviewedSummary(f.job, options); expect(calls).toBe(p.chunkCount + 1); expect(output.summary.support!.reviewRequired).toBe(true);
  expect(output.summary.support!.references.every(ref => f.transcript.segments[Number(ref.id.slice(1))]!.start === ref.start)).toBe(true);
});

test("exhausted requests never invoke a retry or reset counters", async () => {
  const f = await fixture(), p = await f.plan("failed"); let calls = 0;
  const options = { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter: { identity, summarize: async () => { calls++; throw Error("fixture failed"); } } };
  await expect(regenerateReviewedSummary(f.job, options)).rejects.toThrow("fixture failed"); await expect(regenerateReviewedSummary(f.job, options)).rejects.toThrow("budget exhausted"); expect(calls).toBe(1); await absentResults(f.dir);
});

test("corrupt checkpoint/private paths and mismatched provider claims fail closed without replacement", async () => {
  const f = await fixture(); await f.generate("good"); const file = join(f.dir, "cache", (await fs.readdir(join(f.dir, "cache")))[0]!), original = await fs.readFile(file, "utf8"), stored = JSON.parse(original);
  stored.summary.model = "wrong-model"; stored.summarySha256 = sha(stored.summary); await fs.writeFile(file, JSON.stringify(stored));
  let calls = 0; await expect(f.generate("bad", async () => { calls++; return response(); })).rejects.toThrow("checkpoint fingerprint"); expect(calls).toBe(0);
  await fs.writeFile(file, original); await fs.chmod(file, 0o644); await expect(f.generate("public")).rejects.toThrow("private"); await fs.chmod(file, 0o600);
  const plans = join(f.dir, "plans"), moved = join(f.dir, "preserved-plans"); await fs.rename(plans, moved); await fs.symlink(moved, plans);
  await expect(f.plan("symlink")).rejects.toThrow("Unsafe"); expect(await fs.readFile(join(moved, "good.json"), "utf8")).toContain("falatrace-reviewed-summary-plan");
});

test("production default is explicit loopback Ollama and fresh config changes reject before execution", async () => {
  const f = await fixture(), descriptor = reviewedSummaryProviderForConfig(f.config); expect(descriptor.endpoint).toBe("http://127.0.0.1:11434/");
  for (const url of ["https://remote.invalid", "http://localhost:11434/other", "http://user:pass@localhost:11434", "http://localhost:11434/?token=secret"]) { const config = structuredClone(f.config); config.summary.ollamaUrl = url; expect(() => reviewedSummaryProviderForConfig(config)).toThrow("loopback"); }
  const paid = structuredClone(f.config); paid.summary.provider = "openai"; expect(() => reviewedSummaryProviderForConfig(paid)).toThrow("local Ollama only");
  const p = await planReviewedSummary(f.job, { requestId: "production-plan", config: f.config }); const changed = structuredClone(f.config); changed.summary.ollamaUrl = "http://localhost:11435";
  await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: changed, consent: true, consentKey: p.consentKey })).rejects.toThrow("identity changed"); await absentResults(f.dir);
});

test("reader double-checks asynchronous drift and does not acquire revision lease while context is held", async () => {
  const f = await fixture(); await f.generate("read");
  expect((await withContextPublicationLease(aiContextRoot(), () => readCurrentReviewedSummary(f.job, undefined)))!.requestId).toBe("read");
  const nativeOpen = fs.open.bind(fs); let edited = false;
  const open = spyOn(fs, "open").mockImplementation(async (...args: any[]) => { if (!edited && String(args[0]).includes("/results/read.json")) { edited = true; await f.edit("Edição durante leitura"); } return (nativeOpen as any)(...args); });
  try { expect(await readReviewedSummary(f.job)).toBeUndefined(); } finally { open.mockRestore(); }
});

test("index failure leaves an unadvertised immutable result; retry verifies and commits it from checkpoints", async () => {
  const f = await fixture(), p = await f.plan("recover"); let calls = 0; const nativeRename = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === join(f.dir, "index.json") && await fs.access(join(f.dir, "results/recover.json")).then(() => true, () => false)) throw Error("synthetic final CAS failure"); return nativeRename(from, to); });
  try { await expect(f.generate(p.requestId, async () => { calls++; return response(); })).rejects.toThrow("synthetic final CAS failure"); } finally { rename.mockRestore(); }
  expect(await readReviewedSummary(f.job)).toBeUndefined(); const orphan = await hashFile(join(f.dir, "results/recover.json"));
  const output = await f.generate(p.requestId, async () => { calls++; return response(); }); expect(calls).toBe(1); expect(await hashFile(output.path)).toBe(orphan); expect((await readReviewedSummary(f.job))!.requestId).toBe(p.requestId);
});

test("uncommitted plan recovery preserves consent and final staging rechecks abort before advertising", async () => {
  const f = await fixture(), nativeRename = fs.rename.bind(fs); let fail = true;
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => { if (fail && String(to) === join(f.dir, "index.json")) throw Error("synthetic plan index failure"); return nativeRename(from, to); });
  try { await expect(f.plan("plan-recover")).rejects.toThrow("synthetic plan index failure"); fail = false; const orphan = JSON.parse(await fs.readFile(join(f.dir, "plans/plan-recover.json"), "utf8")); expect((await f.plan("plan-recover")).consentKey).toBe(orphan.plan.consentKey); } finally { rename.mockRestore(); }
  const controller = new AbortController(), p = await f.plan("late-abort"), nativeOpen = fs.open.bind(fs); let aborted = false;
  const open = spyOn(fs, "open").mockImplementation(async (...args: any[]) => { if (!aborted && String(args[0]) === join(f.dir, "index.json") && await fs.access(join(f.dir, "results/late-abort.json")).then(() => true, () => false)) { aborted = true; controller.abort(Error("abort during index staging")); } return (nativeOpen as any)(...args); });
  try { await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, signal: controller.signal, adapter: { identity, summarize: async () => response() } })).rejects.toThrow("abort during index staging"); } finally { open.mockRestore(); }
  expect(aborted).toBe(true); expect(await readReviewedSummary(f.job)).toBeUndefined(); expect(JSON.parse(await fs.readFile(join(f.dir, "index.json"), "utf8")).requests.find((entry: any) => entry.requestId === p.requestId).status).not.toBe("completed");
});

test("successful publication invalidates cached AI context under its lease", async () => {
  const f = await fixture(); await fs.mkdir(aiContextRoot(), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(aiContextRoot(), "fixture.md"), "Synthetic cached context"); await f.generate("context");
  expect(await readContextInvalidation(aiContextRoot())).toContain("reviewed-summary-regeneration");
});

test("runtime request/provider fields reject hidden credentials before any persisted plan", async () => {
  const f = await fixture();
  await expect(planReviewedSummary(f.job, { requestId: "extra", config: f.config, provider: { ...identity, apiKey: "synthetic-placeholder" } as any })).rejects.toThrow("identity");
  await expect(planReviewedSummary(f.job, { requestId: "extra", config: f.config, provider: identity, secret: "synthetic-placeholder" } as any)).rejects.toThrow("fields");
  for (const endpoint of ["https://user:placeholder@fixture.invalid", "https://fixture.invalid/?key=placeholder", "https://fixture.invalid/#placeholder"]) await expect(f.plan("endpoint", { provider: { ...identity, endpoint } })).rejects.toThrow("secrets");
  const p = await f.plan("safe");
  await expect(regenerateReviewedSummary(f.job, { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter: { identity, summarize: async () => response() }, token: "synthetic-placeholder" } as any)).rejects.toThrow("fields");
  expect((await fs.readdir(join(f.dir, "plans")))).toEqual(["safe.json"]); await absentResults(f.dir);
});

test("concurrent repeated execution cannot invoke a second adapter and late source drift blocks index commit", async () => {
  const f = await fixture(), p = await f.plan("concurrent"), gate = deferred(), entered = deferred(); let calls = 0;
  const options = { requestId: p.requestId, config: f.config, consent: true, consentKey: p.consentKey, adapter: { identity, summarize: async () => { calls++; entered.resolve(); await gate.promise; return response(); } } };
  const first = regenerateReviewedSummary(f.job, options); await entered.promise;
  await expect(regenerateReviewedSummary(f.job, options)).rejects.toThrow("already"); gate.resolve(); await first; expect(calls).toBe(1);
  const next = await f.plan("late-source"), nativeOpen = fs.open.bind(fs); let drifted = false;
  const open = spyOn(fs, "open").mockImplementation(async (...args: any[]) => { if (!drifted && String(args[0]) === join(f.dir, "index.json") && await fs.access(join(f.dir, "results/late-source.json")).then(() => true, () => false)) { drifted = true; await fs.writeFile(f.media, "DIFFERENT SYNTHETIC SOURCE"); } return (nativeOpen as any)(...args); });
  try { await expect(regenerateReviewedSummary(f.job, { requestId: next.requestId, config: f.config, consent: true, consentKey: next.consentKey, adapter: { identity, summarize: async () => response() } })).rejects.toBeInstanceOf(RevisionConflictError); } finally { open.mockRestore(); }
  expect(drifted).toBe(true); expect(await readReviewedSummary(f.job)).toBeUndefined();
  expect(JSON.parse(await fs.readFile(join(f.dir, "index.json"), "utf8")).requests.find((entry: any) => entry.requestId === next.requestId).status).not.toBe("completed");
});

test("cancelled requests retain per-job lifetime slots across process restart with no budget reset", async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) { await f.plan(`cancel-${i}`); await cancelReviewedSummary(f.job, `cancel-${i}`); }
  const before = await hashFile(join(f.dir, "index.json")); await expect(f.plan("33rd")).rejects.toThrow("32 requests"); expect(await hashFile(join(f.dir, "index.json"))).toBe(before);
  const script = join(f.root, "restart-cap.ts");
  await fs.writeFile(script, `import {planReviewedSummary} from ${JSON.stringify(join(import.meta.dir, "../reviewed.ts"))};\ntry { await planReviewedSummary(${JSON.stringify(f.job)}, {requestId:'restart-33rd',config:${JSON.stringify(f.config)},provider:${JSON.stringify(identity)}}); throw Error('unexpected reset'); } catch (error) { if (!String(error).includes('32 requests')) throw error; console.log('persisted 32-request cap'); }\n`);
  const child = Bun.spawn([process.execPath, "run", "--preload", join(import.meta.dir, "../../../scripts/offline-network.ts"), script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe(""); expect(await new Response(child.stdout).text()).toContain("persisted 32-request cap");
  expect(await hashFile(join(f.dir, "index.json"))).toBe(before); expect((await fs.readdir(join(f.dir, "plans"))).length).toBe(32); await absentResults(f.dir);
}, 15000);

test("missing reviewed state and unsupported original summary remain graceful read-only fallbacks", async () => {
  const f = await fixture(); await fs.writeFile(f.originalSummaryPath, "unsupported legacy summary");
  expect(await readReviewedSummary(f.job)).toBeUndefined(); expect(await fs.readFile(f.originalSummaryPath, "utf8")).toBe("unsupported legacy summary");
  expect(getReviewedSummaryRoot()).toContain("recording-cli/reviewed-summaries");
});

test("an incomplete local job regenerates from its verified reviewed work transcript without changing job state", async () => {
  const f = await fixture({ verified: true }), work = f.jobs.getWorkDir(f.job.id);
  await fs.writeFile(join(work, "transcript.json"), await fs.readFile(f.transcriptPath));
  await fs.writeFile(join(work, "transcript-receipt.json"), await fs.readFile(join(f.job.artifactDir, "transcript-receipt.json")));
  const job = await f.jobs.update(f.job.id, "failed", { error: "Synthetic summary-stage failure" }), statePath = join(f.jobs.stateDir, `${job.id}.json`), stateHash = await hashFile(statePath), originalHash = await hashFile(f.originalSummaryPath);
  const view = await readReviewedView(job); expect(view.original.provenance.origin).toBe("work"); expect(view.original.provenance.receipt).toBe("verified");
  await saveRevision(job, { expectedRevision: view.revision.revision, base: view.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "Trecho work revisado por humano." }] });
  const plan = await planReviewedSummary(job, { requestId: "failed-work", config: f.config, provider: identity });
  expect(plan.snapshot.original.origin).toBe("work"); let calls = 0;
  const result = await regenerateReviewedSummary(job, { requestId: plan.requestId, config: f.config, consent: true, consentKey: plan.consentKey, adapter: { identity, summarize: async chunk => { calls++; expect(chunk.text).toContain("work revisado por humano"); return response(); } } });
  expect(calls).toBe(1); expect(result.revision.revision).toBe(1); expect((await readReviewedSummary(job))!.requestId).toBe(plan.requestId);
  expect((await f.jobs.get(job.id)).state).toBe("failed"); expect(await hashFile(statePath)).toBe(stateHash); expect(await hashFile(f.originalSummaryPath)).toBe(originalHash);
});

test("existing capture admission pauses regeneration before request leases and queued cancellation invokes no adapter", async () => {
  const f = await fixture(), plan = await f.plan("queued-cancel"), root = getRecordingStateDir(), session = join(root, "recording-session.json"), previousPause = process.env.FALATRACE_HEAVY_PAUSE;
  const previousSession = await fs.readFile(session).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const recording = { version: 1, id: randomUUID(), owner: "manual", backend: "audio", outputPath: f.media, startedAt: new Date().toISOString(), phase: "recording" };
  await fs.writeFile(session, JSON.stringify(recording), { mode: 0o600 }); process.env.FALATRACE_HEAVY_PAUSE = "capture";
  let calls = 0; const controller = new AbortController();
  const pending = regenerateReviewedSummary(f.job, { requestId: plan.requestId, config: f.config, consent: true, consentKey: plan.consentKey, signal: controller.signal, adapter: { identity, summarize: async () => { calls++; return response(); } } });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 80; attempt++) { const status = await readHeavyStatus(); if (status.waiting.some(ticket => ticket.reason === "recording-active")) { waiting = true; break; } await Bun.sleep(25); }
    expect(waiting).toBe(true); expect(calls).toBe(0);
    expect(JSON.parse(await fs.readFile(join(f.dir, "index.json"), "utf8")).requests[0].requestsSpent).toBe(0);
    expect((await cancelReviewedSummary(f.job, plan.requestId)).status).toBe("cancelled");
    await fs.writeFile(session, JSON.stringify({ ...recording, phase: "stopped" }), { mode: 0o600 });
    await expect(pending).rejects.toThrow("cancelled"); expect(calls).toBe(0); await absentResults(f.dir); expect((await readHeavyStatus()).active).toBe(false);
  } finally {
    controller.abort(); await pending.catch(() => undefined);
    if (previousPause === undefined) delete process.env.FALATRACE_HEAVY_PAUSE; else process.env.FALATRACE_HEAVY_PAUSE = previousPause;
    if (previousSession) await fs.writeFile(session, previousSession); else await fs.unlink(session).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}, 10000);
