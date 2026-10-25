import { describe, expect, test } from "bun:test";
import { BUILT_IN_TEMPLATES, GENERAL_TEMPLATE, validateTemplate, type SummaryTemplate } from "../catalog";
import {
  CALENDAR_MIN_SCORE,
  MAX_MODEL_CHOICE_CANDIDATES,
  resolveModelChoice,
  selectTemplate,
  type TemplateSelectionInput
} from "../select";

const templates = [...BUILT_IN_TEMPLATES];

const customTemplate = (slug: string, overrides: Partial<SummaryTemplate> = {}): SummaryTemplate => validateTemplate({
  id: `custom:${slug}`,
  version: 1,
  builtIn: false,
  name: { "pt-BR": `Modelo ${slug}`, en: `Template ${slug}`, es: `Plantilla ${slug}` },
  description: "A custom template used by the selection tests.",
  titleKeywords: [],
  transcriptKeywords: [],
  sections: [
    { id: "a", title: { "pt-BR": `A ${slug}`, en: `A ${slug}`, es: `A ${slug}` }, instruction: "First section." },
    { id: "b", title: { "pt-BR": `B ${slug}`, en: `B ${slug}`, es: `B ${slug}` }, instruction: "Second section." },
    { id: "c", title: { "pt-BR": `C ${slug}`, en: `C ${slug}`, es: `C ${slug}` }, instruction: "Third section." }
  ],
  guidance: "",
  ...overrides
});

const select = (overrides: Partial<TemplateSelectionInput> = {}) =>
  selectTemplate({ configDefault: "auto", detection: "ai", templates, ...overrides });

const byCalendar = (title: string, recurring = false, extra: Partial<TemplateSelectionInput> = {}) =>
  select({ calendar: { title, recurring }, ...extra });

describe("precedence", () => {
  test("the choice on the recording wins over everything", () => {
    const selection = select({ override: "postmortem", configDefault: "standup", calendar: { title: "Daily Squad Pagamentos", recurring: true } });
    expect(selection).toMatchObject({ mode: "fixed", source: "user", confidence: 1 });
    expect(selection.template?.id).toBe("postmortem");
    expect(selection.candidates.map((template) => template.id)).toEqual(["postmortem"]);
    expect(selection.reason).toBe("Modelo escolhido por você: Postmortem de incidente.");
  });

  test("the configured default comes next, then the calendar title", () => {
    const configured = select({ configDefault: "retrospective", calendar: { title: "Daily Squad Pagamentos", recurring: true } });
    expect(configured).toMatchObject({ mode: "fixed", source: "default", confidence: 1 });
    expect(configured.template?.id).toBe("retrospective");
    const calendar = select({ calendar: { title: "Daily Squad Pagamentos", recurring: true }, transcriptSample: "causa raiz rollback causa raiz rollback incidente" });
    expect(calendar.source).toBe("calendar");
    expect(calendar.template?.id).toBe("standup");
  });

  test("auto or empty choices mean no choice", () => {
    expect(select({ override: "auto", configDefault: "auto" }).source).toBe("ai");
    expect(select({ override: "", configDefault: " auto " }).source).toBe("ai");
    expect(select({ override: "   " }).source).toBe("ai");
  });

  test("a choice that no longer exists falls through and says so", () => {
    const selection = select({ override: "custom:apagado", configDefault: "custom:sumiu", calendar: { title: "Retro Sprint 42", recurring: true } });
    expect(selection.source).toBe("calendar");
    expect(selection.template?.id).toBe("retrospective");
    expect(selection.reason).toContain("O modelo escolhido (custom:apagado) não existe mais.");
    expect(selection.reason).toContain("O modelo padrão (custom:sumiu) não existe mais.");
    const fallback = select({ configDefault: "custom:sumiu", detection: "keywords" });
    expect(fallback).toMatchObject({ source: "fallback", mode: "fixed" });
    expect(fallback.reason).toBe("O modelo padrão (custom:sumiu) não existe mais. Sem sinal claro; usado o modelo geral.");
  });

  test("an unknown choice is echoed in the reason as one short line", () => {
    const selection = select({ override: `custom:x\n# Injected‮${"y".repeat(5000)}`, detection: "keywords" });
    expect(selection.source).toBe("fallback");
    const echoed = /O modelo escolhido \((.*)\) não existe mais\./u.exec(selection.reason);
    expect(echoed).not.toBeNull();
    expect(echoed?.[1].startsWith("custom:x # Injected y")).toBe(true);
    expect(echoed?.[1].length).toBeLessThanOrEqual(60);
    expect(/[\p{Cc}\p{Cf}]/u.test(selection.reason)).toBe(false);
    expect(select({ override: 42 as unknown as string }).source).toBe("ai");
  });

  test("custom templates can be chosen explicitly", () => {
    const comite = customTemplate("comite");
    const selection = select({ override: "custom:comite", templates: [...templates, comite] });
    expect(selection.template).toBe(comite);
    expect(selection.source).toBe("user");
  });

  test("without any signal: ai detection lets the model choose, keywords detection uses general", () => {
    const ai = byCalendar("Weekly sync", true);
    expect(ai).toMatchObject({ mode: "model-choice", source: "ai", confidence: 0 });
    expect(ai.template).toBeUndefined();
    expect(ai.candidates.map((template) => template.id)).toEqual(templates.map((template) => template.id));
    expect(ai.reason).toBe("Sem sinal claro; o modelo escolhe entre 9 modelos pela conversa.");
    const keywords = byCalendar("Weekly sync", true, { detection: "keywords" });
    expect(keywords).toMatchObject({ mode: "fixed", source: "fallback", confidence: 0 });
    expect(keywords.template?.id).toBe("general");
    expect(keywords.candidates).toEqual([keywords.template!]);
  });
});

