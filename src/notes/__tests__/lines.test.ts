import { describe, expect, test } from "bun:test";
import {
  NOTE_LIMITS, NOTE_MATCHING, NOTES_ERRORS, NOTES_KNOWN_ERRORS, classifyNoteLine, isCanonicalNoteLine, matchNoteLines, mediaOffsetSeconds,
  noteEntryId, noteHeadings, noteLineSimilarity, notesText, parseNoteLine, rebaseNoteOffsets, reconcileNoteEntries, sliceNoteText,
  splitNoteLines, type NoteEntry
} from "../lines";

const char = (code: number): string => String.fromCharCode(code);
const START = "2026-10-25T10:00:00.000Z";
const at = (seconds: number): Date => new Date(Date.parse(START) + seconds * 1000);

/** Each new line described as "<new text> <- <old text>|NEW". */
const describeMatch = (oldLines: string[], newLines: string[]): string[] => {
  const { oldIndex } = matchNoteLines(oldLines, newLines);
  return newLines.map((line, index) => `${line} <- ${oldIndex[index] >= 0 ? oldLines[oldIndex[index]] : "NEW"}`);
};

describe("splitNoteLines", () => {
  test("splits every line break style, trims the right side and drops blank lines", () => {
    const text = `# Pauta\r\n\r\n- item um   \r\n  - sub item\n\n[ ] Ligar\rnona${char(0x2028)}decima${char(0x2029)}onze${char(0x0b)}doze${char(0x0c)}treze${char(0x85)}catorze\n   \t \n`;
    expect(splitNoteLines(text)).toEqual(["# Pauta", "- item um", "  - sub item", "[ ] Ligar", "nona", "decima", "onze", "doze", "treze", "catorze"]);
  });

  test("CRLF input gives the same lines as LF input", () => {
    const lines = ["# Decisões", "- Fechar escopo", "[x] Enviar ata"];
    expect(splitNoteLines(lines.join("\r\n"))).toEqual(lines);
    expect(splitNoteLines(`${lines.join("\r\n")}\r\n`)).toEqual(lines);
  });

  test("keeps markdown prefixes and leading indentation, drops a leading BOM and control characters", () => {
    expect(splitNoteLines(`${char(0xfeff)}# Título`)).toEqual(["# Título"]);
    expect(splitNoteLines(`a${char(0)}b${char(7)}c${char(0x1b)}[31md${char(0x9b)}e\tf`)).toEqual(["abc[31mde\tf"]);
    expect(splitNoteLines(`${char(7)}${char(0)}\n- [ ] ação`)).toEqual(["- [ ] ação"]);
  });

  test("normalizes to NFC so the same visible text compares equal", () => {
    const decomposed = "Reunião".normalize("NFD");
    expect(splitNoteLines(decomposed)).toEqual(["Reunião".normalize("NFC")]);
  });

  test("accepts a line of exactly 2000 characters and rejects 2001 with a clear error", () => {
    expect(splitNoteLines("x".repeat(2000))).toEqual(["x".repeat(2000)]);
    expect(splitNoteLines(`${"x".repeat(2000)}      `)).toEqual(["x".repeat(2000)]);
    expect(() => splitNoteLines(`ok\n${"x".repeat(2001)}`)).toThrow(NOTES_ERRORS.lineTooLong);
  });

  test("accepts 500 lines and rejects 501", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `linha ${index}`);
    expect(splitNoteLines(lines.join("\n"))).toHaveLength(500);
    expect(() => splitNoteLines([...lines, "mais uma"].join("\n"))).toThrow(NOTES_ERRORS.tooManyLines);
  });

  test("blank lines do not count toward the 500 line limit", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `linha ${index}`);
    expect(splitNoteLines(lines.join("\n\n\n"))).toHaveLength(500);
  });

  test("rejects more than 64 KiB of text, counted in UTF-8 bytes", () => {
    const line = "é".repeat(1000); // 2000 bytes each
    expect(() => splitNoteLines(Array.from({ length: 33 }, () => line).join("\n"))).toThrow(NOTES_ERRORS.tooLarge);
    expect(splitNoteLines(Array.from({ length: 32 }, () => line).join("\n"))).toHaveLength(32);
  });

  test("rejects non-string input and absurdly large raw input before splitting", () => {
    expect(() => splitNoteLines(undefined)).toThrow(NOTES_ERRORS.invalidText);
    expect(() => splitNoteLines(42)).toThrow(NOTES_ERRORS.invalidText);
    expect(() => splitNoteLines(" ".repeat(NOTE_LIMITS.maxInputChars + 1))).toThrow(NOTES_ERRORS.tooLarge);
    expect(splitNoteLines("")).toEqual([]);
    expect(splitNoteLines("\n \n\t\n")).toEqual([]);
  });
});

