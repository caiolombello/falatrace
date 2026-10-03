import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JobStore } from "../../jobs/store";
import { type JobRecord, validateSummary } from "../../jobs/types";
import { cleanupLocalCompletedWork, planLocalRetention, retentionTotal } from "../../jobs/retention";
import { canonicalJson } from "../../export/snapshot";
import { attachSummarySupport, buildSummaryEvidence, summaryTranscriptEvidenceSha256 } from "../../summary/evidence";
import { planSummaryChunks } from "../../summary/chunks";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "../../summary/schema";
import { buildRemovalPlan, validateRemovalPlan, REMOVAL_LIMITS, type RemovalRequest, type RemovalRoots } from "../removal-plan";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const jsonHash = (value: unknown): string => hash(JSON.stringify(value));
const write = async (path: string, value: unknown): Promise<void> => { await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); };
const treeHashes = async (path: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => { for (const name of (await fs.readdir(directory)).sort()) { const child = join(directory, name), stat = await fs.lstat(child); if (stat.isSymbolicLink()) result[child] = `link:${await fs.readlink(child)}`; else if (stat.isDirectory()) await visit(child); else if (stat.isFile()) result[child] = hash(await fs.readFile(child, "utf8")); } };
  await visit(path); return result;
};

async function fixture(action: (value: { root: string; roots: RemovalRoots; request: RemovalRequest; store: JobStore; base: { jobId: string; mediaSha256: string; transcriptArtifactSha256: string }; revisionPath: string; summaryPlanPath: string; summaryResultPath: string; summaryIndexPath: string; exportDir: string; remoteSentinel: string }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), "compat-lifecycle-"));
  const roots: RemovalRoots = { recordings: join(root, "recordings"), jobState: join(root, "state/jobs"), jobWork: join(root, "data/jobs"), revisions: join(root, "data/revisions"), derivedSummaries: join(root, "data/reviewed-summaries"), exports: join(root, "data/exports") };
  try {
    for (const path of Object.values(roots)) await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const transcript = JSON.stringify({ version: 1, provider: "whisper-cpp", model: "synthetic", language: "pt", text: "Texto sintético", segments: [{ start: 0, end: 1, text: "Texto sintético" }] });
    const job: JobRecord = { version: 1, id, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", state: "completed", target: "local", sourcePath: join(roots.recordings, "synthetic.mkv"), artifactDir: join(roots.recordings, "synthetic.recording", id), source: { originalName: "synthetic.mkv", mediaFile: "source.mkv", size: 5, sha256: hash("media") }, transcription: { provider: "whisper-cpp", model: "synthetic", language: "pt" }, summary: { provider: "openai", model: "synthetic-offline" } };
    await write(job.sourcePath, "media"); await write(join(job.artifactDir, "transcript.json"), transcript); await write(join(job.artifactDir, "summary.json"), "original-summary-must-stay");
    await write(join(roots.jobState, `${id}.json`), job); await write(join(roots.jobWork, id, "source.mkv"), "media"); await write(join(roots.jobWork, id, "transcript.json"), transcript);
    const base = { jobId: id, mediaSha256: job.source.sha256, transcriptArtifactSha256: hash(transcript) }, revision = { version: 1, revision: 1, base };
    const revisionPath = join(roots.revisions, `${id}.json`);
    await write(revisionPath, { version: 1, base, history: [{ revision: 1, action: "edit", base, createdAt: "2026-10-03T00:00:00.000Z", operations: [], overlay: { segmentTexts: {}, segmentSpeakers: {}, speakerLabels: {}, turnSpeakers: {}, notes: [] } }] });
    const sourceIdentity = jsonHash({ id: job.id, source: job.source, sourcePath: job.sourcePath, artifactDir: job.artifactDir, target: job.target, transcription: job.transcription, summary: job.summary });
    const snapshot = { revision, sourceIdentity, transcript: JSON.parse(transcript), transcriptSha256: summaryTranscriptEvidenceSha256(JSON.parse(transcript)), original: { path: join(job.artifactDir, "transcript.json"), origin: "published", receipt: "legacy-unverified" }, human: { reviewed: true, notes: [], segments: [] } };
    const provider = { provider: "openai", model: "synthetic-offline", adapterIdentity: "synthetic-no-provider" };
    const fields = { version: 1, jobId: id, requestId: "synthetic-1", createdAt: "2026-10-03T00:00:00.000Z", snapshot, snapshotSha256: jsonHash(snapshot), provider, maxCharacters: 16000, maxRequests: 1, chunkCount: planSummaryChunks(snapshot.transcript, job.source.sha256, undefined, 16000).length, inputIdentity: jsonHash({ snapshotSha256: jsonHash(snapshot), provider, maxCharacters: 16000, maxRequests: 1, prompt: SUMMARY_SYSTEM_PROMPT, schema: SUMMARY_JSON_SCHEMA }), requiresConsent: true, inputScope: "reviewed-transcript-only" };
    const summaryPlan = { ...fields, consentKey: jsonHash(fields) };
    const summary = attachSummarySupport(validateSummary({ title: "Sintético", overview: "Resumo sintético", topics: [], decisions: [], actionItems: [] }, "openai", "synthetic-offline"), buildSummaryEvidence(snapshot.transcript, job.source.sha256));
    summary.support!.reviewRequired = true;
    const result = { version: 1, jobId: id, requestId: "synthetic-1", generatedAt: "2026-10-03T00:00:00.000Z", revision, snapshotSha256: summaryPlan.snapshotSha256, transcriptSha256: snapshot.transcriptSha256, summary, summarySha256: jsonHash(summary), provenance: { authorship: "model", inputScope: "reviewed-transcript-only", provider, humanReviewedInput: true, humanNotesUsed: false, acousticLabelsUsed: false, originalTranscriptReceipt: "legacy-unverified" } };
    const summaryPlanPath = join(roots.derivedSummaries, id, "plans/synthetic-1.json"), summaryResultPath = join(roots.derivedSummaries, id, "results/synthetic-1.json"), summaryIndexPath = join(roots.derivedSummaries, id, "index.json");
    await write(summaryPlanPath, { kind: "falatrace-reviewed-summary-plan", plan: summaryPlan, sha256: jsonHash(summaryPlan) }); await write(summaryResultPath, result);
    await write(summaryIndexPath, { version: 1, jobId: id, sequence: 1, requests: [{ requestId: "synthetic-1", planSha256: jsonHash(summaryPlan), status: "completed", requestsSpent: 1, resultSha256: jsonHash(result), sequence: 1 }] });
    await write(join(roots.derivedSummaries, id, "cache", `${"c".repeat(64)}.json`), { version: 1, key: "c".repeat(64), snapshotSha256: summaryPlan.snapshotSha256, summary });
    const exportSnapshot = canonicalJson({ version: 1, jobId: id, revision }), content = "synthetic-export\n", snapshotSha256 = hash(exportSnapshot), sha256 = hash(content);
    const exportDir = join(roots.exports, hash(canonicalJson({ version: 1, format: "markdown", snapshotSha256, sha256 })));
    await write(join(exportDir, "snapshot.json"), exportSnapshot); await write(join(exportDir, "export.md"), content); await write(join(exportDir, "manifest.json"), { version: 1, jobId: id, revision, format: "markdown", snapshotSha256, sha256, bytes: Buffer.byteLength(content), contentFile: "export.md", snapshotFile: "snapshot.json" });
    const remoteSentinel = join(root, "remote-incoming/synthetic-original.mkv"); await write(remoteSentinel, "remote-not-contacted");
    await action({ root, roots, request: { job, roots, reason: "manual" }, store: new JobStore(roots.jobState, roots.jobWork), base, revisionPath, summaryPlanPath, summaryResultPath, summaryIndexPath, exportDir, remoteSentinel });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("dry-run plans owned revision, summary chain and hashed export while every synthetic file remains unchanged", async () => fixture(async f => {
  await write(join(f.roots.revisions, "unknown.json"), "unknown-private-data");
  const before = await treeHashes(f.root), plan = await buildRemovalPlan(f.request);
  expect(plan.mode).toBe("dry-run"); expect(plan.executable).toBe(false); expect(plan.hasSnapshotReferences).toBe(true);
  expect(plan.candidates.filter(item => item.kind === "revision")).toHaveLength(1);
  expect(plan.candidates.filter(item => item.kind === "derived-summary")).toHaveLength(3);
  expect(plan.candidates.filter(item => item.kind === "managed-export")).toHaveLength(3);
  expect(plan.preserved.some(item => item.path.includes("cache"))).toBe(true); expect(plan.preserved.some(item => item.path.endsWith("unknown.json"))).toBe(true);
  expect(plan.scope.remoteCopies).toBe("preserved-not-contacted"); expect(plan.inventory.some(item => item.path.includes("remote-incoming"))).toBe(false);
  await validateRemovalPlan(plan, f.request); expect(await treeHashes(f.root)).toEqual(before);
}));

test("cross-job and hash-mismatched sidecars are explicitly preserved", async () => fixture(async f => {
  const journal = JSON.parse(await fs.readFile(f.revisionPath, "utf8")); journal.base.jobId = other; journal.history[0].base.jobId = other; await write(f.revisionPath, journal);
  const result = JSON.parse(await fs.readFile(f.summaryResultPath, "utf8")); result.jobId = other; await write(f.summaryResultPath, result);
  await write(join(f.exportDir, "export.md"), "changed-without-matching-manifest");
  const before = await treeHashes(f.root), plan = await buildRemovalPlan(f.request);
  expect(plan.candidates.some(item => item.path === f.revisionPath || item.path === f.summaryResultPath || item.kind === "managed-export")).toBe(false);
  for (const path of [f.revisionPath, f.summaryResultPath, join(f.exportDir, "export.md")]) expect(plan.preserved.some(item => item.path === path)).toBe(true);
  expect(await treeHashes(f.root)).toEqual(before);
}));

test("symlink files and ancestors are never followed, even when the target resembles an owned sidecar", async () => fixture(async f => {
  const sentinel = join(f.root, "outside/private.json"); await write(sentinel, "outside-secret-synthetic");
  await fs.symlink(sentinel, join(f.roots.revisions, "link.json"));
  const linkParent = join(f.root, "linked-parent"); await fs.symlink(join(f.root, "outside"), linkParent);
  const request = { ...f.request, roots: { ...f.roots, derivedSummaries: join(linkParent, "reviewed-summaries") } };
  const before = await treeHashes(f.root), plan = await buildRemovalPlan(request);
  expect(plan.inventory.some(item => item.kind === "symlink")).toBe(true); expect(plan.inventory.some(item => item.kind === "unsafe-ancestor")).toBe(true);
  expect(plan.inventory.some(item => item.sha256 === hash("outside-secret-synthetic"))).toBe(false); expect(await treeHashes(f.root)).toEqual(before);
}));

test("retention zero and active jobs have no sidecar candidates", async () => fixture(async f => {
  const before = await treeHashes(f.root), now = Date.parse("2026-10-03T00:00:00.000Z");
  const zero = await buildRemovalPlan({ ...f.request, reason: "retention", retentionDays: 0, now }); expect(zero.candidates).toEqual([]); expect(zero.retention.reason).toBe("zero disables retention");
  const activeJob = { ...f.request.job, state: "processing" as const }; await write(join(f.roots.jobState, `${id}.json`), activeJob);
  const active = await buildRemovalPlan({ ...f.request, job: activeJob }); expect(active.candidates).toEqual([]); expect(active.retention.eligible).toBe(false);
  await write(join(f.roots.jobState, `${id}.json`), f.request.job);
  const report = await planLocalRetention(f.store, 0, { roots: f.roots, now }); expect(report.eligibleLocalWork).toBe(0); expect(report.protectedLocalWork).toBe(0); expect(await treeHashes(f.root)).toEqual(before);
}));

for (const changed of ["revision", "new-summary", "new-export", "job-state", "root-boundary"] as const) test(`snapshot CAS rejects ${changed} drift without expanding or executing the old plan`, async () => fixture(async f => {
  const plan = await buildRemovalPlan(f.request), paths = plan.candidates.map(item => item.path);
  let request = f.request;
  if (changed === "revision") { const journal = JSON.parse(await fs.readFile(f.revisionPath, "utf8")); journal.history.push({ ...journal.history[0], revision: 2 }); await write(f.revisionPath, journal); }
  if (changed === "new-summary") await write(join(f.roots.derivedSummaries, id, "plans/concurrent.json"), "new-synthetic-summary-plan");
  if (changed === "new-export") await write(join(f.roots.exports, "d".repeat(64), "manifest.json"), { version: 1, jobId: id });
  if (changed === "job-state") request = { ...f.request, job: { ...f.request.job, updatedAt: "2026-10-03T01:00:00.000Z" } };
  if (changed === "root-boundary") request = { ...f.request, roots: { ...f.roots, exports: join(f.root, "different-exports") } };
  const afterIntentionalChange = await treeHashes(f.root);
  await expect(validateRemovalPlan(plan, request)).rejects.toMatchObject({ code: "REMOVAL_PLAN_STALE" }); expect(plan.candidates.map(item => item.path)).toEqual(paths); expect(await treeHashes(f.root)).toEqual(afterIntentionalChange);
}));

test("CAS rejects a modified plan and path expansion, unknown nested data remains preserved", async () => fixture(async f => {
  await write(join(f.roots.derivedSummaries, id, "unknown/nested/original.bin"), "unknown-original");
  const plan = await buildRemovalPlan(f.request); expect(plan.preserved.some(item => item.path.includes("unknown"))).toBe(true);
  const forged = structuredClone(plan); forged.candidates.push({ root: "recordings", path: f.request.job.sourcePath, kind: "original", reason: "forged" });
  await expect(validateRemovalPlan(forged, f.request)).rejects.toMatchObject({ code: "REMOVAL_PLAN_STALE" });
  await expect(buildRemovalPlan({ ...f.request, roots: { ...f.roots, exports: "~/exports" } })).rejects.toThrow("absolute");
  await expect(buildRemovalPlan({ ...f.request, roots: { ...f.roots, exports: f.roots.derivedSummaries } })).rejects.toThrow("disjoint");
  await expect(buildRemovalPlan({ ...f.request, job: { ...f.request.job, artifactDir: join(f.roots.recordings, "wrong.recording", id) } })).rejects.toThrow("do not belong");
}));

test("legacy work retention protects a sole base and new sidecars; remote hashes remain unchanged", async () => fixture(async f => {
  const before = await treeHashes(f.root), now = Date.parse("2026-10-03T00:00:00.000Z");
  const preview = await cleanupLocalCompletedWork(f.store, 7, { removalRoots: f.roots, now, dryRun: true }); expect(preview.localCompletedWork).toBe(0); expect(preview.protectedLocalCompletedWork).toBe(1); expect(retentionTotal(preview)).toBe(0);
  // The non-dry-run legacy path must also skip referenced work; no deletion occurs.
  const actual = await cleanupLocalCompletedWork(f.store, 7, { removalRoots: f.roots, now }); expect(actual.localCompletedWork).toBe(0); expect(actual.protectedLocalCompletedWork).toBe(1);
  const planning = await planLocalRetention(f.store, 7, { roots: f.roots, now }); expect(planning.protectedLocalWork).toBe(1); expect(planning.eligibleLocalWork).toBe(0);
  expect(await treeHashes(f.root)).toEqual(before); expect(await fs.readFile(f.remoteSentinel, "utf8")).toBe("remote-not-contacted");
}));

test("in-flight reviewed summary requests preserve all candidates; oversized and nonprivate data stays explicit", async () => fixture(async f => {
  const index = JSON.parse(await fs.readFile(f.summaryIndexPath, "utf8")); index.requests[0].status = "running"; delete index.requests[0].resultSha256; delete index.requests[0].sequence; await write(f.summaryIndexPath, index);
  await fs.chmod(f.revisionPath, 0o644);
  const large = join(f.roots.revisions, "oversized.bin"), handle = await fs.open(large, "wx", 0o600); try { await handle.truncate(REMOVAL_LIMITS.fileBytes + 1); } finally { await handle.close(); }
  const plan = await buildRemovalPlan(f.request); expect(plan.candidates).toEqual([]); expect(plan.retention.eligible).toBe(false); expect(plan.preserved.some(item => item.path === large)).toBe(true); expect(plan.inventory.find(item => item.path === large)?.problem).toBe("oversized content preserved");
}));

test("a stale job lookup or changed original media cannot authorize sidecar candidates", async () => fixture(async f => {
  await write(f.request.job.sourcePath, "changed-original");
  const plan = await buildRemovalPlan(f.request); expect(plan.candidates).toEqual([]); expect(plan.preserved.some(item => item.reason.includes("media identity"))).toBe(true);
  const before = await treeHashes(f.root);
  await expect(buildRemovalPlan({ ...f.request, job: { ...f.request.job, updatedAt: "2026-10-04T00:00:00.000Z" } })).rejects.toMatchObject({ code: "REMOVAL_PLAN_STALE" });
  expect(await treeHashes(f.root)).toEqual(before);
}));

test("unsafe snapshot roots and in-flight exports protect work without traversing unrelated data", async () => fixture(async f => {
  const outside = join(f.root, "outside-root"); await fs.mkdir(outside, { mode: 0o700 }); await write(join(outside, "private.json"), "private-synthetic");
  const unsafeRoot = join(f.root, "unsafe-exports"); await fs.symlink(outside, unsafeRoot);
  const roots = { ...f.roots, exports: unsafeRoot }, before = await treeHashes(f.root);
  const plan = await buildRemovalPlan({ ...f.request, roots }); expect(plan.hasSnapshotReferences).toBe(true); expect(plan.inventory.some(item => item.path === join(unsafeRoot, "private.json"))).toBe(false);
  const report = await cleanupLocalCompletedWork(f.store, 7, { removalRoots: roots, now: Date.parse("2026-10-03T00:00:00.000Z") }); expect(report.protectedLocalCompletedWork).toBe(1); expect(report.localCompletedWork).toBe(0); expect(await treeHashes(f.root)).toEqual(before);
}));

test("a concealed export child alone protects work, even without revision or summary references", async () => fixture(async f => {
  // Clear only fixture-owned sidecars to isolate the export-child gate.
  await fs.rm(f.revisionPath); await fs.rm(join(f.roots.derivedSummaries, id), { recursive: true }); await fs.rm(f.exportDir, { recursive: true });
  const outside = join(f.root, "outside-bundle"); await write(join(outside, "snapshot.json"), { version: 1, jobId: id, revision: { version: 1, revision: 0, base: f.base } });
  await fs.symlink(outside, join(f.roots.exports, "a".repeat(64)));
  const before = await treeHashes(f.root), plan = await buildRemovalPlan(f.request); expect(plan.hasSnapshotReferences).toBe(true); expect(plan.localWorkProtection.canPruneLegacyWork).toBe(false);
  const report = await cleanupLocalCompletedWork(f.store, 7, { removalRoots: f.roots, now: Date.parse("2026-10-03T00:00:00.000Z") }); expect(report.localCompletedWork).toBe(0); expect(report.protectedLocalCompletedWork).toBe(1); expect(await treeHashes(f.root)).toEqual(before);
}));

test("a symlink work-root ancestor alone blocks legacy pruning, and missing work is never counted eligible", async () => fixture(async f => {
  await fs.rm(f.revisionPath); await fs.rm(join(f.roots.derivedSummaries, id), { recursive: true }); await fs.rm(f.exportDir, { recursive: true });
  const outside = join(f.root, "outside-work"); await fs.mkdir(outside, { mode: 0o700 }); await fs.rename(join(f.roots.jobWork, id), join(outside, id));
  const workLink = join(f.root, "work-link"); await fs.symlink(outside, workLink);
  const roots = { ...f.roots, jobWork: workLink }, store = new JobStore(f.roots.jobState, workLink), before = await treeHashes(f.root);
  const plan = await buildRemovalPlan({ ...f.request, roots }); expect(plan.hasSnapshotReferences).toBe(false); expect(plan.localWorkProtection.canPruneLegacyWork).toBe(false);
  const report = await cleanupLocalCompletedWork(store, 7, { removalRoots: roots, now: Date.parse("2026-10-03T00:00:00.000Z") }); expect(report.localCompletedWork).toBe(0); expect(report.protectedLocalCompletedWork).toBe(1); expect(await treeHashes(f.root)).toEqual(before);
  const absent = await planLocalRetention(f.store, 7, { roots: f.roots, now: Date.parse("2026-10-03T00:00:00.000Z") }); expect(absent.eligibleLocalWork).toBe(0); expect(absent.protectedLocalWork).toBe(0);
}));

test("partial jobs select the receipt-verified work transcript and preserve missing or mismatched receipts", async () => fixture(async f => {
  await fs.rm(join(f.request.job.artifactDir, "transcript.json"));
  const job = { ...f.request.job, state: "failed" as const }; await write(join(f.roots.jobState, `${id}.json`), job);
  const request = { ...f.request, job }, workReceipt = join(f.roots.jobWork, id, "transcript-receipt.json");
  expect((await buildRemovalPlan(request)).candidates).toEqual([]);
  await write(workReceipt, { version: 1, identity: jsonHash({ media: job.source.sha256, transcription: job.transcription }), transcriptSha256: f.base.transcriptArtifactSha256 });
  const plan = await buildRemovalPlan(request); expect(plan.job.transcriptArtifactSha256).toBe(f.base.transcriptArtifactSha256); expect(plan.candidates.some(item => item.kind === "revision")).toBe(true);
  await write(workReceipt, { version: 1, identity: "b".repeat(64), transcriptSha256: f.base.transcriptArtifactSha256 }); expect((await buildRemovalPlan(request)).candidates).toEqual([]);
}));

for (const bad of ["nonprivate-index", "sequence", "result-transcript", "plan-consent", "journal-schema"] as const) test(`unverifiable ${bad} stays preserved instead of receiving a candidate`, async () => fixture(async f => {
  if (bad === "nonprivate-index") await fs.chmod(f.summaryIndexPath, 0o644);
  if (bad === "sequence") { const index = JSON.parse(await fs.readFile(f.summaryIndexPath, "utf8")); index.requests[0].sequence = 2; await write(f.summaryIndexPath, index); }
  if (bad === "result-transcript") { const result = JSON.parse(await fs.readFile(f.summaryResultPath, "utf8")), index = JSON.parse(await fs.readFile(f.summaryIndexPath, "utf8")); result.transcriptSha256 = "b".repeat(64); index.requests[0].resultSha256 = jsonHash(result); await write(f.summaryResultPath, result); await write(f.summaryIndexPath, index); }
  if (bad === "plan-consent") { const envelope = JSON.parse(await fs.readFile(f.summaryPlanPath, "utf8")), index = JSON.parse(await fs.readFile(f.summaryIndexPath, "utf8")); envelope.plan.consentKey = "b".repeat(64); envelope.sha256 = jsonHash(envelope.plan); index.requests[0].planSha256 = envelope.sha256; await write(f.summaryPlanPath, envelope); await write(f.summaryIndexPath, index); }
  if (bad === "journal-schema") { const journal = JSON.parse(await fs.readFile(f.revisionPath, "utf8")); journal.history[0].action = "unknown"; await write(f.revisionPath, journal); }
  const before = await treeHashes(f.root), plan = await buildRemovalPlan(f.request); expect(plan.candidates.some(item => item.kind === (bad === "journal-schema" ? "revision" : "derived-summary"))).toBe(false); expect(await treeHashes(f.root)).toEqual(before);
}));
