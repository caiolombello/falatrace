import { createHash } from "node:crypto";
import { sanitizeKnowledgeText } from "../knowledge/context";

/**
 * Shareable Markdown for a meeting (or for a recipe result): what Obsidian, Notion, Slack,
 * the clipboard and AI apps receive. Every value is untrusted meeting text, so it is cleaned,
 * bounded and escaped before it becomes Markdown, and YAML frontmatter values are JSON-quoted.
 */

export const SHARE_LANGUAGES = ["pt-BR", "en", "es"] as const;
export type ShareLanguage = (typeof SHARE_LANGUAGES)[number];
export const SHARE_INCLUDES = ["summary", "summary+notes", "full"] as const;
export type ShareInclude = (typeof SHARE_INCLUDES)[number];

export type ShareItem = { text: string; origin: "user" | "ai" };
export type ShareSection = { heading: string; items: ShareItem[] };
export type ShareAction = { text: string; owner: string; dueDate: string; done: boolean };
export type ShareTranscriptLine = { at: string; speaker?: string; text: string };

export type ShareNote = {
  jobId: string;
  title: string;
  /** ISO time the meeting started. */
  date: string;
  people: string[];
  client?: string;
  template?: string;
  overview: string;
  sections?: ShareSection[];
  decisions: string[];
  actions: ShareAction[];
  notes?: string[];
  transcript?: ShareTranscriptLine[];
  /** falatrace://recording/<jobId> */
  link: string;
};

export type ShareRenderOptions = {
  /** When true, `markdown` carries the YAML frontmatter; `document` always does. */
  frontmatter: boolean;
  language: ShareLanguage;
  include: ShareInclude;
  /** IANA time zone for dates shown in the note and file names; defaults to the system zone. */
  timeZone?: string;
};

/** Content ready for a destination. Destinations that keep files use `document`, chat-like ones `body`. */
export type RenderedShare = {
  kind: "note" | "text";
  jobId?: string;
  title: string;
  /** ISO time used for the file name and the frontmatter date. */
  date: string;
  language: ShareLanguage;
  include?: ShareInclude;
  recipeId?: string;
  /** sha256 of everything rendered except itself; equal snapshots mean equal content. */
  snapshot: string;
  /** YAML frontmatter + body. */
  document: string;
  /** Markdown without frontmatter. */
  body: string;
  /** `document` or `body`, following the frontmatter option. */
  markdown: string;
  /** sha256 of `markdown`. */
  sha256: string;
};

export const SHARE_LIMITS = Object.freeze({
  /** Largest Markdown a share may produce (characters). */
  maxCharacters: 1_000_000,
  title: 300,
  person: 120,
  people: 100,
  client: 120,
  template: 60,
  overview: 20_000,
  sections: 20,
  heading: 200,
  sectionItems: 100,
  item: 2_000,
  decisions: 200,
  actions: 300,
  owner: 120,
  dueDate: 40,
  notes: 500,
  transcriptLines: 50_000,
  transcriptText: 4_000,
  recipeText: 200_000
});

