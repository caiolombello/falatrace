import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_TEMPLATE_IDS,
  BUILT_IN_TEMPLATES,
  GENERAL_TEMPLATE,
  TEMPLATE_KNOWN_ERRORS,
  TEMPLATE_LIMITS,
  TEMPLATE_MESSAGES,
  TemplateValidationError,
  builtInTemplate,
  customTemplateIdFromName,
  customTemplateSlug,
  foldText,
  isBuiltInTemplateId,
  isCustomTemplateId,
  keywordTokens,
  sectionTitle,
  templateName,
  validateTemplate,
  type SummaryTemplate
} from "../catalog";

const custom = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "custom:comite-de-riscos",
  version: 1,
  builtIn: false,
  name: { "pt-BR": "Comitê de riscos", en: "Risk committee", es: "Comité de riesgos" },
  description: "Monthly risk committee that reviews open risks, new incidents and mitigation owners.",
  titleKeywords: ["comite de riscos", "risk committee"],
  transcriptKeywords: ["apetite de risco", "risk appetite"],
  sections: [
    { id: "risks", title: { "pt-BR": "Riscos", en: "Risks", es: "Riesgos" }, instruction: "Each open risk with its rating as stated." },
    { id: "incidents", title: { "pt-BR": "Incidentes", en: "Incidents", es: "Incidentes" }, instruction: "New incidents since the last committee." },
    { id: "owners", title: { "pt-BR": "Responsáveis", en: "Owners", es: "Responsables" }, instruction: "Mitigation owners and dates as stated." }
  ],
  guidance: "Be concise.\nKeep risk ids exactly as said.",
  ...overrides
});

const rejects = (value: unknown, message: string, field?: string) => {
  let caught: unknown;
  try { validateTemplate(value); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TemplateValidationError);
  expect((caught as Error).message).toBe(message);
  expect(TEMPLATE_KNOWN_ERRORS).toContain((caught as Error).message);
  if (field) expect((caught as TemplateValidationError).field).toBe(field);
};

