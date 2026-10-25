import {
  BUILT_IN_TEMPLATES,
  GENERAL_TEMPLATE,
  GENERAL_TEMPLATE_ID,
  foldText,
  keywordTokens,
  type SummaryTemplate
} from "./catalog";

export type TemplateSelectionSource = "user" | "default" | "calendar" | "keywords" | "ai" | "fallback";

export type TemplateSelectionInput = {
  /** Choice made on this recording ("auto" or empty means none). */
  override?: string;
  /** The summary.template setting. */
  configDefault: string;
  /** The summary.templateDetection setting. */
  detection: "ai" | "keywords";
  calendar?: { title: string; recurring: boolean };
  transcriptSample?: string;
  /** Headings the user typed in the notepad ("# Bloqueios"). */
  noteHeadings?: string[];
  templates: readonly SummaryTemplate[];
};

export type TemplateSelection = {
  /** "model-choice": the summary request picks one of `candidates` and answers its id. */
  mode: "fixed" | "model-choice";
  template?: SummaryTemplate;
  candidates: SummaryTemplate[];
  source: TemplateSelectionSource;
  /** 0..1; 1 for explicit choices. */
  confidence: number;
  /** Portuguese, ready to show ("why this template"). */
  reason: string;
  /** Keywords or note headings behind a calendar/keywords choice. */
  matched: string[];
};

/** Calendar title score needed to decide; a runner-up this close makes the title ambiguous. */
export const CALENDAR_MIN_SCORE = 0.6;
export const CALENDAR_MIN_LEAD = 0.2;
/** Transcript keywords decide only with a clear winner. */
export const TRANSCRIPT_MIN_HITS = 3;
export const TRANSCRIPT_MIN_RATIO = 2;
/** Bounds the system prompt when the model chooses. */
export const MAX_MODEL_CHOICE_CANDIDATES = 16;

const TITLE_CHARACTERS = 300;
const TRANSCRIPT_SAMPLE_CHARACTERS = 60_000;
const MAX_NOTE_HEADINGS = 50;
const NOTE_HEADING_CHARACTERS = 200;
// One word repeated all meeting long is not a meeting type.
const KEYWORD_HIT_CAP = 2;
const HEADING_SECTION_HITS = 2;
const HEADING_KEYWORD_HITS = 1;
// Meeting types that usually recur; a recurring event adds to their title score.
const RECURRING_TYPES: ReadonlySet<string> = new Set(["standup", "retrospective", "planning", "one-on-one"]);

const round2 = (value: number): number => Math.round(value * 100) / 100;

type Match = { template: number; keyword: string; start: number; end: number };

const tokenPositions = (tokens: string[]): Map<string, number[]> => {
  const positions = new Map<string, number[]>();
  tokens.forEach((token, index) => {
    const list = positions.get(token);
    if (list) list.push(index);
    else positions.set(token, [index]);
  });
  return positions;
};

/** Every whole-word occurrence of each template keyword, then drops matches covered by a
 * longer one ("entrevista com usuario" hides "entrevista") or by a custom template with the
 * same words (your own "daily" template wins over the built-in one). */
const findMatches = (
  tokens: string[],
  templates: readonly SummaryTemplate[],
  keywordsOf: (template: SummaryTemplate) => readonly string[]
): Match[] => {
  const positions = tokenPositions(tokens);
  const matches: Match[] = [];
  let longest = 1;
  templates.forEach((template, templateIndex) => {
    for (const keyword of keywordsOf(template)) {
      const needle = keywordTokens(keyword);
      if (!needle.length) continue;
      longest = Math.max(longest, needle.length);
      for (const start of positions.get(needle[0]) || []) {
        if (needle.every((token, offset) => tokens[start + offset] === token)) {
          matches.push({ template: templateIndex, keyword, start, end: start + needle.length });
        }
      }
    }
  });
  const byStart = new Map<number, Match[]>();
  for (const match of matches) {
    const list = byStart.get(match.start);
    if (list) list.push(match);
    else byStart.set(match.start, [match]);
  }
  return matches.filter((match) => {
    const length = match.end - match.start;
    for (let start = Math.max(0, match.start - longest); start <= match.start; start++) {
      for (const other of byStart.get(start) || []) {
        if (other === match || other.end < match.end) continue;
        const otherLength = other.end - other.start;
        if (otherLength > length) return false;
        if (otherLength === length && other.start === match.start &&
            templates[match.template].builtIn && !templates[other.template].builtIn) return false;
      }
    }
    return true;
  });
};

type CalendarScore = { index: number; score: number; matched: string[] };

// "Ana <> Caio", "Ana Lima <-> Caio": two short capitalized names joined by an exchange sign.
const TWO_PARTY = /^\s*\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,2}\s*(?:<>|<->|↔)\s*\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,2}\s*$/u;
const ONE_ON_ONE_PREFIX = /^\s*(?:1\s*[:x-]\s*1|1on1|one[\s-]on[\s-]one)\s*[-—:|]?\s*/iu;