/** Fixed messages of the share and destination modules; the bridge whitelists and translates them. */
export const SHARE_MESSAGES = Object.freeze({
  invalidNote: "O conteúdo para compartilhar é inválido.",
  invalidOptions: "Opções de compartilhamento inválidas.",
  tooLarge: "O conteúdo é grande demais para compartilhar; escolha Resumo ou Resumo + notas.",
  previewChanged: "O conteúdo mudou desde a prévia; gere a prévia de novo antes de enviar.",
  consentRequired: "Confirme o destino e o conteúdo antes de enviar.",
  unknownDestination: "Destino de compartilhamento não suportado.",
  obsidianNotConfigured: "Escolha o cofre do Obsidian nas configurações de compartilhamento.",
  obsidianVaultInvalid: "O cofre do Obsidian precisa ser uma pasta existente, sem link simbólico.",
  obsidianFolderInvalid: "A pasta dentro do cofre do Obsidian é inválida; use um caminho relativo, sem '..' nem link simbólico.",
  obsidianNoFreeName: "Já existem notas demais com esse nome no Obsidian; renomeie ou apague algumas.",
  obsidianWriteFailed: "Não foi possível gravar a nota no cofre do Obsidian.",
  notionNotConfigured: "Configure NOTION_TOKEN nas chaves e a página do Notion nas configurações de compartilhamento.",
  notionParentInvalid: "O endereço ou identificador da página do Notion é inválido.",
  notionAuth: "O Notion recusou o token; confira NOTION_TOKEN.",
  notionNoAccess: "A integração do Notion não tem acesso à página escolhida; compartilhe a página com a integração.",
  notionRateLimited: "O Notion pediu para esperar; tente de novo em instantes.",
  notionRejected: "O Notion recusou o conteúdo da página.",
  notionUnavailable: "O Notion não respondeu como esperado; tente de novo mais tarde.",
  notionPartial: "A página foi criada no Notion, mas parte do conteúdo não foi enviada; confira a página.",
  notionTooLarge: "O conteúdo é grande demais para o Notion; escolha Resumo ou Resumo + notas.",
  slackNotConfigured: "Configure SLACK_WEBHOOK_URL nas chaves para enviar ao Slack.",
  slackUrlInvalid: "SLACK_WEBHOOK_URL precisa ser um endereço https://hooks.slack.com/services/…",
  slackAuth: "O Slack recusou o webhook; gere um novo webhook e atualize SLACK_WEBHOOK_URL.",
  slackArchived: "O canal do webhook do Slack foi arquivado.",
  slackRateLimited: "O Slack pediu para esperar; tente de novo em instantes.",
  slackRejected: "O Slack recusou a mensagem.",
  slackUnavailable: "O Slack não respondeu como esperado; tente de novo mais tarde.",
  slackPartial: "O envio ao Slack parou no meio; parte do conteúdo já foi publicada.",
  slackTooLarge: "O conteúdo é grande demais para o Slack; escolha Resumo ou Resumo + notas.",
  networkFailed: "Não foi possível conectar ao serviço; verifique a internet.",
  timeout: "O serviço demorou demais para responder; tente de novo.",
  clipboardFailed: "Não foi possível copiar nem salvar o conteúdo.",
  aiAppInvalid: "Aplicativo de IA não suportado.",
  aiToolMissing: "A ferramenta de IA escolhida não foi encontrada; instale-a ou escolha outro aplicativo.",
  handoffFailed: "Não foi possível preparar o arquivo para a ferramenta de IA.",
  terminalFailed: "Não foi possível abrir um terminal com a ferramenta escolhida.",
  openFailed: "Não foi possível abrir o aplicativo escolhido.",
  logBusy: "Outra janela está registrando um envio; tente de novo.",
  logUnsafe: "A pasta do histórico de envios não é segura; ela precisa ser uma pasta comum, sem link simbólico."
});

export type ShareMessage = (typeof SHARE_MESSAGES)[keyof typeof SHARE_MESSAGES];

/** Non-fatal notes a receipt can carry; translated like the errors. */
export const SHARE_WARNINGS = Object.freeze({
  obsidianNotOpened: "A nota foi salva, mas o Obsidian não abriu.",
  pasteInApp: "Contexto copiado — cole com Ctrl+V no aplicativo.",
  clipboardUnavailable: "Não há área de transferência disponível; o conteúdo foi salvo em um arquivo privado.",
  appNotOpened: "O conteúdo foi preparado, mas o aplicativo não abriu; abra-o e cole o conteúdo."
});

export const SHARE_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(SHARE_MESSAGES));
export const SHARE_KNOWN_WARNINGS: readonly string[] = Object.freeze(Object.values(SHARE_WARNINGS));

export type ShareErrorCode =
  | "invalid"
  | "too-large"
  | "conflict"
  | "consent"
  | "config"
  | "auth"
  | "forbidden"
  | "rate-limit"
  | "rejected"
  | "unavailable"
  | "network"
  | "timeout"
  | "partial"
  | "io"
  | "busy";

