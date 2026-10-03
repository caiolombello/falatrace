import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore, hashFile } from "../../jobs/store";
import { DiarizationStore, transcriptChecksum } from "../../diarization/store";
import { aiContextRoot, assertFreshAiContext, readContextInvalidation, withContextPublicationLease } from "../../knowledge/invalidation";
import { buildAiContextFiles, readClientAiContext } from "../../knowledge/context";
import { readReviewedView, saveRevision, undoRevision, REVISION_LIMITS, RevisionConflictError } from "../index";
import type { JobRecord } from "../../jobs/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const fixture = async (options: { diarization?: boolean; unmapped?: boolean } = {}) => {
  const root = await fs.mkdtemp(join(tmpdir(), "g5-revision-")); roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = root; config.timesheet.contextPath = join(root, "no-context.json"); config.processing.defaultTarget = "local";
  config.transcription.provider = "whisper-cpp";
  const media = join(root, "synthetic.wav"); await fs.writeFile(media, "SYNTHETIC FIXTURE, NOT A RECORDING");
  const jobs = new JobStore(); const created = await jobs.enqueue(config, media); const job = await jobs.update(created.id, "completed");
  const text = " Primeiro trecho.\nSegundo trecho! ";
  await fs.mkdir(job.artifactDir, { recursive: true });
  const transcriptPath = join(job.artifactDir, "transcript.json");
  await fs.writeFile(transcriptPath, JSON.stringify({ version: 1, provider: job.transcription.provider, model: job.transcription.model, language: job.transcription.language, text,
    segments: [{ start: 1, end: 3, text: options.unmapped ? "Ausente do texto original" : "Primeiro trecho." }, { start: 3, end: 5, text: "Segundo trecho!" }],
    words: [{ start: 1, end: 2, text: "Primeiro" }] }));
  const summaryPath = join(job.artifactDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify({ version: 1, provider: job.summary.provider, model: job.summary.model, title: "Resumo sintético original", overview: "Resumo sintético anterior", topics: [], decisions: [], actionItems: [] }));
  const addDiarization = async () => {
    const store = new DiarizationStore();
    await store.save({ version: 1, jobId: job.id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(text), provider: "openai", model: "gpt-4o-transcribe-diarize", duration: 5, generatedAt: "2026-10-03T00:00:00Z", labels: { S01: "Falante 1", S02: "Falante 2" }, acousticValidation: "pending",
      turns: [{ start: 1, end: 3, text: "Primeiro trecho.", speaker: "S01" }, { start: 3, end: 5, text: "Segundo trecho!", speaker: "S02" }],
      alignment: { text, matchedTokenRatio: 0, unassignedTokenCount: 4, segments: [{ start: 0, end: 5, text, charStart: 0, charEnd: text.length, reviewRequired: true }] } });
    return store.resultPath(job.id);
  };
  const diarizationPath = options.diarization === false ? undefined : await addDiarization();
  const path = join(process.env.XDG_DATA_HOME!, "recording-cli/revisions", `${job.id}.json`);
  return { root, config, job, jobs, media, transcriptPath, summaryPath, diarizationPath, addDiarization, path, text };
};

test("human overlay preserves exact original evidence, IDs, intervals and acoustic uncertainty", async () => {
  const f = await fixture(); const original = await readReviewedView(f.job);
  const paths = [f.media, f.transcriptPath, f.summaryPath, f.diarizationPath!];
  const before = await Promise.all(paths.map(hashFile));
  const head = await saveRevision(f.job, { expectedRevision: 0, base: original.revision.base, operations: [
    { kind: "segment-text", segmentId: "s000000", text: "Primeiro trecho revisado." },
    { kind: "speaker-label", speakerId: "S01", label: "Rótulo humano" },
    { kind: "segment-speaker", segmentId: "s000000", speakerId: "S01" },
    { kind: "turn-speaker", turnId: "t000001", speakerId: "S01" },
    { kind: "note", text: "Nota humana sem tempo; não prova identidade." }
  ] });
  const current = await readReviewedView(f.job);
  expect(head.revision).toBe(1); expect(current.canUndo).toBe(true); expect(current.derivedStale).toBe(true);
  expect(current.segments.map(s => s.id)).toEqual(["s000000", "s000001"]);
  expect(current.segments[0]!.canonicalId).toBe(original.segments[0]!.canonicalId);
  expect(current.transcript.text).toBe(" Primeiro trecho revisado.\nSegundo trecho! ");
  expect(current.transcript.words).toBeUndefined(); expect(current.original.transcript.words).toHaveLength(1);
  expect(current.segments.map(s => [s.start, s.end])).toEqual([[1, 3], [3, 5]]);
  expect(current.diarization!.turns[1]).toMatchObject({ id: "t000001", start: 3, end: 5, text: "Segundo trecho!", speaker: "S01", label: "Rótulo humano", humanSpeakerEdited: true });
  expect(current.diarization!.original.acousticValidation).toBe("pending");
  expect(current.diarization!.original.labels.S01).toBe("Falante 1");
  expect(current.notes).toEqual(["Nota humana sem tempo; não prova identidade."]);
  expect(await Promise.all(paths.map(hashFile))).toEqual(before);
  expect((await fs.stat(f.path)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(join(f.path, ".."))).mode & 0o777).toBe(0o700);
});

