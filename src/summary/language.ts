import type { SummaryLanguage } from "../config/defaults";

/** Languages a summary can be written in ("auto" resolves to one of these). */
export const CONTENT_LANGUAGES = ["pt-BR", "en", "es"] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];

export const isContentLanguage = (value: unknown): value is ContentLanguage =>
  typeof value === "string" && (CONTENT_LANGUAGES as readonly string[]).includes(value);

/** Maps loose tags ("pt", "pt_BR", "en-US", "es-419", Studio's "pt"/"en") to a content language. */
export const toContentLanguage = (value: string | undefined, fallback: ContentLanguage = "pt-BR"): ContentLanguage => {
  const tag = (value || "").trim().toLowerCase().replace(/_/g, "-");
  if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "es" || tag.startsWith("es-")) return "es";
  return fallback;
};

/** How the language is named to the model in the v2 system prompt. */
export const LANGUAGE_PROMPT_NAMES: Readonly<Record<ContentLanguage, string>> = Object.freeze({
  "pt-BR": "Brazilian Portuguese (pt-BR)",
  en: "English",
  es: "Spanish"
});

/** Detection reads at most this many characters, spread over the text. */
export const LANGUAGE_SAMPLE_CHARACTERS = 20_000;

// Only words that are frequent in one language and rare in the other two count, so shared
// function words ("que", "de", "a", "no", "como", "do", "as") never tip the balance.
const STOPWORDS: Readonly<Record<ContentLanguage, ReadonlySet<string>>> = {
  "pt-BR": new Set([
    "não", "é", "o", "os", "e", "um", "uma", "uns", "umas", "com", "sem", "em", "da", "na", "nas", "ao", "aos", "à", "às",
    "pelo", "pela", "pelos", "pelas", "num", "numa", "isso", "isto", "esse", "essa", "esses", "essas", "aquilo", "então", "também",
    "você", "vocês", "eu", "ele", "ela", "eles", "elas", "nós", "meu", "minha", "seu", "sua", "nosso", "nossa", "pra", "pro", "tá",
    "aí", "né", "tô", "muito", "muita", "mas", "mais", "foi", "são", "tem", "têm", "tenho", "temos", "há", "vai", "vou", "aqui",
    "agora", "já", "só", "sim", "bom", "tudo", "ainda", "depois", "fazer", "até", "coisa", "onde", "quem", "quando", "estou",
    "acho", "pode", "hoje", "ontem", "amanhã", "obrigado", "obrigada", "olá", "pouco", "assim", "porém", "lá"
  ]),
  en: new Set([
    "the", "and", "is", "are", "was", "were", "to", "of", "in", "that", "it", "it's", "we", "we're", "you", "you're", "i", "i'm",
    "for", "on", "with", "this", "be", "have", "has", "not", "don't", "so", "but", "they", "what", "does", "can", "will", "just",
    "about", "there", "if", "at", "or", "my", "our", "your", "like", "yeah", "think", "know", "going", "gonna", "would", "should",
    "from", "get", "all", "out", "up", "then", "that's", "really", "right", "because", "which", "been", "how", "when", "where",
    "who", "an", "by", "she", "them", "their", "here", "let's", "also", "any", "some", "could", "did", "need"
  ]),
  es: new Set([
    "el", "la", "los", "las", "lo", "le", "les", "del", "al", "un", "una", "unos", "unas", "con", "sin", "en", "es", "son", "fue",
    "muy", "pero", "más", "entonces", "también", "usted", "ustedes", "yo", "él", "ella", "ellos", "ellas", "nosotros", "eso", "esto",
    "ese", "esa", "hay", "y", "su", "sus", "mi", "ya", "aquí", "ahora", "sí", "bueno", "todavía", "después", "hacer", "hasta",
    "donde", "dónde", "quien", "quién", "nuestro", "nuestra", "estoy", "pues", "qué", "cómo", "cuando", "cuándo", "tiene", "tengo",
    "tenemos", "puede", "creo", "hoy", "ayer", "mañana", "gracias", "hola", "poco", "así", "ahí", "allá", "cosa"
  ])
};