describe("line kinds", () => {
  test("classifies headings, actions, bullets and text", () => {
    const cases: Array<[string, string]> = [
      ["# Pauta", "heading"], ["### Riscos", "heading"], ["#hashtag", "text"], ["#", "text"], ["####### sete", "text"],
      ["[ ] Ligar", "action"], ["[x] Feito", "action"], ["[X] Feito", "action"], ["[] Granola", "action"], ["- [ ] Ligar", "action"],
      ["* [x] Ligar", "action"], ["  - [ ] indentado", "action"], ["[ ]", "action"], ["[link](http://x)", "text"],
      ["- item", "bullet"], ["* item", "bullet"], ["+ item", "bullet"], ["• item", "bullet"], ["1. item", "bullet"], ["2) item", "bullet"],
      ["  - sub", "bullet"], ["*itálico*", "text"], ["-5 graus", "text"], ["1.5 litros", "text"], ["-", "text"], ["texto livre", "text"]
    ];
    for (const [line, kind] of cases) expect(`${line} => ${classifyNoteLine(line)}`).toBe(`${line} => ${kind}`);
  });

  test("parses the body, heading level and checkbox state", () => {
    expect(parseNoteLine("## Próximos passos")).toEqual({ kind: "heading", body: "Próximos passos", level: 2 });
    expect(parseNoteLine("- [x] Enviar ata")).toEqual({ kind: "action", body: "Enviar ata", done: true });
    expect(parseNoteLine("[ ] Ligar")).toEqual({ kind: "action", body: "Ligar", done: false });
    expect(parseNoteLine("* item")).toEqual({ kind: "bullet", body: "item" });
    expect(parseNoteLine("  solto")).toEqual({ kind: "text", body: "solto" });
  });

  test("noteHeadings lists heading texts in order, bounded", () => {
    const entries = ["# Contexto", "- a", "## Riscos", "#tag", `# ${"x".repeat(300)}`].map((text) => ({ text }));
    expect(noteHeadings({ entries })).toEqual(["Contexto", "Riscos", "x".repeat(120)]);
    expect(noteHeadings({ entries }, 1)).toEqual(["Contexto"]);
    expect(noteHeadings(undefined)).toEqual([]);
    // The 120-character bound never leaves half of an emoji behind.
    expect(noteHeadings({ entries: [{ text: `# ${"x".repeat(119)}😀` }] })).toEqual(["x".repeat(119)]);
    expect(sliceNoteText("ab😀", 3)).toBe("ab");
    expect(sliceNoteText("ab😀", 4)).toBe("ab😀");
    expect(sliceNoteText("abc", 2)).toBe("ab");
  });

  test("notesText renders one entry per line and round-trips through splitNoteLines", () => {
    const entries = ["# Pauta", "  - sub", "[ ] Ligar"].map((text) => ({ text }));
    expect(notesText({ entries })).toBe("# Pauta\n  - sub\n[ ] Ligar");
    expect(splitNoteLines(notesText({ entries }))).toEqual(entries.map((entry) => entry.text));
    expect(notesText(null)).toBe("");
  });

  test("canonical lines are single, trimmed on the right, free of control characters and not blank", () => {
    expect(isCanonicalNoteLine("  - ok")).toBe(true);
    expect(isCanonicalNoteLine("tab\tinside")).toBe(true);
    for (const bad of ["", "   ", "a ", "a\nb", "a\rb", `a${char(0x2028)}b`, `a${char(0)}`, "x".repeat(2001), 5]) {
      expect(isCanonicalNoteLine(bad)).toBe(false);
    }
  });

  test("known errors are exported in Portuguese", () => {
    expect(NOTES_KNOWN_ERRORS).toContain("As notas mudaram em outra janela; recarregue antes de salvar.");
    expect(NOTES_KNOWN_ERRORS).toContain(NOTES_ERRORS.lineTooLong);
    expect(new Set(NOTES_KNOWN_ERRORS).size).toBe(NOTES_KNOWN_ERRORS.length);
  });
});