/** A share failure whose message is one of SHARE_KNOWN_ERRORS. `detail` is redacted and for logs only. */
export class ShareError extends Error {
  readonly code: ShareErrorCode;
  readonly detail?: string;
  constructor(message: ShareMessage, code: ShareErrorCode, detail?: string) {
    super(message);
    this.name = "ShareError";
    this.code = code;
    if (detail) this.detail = detail.slice(0, 500);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AT = /^\d{1,3}:[0-5]\d(:[0-5]\d)?$/;
const RECIPE_ID = /^([a-z][a-z0-9-]{0,40}|custom:[a-z0-9][a-z0-9-]{0,40})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RENDER_VERSION = 1;

export const isShareLanguage = (value: unknown): value is ShareLanguage =>
  typeof value === "string" && (SHARE_LANGUAGES as readonly string[]).includes(value);
export const isShareInclude = (value: unknown): value is ShareInclude =>
  typeof value === "string" && (SHARE_INCLUDES as readonly string[]).includes(value);

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const recordingLink = (jobId: string): string => `falatrace://recording/${jobId}`;
export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const invalid = (): ShareError => new ShareError(SHARE_MESSAGES.invalidNote, "invalid");

// Lone surrogates do not survive UTF-8 or JSON APIs. They are dropped before cleaning and again
// after it, because cutting text to a length can split an emoji's surrogate pair.
const LONE_SURROGATE = /\p{Cs}/gu;
const dropLoneSurrogates = (text: string): string => text.replace(LONE_SURROGATE, "");

/** One line of untrusted text: credentials and e-mails redacted, control characters and line breaks collapsed. */
const cleanLine = (value: unknown, max: number, required = false): string => {
  if (typeof value !== "string" || value.length > max * 4 + 1000) throw invalid();
  const text = dropLoneSurrogates(sanitizeKnowledgeText(dropLoneSurrogates(value), max)).trim();
  if (required && !text) throw invalid();
  return text;
};

const cleanList = (value: unknown, maxItems: number, maxLength: number): string[] => {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid();
  return value.map((item) => cleanLine(item, maxLength)).filter((item) => item.length > 0);
};

/** Paragraphs of the overview, each cleaned like a line, separated by one blank line. */
const cleanOverview = (value: unknown): string => {
  if (typeof value !== "string" || value.length > SHARE_LIMITS.overview * 2) throw invalid();
  return dropLoneSurrogates(dropLoneSurrogates(value).split(/\r?\n\s*\r?\n/).map((paragraph) => sanitizeKnowledgeText(paragraph, SHARE_LIMITS.overview))
    .filter(Boolean).join("\n\n").slice(0, SHARE_LIMITS.overview)).trim();
};

const isoDate = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw invalid();
  }
  return value;
};

