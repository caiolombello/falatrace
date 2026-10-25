import { toContentLanguage, type ContentLanguage } from "../summary/language";

/** Text in each language a summary can be written in. */
export type LocalizedText = { "pt-BR": string; en: string; es: string };

export type TemplateSection = {
  id: string;
  title: LocalizedText;
  /** English, for the model. */
  instruction: string;
};

export type SummaryTemplate = {
  /** Built-ins: kebab-case. Custom: "custom:<slug>". */
  id: string;
  /** Revision of the template; custom templates count saves, built-ins change it when their text changes. */
  version: number;
  builtIn: boolean;
  name: LocalizedText;
  /** English, one sentence; also shown to the model. */
  description: string;
  /** Lowercase, accent-free; matched as whole words in the calendar title. */
  titleKeywords: string[];
  /** Lowercase, accent-free terms that suggest this meeting type in the transcript. */
  transcriptKeywords: string[];
  sections: TemplateSection[];
  /** English, extra instructions for the model. */
  guidance: string;
};

export const BUILT_IN_TEMPLATE_IDS = [
  "general",
  "one-on-one",
  "standup",
  "planning",
  "retrospective",
  "sales-discovery",
  "postmortem",
  "hiring-interview",
  "user-research"
] as const;
export type BuiltInTemplateId = (typeof BUILT_IN_TEMPLATE_IDS)[number];

export const GENERAL_TEMPLATE_ID: BuiltInTemplateId = "general";

export const TEMPLATE_LIMITS = Object.freeze({
  nameCharacters: 80,
  descriptionCharacters: 300,
  keywordCharacters: 60,
  titleKeywords: 40,
  transcriptKeywords: 60,
  minSections: 3,
  maxSections: 8,
  sectionTitleCharacters: 80,
  instructionCharacters: 600,
  guidanceCharacters: 2000,
  maxVersion: 1_000_000
});

/** Same grammar as the summary.template setting (src/config/load.ts). */
export const BUILT_IN_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
export const CUSTOM_ID_PATTERN = /^custom:([a-z0-9][a-z0-9-]{0,40})$/;
const SECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

/** Fixed messages; the Studio bridge whitelists and translates them. */
export const TEMPLATE_MESSAGES = Object.freeze({
  invalid: "O modelo de resumo é inválido.",
  invalidId: "O identificador do modelo é inválido; use letras minúsculas, números e hífens.",
  unknownFields: "O modelo contém campos desconhecidos.",
  invalidName: "O nome do modelo é obrigatório em português, inglês e espanhol, com até 80 caracteres.",
  invalidDescription: "A descrição do modelo é obrigatória, em uma linha de até 300 caracteres.",
  invalidKeywords: "As palavras-chave do modelo são inválidas; use termos curtos em minúsculas, sem acentos e sem repetir.",
  sectionCount: "O modelo precisa ter de 3 a 8 seções.",
  invalidSection: "Cada seção precisa de um título de até 80 caracteres em cada idioma e de uma instrução de até 600 caracteres.",
  duplicateSection: "As seções do modelo precisam ter identificadores e títulos diferentes.",
  invalidGuidance: "As orientações do modelo devem ter até 2000 caracteres.",
  builtInReadOnly: "Modelos embutidos não podem ser alterados nem apagados.",
  customIdRequired: "Modelos personalizados usam identificadores no formato custom:<nome>.",
  exists: "Já existe um modelo personalizado com esse identificador.",
  conflict: "O modelo mudou em outra janela; recarregue antes de salvar.",
  missing: "O modelo personalizado não existe mais.",
  limit: "Limite de 100 modelos personalizados atingido; apague algum antes de criar outro.",
  invalidFile: "O arquivo do modelo personalizado é inválido; corrija ou apague o arquivo.",
  unsafeDirectory: "A pasta de modelos personalizados não é segura; ela precisa ser uma pasta comum, sem link simbólico.",
  tooLarge: "O modelo é grande demais (limite de 64 KiB).",
  busy: "Outra janela está salvando modelos; tente de novo."
});

