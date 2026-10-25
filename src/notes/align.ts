// Notes on the media timeline: which transcript segments a note refers to, the
// bounded and sanitized view sent to a summary model, and a digest for cache and
// consent keys.
import { createHash } from "node:crypto";
import { sanitizeKnowledgeText } from "../knowledge/context";
import { NOTE_LIMITS, isNoteEntryId, type NoteEntry, sliceNoteText } from "./lines";

export const NOTES_SUMMARY_LIMITS = Object.freeze({
  maxEntries: 200,
  maxCharacters: 16_000,
  /** A truncated last note keeps at least this many characters, else it is left out. */
  minTruncatedCharacters: 80
});

/** A note is usually typed shortly after the thing was said. */
export const NOTE_ALIGNMENT = Object.freeze({ beforeSeconds: 90, afterSeconds: 10, maxSegments: 4 });

/** A transcript segment; without `id`, its id is derived from its position (s000000, s000001, …). */
export type AlignableSegment = { id?: string; start: number; end: number };

export type NoteForSummary = {
  id: string;
  text: string;
  /** "mm:ss" (or "h:mm:ss" past one hour) from the media start, or null when untimed. */
  at: string | null;
  offsetSeconds: number | null;
  /** Segments around the moment the note was typed, nearest first. */
  nearSegmentIds: string[];
};

const SEGMENT_ID = /^[A-Za-z0-9:_-]{1,64}$/;
// Half of a surrogate pair is not valid Unicode; strict JSON parsers of model APIs refuse it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const segmentIdAt = (index: number): string => `s${String(index).padStart(6, "0")}`;

const validOffset = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= NOTE_LIMITS.maxOffsetSeconds ? value : null;

export const formatNoteOffset = (seconds: number | null | undefined): string | null => {
  const offset = validOffset(seconds);
  if (offset === null) return null;
  const total = Math.floor(offset);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
};

type Prepared = { id: string; start: number; end: number; index: number };

/**
 * For each timed note, the segments overlapping [offset − 90 s, offset + 10 s], nearest to the
 * note first (a segment containing the moment has distance 0; on ties the earlier one wins),
 * at most four. Untimed notes map to an empty list.
 */
export const alignNotesToSegments = (
  entries: readonly Pick<NoteEntry, "id" | "offsetSeconds">[],
  segments: readonly AlignableSegment[],
  options: { beforeSeconds?: number; afterSeconds?: number; maxSegments?: number } = {}
): Map<string, string[]> => {
  const before = options.beforeSeconds ?? NOTE_ALIGNMENT.beforeSeconds;
  const after = options.afterSeconds ?? NOTE_ALIGNMENT.afterSeconds;
  const limit = options.maxSegments ?? NOTE_ALIGNMENT.maxSegments;
  const prepared: Prepared[] = [];
  segments.forEach((segment, index) => {
    if (!segment || typeof segment.start !== "number" || typeof segment.end !== "number" ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start) return;
    const id = segment.id === undefined ? segmentIdAt(index) : segment.id;
    if (typeof id !== "string" || !SEGMENT_ID.test(id)) return;
    prepared.push({ id, start: segment.start, end: segment.end, index });
  });
  prepared.sort((a, b) => a.start - b.start || a.index - b.index);
  const longest = prepared.reduce((max, segment) => Math.max(max, segment.end - segment.start), 0);

  const result = new Map<string, string[]>();
  for (const entry of entries) {
    const offset = validOffset(entry.offsetSeconds);
    if (offset === null || !prepared.length) { result.set(entry.id, []); continue; }
    const low = offset - before, high = offset + after;
    // Last segment starting at or before `high`; earlier ones can overlap only if they end after `low`.
    let lo = 0, hi = prepared.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (prepared[mid].start <= high) lo = mid + 1; else hi = mid; }
    const near: Array<{ segment: Prepared; distance: number; later: number }> = [];
    for (let index = lo - 1; index >= 0 && prepared[index].start >= low - longest; index--) {
      const segment = prepared[index];
      if (segment.end < low) continue;
      const distance = offset < segment.start ? segment.start - offset : offset > segment.end ? offset - segment.end : 0;
      near.push({ segment, distance, later: segment.start > offset ? 1 : 0 });
    }
    near.sort((a, b) => a.distance - b.distance || a.later - b.later || a.segment.start - b.segment.start || a.segment.index - b.segment.index);
    result.set(entry.id, near.slice(0, limit).map((item) => item.segment.id));
  }
  return result;
};

/**
 * The notes as the summary model receives them: sanitized text, media time and nearby segment
 * ids, in notepad order, at most 200 notes and 16k characters (the last one may be truncated).
 */
export const notesForSummary = (
  notes: { entries: readonly NoteEntry[] } | undefined | null,
  segments?: readonly AlignableSegment[]
): NoteForSummary[] => {
  if (!notes || !Array.isArray(notes.entries)) return [];
  const entries = notes.entries.filter((entry) => entry && isNoteEntryId(entry.id) && typeof entry.text === "string");
  const near = segments?.length ? alignNotesToSegments(entries, segments) : undefined;
  const out: NoteForSummary[] = [];
  let budget = NOTES_SUMMARY_LIMITS.maxCharacters;
  for (const entry of entries) {
    if (out.length >= NOTES_SUMMARY_LIMITS.maxEntries || budget <= 0) break;
    // Masking an e-mail can lengthen a line past the cut, which may split a pair; replace any half left.
    let text = sanitizeKnowledgeText(entry.text, NOTE_LIMITS.maxLineChars).replace(LONE_SURROGATE, "\ufffd");
    if (!text) continue;
    if (text.length > budget) {
      if (budget < NOTES_SUMMARY_LIMITS.minTruncatedCharacters) break;
      text = `${sliceNoteText(text, budget - 1).trimEnd()}…`;
    }
    budget -= text.length;
    const offsetSeconds = validOffset(entry.offsetSeconds);
    out.push({ id: entry.id, text, at: formatNoteOffset(offsetSeconds), offsetSeconds, nearSegmentIds: near?.get(entry.id) || [] });
  }
  return out;
};

/**
 * sha256 of what a summary can see of the notes (ids, text and offsets in order). Notes that
 * are absent or empty share one digest. Titles, revisions and wall-clock times are not included.
 */
export const notesDigest = (notes: { entries: readonly Pick<NoteEntry, "id" | "text" | "offsetSeconds">[] } | undefined | null): string =>
  createHash("sha256")
    .update(JSON.stringify(["falatrace-notes", 1, (notes?.entries || []).map((entry) => [entry.id, entry.text, entry.offsetSeconds ?? null])]))
    .digest("hex");
