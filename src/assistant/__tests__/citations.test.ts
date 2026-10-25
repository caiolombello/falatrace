import { describe, expect, test } from "bun:test";
import { type ContextRef, extractCitations, stripMarkers, stripPartialMarker } from "../citations";

const A = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
const B = "4e3b529e-5c22-4802-97b8-f3e1a52c1919";
const ref = (jobId: string, segmentId: string, start: number, title: string): ContextRef => ({ jobId, segmentId, start, end: start + 5, title });

const meeting = new Map<string, ContextRef>([
  ["s000001", ref(A, "s000001", 10, "Planejamento")],
  ["s000002", ref(A, "s000002", 20, "Planejamento")],
  ["s000123", ref(A, "s000123", 723, "Planejamento")]
]);
const library = new Map<string, ContextRef>([
  ["m1:s000001", ref(A, "s000001", 10, "Planejamento")],
  ["m1:s000002", ref(A, "s000002", 20, "Planejamento")],
  ["m2:s000001", ref(B, "s000001", 30, "Kickoff")],
  ["m2:s000050", ref(B, "s000050", 500, "Kickoff")]
]);

describe("extractCitations", () => {
  test("keeps known markers and resolves them to recordings and times", () => {
    const answer = extractCitations("Decidiram adiar a migração [[s000001]]. O prazo é sexta [[s000123]].", meeting);
    expect(answer.text).toBe("Decidiram adiar a migração [[s000001]]. O prazo é sexta [[s000123]].");
    expect(answer.citations).toEqual([
      { ref: "s000001", jobId: A, segmentId: "s000001", start: 10, end: 15, title: "Planejamento" },
      { ref: "s000123", jobId: A, segmentId: "s000123", start: 723, end: 728, title: "Planejamento" }
    ]);
    expect(answer.droppedRefs).toEqual([]);
  });

  test("removes hallucinated markers from the text and reports them", () => {
    const answer = extractCitations("Ana aprovou o orçamento [[s999999]]. Bruno discordou [[s000002]] [[s000003]].", meeting);
    expect(answer.text).toBe("Ana aprovou o orçamento. Bruno discordou [[s000002]].");
    expect(answer.droppedRefs).toEqual(["s999999", "s000003"]);
    expect(answer.citations.map((citation) => citation.ref)).toEqual(["s000002"]);
  });

  test("tolerates single brackets, lists, spaces and case, normalizing to one marker each", () => {
    const answer = extractCitations("Ponto A [s000001]. Ponto B [[s000001, s000002]]. Ponto C [S000123; s000002]. Ponto D [[ s000001 e s000002 ]].", meeting);
    expect(answer.text).toBe("Ponto A [[s000001]]. Ponto B [[s000001]][[s000002]]. Ponto C [[s000123]][[s000002]]. Ponto D [[s000001]][[s000002]].");
    expect(answer.citations.map((citation) => citation.ref)).toEqual(["s000001", "s000002", "s000123"]);
  });

  test("library markers need the meeting label, and a list inherits it", () => {
    const answer = extractCitations("Kickoff marcado [[m2:s000050]]. Escopo [m1: s000001, s000002]. Duplo [[M02:S000001]].", library);
    expect(answer.text).toBe("Kickoff marcado [[m2:s000050]]. Escopo [[m1:s000001]][[m1:s000002]]. Duplo [[m2:s000001]].");
    expect(answer.citations.map((citation) => [citation.ref, citation.jobId])).toEqual([["m2:s000050", B], ["m1:s000001", A], ["m1:s000002", A], ["m2:s000001", B]]);
  });

  test("a bare id in library scope is accepted only when exactly one meeting has it", () => {
    const answer = extractCitations("Único [[s000050]]. Ambíguo [[s000001]]. Inexistente [[m3:s000001]].", library);
    expect(answer.text).toBe("Único [[m2:s000050]]. Ambíguo. Inexistente.");
    expect(answer.droppedRefs).toEqual(["s000001", "m3:s000001"]);
  });

  test("a meeting label added in single-meeting scope still resolves", () => {
    expect(extractCitations("Ok [[m1:s000001]].", meeting).text).toBe("Ok [[s000001]].");
  });

  test("an echoed excerpt header counts as a citation of its segment", () => {
    const answer = extractCitations("Como disse Ana [s000123 12:03 Ana], o prazo é sexta.", meeting);
    expect(answer.text).toBe("Como disse Ana [[s000123]], o prazo é sexta.");
  });

  test("leaves ordinary brackets, links and task boxes alone", () => {
    const text = "Veja [o documento](https://example.com) e [sic]. - [ ] tarefa - [x] feita [12:03] [[Nome Próprio]] [s12345] [s0000001]";
    const answer = extractCitations(text, meeting);
    expect(answer.text).toBe(text);
    expect(answer.citations).toEqual([]);
    expect(answer.droppedRefs).toEqual([]);
  });

  test("a group with any non-marker token is not a citation", () => {
    expect(extractCitations("Lista [s000001, veja acima]", meeting).text).toBe("Lista [s000001, veja acima]");
  });

  test("removing a marker at the end of a line or before punctuation leaves no gap", () => {
    expect(extractCitations("Fim [[s777777]]\nOutra linha [[s777777]] continua", meeting).text).toBe("Fim\nOutra linha continua");
    expect(extractCitations("Texto [[s777777]], depois", meeting).text).toBe("Texto, depois");
  });

  test("handles empty and non-string input, and bounds what it reads", () => {
    expect(extractCitations("", meeting)).toEqual({ text: "", citations: [], droppedRefs: [] });
    expect(extractCitations(undefined as unknown as string, meeting).text).toBe("");
    const long = `${"a".repeat(200_000)} [[s000001]]`;
    expect(extractCitations(long, meeting).citations).toEqual([]);
    const many = Array.from({ length: 300 }, (_value, index) => `[[s${String(500_000 + index).padStart(6, "0")}]]`).join(" ");
    expect(extractCitations(many, meeting).droppedRefs).toHaveLength(100);
  });
});

describe("stream helpers", () => {
  test("stripPartialMarker hides only a marker still being written", () => {
    expect(stripPartialMarker("Texto [[s0001")).toBe("Texto ");
    expect(stripPartialMarker("Texto [[m2:s00")).toBe("Texto ");
    expect(stripPartialMarker("Texto [")).toBe("Texto ");
    expect(stripPartialMarker("Texto [veja")).toBe("Texto [veja");
    expect(stripPartialMarker("Texto [[s000001]]")).toBe("Texto [[s000001]]");
    // Only the first closing bracket arrived: hidden, never rendered as "[[[m2:s000123]]".
    expect(stripPartialMarker("Texto [[m2:s000123]")).toBe("Texto ");
    const refs = new Map([["m2:s000123", { jobId: "a", segmentId: "s000123", title: "T" }]]);
    expect(extractCitations(stripPartialMarker("Texto [[m2:s000123]"), refs).text).toBe("Texto ");
    // A complete single-bracket marker and ordinary brackets stay.
    expect(stripPartialMarker("Texto [s000123]")).toBe("Texto [s000123]");
    expect(stripPartialMarker("Tarefa [x]")).toBe("Tarefa [x]");
  });

  test("stripMarkers removes citations only", () => {
    expect(stripMarkers("Ana decidiu [[m1:s000001]][[m2:s000050]]. Veja [sic] e [link](x).")).toBe("Ana decidiu. Veja [sic] e [link](x).");
  });
});
