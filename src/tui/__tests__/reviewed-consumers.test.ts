import "../../../scripts/qa-isolation-guard";
import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore, hashFile } from "../../jobs/store";
import { type JobRecord, type Transcript } from "../../jobs/types";
import { artifactDigest, transcriptionIdentity } from "../../jobs/transcript-access";
import { DiarizationStore, transcriptChecksum } from "../../diarization/store";
import { readReviewedView, saveRevision, RevisionConflictError, withRevisionLease } from "../../revisions";
import { aiContextRoot, withContextPublicationLease } from "../../knowledge/invalidation";
import { readCurrentReviewedView, reviewedTranscriptForDisplay } from "../../revisions/compat";
import { planReviewedSummary, regenerateReviewedSummary, type ReviewedSummaryProvider } from "../../summary/reviewed";
import { attachSummarySupport, buildSummaryEvidence } from "../../summary/evidence";
import { buildAiContextFiles } from "../../knowledge/context";
import { readMeetingContext, searchMeetings } from "../../knowledge/meetings";
import { buildLibrary, getArtifactAvailability, readArtifact, readMeetingTitle, type LibraryEntry } from "../library";
import { playLibraryEntry, selectPlaybackTranscript } from "../media";

const roots: string[] = [];
const jobs: JobRecord[] = [];
afterEach(async () => {
  await Promise.all(jobs.splice(0).map(job => new JobStore().remove(job.id)));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const fixture = async (diarization = false) => {
  const root = await fs.mkdtemp(join(tmpdir(), "compat-consumer-")); roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = root; config.processing.defaultTarget = "local"; config.transcription.provider = "whisper-cpp";
  config.timesheet.contextPath = join(root, "synthetic-context.json");
  await fs.writeFile(config.timesheet.contextPath, JSON.stringify({ version: 1, colleagues: [],
    clients: [{ code: "CL008", name: "Example Vet", aliases: ["example vet"], responsibleNames: [] }], taskTypes: [] }));
  const media = join(root, "synthetic.wav"); await fs.writeFile(media, "SYNTHETIC FIXTURE ONLY");
  const store = new JobStore(); const created = await store.enqueue(config, media);
  const job = await store.update(created.id, "completed"); jobs.push(job);
  await fs.mkdir(job.artifactDir, { recursive: true });
  const transcript: Transcript = { version: 1, provider: job.transcription.provider, model: job.transcription.model,
    language: job.transcription.language, text: "Gap inicial.\nTexto original.\nCauda exata.",
    segments: [{ start: 1, end: 3, text: "Texto original.", speaker: "S01" }] };
  const transcriptPath = join(job.artifactDir, "transcript.json"), markdownPath = join(job.artifactDir, "transcript.md");
  const summaryPath = join(job.artifactDir, "summary.json"), summaryMarkdownPath = join(job.artifactDir, "summary.md");
  await fs.writeFile(transcriptPath, JSON.stringify(transcript));
  await fs.writeFile(markdownPath, "# Markdown original preservado\nTexto original.\n");
  await fs.writeFile(summaryPath, JSON.stringify({ version: 1, provider: job.summary.provider, model: job.summary.model,
    title: "Título antigo Example Vet", overview: "Overview antigo", topics: [], decisions: [], actionItems: [] }));
  await fs.writeFile(summaryMarkdownPath, "# Título antigo Example Vet\nOverview antigo\n");
  if (diarization) await new DiarizationStore().save({ version: 1, jobId: job.id, mediaSha256: job.source.sha256,
    transcriptSha256: transcriptChecksum(transcript.text), provider: "openai", model: "gpt-4o-transcribe-diarize",
    duration: 3, generatedAt: "2026-10-03T00:00:00Z", labels: { S01: "Pessoa sintética" }, acousticValidation: "pending",
    turns: [{ start: 1, end: 3, text: "Texto próprio acústico.", speaker: "S01" }],
    alignment: { text: transcript.text, matchedTokenRatio: 0, unassignedTokenCount: 8,
      segments: [{ start: 0, end: 3, text: transcript.text, charStart: 0, charEnd: transcript.text.length, reviewRequired: true }] } });
  const entry: LibraryEntry = { sourcePath: media, relativePath: "synthetic.wav", sourceExists: true, size: job.source.size,
    modifiedAt: 0, jobs: [job] };
  return { root, config, store, job, media, transcript, transcriptPath, markdownPath, summaryPath, summaryMarkdownPath, entry };
};
const editText = async (job: JobRecord, text = "Texto corrigido Example Vet.") => {
  const view = await readReviewedView(job);
  await saveRevision(job, { expectedRevision: view.revision.revision, base: view.revision.base,
    operations: [{ kind: "segment-text", segmentId: "s000000", text }] });
};

test("reviewed TUI Markdown retains exact gaps/provenance and never presents original summary as current", async () => {
  const f = await fixture();
  const paths = [f.media, f.transcriptPath, f.markdownPath, f.summaryPath, f.summaryMarkdownPath];
  const hashes = await Promise.all(paths.map(hashFile));
  expect(await readArtifact(f.job, "transcript")).toContain("Markdown original preservado");
  await editText(f.job);
  const markdown = await readArtifact(f.job, "transcript");
  expect(markdown).toContain("Gap inicial.\nTexto corrigido Example Vet.\nCauda exata.");
  expect(markdown).toContain("Revisão humana: 1"); expect(markdown).toContain(hashes[1]!);
  expect(markdown).not.toContain("Markdown original preservado");
  expect(await readArtifact(f.job, "summary")).toContain("regenere o resumo");
  expect(await readMeetingTitle(f.job)).toBeUndefined();
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: false });
  const context = await readMeetingContext(f.config, f.job.id);
  expect(context.summary).toBeNull(); expect(context.title).toBe("synthetic.wav");
  expect(context.excerpts[0]!.textOrigin).toBe("human-revision");
  expect(await Promise.all(paths.map(hashFile))).toEqual(hashes);
});