/** Strict check of a share note: unknown fields are refused and every value is rebuilt. */
export const validateShareNote = (value: unknown): ShareNote => {
  if (!isObject(value) || !onlyKeys(value, ["jobId", "title", "date", "people", "client", "template", "overview", "sections", "decisions", "actions", "notes", "transcript", "link"])) {
    throw invalid();
  }
  if (!isUuid(value.jobId)) throw invalid();
  const jobId = value.jobId;
  if (value.link !== recordingLink(jobId)) throw invalid();
  const note: ShareNote = {
    jobId,
    title: cleanLine(value.title, SHARE_LIMITS.title),
    date: isoDate(value.date),
    people: cleanList(value.people, SHARE_LIMITS.people, SHARE_LIMITS.person),
    overview: cleanOverview(value.overview),
    decisions: cleanList(value.decisions, SHARE_LIMITS.decisions, SHARE_LIMITS.item),
    actions: [],
    link: recordingLink(jobId)
  };
  if (value.client !== undefined) {
    const client = cleanLine(value.client, SHARE_LIMITS.client);
    if (client) note.client = client;
  }
  if (value.template !== undefined) {
    if (typeof value.template !== "string" || !RECIPE_ID.test(value.template) || value.template.length > SHARE_LIMITS.template) throw invalid();
    note.template = value.template;
  }
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections) || value.sections.length > SHARE_LIMITS.sections) throw invalid();
    note.sections = value.sections.map((section): ShareSection => {
      if (!isObject(section) || !onlyKeys(section, ["heading", "items"]) || !Array.isArray(section.items) || section.items.length > SHARE_LIMITS.sectionItems) {
        throw invalid();
      }
      return {
        heading: cleanLine(section.heading, SHARE_LIMITS.heading, true),
        items: section.items.map((item): ShareItem => {
          if (!isObject(item) || !onlyKeys(item, ["text", "origin"]) || (item.origin !== "user" && item.origin !== "ai")) throw invalid();
          return { text: cleanLine(item.text, SHARE_LIMITS.item, true), origin: item.origin };
        })
      };
    });
  }
  if (!Array.isArray(value.actions) || value.actions.length > SHARE_LIMITS.actions) throw invalid();
  note.actions = value.actions.map((action): ShareAction => {
    if (!isObject(action) || !onlyKeys(action, ["text", "owner", "dueDate", "done"]) || typeof action.done !== "boolean") throw invalid();
    return {
      text: cleanLine(action.text, SHARE_LIMITS.item, true),
      owner: cleanLine(action.owner, SHARE_LIMITS.owner),
      dueDate: cleanLine(action.dueDate, SHARE_LIMITS.dueDate),
      done: action.done
    };
  });
  if (value.notes !== undefined) note.notes = cleanList(value.notes, SHARE_LIMITS.notes, SHARE_LIMITS.item);
  if (value.transcript !== undefined) {
    if (!Array.isArray(value.transcript) || value.transcript.length > SHARE_LIMITS.transcriptLines) throw invalid();
    let rawCharacters = 0;
    for (const line of value.transcript) {
      rawCharacters += isObject(line) && typeof line.text === "string" ? line.text.length : 0;
      if (rawCharacters > SHARE_LIMITS.maxCharacters * 2) throw new ShareError(SHARE_MESSAGES.tooLarge, "too-large");
    }
    note.transcript = value.transcript.map((line): ShareTranscriptLine => {
      if (!isObject(line) || !onlyKeys(line, ["at", "speaker", "text"]) || typeof line.at !== "string" || !AT.test(line.at)) throw invalid();
      const entry: ShareTranscriptLine = { at: line.at, text: cleanLine(line.text, SHARE_LIMITS.transcriptText) };
      if (line.speaker !== undefined) {
        const speaker = cleanLine(line.speaker, SHARE_LIMITS.person);
        if (speaker) entry.speaker = speaker;
      }
      return entry;
    }).filter((line) => line.text.length > 0);
  }
  return note;
};

const LABELS: Record<ShareLanguage, {
  date: string; participants: string; client: string; summary: string; decisions: string; actions: string;
  notes: string; transcript: string; open: string; due: string; untitled: string;
}> = {
  "pt-BR": {
    date: "Data", participants: "Participantes", client: "Cliente", summary: "Resumo", decisions: "Decisões", actions: "Ações",
    notes: "Notas", transcript: "Transcrição", open: "Abrir no FalaTrace", due: "até", untitled: "Reunião sem título"
  },
  en: {
    date: "Date", participants: "Participants", client: "Client", summary: "Summary", decisions: "Decisions", actions: "Action items",
    notes: "Notes", transcript: "Transcript", open: "Open in FalaTrace", due: "due", untitled: "Untitled meeting"
  },
  es: {
    date: "Fecha", participants: "Participantes", client: "Cliente", summary: "Resumen", decisions: "Decisiones", actions: "Acciones",
    notes: "Notas", transcript: "Transcripción", open: "Abrir en FalaTrace", due: "para", untitled: "Reunión sin título"
  }
};