describe("calendar title keywords", () => {
  const cases: Array<[string, boolean, string, number]> = [
    ["Daily Squad Pagamentos", true, "standup", 0.8],
    ["Daily Squad Pagamentos", false, "standup", 0.7],
    ["1:1 Ana <> Caio", true, "one-on-one", 1],
    ["1:1 Ana <> Caio", false, "one-on-one", 0.95],
    ["1x1 Caio e Bruna", false, "one-on-one", 0.7],
    ["One-on-one Maria / João", true, "one-on-one", 0.9],
    ["Postmortem incidente checkout", false, "postmortem", 0.85],
    ["Pós-mortem: queda do Pix", false, "postmortem", 0.8],
    ["Discovery - Acme", false, "sales-discovery", 0.7],
    ["Entrevista - Dev Backend Sênior", false, "hiring-interview", 0.7],
    ["Retro Sprint 42", true, "retrospective", 0.8],
    ["Sprint Planning + Refinamento", true, "planning", 1],
    ["Weekly Standup - Platform", true, "standup", 0.8],
    ["Incident review: checkout outage", false, "postmortem", 0.95],
    ["Usability test - new onboarding", false, "user-research", 0.8],
    ["Technical interview - Senior Backend Engineer", false, "hiring-interview", 0.8],
    ["Reunión diaria equipo de datos", true, "standup", 0.9]
  ];
  for (const [title, recurring, id, confidence] of cases) {
    test(`"${title}"${recurring ? " (recurring)" : ""} -> ${id}`, () => {
      const selection = byCalendar(title, recurring);
      expect(selection.mode).toBe("fixed");
      expect(selection.source).toBe("calendar");
      expect(selection.template?.id).toBe(id);
      expect(selection.confidence).toBe(confidence);
      expect(selection.confidence).toBeGreaterThanOrEqual(CALENDAR_MIN_SCORE);
      expect(selection.matched.length).toBeGreaterThan(0);
      expect(selection.reason.startsWith("O título da agenda indica ")).toBe(true);
    });
  }

  test("titles without a meeting-type word do not decide", () => {
    for (const title of ["Weekly sync", "Alinhamento Acme", "Ana <> Caio", "Acme <> FalaTrace", "Sync semanal", "Café com o time", "Review mensal"]) {
      expect(byCalendar(title, false, { detection: "keywords" }).source).toBe("fallback");
    }
    // Two names alone are not enough, even when the event repeats.
    expect(byCalendar("Ana <> Caio", true).mode).toBe("model-choice");
    // A single specific word is: "OKR" means planning.
    expect(byCalendar("Q3 OKR review prep").template?.id).toBe("planning");
  });

  test("keywords match whole words only", () => {
    expect(byCalendar("Retrofit do app legado").source).toBe("ai");
    expect(byCalendar("Dailymotion integration").source).toBe("ai");
    expect(byCalendar("Pré-venda ACME").source).toBe("ai");
  });

  test("a longer keyword hides the shorter one it contains", () => {
    const research = byCalendar("Entrevista com usuário - onboarding");
    expect(research.template?.id).toBe("user-research");
    expect(research.matched).toEqual(["entrevista com usuario"]);
    expect(byCalendar("Product discovery - onboarding").template?.id).toBe("user-research");
    expect(byCalendar("Discovery call - Acme").template?.id).toBe("sales-discovery");
  });

  test("two different types in the title are ambiguous and defer to the next step", () => {
    const ambiguous = byCalendar("Daily + Retro", true);
    expect(ambiguous.mode).toBe("model-choice");
    expect(ambiguous.reason).toContain("O título da agenda é ambíguo entre Daily (stand-up) e Retrospectiva.");
    const withTranscript = byCalendar("Kickoff comercial Acme", false, {
      transcriptSample: "O orçamento deles é de 200 mil e o decisor é o CFO. Vamos mandar a proposta e o contrato na semana que vem; o orçamento já foi aprovado."
    });
    expect(withTranscript.source).toBe("keywords");
    expect(withTranscript.template?.id).toBe("sales-discovery");
    expect(withTranscript.reason).toContain("O título da agenda é ambíguo entre");
  });

  test("a clear lead decides even when another type also matches", () => {
    // Planning: two keywords + recurring (1.0) vs. sales: one keyword (0.7).
    const selection = byCalendar("Sprint planning e backlog comercial", true);
    expect(selection.template?.id).toBe("planning");
  });

  test("a lead of exactly CALENDAR_MIN_LEAD decides (no floating-point miss)", () => {
    // Planning: "sprint planning" + "kickoff" + "roadmap" (capped at 1) vs. postmortem: "incident review" (0.8).
    // 1 - 0.8 is 0.19999999999999996 in floating point.
    const selection = byCalendar("Sprint planning kickoff roadmap + incident review");
    expect(selection).toMatchObject({ mode: "fixed", source: "calendar", confidence: 1 });
    expect(selection.template?.id).toBe("planning");
    expect(selection.reason).not.toContain("ambíguo");
    // Just under the lead stays ambiguous: 0.85 vs 0.7.
    expect(byCalendar("Retro retrospectiva + incidente").reason).toContain("O título da agenda é ambíguo entre Retrospectiva e Postmortem de incidente.");
  });

  test("your custom template wins over a built-in matched by the same words", () => {
    const squad = customTemplate("daily-squad", { titleKeywords: ["daily"] });
    const selection = byCalendar("Daily Squad Pagamentos", true, { templates: [...templates, squad] });
    expect(selection.template?.id).toBe("custom:daily-squad");
    expect(selection.confidence).toBe(0.7);
    const comite = customTemplate("comite", { titleKeywords: ["comite de riscos", "risk committee"] });
    expect(byCalendar("Comitê de Riscos - outubro", false, { templates: [...templates, comite] }).template?.id).toBe("custom:comite");
  });

  test("very long titles are bounded", () => {
    const selection = byCalendar(`${"palavra ".repeat(100)} daily`, true);
    expect(selection.source).toBe("ai");
    expect(byCalendar(`daily ${"palavra ".repeat(10_000)}`, true).template?.id).toBe("standup");
  });
});

