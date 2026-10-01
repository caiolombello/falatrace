import type { Transcript } from "../jobs/types";

export type DiarizationTurn = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};

export type AlignedCanonicalSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  reviewRequired?: boolean;
  charStart: number;
  charEnd: number;
};

export type CanonicalAlignment = {
  text: string;
  segments: AlignedCanonicalSegment[];
  matchedTokenRatio: number;
  unassignedTokenCount: number;
};

type Token = { value: string; start: number; end: number; index: number };
type Anchor = { tokenStart: number; tokenEnd: number; charStart: number; charEnd: number; turn: DiarizationTurn };

const TOKEN = /[\p{L}\p{N}]+/gu;
const normalize = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("und");

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ value: normalize(match[0]), start, end: start + match[0].length, index: tokens.length });
  }
  return tokens;
};

const occurrences = (canonical: Token[], wanted: string[], from: number, until = canonical.length): number[] => {
  if (!wanted.length) return [];
  const result: number[] = [];
  for (let i = Math.max(0, from); i <= Math.min(canonical.length - wanted.length, until - wanted.length); i += 1) {
    let equal = true;
    for (let j = 0; j < wanted.length; j += 1) {
      if (canonical[i + j]!.value !== wanted[j]) { equal = false; break; }
    }
    if (equal) result.push(i);
    if (result.length > 1) break;
  }
  return result;
};

const bestPartialOccurrence = (canonical: Token[], wanted: string[], from: number, until = canonical.length): { start: number; length: number } | null => {
  let best: { start: number; length: number } | null = null;
  let tied = false;
  for (let i = Math.max(0, from); i < Math.min(canonical.length, until); i += 1) {
    if (canonical[i]!.value !== wanted[0]) continue;
    let length = 0;
    while (i + length < Math.min(canonical.length, until) && length < wanted.length && canonical[i + length]!.value === wanted[length]) length += 1;
    if (!best || length > best.length) { best = { start: i, length }; tied = false; }
    else if (length === best.length) tied = true;
  }
  if (!best || wanted.length < 3 || best.length < 3 || best.length / wanted.length < 0.8 || tied) return null;
  return best;
};

const extendPunctuation = (text: string, end: number): number => {
  let result = end;
  while (result < text.length && !/\s/u.test(text[result]!)) result += 1;
  return result;
};

export const alignCanonicalTranscript = (
  canonical: Transcript,
  turns: DiarizationTurn[]
): CanonicalAlignment => {
  const text = canonical.text;
  const canonicalTokens = tokenize(text);
  const windows: Array<{ start: number; end: number; tokenStart: number; tokenEnd: number }> = [];
  let windowToken = 0;
  for (const block of canonical.segments) {
    const blockTokens = tokenize(block.text);
    const tokenStart = windowToken;
    windowToken += blockTokens.length;
    if (Number.isFinite(block.start) && Number.isFinite(block.end) && block.end >= block.start && blockTokens.length > 0) {
      windows.push({ start: block.start, end: block.end, tokenStart, tokenEnd: windowToken });
    }
  }
  const allowedWindow = (turn: DiarizationTurn): { start: number; end: number } => {
    const matching = windows.filter((window) => window.end > turn.start && window.start < turn.end);
    if (windowToken !== canonicalTokens.length) return { start: 0, end: canonicalTokens.length };
    if (!matching.length) return { start: 0, end: 0 };
    return { start: matching[0]!.tokenStart, end: matching[matching.length - 1]!.tokenEnd };
  };
  const anchors: Anchor[] = [];
  let cursor = 0;
  for (const turn of turns) {
    if (!Number.isFinite(turn.start) || !Number.isFinite(turn.end) || turn.end < turn.start || typeof turn.speaker !== "string" || !turn.speaker) continue;
    const wanted = tokenize(turn.text).map((token) => token.value);
    if (!wanted.length) continue;
    const window = allowedWindow(turn);
    const from = Math.max(cursor, window.start);
    const exact = occurrences(canonicalTokens, wanted, from, window.end);
    let tokenStart: number | undefined;
    let tokenLength = wanted.length;
    if (exact.length === 1 && wanted.length >= 3) tokenStart = exact[0];
    else if (exact.length === 0) {
      const partial = bestPartialOccurrence(canonicalTokens, wanted, from, window.end);
      if (partial) { tokenStart = partial.start; tokenLength = partial.length; }
    }
    if (tokenStart === undefined) continue;
    const tokenEnd = tokenStart + tokenLength;
    const previous = anchors[anchors.length - 1];
    if (previous && tokenStart < previous.tokenEnd) continue;
    anchors.push({
      tokenStart,
      tokenEnd,
      charStart: canonicalTokens[tokenStart]!.start,
      charEnd: extendPunctuation(text, canonicalTokens[tokenEnd - 1]!.end),
      turn
    });
    cursor = tokenEnd;
  }

  const segments: AlignedCanonicalSegment[] = [];
  const add = (charStart: number, charEnd: number, start: number, end: number, speaker?: string, reviewRequired = false): void => {
    if (charStart >= charEnd) return;
    segments.push({ start, end: Math.max(start, end), text: text.slice(charStart, charEnd), ...(speaker ? { speaker } : {}), ...(reviewRequired ? { reviewRequired: true } : {}), charStart, charEnd });
  };
  let charCursor = 0;
  let previousEnd = 0;
  for (const [index, anchor] of anchors.entries()) {
    const nextTime = anchor.turn.start;
    const gap = text.slice(charCursor, anchor.charStart);
    let displayStart = anchor.charStart;
    if (gap.trim()) add(charCursor, anchor.charStart, previousEnd, nextTime, undefined, true);
    else if (gap && segments.length > 0) {
      const last = segments[segments.length - 1]!;
      last.charEnd = anchor.charStart;
      last.text = text.slice(last.charStart, last.charEnd);
    } else if (gap) displayStart = charCursor;
    add(displayStart, anchor.charEnd, anchor.turn.start, anchor.turn.end, anchor.turn.speaker, true);
    charCursor = anchor.charEnd;
    previousEnd = anchor.turn.end;
    if (index === anchors.length - 1) {
      const tail = text.slice(charCursor);
      if (tail.trim()) add(charCursor, text.length, anchor.turn.end, anchor.turn.end, undefined, true);
      else if (tail && segments.length > 0) {
        const last = segments[segments.length - 1]!;
        last.charEnd = text.length;
        last.text = text.slice(last.charStart, last.charEnd);
      }
    }
  }
  if (anchors.length === 0) {
    const fallback = turns.find((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end >= turn.start);
    add(0, text.length, fallback?.start ?? 0, fallback?.end ?? fallback?.start ?? 0, undefined, text.length > 0);
  }
  const matchedTokenCount = anchors.reduce((total, anchor) => total + anchor.tokenEnd - anchor.tokenStart, 0);
  return {
    text,
    segments,
    matchedTokenRatio: canonicalTokens.length ? matchedTokenCount / canonicalTokens.length : 1,
    unassignedTokenCount: Math.max(0, canonicalTokens.length - matchedTokenCount)
  };
};