export const TEMPLATE_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(TEMPLATE_MESSAGES));

/** A template failed validation; `message` is one of TEMPLATE_KNOWN_ERRORS, `field` says where. */
export class TemplateValidationError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "TemplateValidationError";
    this.field = field;
  }
}

/** Lowercase and accent-free, the form keywords are stored and matched in. */
export const foldText = (value: string): string =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").normalize("NFC");

/** Word tokens used to match keywords: "1:1" -> ["1", "1"], "Pós-mortem" -> ["pos", "mortem"]. */
export const keywordTokens = (value: string): string[] => foldText(value).match(/[a-z0-9]+/g) || [];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

// Control characters, and lone surrogates (they do not survive UTF-8).
const CONTROL = /[\p{Cc}\p{Cs}]/u;
const hasControlExceptNewline = (value: string): boolean => CONTROL.test(value.replace(/\n/g, ""));

const line = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);

const LANGUAGE_KEYS = ["pt-BR", "en", "es"] as const;

const localized = (value: unknown, max: number, message: string, field: string): LocalizedText => {
  if (!isObject(value) || !hasOnlyKeys(value, LANGUAGE_KEYS)) throw new TemplateValidationError(message, field);
  const result = {} as LocalizedText;
  for (const key of LANGUAGE_KEYS) {
    const text = value[key];
    if (!line(text, max)) throw new TemplateValidationError(message, `${field}.${key}`);
    result[key] = text.trim();
  }
  return result;
};

const keywords = (value: unknown, max: number, field: string): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidKeywords, field);
  const seen = new Set<string>();
  return value.map((item, index) => {
    // Stored already folded and trimmed, so what the file says is what gets matched.
    if (!line(item, TEMPLATE_LIMITS.keywordCharacters) || item !== foldText(item).replace(/\s+/g, " ").trim() ||
        keywordTokens(item).length === 0 || seen.has(item)) {
      throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidKeywords, `${field}[${index}]`);
    }
    seen.add(item);
    return item;
  });
};

const TEMPLATE_KEYS = ["id", "version", "builtIn", "name", "description", "titleKeywords", "transcriptKeywords", "sections", "guidance"] as const;
const SECTION_KEYS = ["id", "title", "instruction"] as const;

