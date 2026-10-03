import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { parseReviewedSnapshotArgs } from "../../cli/reviewed-snapshots";
import { assertCurrentSummaryPresentation } from "../../desktop/bridge";
import { exportRoot, previewExport, saveExport } from "../../export";
import { readReviewedView, RevisionConflictError, saveRevision } from "../../revisions";
import { planReviewedSummary, readReviewedSummary, regenerateReviewedSummary, type ReviewedSummaryProvider } from "../../summary/reviewed";
import { planSummaryChunks } from "../../summary/chunks";
import * as ollama from "../../summary/ollama";
import { reconcileTimeEntryForJob } from "../../timesheet/reconcile";
import * as classification from "../../timesheet/classification";
import { getTimeEntryStatusPath, TimeEntryStore } from "../../timesheet/store";
import type { LocalVisualAdapter } from "../../visual/session";
import * as command from "../command";
import * as media from "../media";
import { formatTranscriptMarkdown } from "../format";
import { processJob } from "../pipeline";
import * as remote from "../remote";
import { pullRemoteArtifacts } from "../remote";
import { hashFile, JobStore } from "../store";
import { syncJob } from "../sync";
import { transcriptionIdentity } from "../transcript-access";
import type { RecordingSummary, Transcript } from "../types";

const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "TMPDIR"] as const;
const provider: ReviewedSummaryProvider = { provider: "ollama", model: "compat-synthetic-summary", adapterIdentity: "compat-injected-adapter-v1" };
const modelSummary = (overview: string): RecordingSummary => ({ version: 1, provider: "ollama", model: provider.model,
  title: "Synthetic fixture", overview, topics: [], decisions: [], actionItems: [],
  citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }] });

async function fixture<T>(action: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(join(tmpdir(), "compat-integrated-offline-"));
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    const dirs = ["home", "config", "state", "data", "runtime", "cache", "tmp"];
    for (const [index, key] of envKeys.entries()) {
      const path = join(root, dirs[index]!);
      await fs.mkdir(path, { mode: 0o700 });
      process.env[key] = path;
    }
    return await action(await createFixture(root));
  } finally {
    for (const key of envKeys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root: string) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = join(root, "recordings");
  config.timesheet.enabled = false;
  config.processing.defaultTarget = "local";
  config.transcription.provider = "whisper-cpp";
  config.transcription.whisperCpp.modelPath = join(root, "synthetic-model.bin");
  config.summary.provider = "ollama";
  config.summary.ollamaModel = provider.model;
  await fs.mkdir(config.recordingsDir, { mode: 0o700 });
  const source = join(config.recordingsDir, "synthetic.wav");
  await fs.writeFile(source, "SYNTHETIC OFFLINE FIXTURE; NOT CAPTURED MEDIA", { mode: 0o600 });
  const store = new JobStore();
  const queued = await store.enqueue(config, source);
  const job = await store.update(queued.id, "completed");
  await fs.mkdir(job.artifactDir, { recursive: true, mode: 0o700 });
  const transcript: Transcript = { version: 1, provider: job.transcription.provider, model: job.transcription.model,
    language: job.transcription.language, text: "Original first sentence.\nOriginal second sentence.",
    segments: [{ start: 0, end: 2, text: "Original first sentence." }, { start: 2, end: 4, text: "Original second sentence." }] };
  const originals = [source, ...["transcript.json", "summary.json", "transcript.md", "summary.md"].map(name => join(job.artifactDir, name))];
  await fs.writeFile(originals[1]!, JSON.stringify(transcript), { mode: 0o600 });
  await fs.writeFile(originals[2]!, JSON.stringify(modelSummary("ORIGINAL SUMMARY PRESERVED")), { mode: 0o600 });
  await fs.writeFile(originals[3]!, "original transcript markdown sentinel", { mode: 0o600 });
  await fs.writeFile(originals[4]!, "original summary markdown sentinel", { mode: 0o600 });
  const revise = async (text = "Human correction.") => {
    const view = await readReviewedView(job);
    return saveRevision(job, { expectedRevision: view.revision.revision, base: view.revision.base,
      operations: [{ kind: "segment-text", segmentId: "s000000", text }] });
  };
  const hashes = () => Promise.all(originals.map(hashFile));
  return { root, config, store, job, source, originals, transcript, revise, hashes };
}