// Spelling that only one of the three uses; each match is worth half a stopword, and spelling
// can at most double the stopword evidence, so it never decides alone.
const FEATURES: ReadonlyArray<readonly [ContentLanguage, RegExp]> = [
  ["pt-BR", /ção|ções|ã|õ|ç/g],
  ["es", /ñ|¿|¡|ción\b|ciones\b/g]
];

const MIN_TOKENS = 6;
const MIN_HITS = 3;
const MIN_COVERAGE = 0.08;
const MIN_LEAD = 1.5;

/** Up to LANGUAGE_SAMPLE_CHARACTERS, taken from the start, middle and end of long texts. */
const sample = (text: string): string => {
  if (text.length <= LANGUAGE_SAMPLE_CHARACTERS) return text;
  const windows = 4;
  const size = Math.floor(LANGUAGE_SAMPLE_CHARACTERS / windows);
  const step = Math.floor((text.length - size) / (windows - 1));
  const parts: string[] = [];
  for (let index = 0; index < windows; index++) parts.push(text.slice(index * step, index * step + size));
  return parts.join(" ");
};

export type LanguageEvidence = { tokens: number; hits: Record<ContentLanguage, number> };

/** Counts used by detectLanguage, exposed for diagnostics and tests. */
export const languageEvidence = (text: string): LanguageEvidence => {
  const hits: Record<ContentLanguage, number> = { "pt-BR": 0, en: 0, es: 0 };
  if (typeof text !== "string" || !text) return { tokens: 0, hits };
  const lowered = sample(text).normalize("NFC").toLocaleLowerCase("pt-BR").replace(/[’`´]/g, "'");
  const words = lowered.match(/\p{L}+(?:'\p{L}+)?/gu) || [];
  for (const word of words) {
    for (const language of CONTENT_LANGUAGES) if (STOPWORDS[language].has(word)) hits[language] += 1;
  }
  for (const [language, pattern] of FEATURES) hits[language] += Math.min(hits[language], (lowered.match(pattern) || []).length / 2);
  return { tokens: words.length, hits };
};

/** Predominant language by stopword share; undefined when the text is short, has too few
 * function words (names, code, lists) or mixes languages without a clear majority. */
export const detectLanguage = (text: string): ContentLanguage | undefined => {
  const { tokens, hits } = languageEvidence(text);
  if (tokens < MIN_TOKENS) return undefined;
  const ranked = [...CONTENT_LANGUAGES].sort((left, right) => hits[right] - hits[left]);
  const top = hits[ranked[0]];
  const second = hits[ranked[1]];
  if (top < MIN_HITS || top / tokens < MIN_COVERAGE || top < MIN_LEAD * second) return undefined;
  return ranked[0];
};

/** The language a new summary is written in: the setting, or for "auto" the detected
 * language of the transcript, else Brazilian Portuguese. */
export const resolveSummaryLanguage = (setting: SummaryLanguage | string, transcriptText: string): ContentLanguage => {
  if (isContentLanguage(setting)) return setting;
  return detectLanguage(transcriptText) ?? "pt-BR";
};

export type SummaryLimitationLabels = {
  /** attachSummarySupport: claim without a clear reference or no timing. */
  reviewRequired: string;
  /** summarizeInChunks merge. */
  chunked: string;
  /** Reviewed regeneration merge. */
  chunkedReviewed: string;
  visualEvidence: string;
  legacyTranscript: string;
  visualExpired: string;
  partialRange: string;
  reviewedNotesNotUsed: string;
  reviewedLegacyUnverified: string;
  /** v2: some of the user's notes were not placed in the summary. */
  notesNotUsed: string;
  /** v2: notes were present but left out (setting off or not consented). */
  notesExcluded: string;
};

export type SummaryLabels = {
  summary: string;
  topics: string;
  decisions: string;
  actions: string;
  notes: string;
  evidence: string;
  limitations: string;
  /** Empty topic list ("Nenhum identificado"). */
  noneFound: string;
  /** Empty decision/action list ("Nenhuma identificada"). */
  noneFoundFeminine: string;
  owner: string;
  dueDate: string;
  unusedNotes: string;
  template: string;
  transcript: string;
  fullText: string;
  excerpts: string;
  yourNote: string;
  aiAddition: string;
  reviewNeeded: string;
  yes: string;
  notFlagged: string;
  timing: string;
  mediaSha256: string;
  transcriptSha256: string;
  limitation: SummaryLimitationLabels;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Markdown headings and fixed phrases of summaries, per language. The pt-BR strings are
 * byte-identical to the ones the pipeline writes today. */
export const SUMMARY_LABELS: Readonly<Record<ContentLanguage, Readonly<SummaryLabels>>> = deepFreeze({
  "pt-BR": {
    summary: "Resumo",
    topics: "Tópicos",
    decisions: "Decisões",
    actions: "Ações",
    notes: "Notas",
    evidence: "Evidências e limites",
    limitations: "Limitações",
    noneFound: "Nenhum identificado",
    noneFoundFeminine: "Nenhuma identificada",
    owner: "responsável",
    dueDate: "prazo",
    unusedNotes: "Notas suas que o modelo não usou",
    template: "Modelo",
    transcript: "Transcrição",
    fullText: "Texto completo",
    excerpts: "Trechos",
    yourNote: "sua nota",
    aiAddition: "complemento da IA",
    reviewNeeded: "Revisão necessária",
    yes: "sim",
    notFlagged: "não sinalizada (não garante correção semântica)",
    timing: "Precisão temporal",
    mediaSha256: "Mídia SHA-256",
    transcriptSha256: "Transcrição SHA-256",
    limitation: {
      reviewRequired: "Resumo requer revisão: afirmação sem referência clara ou precisão temporal indisponível. Referências válidas não comprovam correção semântica.",
      chunked: "Resumo montado por partes: revisar redundâncias, contexto global e eventuais conflitos. Fragmentos mantêm o intervalo do segmento original.",
      chunkedReviewed: "Resumo montado por partes: revisar contexto global, redundâncias e conflitos; intervalos dos segmentos originais preservados.",
      visualEvidence: "Evidência visual seletiva requer revisão; um frame representa somente seu instante e suas observações não são prova semântica.",
      legacyTranscript: "Transcrição legada: mídia verificada, parâmetros originais completos não comprovados; revisar antes de reutilizar decisões.",
      visualExpired: "Evidência visual expirada; este resumo utiliza somente a transcrição e requer revisão das referências visuais.",
      partialRange: "Resumo parcial do intervalo selecionado; restante omitido.",
      reviewedNotesNotUsed: "Notas humanas sem tempo e rótulos acústicos permanecem na revisão; não foram usados como evidência do modelo.",
      reviewedLegacyUnverified: "Transcrição original legada sem recibo verificado; resumo requer revisão humana.",
      notesNotUsed: "Algumas notas suas não aparecem no resumo; elas estão listadas em \"Notas suas que o modelo não usou\".",
      notesExcluded: "Suas notas desta reunião não foram enviadas ao modelo; o resumo usa somente a transcrição."
    }
  },
  en: {
    summary: "Summary",
    topics: "Topics",
    decisions: "Decisions",
    actions: "Action items",
    notes: "Notes",
    evidence: "Evidence and limits",
    limitations: "Limitations",
    noneFound: "None identified",
    noneFoundFeminine: "None identified",
    owner: "owner",
    dueDate: "due",
    unusedNotes: "Your notes the model did not use",
    template: "Template",
    transcript: "Transcript",
    fullText: "Full text",
    excerpts: "Excerpts",
    yourNote: "your note",
    aiAddition: "AI addition",
    reviewNeeded: "Review needed",
    yes: "yes",
    notFlagged: "not flagged (does not guarantee semantic accuracy)",
    timing: "Timing precision",
    mediaSha256: "Media SHA-256",
    transcriptSha256: "Transcript SHA-256",
    limitation: {
      reviewRequired: "Summary needs review: a statement has no clear reference or timing precision is unavailable. Valid references do not prove semantic accuracy.",
      chunked: "Summary assembled in parts: review redundancies, overall context and possible conflicts. Fragments keep the interval of the original segment.",
      chunkedReviewed: "Summary assembled in parts: review overall context, redundancies and conflicts; intervals of the original segments preserved.",
      visualEvidence: "Selective visual evidence needs review; a frame represents only its own instant and its observations are not semantic proof.",
      legacyTranscript: "Legacy transcript: media verified, complete original parameters not proven; review before reusing decisions.",
      visualExpired: "Visual evidence expired; this summary uses only the transcript and its visual references need review.",
      partialRange: "Partial summary of the selected interval; the rest was left out.",
      reviewedNotesNotUsed: "Untimed human notes and acoustic labels stay in the review; they were not used as evidence by the model.",
      reviewedLegacyUnverified: "Legacy original transcript without a verified receipt; the summary needs human review.",
      notesNotUsed: "Some of your notes do not appear in the summary; they are listed under \"Your notes the model did not use\".",
      notesExcluded: "Your notes for this meeting were not sent to the model; the summary uses only the transcript."
    }
  },
  es: {
    summary: "Resumen",
    topics: "Temas",
    decisions: "Decisiones",
    actions: "Acciones",
    notes: "Notas",
    evidence: "Evidencias y límites",
    limitations: "Limitaciones",
    noneFound: "Ninguno identificado",
    noneFoundFeminine: "Ninguna identificada",
    owner: "responsable",
    dueDate: "plazo",
    unusedNotes: "Notas tuyas que el modelo no usó",
    template: "Plantilla",
    transcript: "Transcripción",
    fullText: "Texto completo",
    excerpts: "Fragmentos",
    yourNote: "tu nota",
    aiAddition: "complemento de la IA",
    reviewNeeded: "Revisión necesaria",
    yes: "sí",
    notFlagged: "no señalada (no garantiza corrección semántica)",
    timing: "Precisión temporal",
    mediaSha256: "Medio SHA-256",
    transcriptSha256: "Transcripción SHA-256",
    limitation: {
      reviewRequired: "El resumen requiere revisión: hay una afirmación sin referencia clara o no hay precisión temporal. Las referencias válidas no prueban la corrección semántica.",
      chunked: "Resumen armado por partes: revisar redundancias, contexto global y posibles conflictos. Los fragmentos mantienen el intervalo del segmento original.",
      chunkedReviewed: "Resumen armado por partes: revisar contexto global, redundancias y conflictos; intervalos de los segmentos originales preservados.",
      visualEvidence: "La evidencia visual selectiva requiere revisión; un fotograma representa solo su instante y sus observaciones no son prueba semántica.",
      legacyTranscript: "Transcripción heredada: medio verificado, parámetros originales completos no comprobados; revisar antes de reutilizar decisiones.",
      visualExpired: "Evidencia visual vencida; este resumen usa solo la transcripción y requiere revisar las referencias visuales.",
      partialRange: "Resumen parcial del intervalo seleccionado; el resto se omitió.",
      reviewedNotesNotUsed: "Las notas humanas sin tiempo y las etiquetas acústicas permanecen en la revisión; no se usaron como evidencia del modelo.",
      reviewedLegacyUnverified: "Transcripción original heredada sin recibo verificado; el resumen requiere revisión humana.",
      notesNotUsed: "Algunas de tus notas no aparecen en el resumen; están listadas en \"Notas tuyas que el modelo no usó\".",
      notesExcluded: "Tus notas de esta reunión no se enviaron al modelo; el resumen usa solo la transcripción."
    }
  }
});