export const untitledLabel = (language: ShareLanguage): string => LABELS[language].untitled;

/**
 * Obsidian plugins that run code found in a note: Templater executes "<% … %>" anywhere in a file
 * (with "trigger on new file creation", as soon as FalaTrace writes it), so "<%" becomes "<\%"
 * (still shown as "<%").
 */
const neutralizeTemplaterTags = (text: string): string => text.replace(/<%/g, "<\\%");

/**
 * Text that cannot open HTML, load a remote image, start a code span (Dataview runs "`$= …`" as
 * JavaScript), run a Templater command or start a Markdown block where it lands.
 */
export const escapeInline = (text: string): string =>
  neutralizeTemplaterTags(text.replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/!\[/g, "\\![").replace(/`/g, "\\`"));

const escapeBlockStart = (text: string): string => {
  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(text);
  if (ordered) return `${ordered[1]}\\${ordered[2]}${text.slice(ordered[1].length + 1)}`;
  return /^(#{1,6}(\s|$)|>|[-+*](\s|$)|[-*_=]{3,}|\||\[[ xX]\]|`{3}|~{3})/.test(text) ? `\\${text}` : text;
};

/** A paragraph or list item body from untrusted text. */
const inline = (text: string): string => escapeBlockStart(escapeInline(text));

/** Date and time "YYYY-MM-DD HH:mm" in a time zone (the system zone when none is given). A date
 * without a time is a calendar day, not UTC midnight, so it keeps its day in every zone. */
export const formatLocalDateTime = (iso: string, timeZone?: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(Date.parse(iso))) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone });
    } catch {
      throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
    }
    return `${iso} 00:00`;
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw invalid();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
  } catch {
    throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour") === "24" ? "00" : part("hour")}:${part("minute")}`;
};

/** A YAML double-quoted scalar: JSON quoting (YAML is a superset), with control and line-separator
 * characters removed, and the "<" of "<%" written as a JSON/YAML unicode escape (u003c) so Templater
 * never sees a command in the frontmatter. */
export const yamlString = (value: string): string =>
  JSON.stringify(value.replace(/[\p{Cc}\p{Cs}\u2028\u2029\uFEFF]/gu, " ")).replace(/<%/g, "\\u003c%");

type FrontmatterValue = string | string[];

const frontmatterText = (entries: Array<[string, FrontmatterValue | undefined]>): string => {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.map(yamlString).join(", ")}]` : yamlString(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
};

const assertSize = (text: string): void => {
  if (text.length > SHARE_LIMITS.maxCharacters) throw new ShareError(SHARE_MESSAGES.tooLarge, "too-large");
};

const finish = (
  base: Omit<RenderedShare, "snapshot" | "document" | "body" | "markdown" | "sha256">,
  body: string,
  frontmatter: Array<[string, FrontmatterValue | undefined]>,
  withFrontmatter: boolean
): RenderedShare => {
  assertSize(body);
  // The snapshot covers the body and every other frontmatter field, so it changes with any visible change.
  const snapshot = sha256Hex(`falatrace-share-v${RENDER_VERSION}\n${frontmatterText(frontmatter)}${body}`);
  const [first, ...rest] = frontmatter;
  const document = `${frontmatterText([first, ["falatrace_snapshot", snapshot], ...rest])}\n${body}`;
  assertSize(document);
  const markdown = withFrontmatter ? document : body;
  return { ...base, snapshot, document, body, markdown, sha256: sha256Hex(markdown) };
};

const assertOptions = (options: unknown): ShareRenderOptions => {
  if (!isObject(options) || !onlyKeys(options, ["frontmatter", "language", "include", "timeZone"]) || typeof options.frontmatter !== "boolean" ||
      !isShareLanguage(options.language) || !isShareInclude(options.include) ||
      (options.timeZone !== undefined && (typeof options.timeZone !== "string" || options.timeZone.length > 64))) {
    throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  }
  return options as ShareRenderOptions;
};

const overviewParagraphs = (overview: string): string[] => overview.split("\n\n").filter(Boolean).map(inline);

/** A raw notepad line as Markdown under the Notes heading: headings demoted, tasks and bullets kept. */
const noteLine = (text: string): string => {
  const heading = /^#{1,6}\s+(.*)$/.exec(text);
  if (heading?.[1]) return `### ${inline(heading[1])}`;
  const task = /^(?:[-*]\s+)?\[([ xX])\]\s*(.*)$/.exec(text);
  if (task) return `- [${task[1] === " " ? " " : "x"}] ${inline(task[2] || "")}`.trimEnd();
  const bullet = /^[-*]\s+(.*)$/.exec(text);
  return `- ${inline(bullet ? bullet[1] : text)}`;
};

