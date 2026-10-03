import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JobRecord, RecordingSummary } from "../jobs/types";
import { validateSummary } from "../jobs/types";
import { artifactDigest, readBoundedArtifact } from "../jobs/transcript-access";
import { assertExistingJobArtifactPath } from "../tui/library";
import { readReviewedView, type ReviewedView } from "../revisions/index";
import { sourceTimingQuality } from "../transcript/timing";
import { summaryEvidenceMatches, summaryTranscriptEvidenceSha256 } from "../summary/evidence";
import { readCurrentReviewedSummary, type ReviewedSummaryProvenance } from "../summary/reviewed";
import { assertCurrentReviewedView } from "../revisions/compat";

export type ExportFormat = "json" | "markdown" | "srt" | "vtt";
export type ExportTrack = "transcript" | "diarization";
export type ExportOptions = { format: ExportFormat; track: ExportTrack };
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_PREVIEW_CHARACTERS = 24_000;

export const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)])) : value;
export const canonicalJson = (value: unknown): string => `${JSON.stringify(ordered(value), null, 2)}\n`;

export const assertExportOptions = (options: ExportOptions): void => {
  if (!options || !["json", "markdown", "srt", "vtt"].includes(options.format) || !["transcript", "diarization"].includes(options.track)) throw new Error("Formato ou faixa de exportação inválidos");
};

type SummarySnapshot = { state: "ready" | "stale" | "unavailable"; verification?: "verified" | "legacy-unverified" | "mismatch"; artifactSha256?: string; original?: RecordingSummary;
  originalState?: "ready" | "stale"; originalVerification?: SummarySnapshot["verification"]; reviewed?: RecordingSummary; reviewedArtifactSha256?: string; provenance?: ReviewedSummaryProvenance; requestId?: string };
export type ExportSnapshot = {
  version: 1; jobId: string; track: ExportTrack;
  settings: { transcription: { provider: JobRecord["transcription"]["provider"]; model: string; language: string }; summary: JobRecord["summary"] };
  revision: ReviewedView["revision"]; source: ReviewedView["original"]["provenance"];
  timingQuality: ReturnType<typeof sourceTimingQuality>;
  original: { transcript: ReviewedView["original"]["transcript"]; summaryEvidenceTranscriptSha256: string };
  reviewed: { text: string; segments: ReviewedView["segments"]; wordTimingOrigin: "original-transcript"; notes: string[]; derivedStale: boolean };
  diarization?: ReviewedView["diarization"];
  summary: SummarySnapshot;
  warnings: string[];
};

/** Source order and IDs are captured before subtitle sorting. No live references. */
export const snapshotReviewedView = (job: JobRecord, view: ReviewedView, track: ExportTrack, summary: SummarySnapshot = { state: "unavailable" }): ExportSnapshot => {
  if (track !== "transcript" && track !== "diarization") throw new Error("Faixa de exportação inválida");
  if (track === "diarization" && !view.diarization) throw new Error("Esta gravação não possui diarização disponível");
  const quality = track === "diarization" ? "segment" : sourceTimingQuality(view.original.transcript);
  const warnings = ["Tempos preservados da origem; não foi feito alinhamento novo por palavra."];
  if (view.original.provenance.receipt === "legacy-unverified") warnings.push("Transcrição legada com proveniência não verificada por recibo.");
  if (quality === "approximate-block" || quality === "unknown" || quality === "none") warnings.push(`Precisão temporal: ${quality}; legendas indisponíveis nesta faixa.`);
  if (view.segments.some(segment => segment.humanEdited)) warnings.push("Texto corrigido por pessoa; palavras e intervalos originais não comprovam alinhamento do texto revisado.");
  if (view.derivedStale) warnings.push("Derivados da revisão anterior estão desatualizados; o resumo original não representa a revisão atual.");
  if (summary.reviewed) warnings.push("Resumo de modelo vinculado à revisão atual; os hashes verificam origem, não qualidade semântica. Notas humanas sem tempo e rótulos acústicos não foram enviados ao modelo.");
  if ((summary.originalVerification || summary.verification) === "mismatch") warnings.push(summary.reviewed ? "Suporte do resumo original não corresponde à mídia/transcrição original; resumo preservado como desatualizado." : "Suporte do resumo não corresponde à mídia/transcrição original; resumo preservado como desatualizado.");
  if ((summary.originalVerification || summary.verification) === "legacy-unverified") warnings.push(summary.reviewed ? "Resumo legado original sem suporte verificável; revisão humana necessária." : "Resumo legado sem suporte verificável; revisão humana necessária.");
  if (view.diarization) warnings.push("Falantes automáticos requerem revisão acústica; nomes humanos não comprovam identidade. A diarização usa texto próprio.");
  if (track === "transcript") warnings.push("Duração total da mídia não foi medida nesta exportação.");
  return structuredClone({ version: 1, jobId: job.id, track, settings: { transcription: { provider: job.transcription.provider, model: job.transcription.model, language: job.transcription.language }, summary: job.summary }, revision: view.revision, source: view.original.provenance,
    timingQuality: quality, original: { transcript: view.original.transcript, summaryEvidenceTranscriptSha256: summaryTranscriptEvidenceSha256(view.original.transcript) },
    reviewed: { text: view.transcript.text, segments: view.segments, wordTimingOrigin: "original-transcript", notes: view.notes, derivedStale: view.derivedStale },
    ...(view.diarization ? { diarization: view.diarization } : {}), summary, warnings });
};

export const readExportSnapshot = async (job: JobRecord, track: ExportTrack): Promise<ExportSnapshot> => {
  const view = await readReviewedView(job);
  let summary: SummarySnapshot = { state: "unavailable" };
  if (job.state === "completed") {
    try {
      const path = join(job.artifactDir, "summary.json");
      await assertExistingJobArtifactPath(job, path);
      const raw = await readBoundedArtifact(path, 2 * 1024 * 1024);
      const original = validateSummary(JSON.parse(raw), job.summary.provider, job.summary.model);
      const matches = summaryEvidenceMatches(original, job.source.sha256, view.original.transcript);
      summary = { state: view.derivedStale || !matches ? "stale" : "ready", verification: !matches ? "mismatch" : original.support ? "verified" : "legacy-unverified",
        artifactSha256: artifactDigest(raw), original };
    } catch { /* Transcript export remains possible without a committed summary. */ }
  }
  const current = await readCurrentReviewedSummary(job, view);
  if (current) summary = { ...summary, originalState: summary.original ? summary.state === "ready" ? "ready" : "stale" : undefined, originalVerification: summary.original ? summary.verification : undefined,
    state: "ready", verification: "verified", reviewed: current.summary, reviewedArtifactSha256: artifactDigest(current.raw), provenance: current.provenance, requestId: current.requestId };
  await assertCurrentReviewedView(job, view);
  return snapshotReviewedView(job, view, track, summary);
};