describe("transcript keywords and note headings", () => {
  const incident = "O alerta disparou às três da manhã e o on call fez rollback. A causa raiz foi uma migração sem índice; o downtime foi de quarenta minutos. Precisamos revisar a mitigação e o rollback automático.";

  test("a clear winner with at least three hits decides", () => {
    const selection = select({ transcriptSample: incident });
    expect(selection.source).toBe("keywords");
    expect(selection.template?.id).toBe("postmortem");
    expect(selection.confidence).toBeGreaterThanOrEqual(0.6);
    expect(selection.confidence).toBeLessThanOrEqual(0.9);
    expect(selection.matched).toEqual(expect.arrayContaining(["causa raiz", "rollback", "downtime"]));
    expect(selection.reason.startsWith("Termos da conversa indicam Postmortem de incidente")).toBe(true);
  });

  test("English and Spanish transcripts", () => {
    const standup = "Yesterday I finished the export job. Today I will pair with Ana on the parser. No blockers from me. Yesterday I reviewed two PRs; today I'm on the migration, blocked on the staging database.";
    expect(select({ transcriptSample: standup }).template?.id).toBe("standup");
    const retro = "Bueno, lo que salió bien fue la coordinación con datos. Qué podemos mejorar: la comunicación. Lo que salió bien también fue el deploy. Que podemos mejorar en las revisiones.";
    expect(select({ transcriptSample: retro }).template?.id).toBe("retrospective");
  });

  test("one word repeated all meeting long is not enough", () => {
    const selection = select({ transcriptSample: "rollback ".repeat(50), detection: "keywords" });
    expect(selection.source).toBe("fallback");
  });

  test("no clear winner (less than twice the runner-up) defers", () => {
    const mixed = "A causa raiz e o rollback. O orçamento e a proposta. Downtime. Contrato.";
    const selection = select({ transcriptSample: mixed, detection: "keywords" });
    expect(selection.source).toBe("fallback");
  });

  test("note headings that match template sections count", () => {
    const selection = select({ noteHeadings: ["# Ontem", "# Hoje", "## Bloqueios:"] });
    expect(selection.source).toBe("keywords");
    expect(selection.template?.id).toBe("standup");
    expect(selection.reason.startsWith("Os títulos das suas notas e termos da conversa indicam Daily (stand-up)")).toBe(true);
    expect(selection.matched).toEqual(["# ontem", "# hoje", "# bloqueios"]);
    const english = select({ noteHeadings: ["Impact", "Timeline", "Root cause", "Corrective actions"] });
    expect(english.template?.id).toBe("postmortem");
  });

  test("a heading shared by several templates is not a clear winner on its own", () => {
    expect(select({ noteHeadings: ["# Próximos passos"], detection: "keywords" }).source).toBe("fallback");
    expect(select({ noteHeadings: ["# Resumo", "# Decisões", "# Próximos passos"] }).template?.id).toBe("general");
  });

  test("malformed headings and samples are ignored", () => {
    const selection = select({ noteHeadings: [7 as unknown as string, "", "#", "   "], transcriptSample: 42 as unknown as string, detection: "keywords" });
    expect(selection.source).toBe("fallback");
    expect(select({ noteHeadings: "x" as unknown as string[], detection: "keywords" }).source).toBe("fallback");
  });
});

