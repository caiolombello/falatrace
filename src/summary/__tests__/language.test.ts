import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_LANGUAGES,
  LANGUAGE_PROMPT_NAMES,
  LANGUAGE_SAMPLE_CHARACTERS,
  SUMMARY_LABELS,
  detectLanguage,
  isContentLanguage,
  languageEvidence,
  resolveSummaryLanguage,
  toContentLanguage
} from "../language";

const PT = "Bom dia, pessoal. Então, hoje a gente precisa fechar o escopo da sprint. Eu acho que o deploy do serviço de pagamentos ainda não está pronto, porque o time de QA encontrou dois bugs ontem. Você consegue ver isso com a Ana depois da reunião? Sim, vou falar com ela e já te aviso.";
const EN = "Good morning everyone. So today we need to close the sprint scope. I think the payments service deploy is not ready yet, because the QA team found two bugs yesterday. Can you check that with Ana after the meeting? Yes, I'll talk to her and let you know.";
const ES = "Buenos días a todos. Entonces, hoy tenemos que cerrar el alcance del sprint. Yo creo que el despliegue del servicio de pagos todavía no está listo, porque el equipo de QA encontró dos errores ayer. ¿Puedes revisar eso con Ana después de la reunión? Sí, voy a hablar con ella y te aviso.";
const PT_JARGON = "Então, o pipeline de CI quebrou no build do backend; a gente fez rollback do deploy e abriu um ticket no Jira pra investigar o memory leak. O on-call já tá olhando os logs no Grafana e vai mandar o post-mortem até amanhã.";
const EN_SALES = "Thanks for making the time. We're evaluating three vendors and the decision is with our CFO, but I'd like to understand how your pricing works for teams of about two hundred people, and whether you can run a pilot in the next quarter.";
const ES_RETRO = "Bueno, empecemos la retro. Lo que salió bien fue la coordinación con el equipo de datos; lo que podemos mejorar es la comunicación cuando hay cambios de prioridad. Creo que deberíamos tener una revisión semanal más corta.";

