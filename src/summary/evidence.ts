import { createHash } from "node:crypto";
import type { RecordingSummary, Transcript, SummarySupport } from "../jobs/types";

export type SummaryInputEvidence = {
  visual?: { adapterIdentity: string; expiresAt: number; observations: Array<{ timestampSeconds: number; frameSha256: string; text: string; uncertainty: "clear" | "uncertain" }> };
  mediaSha256: string;
  transcriptSha256: string;
  timingQuality: SummarySupport["timingQuality"];
  segments: Array<{ id: string; start: number; end: number; text: string }>;
};

export const buildSummaryEvidence = (transcript: Transcript, mediaSha256: string, maxSegments = 1000): SummaryInputEvidence => {
  if (!/^[a-f0-9]{64}$/.test(mediaSha256)) throw new Error("Invalid media hash for summary evidence");
  if (transcript.segments.length > maxSegments) throw new Error("Transcript has too many segments for one summary; chunking is required");
  return {
    mediaSha256, transcriptSha256: createHash("sha256").update(JSON.stringify(transcript, null, 2)).digest("hex"),
    timingQuality: !transcript.segments.some((segment) => segment.end > segment.start) ? "none" : transcript.provider === "whisper-cpp" ? "segment" : "approximate-block",
    segments: transcript.segments.map((segment, index) => ({ id: `s${String(index).padStart(6,"0")}`, start: segment.start, end: segment.end, text: segment.text }))
  };
};

export const attachSummarySupport = (summary: RecordingSummary, evidence: SummaryInputEvidence): RecordingSummary => {
  const ids = new Set(evidence.segments.filter((segment) => segment.text.trim()).map((segment) => segment.id));
  const citations = summary.citations || [];
  for (const citation of citations) {
    if (citation.segmentIds.some((id) => !ids.has(id))) throw new Error("Summary cited a transcript segment that does not exist");
  }
  const covered = new Set(citations.filter((citation) => citation.uncertainty === "clear").map((citation) => `${citation.section}:${citation.index}`));
  const required = ["overview:0", ...summary.decisions.map((_, index) => `decision:${index}`), ...summary.actionItems.map((_, index) => `action:${index}`)];
  const reviewRequired = required.some((key) => !covered.has(key)) || citations.some((citation) => citation.uncertainty === "uncertain") || evidence.timingQuality === "none";
  const limitations = [...(summary.limitations || [])];
  if (reviewRequired) limitations.push("Resumo requer revisão: afirmação sem referência clara ou precisão temporal indisponível. Referências válidas não comprovam correção semântica.");
  return { ...summary, limitations: [...new Set(limitations)].slice(0,100), support: {
    version: 1, mediaSha256: evidence.mediaSha256, transcriptSha256: evidence.transcriptSha256,
    timingQuality: evidence.timingQuality, reviewRequired,
    references: evidence.segments.filter((segment) => citations.some((citation) => citation.segmentIds.includes(segment.id))).map(({id,start,end}) => ({id,start,end}))
  } };
};
