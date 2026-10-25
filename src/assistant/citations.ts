import type { ChatAnswer, ChatCitation } from "./types";

/**
 * Checks the segment markers an answer carries against what was actually sent. A marker that
 * points to nothing sent is removed from the text and reported, never repaired by guessing.
 */

/** A marker that was sent with the question: `s000123` (one meeting) or `m2:s000123` (several). */
export type ContextRef = { jobId: string; segmentId: string; start?: number; end?: number; title: string };

const MAX_TEXT = 200_000;
const MAX_CITATIONS = 500;
const MAX_DROPPED = 100;

// [[...]] or [...] (not a markdown link), without nested brackets or line breaks.
const GROUP = /\[\[([^[\]\n]{1,400})\]\]|\[([^[\]\n]{1,400})\](?!\()/g;
const MARKER = /^(?:m0*(\d{1,4}):)?s(\d{6})$/i;
const ECHOED_LINE = /^((?:m0*\d{1,4}:)?s\d{6})\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s.*)?$/i;
const CONNECTORS = new Set(["e", "and", "y", "&"]);

/** Parsed markers of one bracket group, or undefined when the group is ordinary text. */
const groupMarkers = (content: string): string[] | undefined => {
  const compact = content.trim().replace(/\s*:\s*/g, ":");
  const echoed = ECHOED_LINE.exec(compact);
  if (echoed) return [echoed[1]!];
  const tokens = compact.split(/[\s,;]+/).filter((token) => token && !CONNECTORS.has(token.toLowerCase()));
  if (!tokens.length || tokens.length > 50 || !tokens.every((token) => MARKER.test(token))) return undefined;
  return tokens;
};

const resolver = (refs: ReadonlyMap<string, ContextRef>) => {
  const keys = [...refs.keys()];
  const prefixed = keys.some((key) => key.includes(":"));
  return (meeting: string | undefined, segment: string): { key?: string; written: string } => {
    const written = meeting ? `m${meeting}:s${segment}` : `s${segment}`;
    if (refs.has(written)) return { key: written, written };
    if (!meeting) {
      // A bare id is accepted only when exactly one sent meeting has that segment.
      const matches = keys.filter((key) => key.endsWith(`:s${segment}`));
      return matches.length === 1 ? { key: matches[0], written } : { written };
    }
    // One meeting was sent with bare ids, but the model added a meeting label.
    if (!prefixed && refs.has(`s${segment}`)) return { key: `s${segment}`, written };
    return { written };
  };
};

/** Validated answer: known markers normalized to `[[ref]]`, unknown ones removed and listed. */
export const extractCitations = (input: string, refs: ReadonlyMap<string, ContextRef>): ChatAnswer => {
  const text = typeof input === "string" ? input.slice(0, MAX_TEXT) : "";
  const resolve = resolver(refs);
  const citations: ChatCitation[] = [];
  const cited = new Set<string>();
  const dropped = new Set<string>();
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(GROUP)) {
    const markers = groupMarkers(match[1] ?? match[2]!);
    if (!markers) continue;
    const start = match.index!;
    output += text.slice(cursor, start);
    cursor = start + match[0].length;
    let inherited: string | undefined;
    const kept: string[] = [];
    for (const marker of markers) {
      const parsed = MARKER.exec(marker)!;
      // "m2:s000123, s000124" means both are in m2.
      const meeting = parsed[1] ? String(Number(parsed[1])) : inherited;
      if (parsed[1]) inherited = meeting;
      const { key, written } = resolve(meeting, parsed[2]!);
      if (!key) { if (dropped.size < MAX_DROPPED) dropped.add(written.toLowerCase()); continue; }
      if (!kept.includes(key)) kept.push(key);
      if (!cited.has(key) && citations.length < MAX_CITATIONS) {
        const ref = refs.get(key)!;
        cited.add(key);
        citations.push({ ref: key, jobId: ref.jobId, segmentId: ref.segmentId, ...(ref.start !== undefined ? { start: ref.start } : {}),
          ...(ref.end !== undefined ? { end: ref.end } : {}), title: ref.title });
      }
    }
    if (kept.length) {
      output += kept.map((key) => `[[${key}]]`).join("");
    } else {
      // Do not leave a gap before punctuation or at the end of a line.
      const next = text.charAt(cursor);
      if (/[ \t]$/.test(output) && (next === "" || /[\s.,;:!?)]/.test(next))) output = output.replace(/[ \t]+$/, "");
    }
  }
  output += text.slice(cursor);
  return { text: output, citations, droppedRefs: [...dropped] };
};

/**
 * While an answer streams, hides a marker that is still being written at the very end, including
 * `[[m2:s000123]` with only its first closing bracket (shown as is, it would read `[[[m2:s000123]]`).
 */
export const stripPartialMarker = (text: string): string => text.replace(/\[\[?[^[\]\n]{0,40}\]?$/, (tail) =>
  /^\[\[\s*(?:m\d{0,4}\s*:?\s*)?(?:s\d{0,6})?\s*\]?$|^\[\s*(?:m\d{0,4}\s*:?\s*)?(?:s\d{0,6})?$/i.test(tail) ? "" : tail);

/** Removes every marker, for passing earlier answers back as history (their labels no longer apply). */
export const stripMarkers = (text: string): string => {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(GROUP)) {
    if (!groupMarkers(match[1] ?? match[2]!)) continue;
    output += text.slice(cursor, match.index!);
    cursor = match.index! + match[0].length;
  }
  return (output + text.slice(cursor)).replace(/[ \t]+([.,;:!?])/g, "$1");
};