describe("model choice", () => {
  test("general first, then the likeliest candidates, capped", () => {
    const customs = Array.from({ length: 30 }, (_value, index) => customTemplate(`extra-${String(index).padStart(2, "0")}`));
    const signal = customTemplate("zz-signal", { transcriptKeywords: ["esteira de credito"] });
    const selection = select({ templates: [signal, ...customs, ...templates], transcriptSample: "a esteira de credito travou" });
    expect(selection.mode).toBe("model-choice");
    expect(selection.candidates.length).toBe(MAX_MODEL_CHOICE_CANDIDATES);
    expect(selection.candidates[0].id).toBe("general");
    expect(selection.candidates[1].id).toBe("custom:zz-signal");
    // Built-ins come before customs without signals.
    expect(selection.candidates.slice(2, 10).every((template) => template.builtIn)).toBe(true);
  });

  test("general is always available even if missing from the list", () => {
    const selection = select({ templates: [customTemplate("so-eu")] });
    expect(selection.candidates[0]).toEqual(GENERAL_TEMPLATE);
    expect(select({ templates: [] }).candidates.length).toBe(BUILT_IN_TEMPLATES.length);
  });

  test("resolveModelChoice records the model's answer", () => {
    const selection = byCalendar("Weekly sync", true);
    const chosen = resolveModelChoice(selection, "planning");
    expect(chosen).toMatchObject({ mode: "model-choice", source: "ai", confidence: 0.5 });
    expect(chosen.template?.id).toBe("planning");
    expect(chosen.reason).toBe("O modelo escolheu Planejamento pela conversa.");
    expect(chosen.candidates).toBe(selection.candidates);
    const unknown = resolveModelChoice(selection, "custom:inventado");
    expect(unknown).toMatchObject({ source: "fallback", confidence: 0 });
    expect(unknown.template?.id).toBe("general");
    expect(resolveModelChoice(selection, 42).template?.id).toBe("general");
    const fixedSelection = byCalendar("Retro Sprint 42", true);
    expect(resolveModelChoice(fixedSelection, "standup")).toBe(fixedSelection);
  });
});

describe("properties", () => {
  test("deterministic and does not touch its input", () => {
    const input: TemplateSelectionInput = { configDefault: "auto", detection: "ai", calendar: { title: "Retro Sprint 42", recurring: true }, transcriptSample: "o que foi bem", noteHeadings: ["# Ações"], templates };
    const snapshot = JSON.stringify(input);
    expect(JSON.stringify(selectTemplate(input))).toBe(JSON.stringify(selectTemplate(input)));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("duplicate template ids keep the first", () => {
    const shadow = customTemplate("x", { titleKeywords: ["daily"] });
    const first = { ...shadow };
    const second = { ...shadow, titleKeywords: [] };
    const selection = byCalendar("Daily", false, { templates: [first, second, ...templates] });
    expect(selection.template).toBe(first);
  });

  test("large transcripts stay fast", () => {
    const sample = "a gente falou sobre o roadmap e a causa raiz do incidente de ontem, depois sobre orçamento. ".repeat(2000);
    const customs = Array.from({ length: 100 }, (_value, index) => customTemplate(`c${index}`, { transcriptKeywords: [`termo especifico ${index}`, "causa raiz do"] }));
    const started = performance.now();
    select({ transcriptSample: sample, templates: [...templates, ...customs] });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