/** Strict validation; rebuilds the template field by field and rejects unknown fields. */
export const validateTemplate = (value: unknown): SummaryTemplate => {
  if (!isObject(value)) throw new TemplateValidationError(TEMPLATE_MESSAGES.invalid, "template");
  if (!hasOnlyKeys(value, TEMPLATE_KEYS)) throw new TemplateValidationError(TEMPLATE_MESSAGES.unknownFields, "template");
  const id = value.id;
  if (typeof id !== "string" || !(BUILT_IN_ID_PATTERN.test(id) || CUSTOM_ID_PATTERN.test(id))) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidId, "id");
  }
  if (typeof value.builtIn !== "boolean" || value.builtIn === CUSTOM_ID_PATTERN.test(id)) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidId, "builtIn");
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || (value.version as number) > TEMPLATE_LIMITS.maxVersion) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.invalid, "version");
  }
  const name = localized(value.name, TEMPLATE_LIMITS.nameCharacters, TEMPLATE_MESSAGES.invalidName, "name");
  if (!line(value.description, TEMPLATE_LIMITS.descriptionCharacters)) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidDescription, "description");
  }
  const titleKeywords = keywords(value.titleKeywords, TEMPLATE_LIMITS.titleKeywords, "titleKeywords");
  const transcriptKeywords = keywords(value.transcriptKeywords, TEMPLATE_LIMITS.transcriptKeywords, "transcriptKeywords");
  if (!Array.isArray(value.sections) || value.sections.length < TEMPLATE_LIMITS.minSections || value.sections.length > TEMPLATE_LIMITS.maxSections) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.sectionCount, "sections");
  }
  const sectionIds = new Set<string>();
  const titles: Record<ContentLanguage, Set<string>> = { "pt-BR": new Set(), en: new Set(), es: new Set() };
  const sections = value.sections.map((item, index): TemplateSection => {
    const field = `sections[${index}]`;
    if (!isObject(item)) throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidSection, field);
    if (!hasOnlyKeys(item, SECTION_KEYS)) throw new TemplateValidationError(TEMPLATE_MESSAGES.unknownFields, field);
    if (typeof item.id !== "string" || !SECTION_ID_PATTERN.test(item.id)) throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidSection, `${field}.id`);
    const title = localized(item.title, TEMPLATE_LIMITS.sectionTitleCharacters, TEMPLATE_MESSAGES.invalidSection, `${field}.title`);
    if (!line(item.instruction, TEMPLATE_LIMITS.instructionCharacters)) {
      throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidSection, `${field}.instruction`);
    }
    if (sectionIds.has(item.id)) throw new TemplateValidationError(TEMPLATE_MESSAGES.duplicateSection, `${field}.id`);
    sectionIds.add(item.id);
    for (const language of LANGUAGE_KEYS) {
      const key = foldText(title[language]).replace(/\s+/g, " ");
      if (titles[language].has(key)) throw new TemplateValidationError(TEMPLATE_MESSAGES.duplicateSection, `${field}.title.${language}`);
      titles[language].add(key);
    }
    return { id: item.id, title, instruction: item.instruction.trim() };
  });
  const guidance = value.guidance;
  if (typeof guidance !== "string" || guidance.length > TEMPLATE_LIMITS.guidanceCharacters || hasControlExceptNewline(guidance)) {
    throw new TemplateValidationError(TEMPLATE_MESSAGES.invalidGuidance, "guidance");
  }
  return {
    id,
    version: value.version as number,
    builtIn: value.builtIn,
    name,
    description: value.description.trim(),
    titleKeywords,
    transcriptKeywords,
    sections,
    guidance: guidance.trim()
  };
};

/** Template name in a content language (accepts loose tags such as Studio's "pt"). */
export const templateName = (template: SummaryTemplate, language: ContentLanguage | string): string =>
  template.name[toContentLanguage(language)];

/** Section heading in a content language. */
export const sectionTitle = (section: TemplateSection, language: ContentLanguage | string): string =>
  section.title[toContentLanguage(language)];

export const isBuiltInTemplateId = (id: string): id is BuiltInTemplateId =>
  (BUILT_IN_TEMPLATE_IDS as readonly string[]).includes(id);

export const isCustomTemplateId = (id: string): boolean => CUSTOM_ID_PATTERN.test(id);

/** The <slug> of "custom:<slug>", or undefined for anything else. */
export const customTemplateSlug = (id: string): string | undefined => CUSTOM_ID_PATTERN.exec(id)?.[1];

