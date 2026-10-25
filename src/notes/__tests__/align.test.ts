import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../../jobs/types";
import {
  NOTE_ALIGNMENT, NOTES_SUMMARY_LIMITS, alignNotesToSegments, formatNoteOffset, notesDigest, notesForSummary, segmentIdAt,
  type AlignableSegment
} from "../align";
import { noteEntryId, type NoteEntry } from "../lines";

const entry = (seq: number, text: string, offsetSeconds: number | null, createdAt = "2026-10-25T10:00:00.000Z"): NoteEntry =>
  ({ id: noteEntryId(seq), createdAt, offsetSeconds, text });

/** 10-second segments s000000.. from 0 s to `count`×10 s. */
const evenSegments = (count: number): TranscriptSegment[] =>
  Array.from({ length: count }, (_, index) => ({ start: index * 10, end: index * 10 + 10, text: `segmento ${index}` }));

describe("formatNoteOffset", () => {
  test("formats mm:ss under an hour and h:mm:ss past it", () => {
    expect(formatNoteOffset(0)).toBe("00:00");
    expect(formatNoteOffset(65.9)).toBe("01:05");
    expect(formatNoteOffset(3599.9)).toBe("59:59");
    expect(formatNoteOffset(3600)).toBe("1:00:00");
    expect(formatNoteOffset(2 * 3600 + 5 * 60 + 7)).toBe("2:05:07");
  });

  test("untimed or invalid offsets have no time", () => {
    for (const value of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 10 * 86_400]) expect(formatNoteOffset(value)).toBeNull();
  });
});

describe("alignNotesToSegments", () => {
  test("picks segments overlapping [offset − 90 s, offset + 10 s], nearest first, at most four", () => {
    const near = alignNotesToSegments([entry(1, "nota", 300)], evenSegments(60));
    // 300 s sits on the boundary of s000029 (290–300) and s000030 (300–310): both contain it.
    expect(near.get("n000001")).toEqual(["s000029", "s000030", "s000028", "s000031"]);
  });

  test("prefers the segment just before the note on equal distance (notes follow what was said)", () => {
    const segments: AlignableSegment[] = [{ start: 100, end: 104 }, { start: 110, end: 114 }];
    expect(alignNotesToSegments([entry(1, "n", 107)], segments).get("n000001")).toEqual(["s000000", "s000001"]);
  });

  test("window edges are inclusive and nothing outside is returned", () => {
    const segments: AlignableSegment[] = [
      { id: "early", start: 0, end: 9.9 }, { id: "edge-before", start: 5, end: 10 }, { id: "edge-after", start: 110, end: 120 },
      { id: "late", start: 110.1, end: 115 }
    ];
    expect(alignNotesToSegments([entry(1, "n", 100)], segments).get("n000001")).toEqual(["edge-after", "edge-before"]);
  });

  test("a long segment that started well before the window still counts when it overlaps", () => {
    const segments: AlignableSegment[] = [{ start: 0, end: 500 }, ...Array.from({ length: 30 }, (_, index) => ({ start: 500 + index * 5, end: 505 + index * 5 }))];
    const near = alignNotesToSegments([entry(1, "n", 400)], segments).get("n000001");
    expect(near?.[0]).toBe("s000000");
  });

  test("works with unsorted segments, explicit ids and reviewed-segment shapes", () => {
    const segments = [
      { id: "s000002", start: 50, end: 60, text: "c" }, { id: "s000000", start: 0, end: 10, text: "a" }, { id: "s000001", start: 40, end: 50, text: "b" }
    ];
    expect(alignNotesToSegments([entry(1, "n", 61)], segments).get("n000001")).toEqual(["s000002", "s000001", "s000000"]);
  });

  test("untimed notes, empty transcripts and invalid segments give no segments", () => {
    const segments = [
      { start: Number.NaN, end: 1 }, { start: 5, end: 4 }, { id: "../etc", start: 0, end: 10 }, { id: "", start: 0, end: 10 }, { start: 0, end: 10 }
    ] as AlignableSegment[];
    const near = alignNotesToSegments([entry(1, "a", null), entry(2, "b", 5)], segments);
    expect(near.get("n000001")).toEqual([]);
    expect(near.get("n000002")).toEqual(["s000004"]);
    expect(alignNotesToSegments([entry(3, "c", 5)], []).get("n000003")).toEqual([]);
  });

  test("custom window and limit", () => {
    const near = alignNotesToSegments([entry(1, "n", 300)], evenSegments(60), { beforeSeconds: 5, afterSeconds: 0, maxSegments: 10 });
    expect(near.get("n000001")).toEqual(["s000029", "s000030"]);
  });

  test("handles a long transcript and many notes quickly", () => {
    const segments = evenSegments(50_000);
    const notes = Array.from({ length: 500 }, (_, index) => entry(index + 1, `n${index}`, index * 170));
    const started = performance.now();
    const near = alignNotesToSegments(notes, segments);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(near.get("n000500")?.length).toBe(NOTE_ALIGNMENT.maxSegments);
  });

  test("segment ids follow the transcript position format", () => {
    expect(segmentIdAt(0)).toBe("s000000");
    expect(segmentIdAt(123)).toBe("s000123");
  });
});