test("canonical codes receive acoustic names only after an explicit same-code human binding", async () => {
  const f = await fixture(true); let view = await readReviewedView(f.job);
  await saveRevision(f.job, { expectedRevision: 0, base: view.revision.base,
    operations: [{ kind: "speaker-label", speakerId: "S01", label: "Nome revisado" }] });
  view = await readCurrentReviewedView(f.job);
  expect(reviewedTranscriptForDisplay(view).segments[0]!.speaker).toBe("S01");
  expect(await readArtifact(f.job, "transcript")).not.toContain("Nome revisado");
  await saveRevision(f.job, { expectedRevision: 1, base: view.revision.base,
    operations: [{ kind: "segment-speaker", segmentId: "s000000", speakerId: "S01" }] });
  const selection = await selectPlaybackTranscript(f.entry, f.job);
  expect(selection.transcript!.segments[0]!.speaker).toBe("Nome revisado");
  expect(selection.warnings).toEqual([]);
  expect(JSON.parse(await fs.readFile(f.transcriptPath, "utf8")).segments[0].speaker).toBe("S01");
  expect((await readReviewedView(f.job)).diarization!.turns[0]!.text).toBe("Texto próprio acústico.");
});

test("corrected text refuses captions instead of selecting media-hash original aligned captions", async () => {
  const f = await fixture(); const subtitleRoot = join(process.env.XDG_DATA_HOME!, "recording-cli/subtitles");
  await fs.mkdir(subtitleRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(subtitleRoot, `${f.job.source.sha256}.json`), JSON.stringify({ ...f.transcript,
    mediaSha256: f.job.source.sha256, text: "Legenda antiga", segments: [{ start: 0, end: 3, text: "Legenda antiga" }] }));
  expect((await selectPlaybackTranscript(f.entry, f.job)).transcript!.text).toBe("Legenda antiga");
  await editText(f.job);
  f.entry.meetingTitle = "Título antigo em seleção cacheada";
  let input: Parameters<NonNullable<import("../media").MediaDependencies["player"]>>[1];
  const result = await playLibraryEntry(f.config, f.entry, f.job, { player: async (_path, options) => { input = options; } });
  expect(result.warnings![0]).toContain("alinhamento acústico comprovado");
  expect(input!.transcript!.text).toContain("Texto corrigido Example Vet.");
  expect(input!.transcript!.segments).toEqual([]); expect(input!.transcriptPath).toBeUndefined();
  expect(input!.title).toBe("synthetic.wav");
});