test("explicit canonical-to-acoustic binding records human evidence for equal speaker codes, replays once and undoes", async () => {
  const f = await fixture();
  const canonical = JSON.parse(await fs.readFile(f.transcriptPath, "utf8"));
  canonical.segments[0].speaker = "S01";
  await fs.writeFile(f.transcriptPath, JSON.stringify(canonical));
  const paths = [f.media, f.transcriptPath, f.summaryPath, f.diarizationPath!];
  const originalHashes = await Promise.all(paths.map(hashFile));
  const initial = await readReviewedView(f.job);
  expect(initial.segments[0]).toMatchObject({ speakerId: "S01", humanSpeakerEdited: false });
  expect(initial.diarization!.turns[0]!.speaker).toBe("S01");
  const operation = { kind: "segment-speaker" as const, segmentId: "s000000", speakerId: "S01" };
  expect((await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [operation] })).revision).toBe(1);
  const assigned = await readReviewedView(f.job);
  expect(assigned.segments[0]).toMatchObject({ speakerId: "S01", humanSpeakerEdited: true });
  expect(assigned.original.transcript.segments[0]!.speaker).toBe("S01");
  expect(assigned.revision.base).toEqual(initial.revision.base);
  expect(assigned.segments[0]!.canonicalId).toBe(initial.segments[0]!.canonicalId);
  expect(assigned.diarization!.original.acousticValidation).toBe("pending");
  const journalHash = await hashFile(f.path);
  expect(JSON.parse(await fs.readFile(f.path, "utf8")).history[0].overlay.segmentSpeakers.s000000).toBe("S01");
  expect((await saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [operation] })).revision).toBe(1);
  expect(await hashFile(f.path)).toBe(journalHash);
  await expect(saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [operation] })).rejects.toBeInstanceOf(RevisionConflictError);
  expect((await undoRevision(f.job, { expectedRevision: 1, base: initial.revision.base })).revision).toBe(2);
  const restored = await readReviewedView(f.job);
  expect(restored.segments[0]).toMatchObject({ speakerId: "S01", humanSpeakerEdited: false });
  expect(restored.revision.base).toEqual(initial.revision.base);
  expect(restored.canUndo).toBe(false);
  expect(await Promise.all(paths.map(hashFile))).toEqual(originalHashes);
});

test("concurrent stale editors conflict and consecutive undo traverses active applies with monotonic heads", async () => {
  const f = await fixture(); const initial = await readReviewedView(f.job);
  const saves = await Promise.allSettled(["A", "B"].map(text => saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text }] })));
  expect(saves.filter(s => s.status === "fulfilled")).toHaveLength(1);
  const failure = saves.find(s => s.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason).toBeInstanceOf(RevisionConflictError);
  const first = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 1, base: first.revision.base, operations: [{ kind: "note", text: "Segundo apply" }] });
  expect((await undoRevision(f.job, { expectedRevision: 2, base: first.revision.base })).revision).toBe(3);
  expect((await readReviewedView(f.job)).notes).toEqual([]);
  expect((await undoRevision(f.job, { expectedRevision: 3, base: first.revision.base })).revision).toBe(4);
  const restored = await readReviewedView(f.job);
  expect(restored.transcript.text).toBe(f.text); expect(restored.canUndo).toBe(false);
  await expect(undoRevision(f.job, { expectedRevision: 4, base: restored.revision.base })).rejects.toThrow("Não há revisão");
  await expect(saveRevision(f.job, { expectedRevision: 0, base: restored.revision.base, operations: [{ kind: "note", text: "Editor antigo" }] })).rejects.toBeInstanceOf(RevisionConflictError);
  const history = JSON.parse(await fs.readFile(f.path, "utf8")).history;
  expect(history.map((e: any) => e.revision)).toEqual([1, 2, 3, 4]);
  expect(history[2].restoresRevision).toBe(1); expect(history[3].restoresRevision).toBe(0);
});

