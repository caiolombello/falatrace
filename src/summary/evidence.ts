import { createHash } from "node:crypto";
import type { RecordingSummary, Transcript, SummarySupport } from "../jobs/types";
import { sourceTimingQuality } from "../transcript/timing";
import { SUMMARY_LABELS } from "./language";

export type SummaryInputEvidence = {
  visual?: { adapterIdentity: string; expiresAt: number; observations: Array<{ timestampSeconds: number; frameSha256: string; text: string; uncertainty: "clear" | "uncertain" }> };
  mediaSha256: string;
  transcriptSha256: string;
  timingQuality: SummarySupport["timingQuality"];
  segments: Array<{ id: string; start: number; end: number; text: string }>;
};

/** Historical producer contract: normalized Transcript JSON, without final LF.
 * This is distinct from the exact raw transcript artifact/receipt digest. */
export const summaryTranscriptEvidenceSha256 = (transcript: Transcript): string =>
  createHash("sha256").update(JSON.stringify(transcript, null, 2), "utf8").digest("hex");
export const summaryEvidenceMatches = (summary: RecordingSummary, mediaSha256: string, transcript: Transcript): boolean =>
  !summary.support || (summary.support.mediaSha256 === mediaSha256 && summary.support.transcriptSha256 === summaryTranscriptEvidenceSha256(transcript) &&
    summary.support.references.every(reference => {
      const segment = /^s\d{6}$/.test(reference.id) ? transcript.segments[Number(reference.id.slice(1))] : undefined;
      return segment !== undefined && segment.start === reference.start && segment.end === reference.end;
    }));

export const buildSummaryEvidence = (transcript: Transcript, mediaSha256: string, maxSegments = 1000, selectedSegmentIds?:string[]): SummaryInputEvidence => {
  if (!/^[a-f0-9]{64}$/.test(mediaSha256)) throw new Error("Invalid media hash for summary evidence");
  const selection=selectedSegmentIds?new Set(selectedSegmentIds):undefined;
  if(selection && (!selection.size||selection.size!==selectedSegmentIds!.length||selectedSegmentIds!.some(id=>!/^s[0-9]{6}$/.test(id)||Number(id.slice(1))>=transcript.segments.length)))throw Error('Invalid explicit summary segment selection');
  if ((selection?.size ?? transcript.segments.length) > maxSegments) throw new Error("Transcript has too many segments for one summary; chunking is required");
  const quality = sourceTimingQuality(transcript);
  return {
    mediaSha256, transcriptSha256: summaryTranscriptEvidenceSha256(transcript),
    timingQuality: quality === "word" || quality === "segment" ? "segment" : quality === "approximate-block" ? "approximate-block" : "none",
    segments: transcript.segments.map((segment, index) => ({ id: `s${String(index).padStart(6,"0")}`, start: segment.start, end: segment.end, text: segment.text })).filter(s=>!selection||selection.has(s.id))
  };
};

export const attachSummarySupport = (summary: RecordingSummary, evidence: SummaryInputEvidence): RecordingSummary => {
  const ids = new Set(evidence.segments.filter((segment) => segment.text.trim()).map((segment) => segment.id));
  const citations = summary.citations || [];
  const items = (summary.sections || []).flatMap((section) => section.items);
  for (const cited of [...citations, ...items]) {
    if (cited.segmentIds.some((id) => !ids.has(id))) throw new Error("Summary cited a transcript segment that does not exist");
  }
  const covered = new Set(citations.filter((citation) => citation.uncertainty === "clear").map((citation) => `${citation.section}:${citation.index}`));
  const required = ["overview:0", ...summary.decisions.map((_, index) => `decision:${index}`), ...summary.actionItems.map((_, index) => `action:${index}`)];
  // Legacy rules, plus any section item the model itself marked uncertain.
  const reviewRequired = required.some((key) => !covered.has(key)) || citations.some((citation) => citation.uncertainty === "uncertain") ||
    items.some((item) => item.uncertainty === "uncertain") || evidence.timingQuality === "none";
  const limitations = [...(summary.limitations || [])];
  if (reviewRequired) limitations.push(SUMMARY_LABELS[summary.meta?.language ?? "pt-BR"].limitation.reviewRequired);
  const cited = new Set([...citations, ...items].flatMap((entry) => entry.segmentIds));
  return { ...summary, limitations: [...new Set(limitations)].slice(0,100), support: {
    version: 1, mediaSha256: evidence.mediaSha256, transcriptSha256: evidence.transcriptSha256,
    timingQuality: evidence.timingQuality, reviewRequired,
    references: evidence.segments.filter((segment) => cited.has(segment.id)).map(({id,start,end}) => ({id,start,end}))
  } };
};