const scoreCalendarTitle = (title: string, recurring: boolean, templates: readonly SummaryTemplate[]): CalendarScore[] => {
  const text = title.slice(0, TITLE_CHARACTERS);
  const matches = findMatches(keywordTokens(text), templates, (template) => template.titleKeywords);
  const twoParty = TWO_PARTY.test(text.replace(ONE_ON_ONE_PREFIX, ""));
  return templates.map((template, index) => {
    const own = matches.filter((match) => match.template === index).sort((left, right) => left.start - right.start);
    const matched = [...new Set(own.map((match) => match.keyword))];
    if (!matched.length) return { index, score: 0, matched };
    const longest = Math.max(...own.map((match) => match.end - match.start));
    let score = (longest >= 2 ? 0.8 : 0.7) + 0.15 * (matched.length - 1);
    if (template.id === "one-on-one" && twoParty) {
      score += 0.15;
      matched.push("<>");
    }
    if (recurring && template.builtIn && RECURRING_TYPES.has(template.id)) score += 0.1;
    return { index, score: round2(Math.min(1, score)), matched };
  });
};

type TranscriptScore = { index: number; hits: number; matched: string[] };

const headingText = (heading: string): string =>
  foldText(heading.slice(0, NOTE_HEADING_CHARACTERS)).replace(/^\s*(?:#+|[-*]\s*\[[ x]\]|\[[ x]\]|[-*])\s*/, "").replace(/[\s:.]+$/, "").replace(/\s+/g, " ").trim();

const scoreTranscript = (sample: string, headings: string[], templates: readonly SummaryTemplate[]): TranscriptScore[] => {
  const matches = sample ? findMatches(keywordTokens(sample.slice(0, TRANSCRIPT_SAMPLE_CHARACTERS)), templates, (template) => template.transcriptKeywords) : [];
  const scores = templates.map((_template, index): TranscriptScore => {
    const counts = new Map<string, number>();
    for (const match of matches) if (match.template === index) counts.set(match.keyword, (counts.get(match.keyword) || 0) + 1);
    let hits = 0;
    for (const count of counts.values()) hits += Math.min(KEYWORD_HIT_CAP, count);
    return { index, hits, matched: [...counts.keys()] };
  });
  const cleaned = headings.slice(0, MAX_NOTE_HEADINGS).map(headingText).filter(Boolean);
  for (const heading of cleaned) {
    const headingTokens = keywordTokens(heading);
    const titleMatches = findMatches(headingTokens, templates, (template) => template.titleKeywords);
    templates.forEach((template, index) => {
      const sectionMatch = template.sections.some((section) =>
        Object.values(section.title).some((title) => foldText(title).replace(/\s+/g, " ").trim() === heading));
      if (sectionMatch) {
        scores[index].hits += HEADING_SECTION_HITS;
        scores[index].matched.push(`# ${heading}`);
      } else if (titleMatches.some((match) => match.template === index)) {
        scores[index].hits += HEADING_KEYWORD_HITS;
        scores[index].matched.push(`# ${heading}`);
      }
    });
  }
  return scores;
};

const uniqueTemplates = (templates: readonly SummaryTemplate[]): SummaryTemplate[] => {
  const seen = new Set<string>();
  const list = (templates.length ? templates : BUILT_IN_TEMPLATES).filter((template) => {
    if (!template || typeof template.id !== "string" || seen.has(template.id)) return false;
    seen.add(template.id);
    return true;
  });
  return list.some((template) => template.id === GENERAL_TEMPLATE_ID) ? list : [GENERAL_TEMPLATE, ...list];
};

const nameOf = (template: SummaryTemplate): string => template.name["pt-BR"];

const fixed = (
  template: SummaryTemplate,
  source: TemplateSelectionSource,
  confidence: number,
  reason: string,
  matched: string[] = []
): TemplateSelection => ({ mode: "fixed", template, candidates: [template], source, confidence, reason, matched });

const choiceRequested = (value: string | undefined): string | undefined => {
  const id = (typeof value === "string" ? value : "").trim();
  return id && id !== "auto" ? id : undefined;
};

// An id that matched nothing is echoed in the reason; keep it one short line.
const MISSING_ID_CHARACTERS = 60;
const shownId = (id: string): string => {
  const line = id.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return line.length > MISSING_ID_CHARACTERS ? `${line.slice(0, MISSING_ID_CHARACTERS - 1)}…` : line;
};

/** Picks the template of one summary. Order: your choice on the recording, the default in
 * the settings, the calendar title, keywords in the transcript and note headings, then the
 * model itself ("ai") or the general template. Deterministic; no I/O. */
export const selectTemplate = (input: TemplateSelectionInput): TemplateSelection => {
  const templates = uniqueTemplates(input.templates);
  const general = templates.find((template) => template.id === GENERAL_TEMPLATE_ID) as SummaryTemplate;
  const byId = (id: string) => templates.find((template) => template.id === id);
  const notes: string[] = [];

  const override = choiceRequested(input.override);
  if (override) {
    const template = byId(override);
    if (template) return fixed(template, "user", 1, `Modelo escolhido por você: ${nameOf(template)}.`);
    notes.push(`O modelo escolhido (${shownId(override)}) não existe mais.`);
  }
  const configured = choiceRequested(input.configDefault);
  if (configured) {
    const template = byId(configured);
    if (template) return fixed(template, "default", 1, [...notes, `Modelo padrão das configurações: ${nameOf(template)}.`].join(" "));
    notes.push(`O modelo padrão (${shownId(configured)}) não existe mais.`);
  }

  const calendarScores = input.calendar && typeof input.calendar.title === "string"
    ? scoreCalendarTitle(input.calendar.title, input.calendar.recurring === true, templates)
    : templates.map((_template, index): CalendarScore => ({ index, score: 0, matched: [] }));
  const rankedCalendar = [...calendarScores].sort((left, right) => right.score - left.score || left.index - right.index);
  const [topCalendar, secondCalendar] = rankedCalendar;
  if (topCalendar && topCalendar.score >= CALENDAR_MIN_SCORE) {
    const runnerUp = secondCalendar?.score ?? 0;
    const template = templates[topCalendar.index];
    // Rounded: 1 - 0.8 is 0.19999999999999996 in floating point, which is still a lead of 0.2.
    if (runnerUp < CALENDAR_MIN_SCORE || round2(topCalendar.score - runnerUp) >= CALENDAR_MIN_LEAD) {
      return fixed(template, "calendar", topCalendar.score,
        [...notes, `O título da agenda indica ${nameOf(template)} (${topCalendar.matched.join(", ")}).`].join(" "), topCalendar.matched);
    }
    notes.push(`O título da agenda é ambíguo entre ${nameOf(template)} e ${nameOf(templates[secondCalendar.index])}.`);
  }

  const headings = Array.isArray(input.noteHeadings) ? input.noteHeadings.filter((item): item is string => typeof item === "string") : [];
  const transcriptScores = scoreTranscript(typeof input.transcriptSample === "string" ? input.transcriptSample : "", headings, templates);
  const rankedTranscript = [...transcriptScores].sort((left, right) => right.hits - left.hits || left.index - right.index);
  const [topTranscript, secondTranscript] = rankedTranscript;
  if (topTranscript && topTranscript.hits >= TRANSCRIPT_MIN_HITS && topTranscript.hits >= TRANSCRIPT_MIN_RATIO * (secondTranscript?.hits ?? 0)) {
    const template = templates[topTranscript.index];
    const fromHeadings = topTranscript.matched.some((item) => item.startsWith("# "));
    const what = fromHeadings ? "Os títulos das suas notas e termos da conversa indicam" : "Termos da conversa indicam";
    const shown = topTranscript.matched.slice(0, 6);
    return fixed(template, "keywords", round2(Math.min(0.9, 0.6 + 0.05 * (topTranscript.hits - TRANSCRIPT_MIN_HITS))),
      [...notes, `${what} ${nameOf(template)} (${shown.join(", ")}).`].join(" "), topTranscript.matched);
  }

  if (input.detection === "ai") {
    // Rank by the weak signals so the cap keeps the likeliest ones; general always first.
    const signal = (index: number) => calendarScores[index].score + transcriptScores[index].hits / 10;
    const candidates = templates
      .map((template, index) => ({ template, index }))
      .sort((left, right) => {
        if (left.template.id === GENERAL_TEMPLATE_ID) return -1;
        if (right.template.id === GENERAL_TEMPLATE_ID) return 1;
        return signal(right.index) - signal(left.index) ||
          Number(right.template.builtIn) - Number(left.template.builtIn) || left.index - right.index;
      })
      .slice(0, MAX_MODEL_CHOICE_CANDIDATES)
      .map((entry) => entry.template);
    return {
      mode: "model-choice",
      candidates,
      source: "ai",
      confidence: 0,
      reason: [...notes, `Sem sinal claro; o modelo escolhe entre ${candidates.length} modelos pela conversa.`].join(" "),
      matched: []
    };
  }
  return fixed(general, "fallback", 0, [...notes, "Sem sinal claro; usado o modelo geral."].join(" "));
};

/** Records the model's answer to a model-choice selection. An id outside the candidates
 * (never expected with a strict schema) falls back to the general template. */
export const resolveModelChoice = (selection: TemplateSelection, templateId: unknown): TemplateSelection => {
  if (selection.mode !== "model-choice") return selection;
  const template = typeof templateId === "string" ? selection.candidates.find((candidate) => candidate.id === templateId) : undefined;
  if (template) {
    return { ...selection, template, source: "ai", confidence: 0.5, reason: `O modelo escolheu ${nameOf(template)} pela conversa.`, matched: [] };
  }
  const general = selection.candidates.find((candidate) => candidate.id === GENERAL_TEMPLATE_ID) || GENERAL_TEMPLATE;
  return { ...selection, template: general, source: "fallback", confidence: 0, reason: "O modelo não indicou um modelo válido; usado o modelo geral.", matched: [] };
};