describe("matchNoteLines", () => {
  test("identical text keeps every line", () => {
    const lines = ["# Pauta", "- a", "- b"];
    expect(matchNoteLines(lines, lines)).toEqual({ oldIndex: [0, 1, 2], kind: ["same", "same", "same"] });
  });

  test("a typo fix in the middle is an edit of the same line", () => {
    const result = matchNoteLines(["# Pauta", "Ligar pro Joao", "- prazo sexta"], ["# Pauta", "Ligar pro João", "- prazo sexta"]);
    expect(result).toEqual({ oldIndex: [0, 1, 2], kind: ["same", "edited", "same"] });
  });

  test("a line inserted in the middle is new and the others keep their identity", () => {
    expect(matchNoteLines(["A linha", "B linha", "C linha"], ["A linha", "N nova", "B linha", "C linha"]))
      .toEqual({ oldIndex: [0, -1, 1, 2], kind: ["same", "new", "same", "same"] });
  });

  test("deleting a line keeps the others", () => {
    expect(matchNoteLines(["A linha", "B linha", "C linha"], ["A linha", "C linha"])).toEqual({ oldIndex: [0, 2], kind: ["same", "same"] });
    expect(matchNoteLines(["A linha"], [])).toEqual({ oldIndex: [], kind: [] });
  });

  test("reordered lines keep their identity", () => {
    expect(matchNoteLines(["A linha", "B linha", "C linha"], ["C linha", "A linha", "B linha"]))
      .toEqual({ oldIndex: [2, 0, 1], kind: ["moved", "same", "same"] });
    expect(matchNoteLines(["A", "B", "C", "D"], ["D", "C", "B", "A"]).oldIndex).toEqual([3, 2, 1, 0]);
  });

  test("a moved line next to an edited one does not break the edit, whichever way the line moves", () => {
    expect(describeMatch(["Alpha um", "Beta dois", "Gama tres"], ["Gama tres", "Alpha um", "Beta dois!"]))
      .toEqual(["Gama tres <- Gama tres", "Alpha um <- Alpha um", "Beta dois! <- Beta dois"]);
    expect(describeMatch(["Alpha um", "Beta dois", "Gama tres"], ["Beta dois!", "Gama tres", "Alpha um"]))
      .toEqual(["Beta dois! <- Beta dois", "Gama tres <- Gama tres", "Alpha um <- Alpha um"]);
  });

  test("duplicate lines: deleting one keeps one identity, adding one creates a new line", () => {
    const deleted = matchNoteLines(["- ok", "- ok", "fim"], ["- ok", "fim"]);
    expect(deleted.kind).toEqual(["same", "same"]);
    expect([0, 1]).toContain(deleted.oldIndex[0]);
    expect(deleted.oldIndex[1]).toBe(2);
    expect(matchNoteLines(["- ok", "fim"], ["- ok", "- ok", "fim"]))
      .toEqual({ oldIndex: [0, -1, 1], kind: ["same", "new", "same"] });
    expect(new Set(matchNoteLines(["x", "x", "x"], ["x", "x", "x"]).oldIndex)).toEqual(new Set([0, 1, 2]));
  });

  test("pasting many lines next to a typo fix: only the fixed line inherits", () => {
    const pasted = Array.from({ length: 40 }, (_, index) => `colado ${index}`);
    const result = matchNoteLines(["inicio", "Ligar pro Joao sobre contrato", "fim"], ["inicio", ...pasted, "Ligar pro João sobre o contrato", "fim"]);
    expect(result.oldIndex[0]).toBe(0);
    expect(result.oldIndex.slice(1, 41).every((index) => index === -1)).toBe(true);
    expect(result.oldIndex[41]).toBe(1);
    expect(result.kind[41]).toBe("edited");
    expect(result.oldIndex[42]).toBe(2);
  });

  test("pasting many lines into an empty notepad makes them all new", () => {
    const pasted = Array.from({ length: 300 }, (_, index) => `linha colada ${index}`);
    const result = matchNoteLines([], pasted);
    expect(result.oldIndex.every((index) => index === -1)).toBe(true);
    expect(result.kind.every((kind) => kind === "new")).toBe(true);
  });

  test("toggling a checkbox, re-indenting or changing the bullet is an edit", () => {
    expect(describeMatch(["- [ ] Enviar proposta", "x"], ["- [x] Enviar proposta", "x"])).toEqual(["- [x] Enviar proposta <- - [ ] Enviar proposta", "x <- x"]);
    expect(describeMatch(["a", "- item", "b"], ["a", "  * item", "b"])).toEqual(["a <- a", "  * item <- - item", "b <- b"]);
  });

  test("an in-place rewrite of a single line is still an edit (same gap, same count)", () => {
    expect(describeMatch(["a", "Ligar", "c"], ["a", "Enviar proposta", "c"])).toEqual(["a <- a", "Enviar proposta <- Ligar", "c <- c"]);
  });

  test("typing a line char by char keeps the first moment it was typed", () => {
    expect(describeMatch(["Li"], ["Ligar pro João amanhã às 10h", "outra"])).toEqual(["Ligar pro João amanhã às 10h <- Li", "outra <- NEW"]);
  });

  test("a deleted line next to an edited line does not steal the edit", () => {
    expect(describeMatch(["a", "Xis deletado", "Yps editado", "c"], ["a", "Yps editado!", "Zeta nova", "c"]))
      .toEqual(["a <- a", "Yps editado! <- Yps editado", "Zeta nova <- NEW", "c <- c"]);
  });

  test("splitting and joining lines keep the first part's identity", () => {
    expect(describeMatch(["foo bar baz qux"], ["foo bar", "baz qux"])).toEqual(["foo bar <- foo bar baz qux", "baz qux <- NEW"]);
    expect(describeMatch(["foo bar", "baz qux"], ["foo bar baz qux"])).toEqual(["foo bar baz qux <- foo bar"]);
  });

  test("unrelated lines in a gap with different counts are not treated as edits", () => {
    expect(describeMatch(["a", "Comprar café", "b"], ["a", "Revisar orçamento", "Marcar retro", "b"]))
      .toEqual(["a <- a", "Revisar orçamento <- NEW", "Marcar retro <- NEW", "b <- b"]);
  });

  test("a gap too large to compare only pairs by position when counts are equal", () => {
    const side = Math.ceil(Math.sqrt(NOTE_MATCHING.maxGapPairs)) + 1;
    const olds = Array.from({ length: side }, (_, index) => `velha ${index}`);
    const news = Array.from({ length: side }, (_, index) => `nova ${index}`);
    expect(matchNoteLines(olds, news).oldIndex).toEqual(olds.map((_, index) => index));
    expect(matchNoteLines(olds, [...news, "extra"]).oldIndex.every((index) => index === -1)).toBe(true);
  });

  test("full 500 × 500 rewrite stays fast", () => {
    const olds = Array.from({ length: 500 }, (_, index) => `linha antiga número ${index} com algum texto`);
    const news = Array.from({ length: 499 }, (_, index) => `outra coisa ${index} totalmente diferente`);
    const started = performance.now();
    matchNoteLines(olds, news);
    // Just under the comparison cap: every pair of a 200 × 199 gap is scored.
    const long = (prefix: string, index: number) => `${prefix} ${index} ${"palavra ".repeat(30)}`.trimEnd();
    const scored = matchNoteLines(Array.from({ length: 200 }, (_, index) => long("velha", index)), Array.from({ length: 199 }, (_, index) => long("nova", index)));
    expect(scored.oldIndex.filter((index) => index >= 0).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("similarity ignores case, accents and markdown prefixes", () => {
    expect(noteLineSimilarity("- [ ] Ligar João", "[x] ligar joao")).toBe(1);
    expect(noteLineSimilarity("ok", "ok, confirmado com o cliente")).toBeGreaterThanOrEqual(0.8);
    expect(noteLineSimilarity("Comprar café", "Revisar orçamento")).toBeLessThan(NOTE_MATCHING.editSimilarity);
  });
});

describe("mediaOffsetSeconds", () => {
  test("is the time since the media start, rounded to 0.1 s and never negative", () => {
    expect(mediaOffsetSeconds(at(65.44), START)).toBe(65.4);
    expect(mediaOffsetSeconds(at(-30), START)).toBe(0);
    expect(mediaOffsetSeconds(at(10))).toBeNull();
    expect(mediaOffsetSeconds(at(10), "not a date")).toBeNull();
    expect(mediaOffsetSeconds(new Date(Number.NaN), START)).toBeNull();
  });

  test("notes typed long after the capture stopped are untimed; shortly after, they sit at the end", () => {
    const end = at(600).toISOString();
    expect(mediaOffsetSeconds(at(650), START, end)).toBe(600);
    expect(mediaOffsetSeconds(at(600 + NOTE_LIMITS.afterEndGraceSeconds + 1), START, end)).toBeNull();
    expect(mediaOffsetSeconds(at(300), START, end)).toBe(300);
  });

  test("an offset of more than a day is not on the media timeline", () => {
    expect(mediaOffsetSeconds(at(NOTE_LIMITS.maxOffsetSeconds + 1), START)).toBeNull();
  });
});

describe("reconcileNoteEntries", () => {
  const first = reconcileNoteEntries([], ["# Pauta", "Ligar pro Joao"], { now: at(30), mediaStartedAt: START, seq: 0 });

  test("new lines get sequential ids, now as createdAt and the media offset", () => {
    expect(first.seq).toBe(2);
    expect(first.entries).toEqual([
      { id: "n000001", createdAt: at(30).toISOString(), offsetSeconds: 30, text: "# Pauta" },
      { id: "n000002", createdAt: at(30).toISOString(), offsetSeconds: 30, text: "Ligar pro Joao" }
    ]);
  });

  test("edited and unchanged lines keep id, createdAt and offset; inserted lines are stamped now", () => {
    const second = reconcileNoteEntries(first.entries, ["# Pauta", "- novo ponto", "Ligar pro João"], { now: at(95), mediaStartedAt: START, seq: first.seq });
    expect(second.entries).toEqual([
      first.entries[0],
      { id: "n000003", createdAt: at(95).toISOString(), offsetSeconds: 95, text: "- novo ponto" },
      { ...first.entries[1], text: "Ligar pro João" }
    ]);
    expect(second.seq).toBe(3);
  });

  test("ids of deleted lines are never reused", () => {
    const deleted = reconcileNoteEntries(first.entries, ["# Pauta"], { now: at(40), mediaStartedAt: START, seq: first.seq });
    const added = reconcileNoteEntries(deleted.entries, ["# Pauta", "algo novo e diferente"], { now: at(50), mediaStartedAt: START, seq: deleted.seq });
    expect(added.entries.map((entry) => entry.id)).toEqual(["n000001", "n000003"]);
  });

  test("without a media start, new lines are untimed", () => {
    const result = reconcileNoteEntries([], ["depois da reunião"], { now: at(10), seq: 0 });
    expect(result.entries[0].offsetSeconds).toBeNull();
  });

  test("refuses to issue more ids than the n999999 format allows", () => {
    expect(() => reconcileNoteEntries([], ["a", "b"], { now: at(1), seq: NOTE_LIMITS.maxSeq - 1 })).toThrow(NOTES_ERRORS.idsExhausted);
    expect(reconcileNoteEntries([], ["a"], { now: at(1), seq: NOTE_LIMITS.maxSeq - 1 }).entries[0].id).toBe("n999999");
  });

  test("rebaseNoteOffsets recomputes timed entries from createdAt and leaves untimed ones", () => {
    const entries: NoteEntry[] = [
      { id: noteEntryId(1), createdAt: at(100).toISOString(), offsetSeconds: 100, text: "a" },
      { id: noteEntryId(2), createdAt: at(200).toISOString(), offsetSeconds: null, text: "b" }
    ];
    expect(rebaseNoteOffsets(entries, at(40).toISOString()).map((entry) => entry.offsetSeconds)).toEqual([60, null]);
    expect(rebaseNoteOffsets(entries, at(150).toISOString()).map((entry) => entry.offsetSeconds)).toEqual([0, null]);
    expect(entries[0].offsetSeconds).toBe(100);
  });
});
