import type { JobRecord, Transcript } from "../jobs/types";
import type { TranscriptArtifact } from "../jobs/transcript-access";
import type { DiarizationResult } from "../diarization/store";

export type RevisionBase = { jobId: string; mediaSha256: string; transcriptArtifactSha256: string; diarizationSha256?: string };
export type RevisionHead = { version: 1; revision: number; base: RevisionBase };
export type RevisionOperation =
  | { kind: "segment-text"; segmentId: string; text: string }
  | { kind: "speaker-label"; speakerId: string; label: string }
  | { kind: "segment-speaker"; segmentId: string; speakerId: string | null }
  | { kind: "turn-speaker"; turnId: string; speakerId: string | null }
  | { kind: "note"; text: string };
export type ReviewedSegment = { id: string; canonicalId: string; originalText: string; text: string; start: number; end: number; speakerId?: string; humanEdited: boolean; humanSpeakerEdited: boolean; textRange?: { start: number; end: number } };
export type ReviewedTurn = { id: string; start: number; end: number; text: string; speaker?: string; label?: string; humanSpeakerEdited: boolean };
export type ReviewedView = {
  original: TranscriptArtifact; transcript: Transcript; segments: ReviewedSegment[];
  diarization?: { original: DiarizationResult; turns: ReviewedTurn[]; labels: Record<string, string> };
  revision: RevisionHead & { humanReviewed: boolean }; notes: string[]; derivedStale: boolean; canUndo: boolean;
};
export type RevisionSaveInput = { expectedRevision: number; base: RevisionBase; operations: RevisionOperation[] };
export type RevisionUndoInput = { expectedRevision: number; base: RevisionBase };

export { readReviewedView, saveRevision, undoRevision, withRevisionLease, RevisionConflictError, REVISION_LIMITS } from "./service";