test("unproved text ranges accept only untimed notes; malformed controls and unknown IDs never save", async () => {
  const f = await fixture({ unmapped: true }); const view = await readReviewedView(f.job);
  expect(view.segments[0]!.textRange).toBeUndefined();
  await expect(saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "Inventado" }] })).rejects.toThrow("nota sem tempo");
  for (const label of ["A\u0000B", "A\u0085B", "A\u009fB", "\n", "X".repeat(81)]) {
    await expect(saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "speaker-label", speakerId: "S01", label }] })).rejects.toThrow();
  }
  await expect(saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "turn-speaker", turnId: "t999999", speakerId: "S01" }] })).rejects.toThrow();
  await expect(saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "A\u0085B" }] })).rejects.toThrow();
  await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "Nota\nsem horário" }] });
  expect((await readReviewedView(f.job)).transcript.text).toBe(f.text);
});

test("malformed edit payloads never select undo or change a committed head", async () => {
  const f = await fixture(); const initial = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [{ kind: "note", text: "Preserve committed note" }] });
  const before = await hashFile(f.path);
  for (const payload of [null, false, {}, { expectedRevision: 1, base: initial.revision.base }, ...[undefined, null, false, 0, "", [], {}].map(operations => ({ expectedRevision: 1, base: initial.revision.base, operations })), { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "note", text: "Extra field" }], undo: true }]) {
    await expect(saveRevision(f.job, payload as any)).rejects.toThrow();
    expect(await hashFile(f.path)).toBe(before);
  }
  await expect(undoRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [] } as any)).rejects.toThrow();
  const current = await readReviewedView(f.job); expect(current.revision.revision).toBe(1); expect(current.notes).toEqual(["Preserve committed note"]);
});

test("no-op does not write or invalidate; explicit history cap preserves every committed entry", async () => {
  const f = await fixture(); const view = await readReviewedView(f.job);
  expect((await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "speaker-label", speakerId: "S01", label: "Falante 1" }] })).revision).toBe(0);
  expect(await fs.stat(f.path).catch(() => undefined)).toBeUndefined();
  for (let revision = 0; revision < REVISION_LIMITS.history; revision++) await saveRevision(f.job, { expectedRevision: revision, base: view.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: `Revisão ${revision + 1}` }] });
  const before = await hashFile(f.path);
  expect((await saveRevision(f.job, { expectedRevision: 100, base: view.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "Revisão 100" }] })).revision).toBe(100);
  await expect(saveRevision(f.job, { expectedRevision: 100, base: view.revision.base, operations: [{ kind: "note", text: "Excede histórico" }] })).rejects.toThrow("100 revisões");
  expect(await hashFile(f.path)).toBe(before); expect(JSON.parse(await fs.readFile(f.path, "utf8")).history).toHaveLength(100);
});

test("semantic no-op across reordered keys and failed atomic publication preserve the committed head", async () => {
  const f = await fixture(); const initial = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "A" }, { kind: "segment-text", segmentId: "s000001", text: "B" }] });
  const before = await hashFile(f.path);
  expect((await saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "Primeiro trecho." }, { kind: "segment-text", segmentId: "s000000", text: "A" }] })).revision).toBe(1);
  expect(await hashFile(f.path)).toBe(before);
  const nativeRename = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === f.path) throw new Error("synthetic rename failure");
    return nativeRename(from, to);
  });
  try { await expect(saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "note", text: "Not committed" }] })).rejects.toThrow("synthetic rename failure"); }
  finally { rename.mockRestore(); }
  expect(await hashFile(f.path)).toBe(before); expect((await readReviewedView(f.job)).revision.revision).toBe(1);
  expect((await fs.readdir(join(f.path, ".."))).filter(name => name.includes(f.job.id) && name.endsWith(".tmp"))).toEqual([]);
  expect((await saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "note", text: "Retry committed once" }] })).revision).toBe(2);
});