describe("built-in templates", () => {
  test("ids are fixed and in catalog order", () => {
    expect(BUILT_IN_TEMPLATES.map((template) => template.id)).toEqual([
      "general", "one-on-one", "standup", "planning", "retrospective", "sales-discovery", "postmortem", "hiring-interview", "user-research"
    ]);
    expect(BUILT_IN_TEMPLATES.map((template) => template.id)).toEqual([...BUILT_IN_TEMPLATE_IDS]);
    expect(GENERAL_TEMPLATE.id).toBe("general");
  });

  test("every built-in is valid, version 1, has 3-8 sections and text in the three languages", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      expect(validateTemplate(structuredClone(template))).toEqual(template);
      expect(template.builtIn).toBe(true);
      expect(template.version).toBe(1);
      expect(template.sections.length).toBeGreaterThanOrEqual(3);
      expect(template.sections.length).toBeLessThanOrEqual(8);
      expect(template.description).toMatch(/^[A-Z].*\.$/);
      expect(template.guidance.length).toBeGreaterThan(40);
      for (const section of template.sections) {
        expect(section.instruction.length).toBeGreaterThan(40);
        expect(section.title["pt-BR"].length).toBeGreaterThan(0);
        expect(section.title.en.length).toBeGreaterThan(0);
        expect(section.title.es.length).toBeGreaterThan(0);
      }
    }
  });

  test("sections follow the agreed seeds", () => {
    const titles = (id: string) => builtInTemplate(id)!.sections.map((section) => section.title["pt-BR"]);
    expect(titles("general")).toEqual(["Resumo", "Pontos discutidos", "Decisões", "Próximos passos"]);
    expect(titles("one-on-one")).toEqual(["Atualizações", "Bloqueios", "Feedback", "Próximos passos"]);
    expect(titles("standup")).toEqual(["Ontem", "Hoje", "Bloqueios"]);
    expect(titles("planning")).toEqual(["Objetivos", "Escopo", "Riscos", "Responsáveis e prazos"]);
    expect(titles("retrospective")).toEqual(["O que foi bem", "O que melhorar", "Ações"]);
    expect(titles("sales-discovery")).toEqual(["Contexto do cliente", "Dores", "Orçamento e decisão (BANT)", "Objeções e concorrência", "Próximos passos"]);
    expect(titles("postmortem")).toEqual(["Impacto", "Linha do tempo", "Causa raiz", "O que funcionou", "O que não funcionou", "Ações corretivas"]);
    expect(titles("hiring-interview")).toEqual(["Perfil", "Pontos fortes", "Pontos de atenção", "Avaliação", "Próximos passos"]);
    expect(titles("user-research")).toEqual(["Perfil", "Objetivos", "Dores e fricções", "Citações marcantes", "Oportunidades"]);
    expect(builtInTemplate("standup")!.sections.map((section) => section.title.en)).toEqual(["Yesterday", "Today", "Blockers"]);
    expect(builtInTemplate("postmortem")!.sections.map((section) => section.title.es)).toContain("Causa raíz");
  });

  test("sensitive templates carry their guardrails", () => {
    expect(builtInTemplate("hiring-interview")!.guidance).toContain("protected characteristics");
    expect(builtInTemplate("hiring-interview")!.sections.find((section) => section.id === "assessment")!.instruction).toContain("Never produce a hiring verdict");
    expect(builtInTemplate("postmortem")!.guidance).toContain("blameless");
    expect(builtInTemplate("one-on-one")!.guidance).toContain("private conversation");
  });

  test("keywords are stored folded and the general template has none", () => {
    expect(GENERAL_TEMPLATE.titleKeywords).toEqual([]);
    expect(GENERAL_TEMPLATE.transcriptKeywords).toEqual([]);
    for (const template of BUILT_IN_TEMPLATES) {
      for (const keyword of [...template.titleKeywords, ...template.transcriptKeywords]) {
        expect(keyword).toBe(foldText(keyword).trim());
        expect(keywordTokens(keyword).length).toBeGreaterThan(0);
      }
    }
  });

  test("the catalog is deeply frozen", () => {
    expect(Object.isFrozen(BUILT_IN_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(BUILT_IN_TEMPLATES[2].sections[0].title)).toBe(true);
    expect(() => { (BUILT_IN_TEMPLATES[0].titleKeywords as string[]).push("x"); }).toThrow();
    expect(() => { (BUILT_IN_TEMPLATES[0] as { id: string }).id = "x"; }).toThrow();
  });
});