describe("notesForSummary", () => {
  test("returns sanitized notes with time and nearby segments, in notepad order", () => {
    const notes = { entries: [entry(1, "# Pauta", null), entry(2, "  - Falar com ana@example.com sobre sk-abcdefghijklmnopqrstuvwx", 125.4)] };
    expect(notesForSummary(notes, evenSegments(30))).toEqual([
      { id: "n000001", text: "# Pauta", at: null, offsetSeconds: null, nearSegmentIds: [] },
      {
        id: "n000002", text: "- Falar com [e-mail omitido] sobre [credencial omitida]", at: "02:05", offsetSeconds: 125.4,
        // s000012 contains 125.4 s; s000013 starts 4.6 s later; s000011 ended 5.4 s before; s000014 is past +10 s.
        nearSegmentIds: ["s000012", "s000013", "s000011", "s000010"]
      }
    ]);
  });

  test("without segments there are no nearby ids; without notes there is nothing", () => {
    expect(notesForSummary({ entries: [entry(1, "a", 10)] })[0].nearSegmentIds).toEqual([]);
    expect(notesForSummary(undefined)).toEqual([]);
    expect(notesForSummary(null, evenSegments(3))).toEqual([]);
  });

  test("caps the number of notes at 200", () => {
    const entries = Array.from({ length: 450 }, (_, index) => entry(index + 1, `nota ${index}`, index));
    const out = notesForSummary({ entries });
    expect(out).toHaveLength(NOTES_SUMMARY_LIMITS.maxEntries);
    expect(out[199].id).toBe("n000200");
  });

  test("caps the total text at 16k characters, truncating the last note when worthwhile", () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(index + 1, `${index}${"x".repeat(1999)}`, null));
    const out = notesForSummary({ entries });
    const total = out.reduce((sum, note) => sum + note.text.length, 0);
    expect(total).toBeLessThanOrEqual(NOTES_SUMMARY_LIMITS.maxCharacters);
    expect(out).toHaveLength(8);
    expect(out[7].text.length).toBe(2000);
    const tight = Array.from({ length: 9 }, (_, index) => entry(index + 1, index === 8 ? "y".repeat(500) : "x".repeat(1980), null));
    const truncated = notesForSummary({ entries: tight });
    expect(truncated).toHaveLength(9);
    expect(truncated[8].text.endsWith("…")).toBe(true);
    expect(truncated.reduce((sum, note) => sum + note.text.length, 0)).toBe(NOTES_SUMMARY_LIMITS.maxCharacters);
  });

  test("leaves out a last note that would be cut to almost nothing", () => {
    const entries = [entry(1, "x".repeat(2000), null)];
    for (let index = 2; index <= 8; index++) entries.push(entry(index, "x".repeat(1990), null));
    entries.push(entry(9, "y".repeat(500), null));
    const out = notesForSummary({ entries });
    expect(out.map((note) => note.id)).not.toContain("n000009");
  });

  test("skips malformed entries and notes that sanitize to nothing", () => {
    const entries = [
      entry(1, "ok", 1), { id: "x1", createdAt: "", offsetSeconds: 1, text: "bad id" }, entry(3, "   ", 2), entry(4, "fim", Number.NaN)
    ] as NoteEntry[];
    expect(notesForSummary({ entries }).map((note) => [note.id, note.at])).toEqual([["n000001", "00:01"], ["n000004", null]]);
  });

  test("never sends half of an emoji: truncation keeps surrogate pairs whole and stray halves are replaced", () => {
    const loneHalf = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // 7 × 2000 + 1898 characters leave a budget of 102: a plain cut at 101 would end on a high surrogate.
    const entries = [
      ...Array.from({ length: 7 }, (_, index) => entry(index + 1, "x".repeat(2000), null)),
      entry(8, "y".repeat(1898), null),
      entry(9, "😀".repeat(1000), 5)
    ];
    const out = notesForSummary({ entries });
    expect(out).toHaveLength(9);
    expect(out[8].text).toBe(`${"😀".repeat(50)}…`);
    expect(out.reduce((sum, note) => sum + note.text.length, 0)).toBeLessThanOrEqual(NOTES_SUMMARY_LIMITS.maxCharacters);
    // Masking e-mails makes this line longer than 2000, so the sanitizer's own cut lands inside a pair.
    const masked = notesForSummary({ entries: [entry(1, `${"a@b.co ".repeat(49)}${"😀".repeat(800)}`, 1), entry(2, `ok ${"\ud83d"} fim`, 2)] });
    expect(masked.map((note) => loneHalf.test(note.text))).toEqual([false, false]);
    expect(masked[1].text).toBe("ok \ufffd fim");
  });
});

describe("notesDigest", () => {
  const base = { entries: [entry(1, "# Pauta", null), entry(2, "Ligar", 30)] };

  test("is a stable sha256 of ids, text and offsets", () => {
    expect(notesDigest(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(notesDigest(base)).toBe(notesDigest(structuredClone(base)));
  });

  test("changes with text, offset, id or order", () => {
    const digest = notesDigest(base);
    expect(notesDigest({ entries: [base.entries[0], { ...base.entries[1], text: "Ligar!" }] })).not.toBe(digest);
    expect(notesDigest({ entries: [base.entries[0], { ...base.entries[1], offsetSeconds: 31 }] })).not.toBe(digest);
    expect(notesDigest({ entries: [base.entries[0], { ...base.entries[1], id: "n000003" }] })).not.toBe(digest);
    expect(notesDigest({ entries: [base.entries[1], base.entries[0]] })).not.toBe(digest);
  });

  test("ignores wall-clock creation times and metadata; absent and empty notes share one digest", () => {
    const moved = { entries: base.entries.map((item) => ({ ...item, createdAt: "2030-01-01T00:00:00.000Z" })), title: "outro", rev: 9 };
    expect(notesDigest(moved)).toBe(notesDigest(base));
    expect(notesDigest(undefined)).toBe(notesDigest({ entries: [] }));
    expect(notesDigest(null)).toBe(notesDigest(undefined));
  });
});