test("notes and total journal byte budgets reject growth without dropping prior revisions", async () => {
  const f = await fixture(); const initial = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: Array.from({ length: 20 }, (_, index) => ({ kind: "note" as const, text: `${index}:` + "N".repeat(1990) })) });
  await expect(saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "note", text: "21st note" }] })).rejects.toThrow("Overlay");
  let revision = 1; let rejected = false;
  for (; revision < 100; revision++) {
    const before = await hashFile(f.path);
    try { await saveRevision(f.job, { expectedRevision: revision, base: initial.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: `A${revision}` + "X".repeat(9990) }, { kind: "segment-text", segmentId: "s000001", text: `B${revision}` + "Y".repeat(9990) }] }); }
    catch (error) { expect(String(error)).toContain("4 MiB"); expect(await hashFile(f.path)).toBe(before); rejected = true; break; }
  }
  expect(rejected).toBe(true); expect(revision).toBeLessThan(100);
  const journal = JSON.parse(await fs.readFile(f.path, "utf8"));
  expect(journal.history).toHaveLength(revision); expect(journal.history[0].overlay.notes).toHaveLength(20);
  expect((await fs.stat(f.path)).size).toBeLessThanOrEqual(REVISION_LIMITS.jsonBytes);
});

test("canonical drift, unprivate journals and symlinks fail closed without overwriting evidence", async () => {
  const f = await fixture(); const view = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "Preserve" }] });
  const raw = await fs.readFile(f.transcriptPath, "utf8"); await fs.writeFile(f.transcriptPath, raw + "\n");
  await expect(readReviewedView(f.job)).rejects.toBeInstanceOf(RevisionConflictError);
  await fs.writeFile(f.transcriptPath, raw);
  await fs.chmod(f.path, 0o644); await expect(readReviewedView(f.job)).rejects.toThrow("privado"); await fs.chmod(f.path, 0o600);
  const target = join(f.root, "preserve-target.json"); await fs.writeFile(target, "preserve external synthetic fixture");
  const journal = await fs.readFile(f.path); await fs.unlink(f.path); await fs.symlink(target, f.path);
  await expect(readReviewedView(f.job)).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toBe("preserve external synthetic fixture");
  await fs.unlink(f.path); await fs.writeFile(f.path, journal, { mode: 0o600 });
});

test("first acoustic base expansion preserves text/notes but rejects the old editor and any later acoustic rebase", async () => {
  const f = await fixture({ diarization: false }); const initial = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [{ kind: "segment-text", segmentId: "s000000", text: "Revisado antes das vozes" }, { kind: "note", text: "Nota preservada" }] });
  const historyBefore = JSON.parse(await fs.readFile(f.path, "utf8")).history;
  const diarizationPath = await f.addDiarization(); const expanded = await readReviewedView(f.job);
  expect(expanded.transcript.text).toContain("Revisado antes das vozes"); expect(expanded.notes).toEqual(["Nota preservada"]);
  expect(expanded.revision.base.diarizationSha256).toBe(await hashFile(diarizationPath));
  await expect(saveRevision(f.job, { expectedRevision: 1, base: initial.revision.base, operations: [{ kind: "speaker-label", speakerId: "S01", label: "Velho editor" }] })).rejects.toBeInstanceOf(RevisionConflictError);
  await saveRevision(f.job, { expectedRevision: 1, base: expanded.revision.base, operations: [{ kind: "speaker-label", speakerId: "S01", label: "Rótulo revisto" }] });
  const journal = JSON.parse(await fs.readFile(f.path, "utf8"));
  expect(journal.base).toEqual(expanded.revision.base); expect(journal.history[0]).toEqual(historyBefore[0]);
  await fs.writeFile(diarizationPath, (await fs.readFile(diarizationPath, "utf8")) + "\n");
  await expect(readReviewedView(f.job)).rejects.toBeInstanceOf(RevisionConflictError);
});