/** "custom:<slug>" derived from a display name ("Comitê de Riscos" -> "custom:comite-de-riscos"). */
export const customTemplateIdFromName = (name: string): string | undefined => {
  const slug = keywordTokens(name).join("-").slice(0, 41).replace(/-+$/, "");
  return slug ? `custom:${slug}` : undefined;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

type BuiltInDefinition = Omit<SummaryTemplate, "builtIn" | "version"> & { id: BuiltInTemplateId };

const section = (id: string, ptBR: string, en: string, es: string, instruction: string): TemplateSection =>
  ({ id, title: { "pt-BR": ptBR, en, es }, instruction });

const NEXT_STEPS_INSTRUCTION =
  "Agreed follow-ups: who does what and by when, only as stated. Use the person's name when it was said; never assign an owner or a date that was not said.";

// Section seeds follow common meeting-note structures (see docs research on meeting templates).
const DEFINITIONS: BuiltInDefinition[] = [
  {
    id: "general",
    name: { "pt-BR": "Geral", en: "General", es: "General" },
    description: "General-purpose meeting notes: what was discussed, what was decided and what happens next.",
    titleKeywords: [],
    transcriptKeywords: [],
    sections: [
      section("summary", "Resumo", "Summary", "Resumen",
        "The key takeaways in two to four items: why the meeting happened and its main outcomes. Do not repeat the overview sentence by sentence."),
      section("discussion", "Pontos discutidos", "Discussion points", "Puntos tratados",
        "One item per subject discussed, with the positions, facts and numbers that were said. Group related remarks and keep names of people, systems and products exactly as said."),
      section("decisions", "Decisões", "Decisions", "Decisiones",
        "Only decisions that were explicitly agreed, each as a full sentence stating what was decided (and by whom, when said). Proposals that were not agreed belong in the discussion points."),
      section("next-steps", "Próximos passos", "Next steps", "Próximos pasos", NEXT_STEPS_INSTRUCTION)
    ],
    guidance: "Use this structure when the meeting does not fit a more specific type. Prefer short, factual items over narrative."
  },
  {
    id: "one-on-one",
    name: { "pt-BR": "1:1", en: "One-on-one", es: "1:1" },
    description: "A private one-on-one between two people, usually a manager and a report: updates, blockers, feedback and agreements.",
    titleKeywords: ["1:1", "1x1", "1on1", "1 on 1", "one on one", "1 a 1", "uno a uno", "skip level", "mentoria", "mentoring", "coaching", "conversa individual", "reuniao individual", "reunion individual"],
    transcriptKeywords: ["pdi", "plano de desenvolvimento", "development plan", "plan de desarrollo", "carreira", "career", "carrera", "promocao", "promotion", "promocion", "avaliacao de desempenho", "performance review", "bem estar", "wellbeing", "burnout", "como voce esta se sentindo", "how are you feeling", "feedback para voce", "feedback for you"],
    sections: [
      section("updates", "Atualizações", "Updates", "Novedades",
        "What each person shared about their work, priorities and wellbeing since the last conversation. Keep personal matters brief and respectful."),
      section("blockers", "Bloqueios", "Blockers", "Bloqueos",
        "Obstacles, concerns or support needed that were raised, and who offered to help."),
      section("feedback", "Feedback", "Feedback", "Feedback",
        "Feedback given in either direction, with the concrete example mentioned. Attribute it to who gave it; do not soften or exaggerate it."),
      section("next-steps", "Próximos passos", "Next steps", "Próximos pasos", NEXT_STEPS_INSTRUCTION)
    ],
    guidance: "This is a private conversation. Record work-relevant points; leave out sensitive personal details unless they were explicitly part of an agreement, and never speculate about feelings or performance."
  },
  {
    id: "standup",
    name: { "pt-BR": "Daily (stand-up)", en: "Daily stand-up", es: "Daily (reunión diaria)" },
    description: "A short recurring status round where each person says what they did, what they will do next and what blocks them.",
    titleKeywords: ["daily", "standup", "stand up", "daily scrum", "scrum diario", "reuniao diaria", "reunion diaria", "status diario", "check in diario", "huddle"],
    transcriptKeywords: ["ontem eu", "ontem fiz", "ontem terminei", "hoje vou", "hoje eu vou", "hoje sigo", "impedimento", "impedimentos", "travado", "yesterday i", "today i will", "today i'm", "blocker", "blockers", "blocked on", "ayer hice", "hoy voy", "bloqueo", "bloqueado"],
    sections: [
      section("yesterday", "Ontem", "Yesterday", "Ayer",
        "What each person reported finishing or working on since the last stand-up: one item per person or piece of work, with the person's name when it was said."),
      section("today", "Hoje", "Today", "Hoy",
        "What each person plans to work on next: one item per person or piece of work, with the person's name when it was said."),
      section("blockers", "Bloqueios", "Blockers", "Bloqueos",
        "Impediments and dependencies that were raised, who is blocked and who offered to help.")
    ],
    guidance: "Stand-ups are quick status rounds. Organize items by person when names are known, keep each item to one line, and do not turn status updates into decisions."
  },
  {
    id: "planning",
    name: { "pt-BR": "Planejamento", en: "Planning", es: "Planificación" },
    description: "A planning session (sprint, quarter, roadmap or project kickoff) that sets goals, scope, risks, owners and dates.",
    titleKeywords: ["planning", "sprint planning", "planejamento", "planificacion", "planeacion", "planning poker", "refinamento", "refinement", "refinamiento", "grooming", "backlog", "roadmap", "kickoff", "kick off", "okr", "okrs", "pi planning"],
    transcriptKeywords: ["story points", "pontos de historia", "estimativa", "estimate", "estimacion", "capacidade do time", "team capacity", "escopo da sprint", "sprint scope", "meta da sprint", "objetivo da sprint", "sprint goal", "priorizar", "prioritize", "backlog", "entregavel", "deliverable", "roadmap", "milestone"],
    sections: [
      section("goals", "Objetivos", "Goals", "Objetivos",
        "The goals agreed for the period or project, written as outcomes rather than tasks."),
      section("scope", "Escopo", "Scope", "Alcance",
        "What is in and what was explicitly left out, with estimates or sizes exactly as stated."),
      section("risks", "Riscos", "Risks", "Riesgos",
        "Risks, dependencies and open questions that were raised, with any mitigation mentioned."),
      section("owners", "Responsáveis e prazos", "Owners and dates", "Responsables y plazos",
        "Who owns each piece of work and the dates or milestones that were stated. Never infer an owner or a date.")
    ],
    guidance: "Capture commitments precisely: numbers, dates and scope boundaries matter more than the discussion that led to them."
  },
  {
    id: "retrospective",
    name: { "pt-BR": "Retrospectiva", en: "Retrospective", es: "Retrospectiva" },
    description: "A team retrospective that reviews what went well, what to improve and the actions to try next.",
    titleKeywords: ["retro", "retrospectiva", "retrospective", "lessons learned", "licoes aprendidas", "lecciones aprendidas", "start stop continue"],
    transcriptKeywords: ["o que foi bem", "o que deu certo", "o que pode melhorar", "o que nao foi bem", "what went well", "what didn't go well", "what could be better", "keep doing", "stop doing", "start doing", "continuar fazendo", "parar de fazer", "comecar a fazer", "lo que salio bien", "que podemos mejorar", "retro"],
    sections: [
      section("went-well", "O que foi bem", "What went well", "Lo que salió bien",
        "What the team said worked well in the period, grouping repeated points."),
      section("improve", "O que melhorar", "What to improve", "Qué mejorar",
        "Problems and frustrations raised and the improvements suggested, grouping repeated points."),
      section("actions", "Ações", "Action items", "Acciones",
        "Improvement actions the team agreed to try, with the owner when stated.")
    ],
    guidance: "Record the team's points without judging individuals. Mention how many people raised a point or how votes went only when that was said."
  },
  {
    id: "sales-discovery",
    name: { "pt-BR": "Descoberta comercial", en: "Sales discovery", es: "Descubrimiento comercial" },
    description: "A sales or discovery call with a prospect or customer: their context, pains, budget and decision process, and next steps.",
    titleKeywords: ["discovery", "discovery call", "sales", "sales call", "vendas", "comercial", "prospect", "prospeccao", "qualificacao", "qualification", "bant", "pitch", "proposta comercial", "apresentacao comercial", "intro call", "reunion comercial", "ventas", "llamada de descubrimiento"],
    transcriptKeywords: ["orcamento", "budget", "presupuesto", "decisor", "tomador de decisao", "decision maker", "proposta", "proposal", "propuesta", "contrato", "contract", "preco", "pricing", "precio", "concorrente", "competitor", "competidor", "pain point", "piloto", "pilot", "prova de conceito", "proof of concept", "licencas", "licenses"],
    sections: [
      section("customer-context", "Contexto do cliente", "Customer context", "Contexto del cliente",
        "Who the customer is: company, team, people present and their roles, current tools and situation, as stated."),
      section("pains", "Dores", "Pain points", "Dolores",
        "Problems and needs the customer described, in their own terms, with any numbers or examples they gave."),
      section("bant", "Orçamento e decisão (BANT)", "Budget and decision (BANT)", "Presupuesto y decisión (BANT)",
        "Budget, authority (who decides and who influences), need and timeline, one item each when discussed. Mark anything inferred as uncertain and never guess figures."),
      section("objections", "Objeções e concorrência", "Objections and competition", "Objeciones y competencia",
        "Objections, concerns, and competitors or alternatives the customer mentioned, and how each was answered."),
      section("next-steps", "Próximos passos", "Next steps", "Próximos pasos",
        "Follow-ups agreed on both sides (materials, demos, proposals, next meeting) with owners and dates only as stated.")
    ],
    guidance: "Focus on what the customer said rather than on the pitch. Keep customer quotes faithful and figures exact, and distinguish real commitments from interest."
  },
  {
    id: "postmortem",
    name: { "pt-BR": "Postmortem de incidente", en: "Incident postmortem", es: "Postmortem de incidente" },
    description: "A blameless incident review covering impact, timeline, root cause, what worked and the corrective actions.",
    titleKeywords: ["postmortem", "post mortem", "pos mortem", "post incident review", "incident review", "revisao de incidente", "revision de incidente", "incidente", "incident", "rca", "root cause", "causa raiz", "war room", "sala de guerra", "outage"],
    transcriptKeywords: ["causa raiz", "root cause", "linha do tempo", "rollback", "alerta disparou", "alert fired", "pager", "plantao", "on call", "mitigacao", "mitigation", "mitigacion", "indisponibilidade", "downtime", "outage", "sev1", "sev 1", "slo", "incidente", "incident", "postmortem", "post mortem"],
    sections: [
      section("impact", "Impacto", "Impact", "Impacto",
        "Who and what was affected, for how long and how badly (users, revenue, SLOs), with the numbers stated. Mark estimates as uncertain."),
      section("timeline", "Linha do tempo", "Timeline", "Cronología",
        "Key events in order: start, detection, escalation, mitigation, resolution. Use clock times only when they were said; otherwise keep the order without inventing times."),
      section("root-cause", "Causa raiz", "Root cause", "Causa raíz",
        "The technical and process causes identified, separating confirmed causes from hypotheses still under investigation (uncertain)."),
      section("what-worked", "O que funcionou", "What worked", "Qué funcionó",
        "Detection, tooling, communication or decisions that helped limit the impact."),
      section("what-failed", "O que não funcionou", "What did not work", "Qué no funcionó",
        "Gaps in detection, response, tooling, process or communication that made the incident worse or longer."),
      section("corrective-actions", "Ações corretivas", "Corrective actions", "Acciones correctivas",
        "Corrective and preventive actions agreed, with owner and due date only as stated.")
    ],
    guidance: "Write blameless notes: describe systems, conditions and decisions rather than blaming people. Be exact with service names, versions, error messages and numbers, and never invent times."
  },
  {
    id: "hiring-interview",
    name: { "pt-BR": "Entrevista de contratação", en: "Hiring interview", es: "Entrevista de selección" },
    description: "A job interview with a candidate: profile, strengths, concerns, the interviewers' assessment and next steps.",
    titleKeywords: ["entrevista", "interview", "entrevista tecnica", "technical interview", "tech interview", "screening", "candidato", "candidata", "candidate", "hiring", "recrutamento", "recruiting", "processo seletivo", "proceso de seleccion", "reclutamiento", "live coding", "fit cultural", "culture fit"],
    transcriptKeywords: ["experiencia anterior", "previous experience", "pretensao salarial", "expectativa salarial", "salary expectations", "pretension salarial", "notice period", "aviso previo", "conte sobre voce", "fale sobre voce", "tell me about yourself", "cuentame sobre ti", "por que voce quer", "why do you want", "curriculo", "portfolio", "vaga", "candidato", "candidate", "proxima etapa do processo", "next stage of the process"],
    sections: [
      section("profile", "Perfil", "Candidate profile", "Perfil",
        "The role discussed and the candidate's background, experience and motivation as they described them."),
      section("strengths", "Pontos fortes", "Strengths", "Fortalezas",
        "Strengths shown in the interview, each tied to a concrete answer or example."),
      section("concerns", "Pontos de atenção", "Concerns", "Puntos de atención",
        "Gaps, doubts or risks observed, each tied to a concrete answer; mark interpretations as uncertain."),
      section("assessment", "Avaliação", "Assessment", "Evaluación",
        "Only the assessment or recommendation the interviewers explicitly stated. Never produce a hiring verdict of your own."),
      section("next-steps", "Próximos passos", "Next steps", "Próximos pasos",
        "Next stages of the process, deadlines and who does what, only as stated.")
    ],
    guidance: "Be fair and evidence-based. Do not record or infer age, health, family plans, religion, ethnicity or other protected characteristics, and never judge the candidate beyond what the interviewers said."
  },
  {
    id: "user-research",
    name: { "pt-BR": "Pesquisa com usuários", en: "User research", es: "Investigación con usuarios" },
    description: "A user research session or usability test: who the participant is, their goals, pains, notable quotes and opportunities.",
    titleKeywords: ["user research", "ux research", "pesquisa com usuario", "pesquisa com usuarios", "pesquisa de usuario", "pesquisa ux", "entrevista com usuario", "entrevista de usuario", "entrevista com cliente", "entrevista de cliente", "entrevista con usuario", "entrevista con cliente", "user interview", "customer interview", "usabilidade", "teste de usabilidade", "usability", "usability test", "prueba de usabilidad", "investigacion de usuarios", "product discovery", "discovery de produto", "ux discovery", "jtbd", "jobs to be done", "user testing", "teste com usuario", "focus group", "grupo focal"],
    transcriptKeywords: ["como voce usa", "how do you use", "como usas", "me conta a ultima vez", "tell me about the last time", "o que voce esperava", "what did you expect", "frustracao", "frustrating", "frustrante", "confuso", "confusing", "prototipo", "prototype", "nessa tela", "on this screen", "en esta pantalla", "usabilidade", "usability", "usabilidad", "user journey"],
    sections: [
      section("participant", "Perfil", "Participant profile", "Perfil",
        "Who the participant is: role, context and relevant habits or tools, as stated. No personal data beyond what matters for the research."),
      section("goals", "Objetivos", "Goals", "Objetivos",
        "What the participant is trying to achieve and why (jobs to be done)."),
      section("pains", "Dores e fricções", "Pain points and friction", "Dolores y fricciones",
        "Problems, workarounds and moments of confusion observed or described, with the task or screen involved."),
      section("quotes", "Citações marcantes", "Notable quotes", "Citas destacadas",
        "Up to five short verbatim quotes from the participant that capture key insights, kept in the original language, each citing its segment."),
      section("opportunities", "Oportunidades", "Opportunities", "Oportunidades",
        "Opportunities and ideas suggested by the evidence; mark them uncertain when they are interpretation rather than something the participant said.")
    ],
    guidance: "Separate observation from interpretation. Prefer the participant's own words and do not generalize from a single session."
  }
];

/** The fixed catalog, deep-frozen; ids never change. */
export const BUILT_IN_TEMPLATES: readonly SummaryTemplate[] = deepFreeze(
  DEFINITIONS.map((definition) => validateTemplate({ ...definition, version: 1, builtIn: true }))
);

export const builtInTemplate = (id: string): SummaryTemplate | undefined =>
  BUILT_IN_TEMPLATES.find((template) => template.id === id);

/** The general template, the fallback of every selection. */
export const GENERAL_TEMPLATE: SummaryTemplate = builtInTemplate(GENERAL_TEMPLATE_ID) as SummaryTemplate;