describe("detectLanguage", () => {
  test("recognizes Brazilian Portuguese, English and Spanish meeting speech", () => {
    expect(detectLanguage(PT)).toBe("pt-BR");
    expect(detectLanguage(EN)).toBe("en");
    expect(detectLanguage(ES)).toBe("es");
    expect(detectLanguage(EN_SALES)).toBe("en");
    expect(detectLanguage(ES_RETRO)).toBe("es");
  });

  test("Portuguese full of English tech jargon is still Portuguese", () => {
    expect(detectLanguage(PT_JARGON)).toBe("pt-BR");
    expect(languageEvidence(PT_JARGON).hits.en).toBeLessThan(3);
  });

  test("a clear majority wins; an even mix is undefined", () => {
    expect(detectLanguage(`${PT} ${PT} ${PT} ${EN}`)).toBe("pt-BR");
    expect(detectLanguage(`${EN} ${EN} ${EN} ${PT}`)).toBe("en");
    expect(detectLanguage(`${ES} ${ES} ${EN}`)).toBe("es");
    expect(detectLanguage(`${PT} ${EN}`)).toBeUndefined();
    expect(detectLanguage(`${PT} ${ES}`)).toBeUndefined();
    expect(detectLanguage(`${EN} ${ES}`)).toBeUndefined();
  });

  test("undefined when there is too little to go on", () => {
    expect(detectLanguage("")).toBeUndefined();
    expect(detectLanguage("   \n\t ")).toBeUndefined();
    expect(detectLanguage("Ok, combinado.")).toBeUndefined();
    expect(detectLanguage("Sim. Não.")).toBeUndefined();
    expect(detectLanguage("Ana, Caio, Pedro, João, Maria, Kubernetes, Grafana, Jira, Datadog, Terraform")).toBeUndefined();
    expect(detectLanguage("const x = await fetch(url); return x.json(); if (a) { b(); }")).toBeUndefined();
    expect(detectLanguage("1234 5678 :: -- ## 99 %% 42")).toBeUndefined();
    expect(detectLanguage(undefined as unknown as string)).toBeUndefined();
  });

  test("Portuguese and Spanish spelling (ção, ñ, ¿) is used but never decides alone", () => {
    const pt = languageEvidence("A configuração das integrações não está pronta.");
    const es = languageEvidence("¿La configuración de la integración está lista? Mañana sí.");
    expect(pt.hits["pt-BR"]).toBeGreaterThan(pt.hits.es);
    expect(es.hits.es).toBeGreaterThan(es.hits["pt-BR"]);
    expect(detectLanguage("ção ção ção ção ção ção ção")).toBeUndefined();
  });

  test("long transcripts are sampled across the text, bounded to the sample size", () => {
    // An English preamble longer than the sample must not hide a Portuguese meeting.
    const text = `${EN.repeat(100)} ${PT.repeat(300)}`;
    expect(text.length).toBeGreaterThan(LANGUAGE_SAMPLE_CHARACTERS * 4);
    expect(detectLanguage(text)).toBe("pt-BR");
    const evidence = languageEvidence(`${PT} `.repeat(2000));
    expect(evidence.tokens).toBeLessThan(LANGUAGE_SAMPLE_CHARACTERS / 3);
    const started = performance.now();
    detectLanguage("palavra ".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("stopword evidence is case and apostrophe insensitive", () => {
    expect(detectLanguage(EN.toUpperCase())).toBe("en");
    expect(detectLanguage(PT.toUpperCase())).toBe("pt-BR");
    expect(languageEvidence("I’m sure it’s fine, we’re here").hits.en).toBe(languageEvidence("I'm sure it's fine, we're here").hits.en);
  });
});

describe("resolveSummaryLanguage", () => {
  test("an explicit setting wins over the transcript", () => {
    expect(resolveSummaryLanguage("en", PT)).toBe("en");
    expect(resolveSummaryLanguage("es", EN)).toBe("es");
    expect(resolveSummaryLanguage("pt-BR", ES)).toBe("pt-BR");
  });

  test("auto follows the detected language, else Portuguese", () => {
    expect(resolveSummaryLanguage("auto", EN)).toBe("en");
    expect(resolveSummaryLanguage("auto", ES)).toBe("es");
    expect(resolveSummaryLanguage("auto", PT)).toBe("pt-BR");
    expect(resolveSummaryLanguage("auto", `${PT} ${EN}`)).toBe("pt-BR");
    expect(resolveSummaryLanguage("auto", "")).toBe("pt-BR");
    expect(resolveSummaryLanguage("fr", EN)).toBe("en");
  });
});

describe("language helpers", () => {
  test("content language guards and loose tags", () => {
    expect(CONTENT_LANGUAGES).toEqual(["pt-BR", "en", "es"]);
    expect(isContentLanguage("pt-BR")).toBe(true);
    expect(isContentLanguage("pt")).toBe(false);
    expect(isContentLanguage(undefined)).toBe(false);
    expect(toContentLanguage("pt")).toBe("pt-BR");
    expect(toContentLanguage("pt_PT")).toBe("pt-BR");
    expect(toContentLanguage("EN-us")).toBe("en");
    expect(toContentLanguage("es-419")).toBe("es");
    expect(toContentLanguage("de")).toBe("pt-BR");
    expect(toContentLanguage("de", "en")).toBe("en");
    expect(toContentLanguage(undefined)).toBe("pt-BR");
    expect(Object.keys(LANGUAGE_PROMPT_NAMES).sort()).toEqual([...CONTENT_LANGUAGES].sort());
  });

  test("each stopword belongs to a single language", () => {
    // Shared function words would let one language's text vote for another.
    const shared = ["que", "de", "a", "no", "como", "do", "as", "por", "para", "se", "me", "te", "está", "todo", "porque"];
    for (const word of shared) {
      const hits = languageEvidence(Array(10).fill(word).join(" ")).hits;
      expect(hits["pt-BR"] + hits.en + hits.es).toBe(0);
    }
  });
});

describe("SUMMARY_LABELS", () => {
  const flatten = (value: object, prefix = ""): Record<string, string> =>
    Object.entries(value).reduce<Record<string, string>>((result, [key, child]) => {
      if (typeof child === "string") result[prefix + key] = child;
      else Object.assign(result, flatten(child as object, `${prefix + key}.`));
      return result;
    }, {});

  test("every language has the same non-empty labels, without control characters", () => {
    const keys = Object.keys(flatten(SUMMARY_LABELS["pt-BR"])).sort();
    expect(keys.length).toBeGreaterThan(30);
    for (const language of CONTENT_LANGUAGES) {
      const labels = flatten(SUMMARY_LABELS[language]);
      expect(Object.keys(labels).sort()).toEqual(keys);
      for (const value of Object.values(labels)) {
        expect(value.trim()).toBe(value);
        expect(value.length).toBeGreaterThan(0);
        expect(/\p{Cc}/u.test(value)).toBe(false);
      }
    }
    expect(SUMMARY_LABELS.en.summary).toBe("Summary");
    expect(SUMMARY_LABELS.es.decisions).toBe("Decisiones");
    expect(SUMMARY_LABELS["pt-BR"].unusedNotes).toBe("Notas suas que o modelo não usou");
  });

  test("labels are frozen", () => {
    expect(Object.isFrozen(SUMMARY_LABELS)).toBe(true);
    expect(Object.isFrozen(SUMMARY_LABELS.en.limitation)).toBe(true);
    expect(() => { (SUMMARY_LABELS.en as { summary: string }).summary = "x"; }).toThrow();
  });

  test("the pt-BR headings and limitation phrases are the exact strings summaries were written with before v2", () => {
    // The pipeline now writes these through SUMMARY_LABELS; pinned here so older summaries and
    // stored reviewed results keep reading (and rendering) byte for byte the same.
    const pt = SUMMARY_LABELS["pt-BR"];
    expect([pt.summary, pt.topics, pt.decisions, pt.actions, pt.evidence, pt.limitations, pt.noneFound, pt.noneFoundFeminine,
      pt.owner, pt.dueDate, pt.reviewNeeded, pt.yes, pt.notFlagged, pt.timing, pt.mediaSha256, pt.transcriptSha256, pt.fullText, pt.excerpts]).toEqual([
      "Resumo", "Tópicos", "Decisões", "Ações", "Evidências e limites", "Limitações", "Nenhum identificado", "Nenhuma identificada",
      "responsável", "prazo", "Revisão necessária", "sim", "não sinalizada (não garante correção semântica)", "Precisão temporal",
      "Mídia SHA-256", "Transcrição SHA-256", "Texto completo", "Trechos"]);
    expect(pt.limitation).toMatchObject({
      reviewRequired: "Resumo requer revisão: afirmação sem referência clara ou precisão temporal indisponível. Referências válidas não comprovam correção semântica.",
      chunked: "Resumo montado por partes: revisar redundâncias, contexto global e eventuais conflitos. Fragmentos mantêm o intervalo do segmento original.",
      chunkedReviewed: "Resumo montado por partes: revisar contexto global, redundâncias e conflitos; intervalos dos segmentos originais preservados.",
      visualEvidence: "Evidência visual seletiva requer revisão; um frame representa somente seu instante e suas observações não são prova semântica.",
      legacyTranscript: "Transcrição legada: mídia verificada, parâmetros originais completos não comprovados; revisar antes de reutilizar decisões.",
      visualExpired: "Evidência visual expirada; este resumo utiliza somente a transcrição e requer revisão das referências visuais.",
      partialRange: "Resumo parcial do intervalo selecionado; restante omitido.",
      reviewedNotesNotUsed: "Notas humanas sem tempo e rótulos acústicos permanecem na revisão; não foram usados como evidência do modelo.",
      reviewedLegacyUnverified: "Transcrição original legada sem recibo verificado; resumo requer revisão humana."
    });
    // No producer keeps its own copy of a localized phrase.
    const root = join(import.meta.dir, "..", "..");
    const sources = ["summary/evidence.ts", "summary/chunks.ts", "summary/reviewed.ts", "jobs/pipeline.ts", "jobs/format.ts"]
      .map((path) => readFileSync(join(root, path), "utf8")).join("\n");
    for (const phrase of Object.values(pt.limitation)) expect(sources).not.toContain(phrase);
    for (const heading of [pt.topics, pt.decisions, pt.evidence, pt.limitations]) expect(sources).not.toContain(`"## ${heading}"`);
  });
});
