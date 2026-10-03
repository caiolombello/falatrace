import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { JobStore } from "../jobs/store";
import type { JobRecord, Transcript } from "../jobs/types";
import { hasSavedRevision } from "./service";
import { readReviewedView, RevisionConflictError, type ReviewedView } from "./index";

const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
const identity = (value: unknown): string => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
const jobIdentity = (job: JobRecord): string => identity({ id: job.id, source: job.source, sourcePath: job.sourcePath,
  artifactDir: job.artifactDir, transcription: job.transcription, summary: job.summary, target: job.target,
  state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt });
const viewIdentity = (view: ReviewedView): string => identity({ revision: view.revision, source: view.original.provenance,
  path: view.original.path, transcript: view.transcript, segments: view.segments, diarization: view.diarization, notes: view.notes });

/** Alternate stores must be passed explicitly. Missing records are never a
 * fallback signal: a cached selection must not resurrect a removed job. */
export const assertCurrentJob = async (job: JobRecord, store: Pick<JobStore, "get"> = new JobStore()): Promise<void> => {
  try {
    const current = await store.get(job.id);
    if (jobIdentity(current) !== jobIdentity(job)) throw new RevisionConflictError("O job mudou; releia os artefatos antes de continuar.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new RevisionConflictError("O job não está mais disponível; os derivados foram preservados.");
  }
};

/** Read-only snapshot. Recheck both the job and the exact source/revision after
 * asynchronous reads; unsafe journals/receipts must never select canonical text. */
export const readCurrentReviewedView = async (job: JobRecord, store: Pick<JobStore, "get"> = new JobStore()): Promise<ReviewedView> => {
    await assertCurrentJob(job, store);
    const view = await readReviewedView(job);
    const after = await readReviewedView(job);
    await assertCurrentJob(job, store);
    if (viewIdentity(view) !== viewIdentity(after)) {
      throw new RevisionConflictError("A fonte ou revisão mudou durante a leitura; releia o conteúdo.");
    }
    return view;
};

export const assertCurrentReviewedView = async (job: JobRecord, view: ReviewedView, store: Pick<JobStore, "get"> = new JobStore()): Promise<void> => {
  const current = await readCurrentReviewedView(job, store);
  if (viewIdentity(current) !== viewIdentity(view)) throw new RevisionConflictError("A fonte ou revisão mudou durante a leitura; releia o conteúdo.");
};

/** Acoustic labels only cross into canonical segments after explicit human binding.
 * Equal S01 strings alone are not evidence that the two namespaces correspond. */
export const reviewedTranscriptForDisplay = (view: ReviewedView): Transcript => ({
  ...structuredClone(view.transcript),
  segments: view.transcript.segments.map((segment, index) => {
    const reviewed = view.segments[index];
    const label = reviewed?.humanSpeakerEdited && reviewed.speakerId ? view.diarization?.labels[reviewed.speakerId] : undefined;
    return { ...segment, ...(label ? { speaker: label } : {}) };
  })
});

const literal = (text: string): string => {
  let width = 3;
  for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "`".repeat(width);
  return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
};
export const formatReviewedTranscriptMarkdown = (view: ReviewedView): string => {
  const transcript = reviewedTranscriptForDisplay(view);
  const lines = ["# Transcrição revisada", "", `Revisão humana: ${view.revision.revision}`,
    `Artefato original SHA-256: ${view.original.provenance.transcriptSha256}`,
    `Proveniência original: ${view.original.provenance.origin}/${view.original.provenance.receipt}`,
    "Tempos de origem preservados; o texto humano não foi realinhado por palavra.", "", "## Texto completo", "", literal(transcript.text), "", "## Trechos", ""];
  for (const [index, segment] of transcript.segments.entries()) {
    const reviewed = view.segments[index]!;
    lines.push(`### ${reviewed.id} · intervalo original ${segment.start}–${segment.end} segundos`, "",
      `Falante: ${segment.speaker || "incerto"} · origem: ${reviewed.humanSpeakerEdited ? "atribuição humana ao namespace acústico" : "código original da transcrição"}`,
      `Texto humano alterado: ${reviewed.humanEdited ? "sim" : "não"}`, "", literal(segment.text), "");
  }
  if (view.notes.length) lines.push("## Notas humanas sem tempo", "", ...view.notes.flatMap(note => [literal(note), ""]));
  return `${lines.join("\n")}\n`;
};

/** Only absence of the original transcript, with no saved journal, is legacy.
 * Malformed/unsafe artifacts and revision conflicts are never fallback signals. */
export const isUnreviewedLegacyAbsence = async (job: JobRecord, error: unknown): Promise<boolean> => {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || await hasSavedRevision(job.id)) return false;
  // Missing receipts from an existing work/publication JSON are unsafe, not
  // summary-only/Markdown-only legacy evidence.
  for (const path of [join(job.artifactDir, "transcript.json"), join(new JobStore().getWorkDir(job.id), "transcript.json")]) {
    try { await fs.lstat(path); return false; }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; }
  }
  return true;
};

export const assertUnreviewedLegacyJob = async (job: JobRecord, store: Pick<JobStore, "get"> = new JobStore()): Promise<void> => {
  await assertCurrentJob(job, store);
  if (await hasSavedRevision(job.id)) throw new RevisionConflictError("A revisão mudou durante a leitura do artefato legado.");
  try { await readReviewedView(job); }
  catch (error) {
    if (await isUnreviewedLegacyAbsence(job, error)) return;
    throw error;
  }
  throw new RevisionConflictError("A transcrição original mudou durante a leitura do artefato legado; releia o conteúdo.");
};