/** Renders a meeting as shareable Markdown; see RenderedShare for the variants. */
export const renderShare = (input: ShareNote, rawOptions: ShareRenderOptions): RenderedShare => {
  const options = assertOptions(rawOptions);
  const note = validateShareNote(input);
  const labels = LABELS[options.language];
  const title = note.title || labels.untitled;
  const blocks: string[] = [`# ${escapeInline(title)}`];
  const meta = [`**${labels.date}:** ${formatLocalDateTime(note.date, options.timeZone)}`];
  if (note.people.length > 0) meta.push(`**${labels.participants}:** ${escapeInline(note.people.join(", "))}`);
  if (note.client) meta.push(`**${labels.client}:** ${escapeInline(note.client)}`);
  blocks.push(meta.join(" · "));
  const overview = overviewParagraphs(note.overview);
  if (overview.length > 0) blocks.push(`## ${labels.summary}`, ...overview);
  const sections = (note.sections || []).filter((section) => section.items.length > 0);
  for (const section of sections) {
    blocks.push(`## ${escapeInline(section.heading)}`, section.items.map((item) => `- ${inline(item.text)}`).join("\n"));
  }
  // Template sections already hold the decisions; the action checklist stays for its done state and owners.
  if (sections.length === 0 && note.decisions.length > 0) {
    blocks.push(`## ${labels.decisions}`, note.decisions.map((decision) => `- ${inline(decision)}`).join("\n"));
  }
  if (note.actions.length > 0) {
    blocks.push(`## ${labels.actions}`, note.actions.map((action) => {
      const extra = [action.owner, action.dueDate ? `${labels.due} ${action.dueDate}` : ""].filter(Boolean).join(" · ");
      return `- [${action.done ? "x" : " "}] ${inline(action.text)}${extra ? ` (${escapeInline(extra)})` : ""}`;
    }).join("\n"));
  }
  if (options.include !== "summary" && note.notes && note.notes.length > 0) {
    blocks.push(`## ${labels.notes}`, note.notes.map(noteLine).join("\n"));
  }
  if (options.include === "full" && note.transcript && note.transcript.length > 0) {
    blocks.push(`## ${labels.transcript}`);
    let characters = blocks.reduce((total, block) => total + block.length + 2, 0);
    for (const line of note.transcript) {
      const entry = `**[${line.at}]${line.speaker ? ` ${escapeInline(line.speaker)}:` : ""}** ${escapeInline(line.text)}`;
      characters += entry.length + 2;
      if (characters > SHARE_LIMITS.maxCharacters) throw new ShareError(SHARE_MESSAGES.tooLarge, "too-large");
      blocks.push(entry);
    }
  }
  blocks.push("---", `[${labels.open}](${note.link})`);
  const body = `${blocks.join("\n\n")}\n`;
  return finish(
    { kind: "note", jobId: note.jobId, title, date: note.date, language: options.language, include: options.include },
    body,
    [
      ["title", title],
      ["date", note.date],
      ["falatrace_job", note.jobId],
      ["participants", note.people],
      ["client", note.client],
      ["template", note.template],
      ["tags", ["falatrace"]],
      ["source", note.link]
    ],
    options.frontmatter
  );
};