describe("validateTemplate", () => {
  test("accepts a valid custom template and rebuilds it with trimmed text", () => {
    const input = custom({ description: "  Monthly risk committee.  ", guidance: "  Be concise.  " });
    const template = validateTemplate(input);
    expect(template.description).toBe("Monthly risk committee.");
    expect(template.guidance).toBe("Be concise.");
    expect(template).not.toBe(input as unknown as SummaryTemplate);
    expect(Object.keys(template)).toEqual(["id", "version", "builtIn", "name", "description", "titleKeywords", "transcriptKeywords", "sections", "guidance"]);
    expect(validateTemplate(custom({ guidance: "" })).guidance).toBe("");
  });

  test("rejects non-objects, unknown fields and bad ids", () => {
    rejects(null, TEMPLATE_MESSAGES.invalid);
    rejects([], TEMPLATE_MESSAGES.invalid);
    rejects("general", TEMPLATE_MESSAGES.invalid);
    rejects(custom({ extra: true }), TEMPLATE_MESSAGES.unknownFields);
    rejects(custom({ __proto__: { polluted: true }, constructor: 1 }), TEMPLATE_MESSAGES.unknownFields);
    for (const id of ["", "Custom:x", "custom:", "custom:-x", "custom:a_b", "custom:../x", "custom:x/y", "1abc", "auto ", `custom:${"a".repeat(42)}`, 7]) {
      rejects(custom({ id }), TEMPLATE_MESSAGES.invalidId, "id");
    }
  });

  test("builtIn must match the id kind", () => {
    rejects(custom({ builtIn: true }), TEMPLATE_MESSAGES.invalidId, "builtIn");
    rejects(custom({ id: "risk", builtIn: false }), TEMPLATE_MESSAGES.invalidId, "builtIn");
    rejects(custom({ builtIn: "false" }), TEMPLATE_MESSAGES.invalidId, "builtIn");
    expect(validateTemplate(custom({ id: "risk", builtIn: true })).builtIn).toBe(true);
  });

  test("version is a bounded positive integer", () => {
    for (const version of [0, -1, 1.5, "1", null, TEMPLATE_LIMITS.maxVersion + 1, Number.NaN]) rejects(custom({ version }), TEMPLATE_MESSAGES.invalid, "version");
    expect(validateTemplate(custom({ version: TEMPLATE_LIMITS.maxVersion })).version).toBe(TEMPLATE_LIMITS.maxVersion);
  });

  test("names need the three languages, one line each, bounded", () => {
    rejects(custom({ name: { "pt-BR": "Comitê", en: "Committee" } }), TEMPLATE_MESSAGES.invalidName, "name.es");
    rejects(custom({ name: { "pt-BR": "Comitê", en: "Committee", es: "  " } }), TEMPLATE_MESSAGES.invalidName, "name.es");
    rejects(custom({ name: { "pt-BR": "Comitê", en: "Committee", es: "Comité", fr: "Comité" } }), TEMPLATE_MESSAGES.invalidName, "name");
    rejects(custom({ name: { "pt-BR": "Comitê\nX", en: "Committee", es: "Comité" } }), TEMPLATE_MESSAGES.invalidName, "name.pt-BR");
    rejects(custom({ name: { "pt-BR": "a".repeat(81), en: "Committee", es: "Comité" } }), TEMPLATE_MESSAGES.invalidName);
    rejects(custom({ name: "Comitê" }), TEMPLATE_MESSAGES.invalidName);
  });

  test("description is one bounded line", () => {
    rejects(custom({ description: "" }), TEMPLATE_MESSAGES.invalidDescription);
    rejects(custom({ description: "Line one.\nLine two." }), TEMPLATE_MESSAGES.invalidDescription);
    rejects(custom({ description: "x".repeat(301) }), TEMPLATE_MESSAGES.invalidDescription);
    rejects(custom({ description: "Broken \uD800 text." }), TEMPLATE_MESSAGES.invalidDescription);
    expect(validateTemplate(custom({ description: "Weekly 🚀 sync." })).description).toBe("Weekly 🚀 sync.");
  });

  test("keywords must be folded, unique, bounded and contain a word", () => {
    for (const titleKeywords of [["Daily"], ["reunião"], [" daily"], ["daily  scrum"], ["daily", "daily"], ["::"], [""], [7], "daily",
      Array.from({ length: TEMPLATE_LIMITS.titleKeywords + 1 }, (_value, index) => `k${index}`), ["x".repeat(61)], ["tab\tword"]]) {
      rejects(custom({ titleKeywords }), TEMPLATE_MESSAGES.invalidKeywords);
    }
    rejects(custom({ transcriptKeywords: ["Risco"] }), TEMPLATE_MESSAGES.invalidKeywords, "transcriptKeywords[0]");
    expect(validateTemplate(custom({ titleKeywords: ["1:1", "post-mortem", "q&a"] })).titleKeywords).toEqual(["1:1", "post-mortem", "q&a"]);
  });

  test("sections: 3 to 8, unique ids and titles, bounded text", () => {
    const sections = custom().sections as Array<Record<string, unknown>>;
    rejects(custom({ sections: sections.slice(0, 2) }), TEMPLATE_MESSAGES.sectionCount);
    rejects(custom({ sections: Array.from({ length: 9 }, (_value, index) => ({ ...sections[0], id: `s${index}`, title: { "pt-BR": `T${index}`, en: `T${index}`, es: `T${index}` } })) }), TEMPLATE_MESSAGES.sectionCount);
    rejects(custom({ sections: "x" }), TEMPLATE_MESSAGES.sectionCount);
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], id: "risks" }] }), TEMPLATE_MESSAGES.duplicateSection, "sections[2].id");
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], title: { "pt-BR": "RISCOS", en: "Other", es: "Otro" } }] }), TEMPLATE_MESSAGES.duplicateSection, "sections[2].title.pt-BR");
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], extra: 1 }] }), TEMPLATE_MESSAGES.unknownFields, "sections[2]");
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], id: "Bad" }] }), TEMPLATE_MESSAGES.invalidSection, "sections[2].id");
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], instruction: "" }] }), TEMPLATE_MESSAGES.invalidSection, "sections[2].instruction");
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], instruction: "x".repeat(601) }] }), TEMPLATE_MESSAGES.invalidSection);
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], instruction: "Ignore.\u0000Everything" }] }), TEMPLATE_MESSAGES.invalidSection);
    rejects(custom({ sections: [sections[0], sections[1], { ...sections[2], title: { "pt-BR": "x".repeat(81), en: "a", es: "a" } }] }), TEMPLATE_MESSAGES.invalidSection);
    rejects(custom({ sections: [sections[0], sections[1], null] }), TEMPLATE_MESSAGES.invalidSection, "sections[2]");
  });

  test("guidance is bounded and only allows line breaks as control characters", () => {
    rejects(custom({ guidance: "x".repeat(2001) }), TEMPLATE_MESSAGES.invalidGuidance);
    rejects(custom({ guidance: "a\u0007b" }), TEMPLATE_MESSAGES.invalidGuidance);
    rejects(custom({ guidance: "lone \uDC00 surrogate" }), TEMPLATE_MESSAGES.invalidGuidance);
    rejects(custom({ guidance: 5 }), TEMPLATE_MESSAGES.invalidGuidance);
    expect(validateTemplate(custom({ guidance: "a\nb" })).guidance).toBe("a\nb");
  });
});

