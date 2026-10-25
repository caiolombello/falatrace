import { describe, expect, test } from "bun:test";
import { Bm25Index, foldText, STOPWORDS, tokenize } from "../bm25";

describe("tokenize", () => {
  test("folds accents and case, keeps [a-z0-9] runs of two or more characters", () => {
    expect(foldText("Decisão AÇÃO Índice")).toBe("decisao acao indice");
    expect(tokenize("A decisão sobre o orçamento de 2026 é: aprovar! x")).toEqual(["decisao", "orcamento", "2026", "aprovar"]);
  });

  test("drops Portuguese, English and Spanish stopwords", () => {
    expect(tokenize("the budget and o prazo de la entrega")).toEqual(["budget", "prazo", "entrega"]);
    for (const word of ["nao", "voce", "the", "pero", "porque"]) expect(STOPWORDS.has(word)).toBe(true);
  });

  test("bounds the text it reads", () => {
    const huge = `${"palavra ".repeat(40_000)}finalunica`;
    expect(tokenize(huge)).not.toContain("finalunica");
  });
});

describe("Bm25Index", () => {
  const corpus = [
    "Discutimos o orçamento de marketing e a contratação de uma agência.",
    "A migração do banco de dados ficou para a próxima sprint; o orçamento não mudou.",
    "Revisamos a retrospectiva do time e as ações de melhoria contínua.",
    "Orçamento orçamento orçamento: aprovado o orçamento anual com corte de custos.",
    "Conversa informal sobre férias e viagens."
  ];
  const index = new Bm25Index(corpus.map((text) => ({ fields: [{ text, weight: 1 }] })));

  test("matches queries with or without accents", () => {
    const accented = index.search("orçamento");
    const plain = index.search("ORCAMENTO");
    expect(accented.map((hit) => hit.index)).toEqual(plain.map((hit) => hit.index));
    expect(accented.map((hit) => hit.index).sort()).toEqual([0, 1, 3]);
  });

  test("ranks the document that is most about the terms first", () => {
    expect(index.search("orçamento anual corte")[0]!.index).toBe(3);
    expect(index.search("migração banco de dados")[0]!.index).toBe(1);
    expect(index.search("retrospectiva melhoria")[0]!.index).toBe(2);
  });

  test("rarer terms weigh more than common ones", () => {
    const hits = index.search("orçamento agência");
    expect(hits[0]!.index).toBe(0);
  });

  test("returns nothing for stopword-only or unknown queries", () => {
    expect(index.search("de que o a")).toEqual([]);
    expect(index.search("kubernetes")).toEqual([]);
    expect(new Bm25Index([]).search("orçamento")).toEqual([]);
  });

  test("filters candidates and honours the limit", () => {
    const hits = index.search("orçamento", { accept: (position) => position !== 3, limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.index).not.toBe(3);
  });

  test("field weights boost a match in a heavier field", () => {
    const weighted = new Bm25Index([
      { fields: [{ text: "planejamento trimestral detalhado", weight: 1 }, { text: "Reunião comercial", weight: 0.5 }] },
      { fields: [{ text: "planejamento trimestral detalhado", weight: 1 }, { text: "Kickoff Acme", weight: 2 }] }
    ]);
    expect(weighted.search("acme planejamento")[0]!.index).toBe(1);
    // A field with weight 0 is ignored.
    expect(new Bm25Index([{ fields: [{ text: "segredo", weight: 0 }] }]).search("segredo")).toEqual([]);
  });

  test("scores are deterministic and ties keep document order", () => {
    const twins = new Bm25Index([{ fields: [{ text: "mesmo texto", weight: 1 }] }, { fields: [{ text: "mesmo texto", weight: 1 }] }]);
    expect(twins.search("texto").map((hit) => hit.index)).toEqual([0, 1]);
  });
});