/** Markdown of a meeting: with frontmatter when `options.frontmatter` is true. */
export const renderShareMarkdown = (note: ShareNote, options: ShareRenderOptions): string => renderShare(note, options).markdown;

export type TextShareInput = {
  title: string;
  /** Markdown written by the assistant (a recipe result or an answer). */
  text: string;
  /** The recording it is about; library-wide results have none. */
  jobId?: string;
  /** ISO time for the file name and frontmatter; defaults to now. */
  date?: string;
  recipeId?: string;
  language: ShareLanguage;
  frontmatter?: boolean;
};

/** Code fence languages kept in assistant Markdown; any other info string ("dataviewjs", "js-engine", …) may name a plugin that runs the block, so it is dropped. */
const SAFE_FENCE_LANGUAGES = new Set([
  "text", "txt", "plaintext", "markdown", "md", "json", "yaml", "yml", "toml", "ini", "csv", "sql", "bash", "sh", "shell", "console",
  "powershell", "python", "py", "javascript", "js", "typescript", "ts", "java", "kotlin", "go", "rust", "c", "cpp", "csharp", "cs",
  "ruby", "php", "swift", "html", "css", "xml", "diff", "dockerfile", "makefile", "hcl", "terraform", "lua", "r", "scala"
]);

/**
 * One line of assistant Markdown. Unlike meeting text, code spans and fences stay, but nothing the
 * vault could execute: HTML and remote images are escaped as in escapeInline, Templater tags are
 * broken, Dataview inline JavaScript ("`$= …`") is turned into plain code, and fence languages
 * outside SAFE_FENCE_LANGUAGES are dropped.
 */