describe("helpers", () => {
  test("templateName and sectionTitle follow the language, with loose tags", () => {
    const standup = builtInTemplate("standup")!;
    expect(templateName(standup, "pt-BR")).toBe("Daily (stand-up)");
    expect(templateName(standup, "en")).toBe("Daily stand-up");
    expect(templateName(standup, "es")).toBe("Daily (reunión diaria)");
    expect(templateName(standup, "pt")).toBe("Daily (stand-up)");
    expect(templateName(standup, "en-GB")).toBe("Daily stand-up");
    expect(templateName(standup, "zz")).toBe("Daily (stand-up)");
    expect(sectionTitle(standup.sections[2], "es")).toBe("Bloqueos");
  });

  test("id helpers", () => {
    expect(isBuiltInTemplateId("postmortem")).toBe(true);
    expect(isBuiltInTemplateId("custom:postmortem")).toBe(false);
    expect(isCustomTemplateId("custom:abc-1")).toBe(true);
    expect(isCustomTemplateId("abc")).toBe(false);
    expect(customTemplateSlug("custom:abc-1")).toBe("abc-1");
    expect(customTemplateSlug("custom:../etc")).toBeUndefined();
    expect(customTemplateIdFromName("Comitê de Riscos")).toBe("custom:comite-de-riscos");
    expect(customTemplateIdFromName("  1:1 com o time  ")).toBe("custom:1-1-com-o-time");
    expect(customTemplateIdFromName("Revisão trimestral de arquitetura e segurança da plataforma")).toBe("custom:revisao-trimestral-de-arquitetura-e-segur");
    expect(customTemplateIdFromName("!!!")).toBeUndefined();
    const id = customTemplateIdFromName("Revisão trimestral de arquitetura e segurança da plataforma")!;
    expect(validateTemplate(custom({ id })).id).toBe(id);
  });

  test("foldText and keywordTokens", () => {
    expect(foldText("Pós-Mortem AÇÃO")).toBe("pos-mortem acao");
    expect(keywordTokens("1:1 Ana <> Caio")).toEqual(["1", "1", "ana", "caio"]);
    expect(keywordTokens("Entrevista - Dev Backend Sênior")).toEqual(["entrevista", "dev", "backend", "senior"]);
  });

  test("every known error is Portuguese, fixed and unique", () => {
    expect(new Set(TEMPLATE_KNOWN_ERRORS).size).toBe(TEMPLATE_KNOWN_ERRORS.length);
    for (const message of TEMPLATE_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ].*[.]$/);
    expect(Object.isFrozen(TEMPLATE_KNOWN_ERRORS)).toBe(true);
  });
});