test("unsafe saved journal never falls back to the canonical Markdown or original summary", async () => {
  const f = await fixture(); await editText(f.job);
  const journal = join(process.env.XDG_DATA_HOME!, "recording-cli/revisions", `${f.job.id}.json`);
  await fs.chmod(journal, 0o644);
  await expect(readArtifact(f.job, "transcript")).rejects.toThrow("privado");
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: false, summary: false });
  expect(await readMeetingTitle(f.job)).toBeUndefined();
  const selection = await selectPlaybackTranscript(f.entry, f.job);
  expect(selection.transcript).toBeUndefined(); expect(selection.warnings[0]).toContain("não pôde ser validada");
  await expect(readMeetingContext(f.config, f.job.id)).rejects.toThrow();
  expect((await searchMeetings(f.config, { query: "Título antigo" })).items.some(item => item.jobId === f.job.id)).toBe(false);
  await fs.chmod(journal, 0o600);
});

test("explicit original-summary support mismatching the current transcript does not advertise title or summary Markdown", async () => {
  const f = await fixture();
  const original = JSON.parse(await fs.readFile(f.summaryPath, "utf8"));
  const supported = attachSummarySupport(original, buildSummaryEvidence({ ...f.transcript, text: "Outra transcrição.",
    segments: [{ start: 0, end: 2, text: "Outra transcrição." }] }, f.job.source.sha256, 8000));
  await fs.writeFile(f.summaryPath, JSON.stringify(supported));
  expect(await readArtifact(f.job, "summary")).toContain("sem vínculo com a transcrição atual");
  expect(await readMeetingTitle(f.job)).toBeUndefined();
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: false });
  expect((await readMeetingContext(f.config, f.job.id)).summaryProvenance).toMatchObject({ state: "stale", verification: "mismatch" });
  await fs.unlink(f.transcriptPath);
  expect(await readArtifact(f.job, "summary")).toContain("sem vínculo com a transcrição atual");
  expect(await readMeetingTitle(f.job)).toBeUndefined();
});

test("a deleted job cannot be resurrected from a cached selection and preserved shared artifacts", async () => {
  const f = await fixture(); await f.store.remove(f.job.id);
  expect(await fs.readFile(f.markdownPath, "utf8")).toContain("preservado");
  await expect(readCurrentReviewedView(f.job)).rejects.toBeInstanceOf(RevisionConflictError);
  await expect(readArtifact(f.job, "transcript")).rejects.toBeInstanceOf(RevisionConflictError);
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: false, summary: false });
  expect(await readMeetingTitle(f.job)).toBeUndefined();
});

test("an asynchronous original-summary read detects source drift before returning content", async () => {
  const f = await fixture(); const open = fs.open.bind(fs); let changed = false;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === f.summaryMarkdownPath && !changed) {
      changed = true; await fs.appendFile(f.transcriptPath, "\n");
    }
    return open(...args);
  });
  try { await expect(readArtifact(f.job, "summary")).rejects.toBeInstanceOf(RevisionConflictError); }
  finally { spy.mockRestore(); }
  expect(changed).toBe(true);
});

test("reviewed readers complete while a revision writer waits on the held context publication lease", async () => {
  const f = await fixture(); let notifyHeld!: () => void;
  const revisionHeld = new Promise<void>(resolve => { notifyHeld = resolve; });
  let writer!: Promise<void>;
  await withContextPublicationLease(aiContextRoot(), async () => {
    writer = withRevisionLease(f.job.id, async () => {
      notifyHeld();
      await withContextPublicationLease(aiContextRoot(), async () => {});
    });
    await revisionHeld;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const view = await Promise.race([readCurrentReviewedView(f.job), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Reader inverted context/revision lock order")), 1000);
      })]);
      expect(view.transcript.text).toBe(f.transcript.text);
    } finally { if (timer) clearTimeout(timer); }
  });
  await writer;
});