const escapeAssistantLine = (line: string): string => {
  // A backtick fence's info string cannot hold a backtick ("```a``` b" is inline code, not a fence).
  const fence = /^(`{3,})([^`]*)$/.exec(line) || /^(~{3,})(.*)$/.exec(line);
  if (fence) {
    const language = (fence[2].trim().split(/\s+/)[0] || "").toLowerCase();
    return `${fence[1]}${SAFE_FENCE_LANGUAGES.has(language) ? language : ""}`;
  }
  return neutralizeTemplaterTags(line.replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/!\[/g, "\\![").replace(/(`+)([ \t]*)\$=/g, "$1$2\\$="));
};

/** Assistant Markdown, kept as Markdown: per line, credentials and e-mails redacted, HTML, remote images and executable plugin syntax neutralised. */
const cleanAssistantMarkdown = (text: string): string => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const indent = /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "  ") || "";
    return `${indent}${escapeAssistantLine(dropLoneSurrogates(sanitizeKnowledgeText(dropLoneSurrogates(line), SHARE_LIMITS.recipeText)))}`.trimEnd();
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** Renders an assistant result (for example a recipe) for the same destinations as a meeting note. */
export const renderTextShare = (input: TextShareInput, now: () => Date = () => new Date()): RenderedShare => {
  if (!isObject(input) || !onlyKeys(input, ["title", "text", "jobId", "date", "recipeId", "language", "frontmatter"]) ||
      typeof input.text !== "string" || !isShareLanguage(input.language) ||
      (input.frontmatter !== undefined && typeof input.frontmatter !== "boolean") ||
      (input.jobId !== undefined && !isUuid(input.jobId)) ||
      (input.recipeId !== undefined && (typeof input.recipeId !== "string" || !RECIPE_ID.test(input.recipeId)))) {
    throw invalid();
  }
  if (input.text.length > SHARE_LIMITS.recipeText) throw new ShareError(SHARE_MESSAGES.tooLarge, "too-large");
  const date = input.date === undefined ? now().toISOString() : isoDate(input.date);
  const title = cleanLine(input.title, SHARE_LIMITS.title) || LABELS[input.language].untitled;
  const text = cleanAssistantMarkdown(input.text);
  if (!text) throw invalid();
  const blocks = [`# ${escapeInline(title)}`, text];
  if (input.jobId) blocks.push("---", `[${LABELS[input.language].open}](${recordingLink(input.jobId)})`);
  return finish(
    { kind: "text", ...(input.jobId ? { jobId: input.jobId } : {}), title, date, language: input.language, ...(input.recipeId ? { recipeId: input.recipeId } : {}) },
    `${blocks.join("\n\n")}\n`,
    [
      ["title", title],
      ["date", date],
      ["falatrace_job", input.jobId],
      ["falatrace_recipe", input.recipeId],
      ["tags", ["falatrace"]],
      ["source", input.jobId ? recordingLink(input.jobId) : undefined]
    ],
    input.frontmatter === true
  );
};

/** Checks content handed to a destination, so a hand-built object cannot slip past the renderer's limits. */
export const assertRenderedShare = (value: unknown): RenderedShare => {
  if (!isObject(value)) throw invalid();
  const share = value as RenderedShare;
  if ((share.kind !== "note" && share.kind !== "text") || (share.jobId !== undefined && !isUuid(share.jobId)) ||
      typeof share.title !== "string" || share.title.length > SHARE_LIMITS.title || /[\p{Cc}]/u.test(share.title) ||
      typeof share.date !== "string" || !Number.isFinite(Date.parse(share.date)) || !isShareLanguage(share.language) ||
      typeof share.snapshot !== "string" || !SHA256.test(share.snapshot) ||
      typeof share.document !== "string" || typeof share.body !== "string" || typeof share.markdown !== "string" ||
      share.document.length > SHARE_LIMITS.maxCharacters || share.body.length > SHARE_LIMITS.maxCharacters ||
      !share.document.endsWith(share.body) || !share.document.startsWith("---\n") ||
      (share.markdown !== share.document && share.markdown !== share.body) || share.sha256 !== sha256Hex(share.markdown)) {
    throw invalid();
  }
  return share;
};

export type InlineSegment = { text: string; bold: boolean; url?: string };

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Inline Markdown as FalaTrace writes it: **bold**, [label](url) and backslash escapes. Only http(s)
 * links up to 2000 characters stay links; others (falatrace://…) become "label: url" text.
 */
export const parseInlineMarkdown = (line: string): InlineSegment[] => {
  const segments: InlineSegment[] = [];
  let bold = false;
  let buffer = "";
  const flush = (): void => {
    if (buffer) segments.push({ text: buffer, bold });
    buffer = "";
  };
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && index + 1 < line.length && PUNCTUATION.test(line[index + 1])) {
      buffer += line[index + 1];
      index += 1;
    } else if (character === "*" && line[index + 1] === "*") {
      flush();
      bold = !bold;
      index += 1;
    } else if (character === "[") {
      const link = /^\[([^\]\n]{1,500})\]\(([^)\s]{1,4000})\)/.exec(line.slice(index));
      if (!link) {
        buffer += character;
        continue;
      }
      flush();
      if (/^https?:\/\/[^\s<>|]+$/i.test(link[2]) && link[2].length <= 2000) segments.push({ text: link[1], bold, url: link[2] });
      else segments.push({ text: `${link[1]}: ${link[2]}`, bold });
      index += link[0].length - 1;
    } else {
      buffer += character;
    }
  }
  flush();
  return segments;
};

/** Value of one top-level key of a file's YAML frontmatter as FalaTrace writes it (JSON-quoted), or undefined. */
export const readFrontmatterValue = (text: string, key: string): string | undefined => {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
  const lines = text.split(/\r?\n/);
  for (let index = 1; index < lines.length && index < 200; index += 1) {
    const line = lines[index];
    if (line === "---" || line === "...") return undefined;
    if (!line.startsWith(`${key}:`)) continue;
    const raw = line.slice(key.length + 1).trim();
    if (raw.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return raw.replace(/^'(.*)'$/, "$1") || undefined;
  }
  return undefined;
};