for (const visual of [false, true]) test(`original ${visual ? "visual " : ""}pipeline refuses human journal before probes/adapters and artifact writes`, async () => fixture(async f => {
  await f.revise();
  const before = await f.hashes(), names = await fs.readdir(f.job.artifactDir);
  const probe = spyOn(media, "probeMedia").mockImplementation(async () => { throw Error("unexpected media probe"); });
  let adapterCalls = 0;
  const adapter: LocalVisualAdapter = { identity: "synthetic-never-called", localOnly: true,
    select: async () => { adapterCalls++; throw Error("unexpected selector"); },
    inspect: async () => { adapterCalls++; throw Error("unexpected vision adapter"); } };
  const visualRoot = join(f.root, "never-created-visual");
  try {
    await expect(processJob(f.config, f.store.toManifest(f.job), f.source, f.job.artifactDir, visual ? {
      visual: { root: visualRoot, adapter, review: { id: "never-used-review", consent: true, consentKey: "a".repeat(64) } }
    } : undefined)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(probe).not.toHaveBeenCalled();
    expect(adapterCalls).toBe(0);
    expect(await f.hashes()).toEqual(before);
    expect(await fs.readdir(f.job.artifactDir)).toEqual(names);
    expect(await fs.lstat(visualRoot).catch(error => error.code)).toBe("ENOENT");
  } finally { probe.mockRestore(); }
}));

test("remote original pull refuses human journal before SSH/rsync or local artifact replacement", async () => fixture(async f => {
  await f.revise();
  const before = await f.hashes(), remote = { ...f.job, target: "remote" as const };
  const invoke = spyOn(command, "runCommand").mockImplementation(async () => { throw Error("unexpected external command"); });
  try {
    await expect(pullRemoteArtifacts(f.config, remote, `2026/10/${f.job.id}`)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(invoke).not.toHaveBeenCalled();
    expect(await f.hashes()).toEqual(before);
  } finally { invoke.mockRestore(); }
}));

test("legacy timesheet refuses human journal before looking up or mutating time entries", async () => fixture(async f => {
  await f.revise();
  const config = structuredClone(f.config);
  config.timesheet.enabled = true;
  config.timesheet.contextPath = join(f.root, "missing-context-must-not-be-read.json");
  const store = new TimeEntryStore(join(f.root, "never-created-timesheet"));
  const find = spyOn(store, "findForJob").mockImplementation(async () => { throw Error("unexpected timesheet lookup"); });
  const replace = spyOn(store, "replace").mockImplementation(async () => { throw Error("unexpected timesheet write"); });
  const before = await f.hashes();
  try {
    await expect(reconcileTimeEntryForJob(config, f.job, store, { force: true, notify: false })).rejects.toBeInstanceOf(RevisionConflictError);
    expect(find).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(await f.hashes()).toEqual(before);
    expect(await fs.lstat(store.stateDir).catch(error => error.code)).toBe("ENOENT");
  } finally { find.mockRestore(); replace.mockRestore(); }
}));

test("reviewed snapshot CLI parses only explicit actions and strict request/budget/consent JSON", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const parse = (action: string, input: unknown) => parseReviewedSnapshotArgs(["summary-review", action, id, "--input", JSON.stringify(input)]);
  expect(parse("plan", { requestId: "synthetic-plan", maxRequests: 1 }).input).toEqual({ requestId: "synthetic-plan", maxRequests: 1 });
  expect(parse("run", { requestId: "synthetic-plan", consent: true, consentKey: "a".repeat(64) }).action).toBe("run");
  expect(parse("cancel", { requestId: "synthetic-plan" }).action).toBe("cancel");
  for (const input of [null, [], { requestId: "../escape", maxRequests: 1 }, { requestId: "synthetic", maxRequests: "1" },
    { requestId: "synthetic" }, { requestId: "synthetic", maxRequests: 0 }, { requestId: "synthetic", maxRequests: 9 },
    { requestId: "synthetic", maxRequests: 1.5 }, { requestId: "synthetic", maxRequests: 1, provider: "openai" }]) expect(() => parse("plan", input)).toThrow();
  for (const input of [{ requestId: "synthetic", consent: "true", consentKey: "a".repeat(64) },
    { requestId: "synthetic", consent: false, consentKey: "a".repeat(64) }, { requestId: "synthetic", consent: true, consentKey: "short" },
    { requestId: "synthetic", consent: true, consentKey: "a".repeat(64), adapter: "injected" }]) expect(() => parse("run", input)).toThrow();
  for (const args of [["summary-review", "show", id, "--input", "{}"], ["summary-review", "run", id],
    ["summary-review", "cancel", id, "--input", '{"requestId":"synthetic","consent":true}'],
    ["summary-review", "plan", id, "--input", "{broken"], ["summary-review", "plan", id, "--input", "{}", "--extra"],
    ["removal-plan", "execute", id], ["removal-plan", "validate", id], ["removal-plan", "show", "../escape"]]) expect(() => parseReviewedSnapshotArgs(args)).toThrow();
});

test("CLI synthetic summary plan/show/cancel and removal show/validate preserve originals and reject stale plans", async () => fixture(async f => {
  await f.revise();
  const configDir = join(process.env.XDG_CONFIG_HOME!, "recording-cli");
  await fs.mkdir(configDir, { mode: 0o700 });
  await fs.writeFile(join(configDir, "config.json"), JSON.stringify(f.config), { mode: 0o600 });
  const before = await f.hashes();
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["/usr/bin/python3", "-I", join(import.meta.dir, "../../../scripts/qa-run.py"),
      process.execPath, "run", "--preload", join(import.meta.dir, "../../../scripts/offline-network.ts"),
      join(import.meta.dir, "../../cli/index.ts"), ...args], { env: { ...process.env, NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    } finally { clearTimeout(timer); }
  };
  const initial = await run("summary-review", "show", f.job.id);
  expect(initial.code).toBe(0); expect(initial.err).toBe(""); expect(JSON.parse(initial.out).available).toBe(false);
  const planned = await run("summary-review", "plan", f.job.id, "--input", JSON.stringify({ requestId: "cli-synthetic", maxRequests: 1 }));
  expect(planned.code).toBe(0); expect(planned.err).toBe("");
  const plan = JSON.parse(planned.out);
  expect(plan.snapshot.revision.revision).toBe(1); expect(plan.requiresConsent).toBe(true); expect(plan.inputScope).toBe("reviewed-transcript-only");
  const cancelled = await run("summary-review", "cancel", f.job.id, "--input", JSON.stringify({ requestId: plan.requestId }));
  expect(cancelled.code).toBe(0); expect(JSON.parse(cancelled.out).status).toBe("cancelled");
  const removed = await run("removal-plan", "show", f.job.id);
  expect(removed.code).toBe(0); expect(removed.err).toBe("");
  const removal = JSON.parse(removed.out);
  expect(removal.mode).toBe("dry-run"); expect(removal.executable).toBe(false);
  expect(removal.scope.remoteCopies).toBe("preserved-not-contacted");
  const validated = await run("removal-plan", "validate", f.job.id, "--input", JSON.stringify(removal));
  expect(validated.code).toBe(0); expect(JSON.parse(validated.out)).toEqual({ valid: true, executable: false, mode: "dry-run" });
  await f.revise("Later human correction.");
  const stale = await run("removal-plan", "validate", f.job.id, "--input", JSON.stringify(removal));
  expect(stale.code).toBe(2); expect(stale.out).toBe(""); expect(JSON.parse(stale.err).error.code).toBe("snapshot-conflict");
  const invalid = await run("summary-review", "run", f.job.id, "--input", JSON.stringify({ requestId: plan.requestId, consent: "true", consentKey: plan.consentKey }));
  expect(invalid.code).toBe(1); expect(invalid.out).toBe(""); expect(JSON.parse(invalid.err).error.code).toBe("invalid-or-unavailable");
  expect(await f.hashes()).toEqual(before);
  expect(await readReviewedSummary(f.job)).toBeUndefined();
}), 15000);

test("injected reviewed summary exports fresh model provenance while originals stay unchanged, then revision CAS refuses old exports", async () => fixture(async f => {
  const before = await f.hashes();
  await f.revise("Text corrected by a human for the injected model.");
  const plan = await planReviewedSummary(f.job, { requestId: "export-synthetic", config: f.config, provider, maxRequests: 1 });
  let calls = 0;
  const generated = await regenerateReviewedSummary(f.job, { requestId: plan.requestId, config: f.config, consent: true, consentKey: plan.consentKey,
    adapter: { identity: provider, summarize: async chunk => {
      calls++; expect(chunk.text).toContain("Text corrected by a human");
      return modelSummary("FRESH MODEL SUMMARY OF REVIEWED TEXT");
    } } });
  expect(calls).toBe(1);
  const json = await previewExport(f.job, { format: "json", track: "transcript" });
  const markdown = await previewExport(f.job, { format: "markdown", track: "transcript" });
  expect(json.available).toBe(true); expect(markdown.available).toBe(true);
  const document = JSON.parse(json.display);
  expect(document.summary).toMatchObject({ state: "ready", originalState: "stale", verification: "verified", requestId: plan.requestId,
    reviewed: { overview: generated.summary.overview }, original: { overview: "ORIGINAL SUMMARY PRESERVED" },
    provenance: { authorship: "model", humanReviewedInput: true, humanNotesUsed: false, acousticLabelsUsed: false, provider } });
  expect(markdown.display).toContain("FRESH MODEL SUMMARY OF REVIEWED TEXT");
  expect(markdown.display).toContain('"authorship": "model"');
  expect(markdown.display).toContain('"humanReviewedInput": true');
  expect(markdown.display).toContain("ORIGINAL SUMMARY PRESERVED");
  const input = { format: "json" as const, track: "transcript" as const, expectedRevision: json.revision,
    expectedBase: json.base, expectedSnapshotSha256: json.snapshotSha256! };
  const saved = await saveExport(f.job, input);
  const savedHash = await hashFile(saved.path), exportsBefore = await fs.readdir(exportRoot());
  expect(JSON.parse(await fs.readFile(saved.path, "utf8")).summary.provenance.authorship).toBe("model");
  await f.revise("A later revision invalidates the model summary.");
  expect(await readReviewedSummary(f.job)).toBeUndefined();
  const stale = JSON.parse((await previewExport(f.job, { format: "json", track: "transcript" })).display);
  expect(stale.summary.state).toBe("stale"); expect(stale.summary.reviewed).toBeUndefined(); expect(stale.summary.provenance).toBeUndefined();
  await expect(saveExport(f.job, input)).rejects.toBeInstanceOf(RevisionConflictError);
  expect(await hashFile(saved.path)).toBe(savedHash);
  expect(await fs.readdir(exportRoot())).toEqual(exportsBefore);
  expect(await f.hashes()).toEqual(before);
}));

test("Studio summary presentation rejects a newly available or replaced model result at the same human revision", async () => fixture(async f => {
  const before = await f.hashes();
  await f.revise("Human revision shared by both synthetic model results.");
  await assertCurrentSummaryPresentation(f.job, undefined);
  const generate = async (requestId: string, identity: ReviewedSummaryProvider, overview: string) => {
    const plan = await planReviewedSummary(f.job, { requestId, config: f.config, provider: identity, maxRequests: 1 });
    return regenerateReviewedSummary(f.job, { requestId, config: f.config, consent: true, consentKey: plan.consentKey,
      adapter: { identity, summarize: async () => modelSummary(overview) } });
  };
  const first = await generate("presentation-first", provider, "FIRST SYNTHETIC MODEL RESULT");
  await assertCurrentSummaryPresentation(f.job, first);
  await expect(assertCurrentSummaryPresentation(f.job, undefined)).rejects.toBeInstanceOf(RevisionConflictError);
  const firstHash = await hashFile(first.path);
  // A distinct injected adapter identity deliberately avoids a prior input cache.
  const second = await generate("presentation-second", { ...provider, adapterIdentity: "compat-injected-adapter-v2" }, "SECOND SYNTHETIC MODEL RESULT");
  expect(second.revision).toEqual(first.revision);
  expect(second.raw).not.toBe(first.raw);
  expect(second.summary.overview).toBe("SECOND SYNTHETIC MODEL RESULT");
  await expect(assertCurrentSummaryPresentation(f.job, first)).rejects.toBeInstanceOf(RevisionConflictError);
  await assertCurrentSummaryPresentation(f.job, second);
  expect(await hashFile(first.path)).toBe(firstHash);
  expect(await f.hashes()).toEqual(before);
}));

test("a classifier failure after human review preserves the prior time entry instead of marking it failed", async () => fixture(async f => {
  const config = structuredClone(f.config);
  config.timesheet.enabled = true;
  config.timesheet.aiClassification = false;
  config.timesheet.contextPath = join(f.root, "synthetic-empty-timesheet-context.json");
  await fs.writeFile(config.timesheet.contextPath, JSON.stringify({ version: 1, colleagues: [], clients: [], taskTypes: [] }), { mode: 0o600 });
  const store = new TimeEntryStore(join(f.root, "timesheet"));
  const entry = await store.create({ source: { kind: "manual", jobId: f.job.id, recordingPath: f.source },
    hours: 0.5, status: "draft", classificationStatus: "completed", description: "PRIOR CLASSIFICATION PRESERVED" });
  const entryPath = join(store.stateDir, `${entry.id}.json`), statusPath = getTimeEntryStatusPath(store.stateDir);
  const beforeEntry = await fs.readFile(entryPath, "utf8"), beforeStatus = await hashFile(statusPath), before = await f.hashes();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const classify = spyOn(classification, "classifyTimeEntry").mockImplementation(async () => {
    enter(); await gate; throw Error("synthetic pending classifier failure");
  });
  const replace = spyOn(store, "replace");
  const pending = reconcileTimeEntryForJob(config, f.job, store, { force: true, notify: false });
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  const timer = setTimeout(release, 2000);
  try {
    await Promise.race([entered, outcome.then(() => { throw Error("Classifier did not reach the injected pending stub"); })]);
    await f.revise("Human review saved before the classifier failure.");
    release();
    expect((await outcome).error).toBeInstanceOf(RevisionConflictError);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(await fs.readFile(entryPath, "utf8")).toBe(beforeEntry);
    expect(await hashFile(statusPath)).toBe(beforeStatus);
    expect((await store.get(entry.id)).classificationStatus).toBe("completed");
    expect(await f.hashes()).toEqual(before);
  } finally {
    clearTimeout(timer); release(); await outcome;
    classify.mockRestore(); replace.mockRestore();
  }
}));

test("human review saved by the first synthetic summary response blocks all later pipeline chunks and publication", async () => fixture(async f => {
  const config = structuredClone(f.config);
  config.summary.maxInputCharacters = 4096;
  const segments = Array.from({ length: 3 }, (_, index) => ({ start: index * 2, end: index * 2 + 2,
    text: `Synthetic chunk ${index}: ` + "bounded synthetic content ".repeat(60) }));
  const transcript: Transcript = { ...f.transcript, text: segments.map(segment => segment.text).join("\n"), segments };
  await fs.writeFile(f.originals[1]!, JSON.stringify(transcript), { mode: 0o600 });
  await fs.writeFile(f.originals[3]!, formatTranscriptMarkdown(transcript), { mode: 0o600 });
  const chunks = planSummaryChunks(transcript, f.job.source.sha256, undefined, config.summary.maxInputCharacters);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks.length).toBeLessThanOrEqual(8);
  const before = await f.hashes();
  const summary = spyOn(ollama, "summarizeWithOllama").mockImplementation(async (_config, _text, _model, _context, evidence) => {
    await f.revise("Human review saved during the first synthetic summary response.");
    return { ...modelSummary("FIRST CHUNK ONLY; MUST NEVER BE PUBLISHED"),
      citations: [{ section: "overview", index: 0, segmentIds: [evidence!.segments[0]!.id], uncertainty: "clear" }] };
  });
  const probe = spyOn(media, "probeMedia").mockImplementation(async () => { throw Error("unexpected media probe"); });
  try {
    await expect(processJob(config, f.store.toManifest(f.job), f.source, f.job.artifactDir)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect((await readReviewedView(f.job)).revision.revision).toBe(1);
    expect(await f.hashes()).toEqual(before);
    expect(await fs.readFile(f.originals[2]!, "utf8")).not.toContain("FIRST CHUNK ONLY");
    expect(await fs.readdir(join(f.job.artifactDir, ".summary-chunks"))).toHaveLength(1);
  } finally { summary.mockRestore(); probe.mockRestore(); }
}));

test("remote status read that saves human review stops queue lookup, requeue and transfer before remote commands", async () => fixture(async f => {
  const pending = { ...await f.store.update(f.job.id, "pending"), target: "remote" as const };
  await fs.writeFile(join(f.store.stateDir, `${pending.id}.json`), JSON.stringify(pending), { mode: 0o600 });
  const receiptPath = join(pending.artifactDir, "transcript-receipt.json");
  await fs.writeFile(receiptPath, JSON.stringify({ version: 1, identity: transcriptionIdentity(pending),
    transcriptSha256: await hashFile(f.originals[1]!) }), { mode: 0o600 });
  f.originals.push(receiptPath);
  const before = await f.hashes();
  const status = spyOn(remote, "readRemoteStatus").mockImplementation(async () => {
    const view = await readReviewedView(pending);
    await saveRevision(pending, { expectedRevision: view.revision.revision, base: view.revision.base,
      operations: [{ kind: "segment-text", segmentId: "s000000", text: "Human review saved during the remote status read." }] });
    return null;
  });
  const queued = spyOn(remote, "remoteJobIsQueued").mockImplementation(async () => { throw Error("unexpected remote queue lookup"); });
  const requeue = spyOn(remote, "requeueRemoteFailedJob").mockImplementation(async () => { throw Error("unexpected remote requeue"); });
  const transfer = spyOn(remote, "transferJob").mockImplementation(async () => { throw Error("unexpected remote transfer"); });
  const invoke = spyOn(command, "runCommand").mockImplementation(async () => { throw Error("unexpected external command"); });
  try {
    const result = await syncJob(f.config, f.store, pending.id);
    expect(status).toHaveBeenCalledTimes(1);
    expect(queued).not.toHaveBeenCalled();
    expect(requeue).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(result.state).toBe("pending");
    expect(result.error).toContain("Human review changed during remote status read");
    expect((await readReviewedView(pending)).revision.revision).toBe(1);
    expect(await f.hashes()).toEqual(before);
  } finally { status.mockRestore(); queued.mockRestore(); requeue.mockRestore(); transfer.mockRestore(); invoke.mockRestore(); }
}));