test("current generated summary drives title/search/context with model authorship and becomes stale after the next revision", async () => {
  const f = await fixture(); await editText(f.job);
  const paths = [f.media, f.transcriptPath, f.markdownPath, f.summaryPath, f.summaryMarkdownPath];
  const hashes = await Promise.all(paths.map(hashFile));
  const provider: ReviewedSummaryProvider = { provider: "ollama", model: "fixture-only", adapterIdentity: "synthetic-consumer-stub" };
  const plan = await planReviewedSummary(f.job, { requestId: "consumer-fixture", config: f.config, provider, maxRequests: 1 });
  let calls = 0;
  const result = await regenerateReviewedSummary(f.job, { requestId: plan.requestId, config: f.config, consent: true, consentKey: plan.consentKey,
    adapter: { identity: provider, summarize: async chunk => { calls++; expect(chunk.text).toContain("Texto corrigido Example Vet.");
      return { version: 1, provider: "ollama", model: "fixture-only", title: "Título atual Example Vet", overview: "Síntese atual revisada.", topics: [], decisions: [], actionItems: [] }; } } });
  expect(calls).toBe(1);
  expect(await readMeetingTitle(f.job)).toBe("Título atual Example Vet");
  expect((await buildLibrary(f.config)).find(entry => entry.jobs.some(job => job.id === f.job.id))!.meetingTitle).toBe("Título atual Example Vet");
  expect(await readArtifact(f.job, "summary")).toContain("Autoria: modelo");
  const context = await readMeetingContext(f.config, f.job.id);
  expect(context.summaryPath).toBe(result.path); expect(context.title).toBe("Título atual Example Vet");
  expect(context.summaryProvenance).toMatchObject({ origin: "reviewed-regenerated", revision: 1, authorship: "model" });
  const found = await searchMeetings(f.config, { query: "Título atual" });
  expect(found.items.find(item => item.jobId === f.job.id)!.summaryPath).toBe(result.path);
  const report = await buildAiContextFiles(f.config, { outputDir: join(f.root, "generated-context") });
  expect(report.meetingsIncluded).toBe(1);
  const text = await fs.readFile(report.clients[0]!.path, "utf8");
  expect(text).toContain("Título atual Example Vet"); expect(text).toContain("autoria continua sendo do modelo");
  expect(text).not.toContain("Título antigo");
  await editText(f.job, "Segunda revisão Example Vet.");
  expect(await readMeetingTitle(f.job)).toBeUndefined(); expect((await readMeetingContext(f.config, f.job.id)).summary).toBeNull();
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: false });
  expect(await Promise.all(paths.map(hashFile))).toEqual(hashes);
});

test("a fresh linked regenerated summary is readable for a failed local job with a verified partial checkpoint", async () => {
  const f = await fixture();
  f.job = await f.store.update(f.job.id, "failed", { error: "Synthetic original-summary failure" });
  f.entry.jobs = [f.job];
  const work = f.store.getWorkDir(f.job.id), raw = await fs.readFile(f.transcriptPath, "utf8");
  await fs.writeFile(join(work, "transcript.json"), raw);
  await fs.writeFile(join(work, "transcript-receipt.json"), JSON.stringify({ version: 1,
    identity: transcriptionIdentity(f.job), transcriptSha256: artifactDigest(raw) }));
  await editText(f.job);
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: false });
  const provider: ReviewedSummaryProvider = { provider: "ollama", model: "fixture-only", adapterIdentity: "synthetic-partial-consumer-stub" };
  const plan = await planReviewedSummary(f.job, { requestId: "partial-consumer-fixture", config: f.config, provider, maxRequests: 1 });
  const result = await regenerateReviewedSummary(f.job, { requestId: plan.requestId, config: f.config,
    consent: true, consentKey: plan.consentKey, adapter: { identity: provider, summarize: async () => ({
      version: 1, provider: "ollama", model: "fixture-only", title: "Resumo atual parcial Example Vet", overview: "Síntese parcial revisada.",
      topics: [], decisions: [], actionItems: []
    }) } });
  expect(await readArtifact(f.job, "summary")).toContain("Resumo atual parcial Example Vet");
  expect(await readMeetingTitle(f.job)).toBe("Resumo atual parcial Example Vet");
  expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: true });
  const context = await readMeetingContext(f.config, f.job.id);
  expect(context.jobState).toBe("failed"); expect(context.summaryPath).toBe(result.path);
  expect(context.artifactStates.summary).toBe("ready"); expect(context.transcriptProvenance.origin).toBe("work");
  expect(context.transcriptProvenance.receipt).toBe("verified");
  expect((await f.store.get(f.job.id)).state).toBe("failed");
});