test("invalidation failure blocks commit and a context publication lease cannot race a revision commit", async () => {
  const f = await fixture(); const view = await readReviewedView(f.job); const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.root, "state");
  try {
    const root = aiContextRoot(), target = join(f.root, "outside-context"); await fs.mkdir(target); await fs.mkdir(join(root, ".."), { recursive: true }); await fs.symlink(target, root);
    await expect(saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "Blocked" }] })).rejects.toThrow("invalidar");
    expect(await fs.stat(f.path).catch(() => undefined)).toBeUndefined(); expect(await fs.readdir(target)).toEqual([]);
    await fs.unlink(root); await fs.mkdir(root, { mode: 0o700 });
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
    const build = withContextPublicationLease(root, async () => { entered(); await gate; await fs.writeFile(join(root, "synthetic.md"), "Older snapshot published first"); });
    await started;
    let committed = false;
    const save = saveRevision(f.job, { expectedRevision: 0, base: view.revision.base, operations: [{ kind: "note", text: "Commit after publication" }] }).then(head => { committed = true; return head; });
    await new Promise(resolve => setTimeout(resolve, 100)); expect(committed).toBe(false);
    release(); await build; await save;
    expect(await readContextInvalidation(root)).toContain("human-revision"); await expect(assertFreshAiContext(root)).rejects.toThrow("invalidado");
  } finally { if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState; }
});

test("compact context refuses saved stale summaries and rechecks invalidation after asynchronous reads", async () => {
  const f = await fixture(); const previousState = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = join(f.root, "state");
  try {
    f.config.timesheet.enabled = true;
    const context = { version: 1, colleagues: [], clients: [{ code: "CL008", name: "Example Vet", aliases: [], responsibleNames: [] }], taskTypes: [] };
    await fs.writeFile(f.config.timesheet.contextPath, JSON.stringify(context));
    const summary = JSON.parse(await fs.readFile(f.summaryPath, "utf8")); summary.overview = "Example Vet resumo original"; await fs.writeFile(f.summaryPath, JSON.stringify(summary));
    await buildAiContextFiles(f.config, { jobStore: f.jobs });
    expect(await readClientAiContext(f.config, "CL008")).toContain("resumo original");
    expect(await readClientAiContext(f.config, "CL008")).toContain("Resumo original legado");
    summary.support = { version: 1, mediaSha256: "0".repeat(64), transcriptSha256: "0".repeat(64), timingQuality: "segment", reviewRequired: true, references: [] };
    await fs.writeFile(f.summaryPath, JSON.stringify(summary));
    expect((await buildAiContextFiles(f.config, { jobStore: f.jobs })).meetingsIncluded).toBe(0);
    delete summary.support; await fs.writeFile(f.summaryPath, JSON.stringify(summary));
    await buildAiContextFiles(f.config, { jobStore: f.jobs });
    const nativeOpen = fs.open.bind(fs); let triggered = false;
    const reader = spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
      if (!triggered && String(args[0]).endsWith("CL008.md")) { triggered = true; await fs.writeFile(join(aiContextRoot(), ".invalidated.json"), JSON.stringify({ token: "after-read-start" })); }
      return (nativeOpen as any)(...args);
    });
    try { await expect(readClientAiContext(f.config, "CL008")).rejects.toThrow("invalidado"); } finally { reader.mockRestore(); }
    await fs.unlink(join(aiContextRoot(), ".invalidated.json"));
    const initial = await readReviewedView(f.job);
    await saveRevision(f.job, { expectedRevision: 0, base: initial.revision.base, operations: [{ kind: "note", text: "Human revision invalidates derived summary" }] });
    await expect(readClientAiContext(f.config, "CL008")).rejects.toThrow("invalidado");
    const rebuilt = await buildAiContextFiles(f.config, { jobStore: f.jobs });
    expect(rebuilt.meetingsIncluded).toBe(0); expect(rebuilt.skippedUnreadable).toBeGreaterThan(0);
    await expect(readClientAiContext(f.config, "CL008")).rejects.toThrow();
    expect(await fs.readFile(f.summaryPath, "utf8")).toContain("resumo original");
  } finally { if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState; }
});
