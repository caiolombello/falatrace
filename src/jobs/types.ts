import { basename, extname } from "node:path";
import { isCallApplication, type CallApplication } from "../calls/apps";
import type {
  ExecutionTarget,
  SummaryLanguage,
  SummaryProvider,
  TranscriptionProvider
} from "../config/defaults";
import { SUMMARY_LANGUAGES, TRANSCRIPTION_PROMPT_MAX_LENGTH } from "../config/defaults";

export const JOB_VERSION = 1 as const;

export const MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".flac",
  ".m4a",
  ".mka",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".wav",
  ".webm"
]);

export type JobState =
  | "pending"
  | "transferring"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type MeetingContext = {
  source: "gnome-calendar" | "google-calendar" | "kde-calendar";
  title: string;
  startAt: string;
  endAt: string;
  recurring: boolean;
  confidence: number;
  app?: CallApplication;
};

export type SummaryClientHint = {
  code: string;
  name: string;
  aliases: string[];
};

export type SummaryContext = {
  meeting?: MeetingContext;
  clients?: SummaryClientHint[];
};

export type JobManifest = {
  version: typeof JOB_VERSION;
  id: string;
  createdAt: string;
  source: {
    originalName: string;
    mediaFile: string;
    size: number;
    sha256: string;
  };
  transcription: {
    provider: TranscriptionProvider;
    model: string;
    language: string;
    languages?: string[];
    keywords?: string[];
    prompt?: string;
  };
  summary: {
    provider: SummaryProvider;
    model: string;
    context?: SummaryContext;
    /** The summary.language setting when the job was created ("auto" or a language), so a remote
     * worker writes the same language. Absent on jobs created before this binding existed. */
    language?: SummaryLanguage;
    /** The summary.template setting when the job was created ("auto" or a template id). */
    template?: string;
  };
};

export type JobRecord = JobManifest & {
  sourcePath: string;
  artifactDir: string;
  target: ExecutionTarget;
  state: JobState;
  updatedAt: string;
  error?: string;
};

export type JobStatus = {
  version: typeof JOB_VERSION;
  id: string;
  state: JobState;
  updatedAt: string;
  error?: string;
  archiveRelative?: string;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
};

export type Transcript = {
  version: typeof JOB_VERSION;
  provider: TranscriptionProvider;
  model: string;
  language: string;
  text: string;
  segments: TranscriptSegment[];
  words?: TranscriptSegment[];
};

export type RecordingSummary = {
  version: typeof JOB_VERSION;
  provider: SummaryProvider;
  model: string;
  title: string;
  overview: string;
  topics: string[];
  decisions: string[];
  actionItems: Array<{
    description: string;
    owner: string;
    dueDate: string;
  }>;
  citations?: SummaryCitation[];
  limitations?: string[];
  /** v2: the template sections, with the user's notes (origin "user") and what the model added. */
  sections?: SummarySection[];
  /** v2: how this summary was made (prompt spec, template, language, notes). */
  meta?: SummaryMeta;
  support?: SummarySupport;
};

export type SummarySectionItem = {
  text: string;
  origin: "user" | "ai";
  /** Notes behind a user item (n000001); always empty on AI items. */
  noteIds: string[];
  /** Transcript segments supporting the item (s000000). */
  segmentIds: string[];
  uncertainty: "clear" | "uncertain";
};

export type SummarySection = { heading: string; items: SummarySectionItem[] };

export type SummaryTemplateSource = "user" | "default" | "calendar" | "keywords" | "ai" | "fallback";

export type SummaryMeta = {
  schemaVersion: 2;
  /** Prompt spec of the request ("v2:<sha12>"). */
  specId: string;
  template: { id: string; source: SummaryTemplateSource; confidence: number; reason: string };
  language: "pt-BR" | "en" | "es";
  /** The meeting notes the summary could see: how many and their digest (0 and the empty digest when none). */
  notes: { count: number; digest: string };
};

/** Bounds of stored v2 sections: a merged multi-part summary plus the notes the model did not use. */
export const SUMMARY_SECTION_LIMITS = Object.freeze({
  sections: 100, items: 4000, headingCharacters: 200, itemCharacters: 2000, noteIds: 16, segmentIds: 8, reasonCharacters: 1000
});

export type SummaryCitation = {
  section: "overview" | "topic" | "decision" | "action";
  index: number;
  segmentIds: string[];
  uncertainty: "clear" | "uncertain";
};

export type SummarySupport = {
  version: 1;
  mediaSha256: string;
  transcriptSha256: string;
  timingQuality: "segment" | "approximate-block" | "none";
  reviewRequired: boolean;
  references: Array<{ id: string; start: number; end: number }>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must be an array with at most 100 items`);
  }
  return value.map((item) => assertShortString(item, field, 2000));
};

const assertShortString = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value;
};

const MEETING_TITLE_MAX_LENGTH = 160;

const normalizeMeetingTitle = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

const truncateMeetingTitle = (value: string): string => {
  if (value.length <= MEETING_TITLE_MAX_LENGTH) return value;
  const bounded = value.slice(0, MEETING_TITLE_MAX_LENGTH + 1);
  const lastSpace = bounded.lastIndexOf(" ");
  return bounded
    .slice(0, lastSpace >= 80 ? lastSpace : MEETING_TITLE_MAX_LENGTH)
    .trimEnd();
};

const trimGenericMeetingLead = (value: string): string => {
  const descriptive = value
    .replace(
      /^(?:(?:nesta|na|durante (?:esta|a)|a|esta|the|this)\s+)?(?:reunião|conversa|call|meeting)\s*(?:,|:|-)?\s*(?:(?:gira em torno d[aeo]s?|teve como (?:objetivo|tema)|foi sobre|tratou d[aeo]s?|abordou|aborda|discutiu|discute|trata d[aeo]s?|se concentrou em|focou em|(?:foi|foram) (?:discutid[oa]s?|abordad[oa]s?|tratad[oa]s?)|covered|focused on|discussed)\s*)?/i,
      ""
    )
    .replace(
      /^(?:(?:os?|the)\s+)?temas?\s+(?:incluem?|como|principais (?:foram|são|were|are))\s+/i,
      ""
    )
    .trim();
  return descriptive || value;
};

const limitMeetingTitleWords = (value: string): string => {
  const words = value.split(" ");
  const limited = words.slice(0, 16);
  while (
    limited.length > 1 &&
    /^(?:a|além|ao|aos|as|à|às|com|da|das|de|do|dos|e|em|na|nas|no|nos|o|os|para|sobre|um|uma|umas|uns|the|and|of|to|with)$/i.test(
      limited[limited.length - 1].replace(/[.,;:!?]+$/g, "")
    )
  ) {
    limited.pop();
  }
  return limited.join(" ");
};

export const deriveMeetingTitle = (overview: string): string => {
  const normalized = normalizeMeetingTitle(overview);
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/);
  const firstSentence =
    sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  const title = truncateMeetingTitle(
    limitMeetingTitleWords(trimGenericMeetingLead(firstSentence))
  )
    .replace(/[.!?;:,]+$/g, "")
    .trim();
  return title
    ? `${title[0].toLocaleUpperCase("pt-BR")}${title.slice(1)}`
    : title;
};

const validateMeetingTitle = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(
      `title must be a single-line string up to ${MEETING_TITLE_MAX_LENGTH} characters`
    );
  }
  const normalized = normalizeMeetingTitle(value);
  if (
    normalized.length === 0 ||
    normalized.length > MEETING_TITLE_MAX_LENGTH
  ) {
    throw new Error(
      `title must be a single-line string up to ${MEETING_TITLE_MAX_LENGTH} characters`
    );
  }
  return normalized;
};

const parseOptionalString = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${field} must be a string up to ${max} characters`);
  }
  return value;
};

const parseTranscriptionLanguages = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new Error("transcription.languages must contain 1 to 10 language codes");
  }
  const languages = value.map((language) => {
    const parsed = assertShortString(language, "transcription.languages", 10);
    if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(parsed)) {
      throw new Error("transcription.languages contains an invalid language code");
    }
    return parsed;
  });
  if (new Set(languages).size !== languages.length) {
    throw new Error("transcription.languages must not contain duplicates");
  }
  return languages;
};

const parseTranscriptionKeywords = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("transcription.keywords must contain 1 to 100 items");
  }
  const keywords = value.map((keyword) => {
    const parsed = assertShortString(keyword, "transcription.keywords", 200);
    if (/[<>\r\n\u0000]/.test(parsed)) {
      throw new Error("transcription.keywords contains unsupported characters");
    }
    return parsed;
  });
  if (new Set(keywords).size !== keywords.length) {
    throw new Error("transcription.keywords must not contain duplicates");
  }
  return keywords;
};

const parseIsoTimestamp = (value: unknown, field: string): string => {
  const timestamp = assertShortString(value, field, 40);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
};

const parseSummaryContext = (value: unknown): SummaryContext => {
  if (!isObject(value)) {
    throw new Error("summary.context must be an object");
  }
  let meeting: MeetingContext | undefined;
  if (value.meeting !== undefined) {
    if (!isObject(value.meeting) || (value.meeting.source !== "gnome-calendar" && value.meeting.source !== "google-calendar" && value.meeting.source !== "kde-calendar")) {
      throw new Error("summary.context.meeting is invalid");
    }
    const startAt = parseIsoTimestamp(
      value.meeting.startAt,
      "summary.context.meeting.startAt"
    );
    const endAt = parseIsoTimestamp(
      value.meeting.endAt,
      "summary.context.meeting.endAt"
    );
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      throw new Error("summary.context.meeting.endAt must be after startAt");
    }
    if (
      typeof value.meeting.recurring !== "boolean" ||
      typeof value.meeting.confidence !== "number" ||
      !Number.isFinite(value.meeting.confidence) ||
      value.meeting.confidence < 0 ||
      value.meeting.confidence > 1 ||
      (value.meeting.app !== undefined &&
        !isCallApplication(value.meeting.app))
    ) {
      throw new Error("summary.context.meeting is invalid");
    }
    meeting = {
      source: value.meeting.source as MeetingContext["source"],
      title: validateMeetingTitle(value.meeting.title),
      startAt,
      endAt,
      recurring: value.meeting.recurring,
      confidence: value.meeting.confidence,
      app: value.meeting.app as CallApplication | undefined
    };
  }

  let clients: SummaryClientHint[] | undefined;
  if (value.clients !== undefined) {
    if (!Array.isArray(value.clients) || value.clients.length > 100) {
      throw new Error("summary.context.clients must have at most 100 items");
    }
    clients = value.clients.map((client, index) => {
      if (!isObject(client)) {
        throw new Error(`summary.context.clients.${index} is invalid`);
      }
      if (!Array.isArray(client.aliases) || client.aliases.length > 20) {
        throw new Error(
          `summary.context.clients.${index}.aliases must have at most 20 items`
        );
      }
      return {
        code: assertShortString(
          client.code,
          `summary.context.clients.${index}.code`,
          20
        ),
        name: assertShortString(
          client.name,
          `summary.context.clients.${index}.name`,
          200
        ),
        aliases: client.aliases.map((alias) =>
          assertShortString(
            alias,
            `summary.context.clients.${index}.aliases`,
            200
          )
        )
      };
    });
  }

  if (!meeting && (!clients || clients.length === 0)) {
    throw new Error("summary.context must contain meeting or clients");
  }
  return {
    ...(meeting ? { meeting } : {}),
    ...(clients && clients.length > 0 ? { clients } : {})
  };
};

export const validateJobId = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid job id");
  }
  return value;
};

export const validateMediaExtension = (fileName: string): string => {
  const extension = extname(fileName).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported media extension: ${extension || "none"}`);
  }
  return extension;
};

/** Same grammar as the summary.template setting: auto, a built-in id or custom:<slug>. */
export const SUMMARY_TEMPLATE_SETTING = /^(auto|[a-z][a-z0-9-]{0,40}|custom:[a-z0-9][a-z0-9-]{0,40})$/;

const parseSummaryLanguageBinding = (value: unknown): SummaryLanguage => {
  if (typeof value !== "string" || !(SUMMARY_LANGUAGES as readonly string[]).includes(value)) {
    throw new Error("summary.language must be auto, pt-BR, en or es");
  }
  return value as SummaryLanguage;
};

const parseSummaryTemplateBinding = (value: unknown): string => {
  if (typeof value !== "string" || !SUMMARY_TEMPLATE_SETTING.test(value)) {
    throw new Error("summary.template must be auto, a template id or custom:<slug>");
  }
  return value;
};

export const validateJobManifest = (value: unknown): JobManifest => {
  if (!isObject(value) || value.version !== JOB_VERSION) {
    throw new Error("Unsupported job manifest version");
  }
  const source = value.source;
  const transcription = value.transcription;
  const summary = value.summary;
  if (!isObject(source) || !isObject(transcription) || !isObject(summary)) {
    throw new Error("Job manifest is missing required sections");
  }

  const originalName = assertShortString(source.originalName, "source.originalName", 255);
  const mediaFile = assertShortString(source.mediaFile, "source.mediaFile", 64);
  if (basename(originalName) !== originalName || basename(mediaFile) !== mediaFile) {
    throw new Error("Source names must not contain directory components");
  }
  validateMediaExtension(mediaFile);
  if (typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size <= 0) {
    throw new Error("source.size must be a positive integer");
  }
  if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(source.sha256)) {
    throw new Error("source.sha256 must be a SHA-256 digest");
  }
  if (!["openai", "whisper-cpp", "gemini"].includes(String(transcription.provider))) {
    throw new Error("Unsupported transcription provider");
  }
  if (!["openai", "ollama"].includes(String(summary.provider))) {
    throw new Error("Unsupported summary provider");
  }

  return {
    version: JOB_VERSION,
    id: validateJobId(assertShortString(value.id, "id", 36)),
    createdAt: assertShortString(value.createdAt, "createdAt", 40),
    source: {
      originalName,
      mediaFile,
      size: source.size,
      sha256: source.sha256.toLowerCase()
    },
    transcription: {
      provider: transcription.provider as TranscriptionProvider,
      model: assertShortString(transcription.model, "transcription.model"),
      language: assertShortString(transcription.language, "transcription.language", 16),
      languages:
        transcription.languages === undefined
          ? undefined
          : parseTranscriptionLanguages(transcription.languages),
      keywords:
        transcription.keywords === undefined
          ? undefined
          : parseTranscriptionKeywords(transcription.keywords),
      prompt:
        transcription.prompt === undefined
          ? undefined
          : parseOptionalString(
              transcription.prompt,
              "transcription.prompt",
              TRANSCRIPTION_PROMPT_MAX_LENGTH
            )
    },
    summary: {
      provider: summary.provider as SummaryProvider,
      model: assertShortString(summary.model, "summary.model"),
      context:
        summary.context === undefined
          ? undefined
          : parseSummaryContext(summary.context),
      // Optional bindings stay absent on older manifests: identities hash this object.
      ...(summary.language === undefined ? {} : { language: parseSummaryLanguageBinding(summary.language) }),
      ...(summary.template === undefined ? {} : { template: parseSummaryTemplateBinding(summary.template) })
    }
  };
};

const SUMMARY_TEMPLATE_SOURCES = ["user", "default", "calendar", "keywords", "ai", "fallback"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const parseIdList = (value: unknown, pattern: RegExp, max: number): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some((id) => typeof id !== "string" || !pattern.test(id)) || new Set(value).size !== value.length) {
    throw new Error("Invalid summary section item");
  }
  return [...value] as string[];
};

const parseSummarySections = (value: unknown): SummarySection[] => {
  if (!Array.isArray(value) || value.length > SUMMARY_SECTION_LIMITS.sections) throw new Error("Invalid summary sections");
  let total = 0;
  return value.map((section) => {
    if (!isObject(section) || !Array.isArray(section.items)) throw new Error("Invalid summary section");
    const heading = section.heading;
    if (typeof heading !== "string" || !heading.trim() || heading.length > SUMMARY_SECTION_LIMITS.headingCharacters || CONTROL_CHARACTERS.test(heading)) {
      throw new Error("Invalid summary section heading");
    }
    total += section.items.length;
    if (total > SUMMARY_SECTION_LIMITS.items) throw new Error("Summary has too many section items");
    return {
      heading,
      items: section.items.map((item): SummarySectionItem => {
        if (!isObject(item) || (item.origin !== "user" && item.origin !== "ai") || typeof item.text !== "string" || !item.text.trim() ||
            item.text.length > SUMMARY_SECTION_LIMITS.itemCharacters || (item.uncertainty !== "clear" && item.uncertainty !== "uncertain")) {
          throw new Error("Invalid summary section item");
        }
        const noteIds = parseIdList(item.noteIds, /^n\d{6}$/, SUMMARY_SECTION_LIMITS.noteIds);
        // A user item always names its notes; an AI item never claims one.
        if ((item.origin === "user") !== (noteIds.length > 0)) throw new Error("Invalid summary section item origin");
        return {
          text: item.text, origin: item.origin, noteIds,
          segmentIds: parseIdList(item.segmentIds, /^s\d{6}$/, SUMMARY_SECTION_LIMITS.segmentIds),
          uncertainty: item.uncertainty
        };
      })
    };
  });
};

const parseSummaryMeta = (value: unknown): SummaryMeta => {
  if (!isObject(value) || value.schemaVersion !== 2 || typeof value.specId !== "string" || !/^v2:[a-f0-9]{12}$/.test(value.specId) ||
      !isObject(value.template) || !isObject(value.notes) || !["pt-BR", "en", "es"].includes(String(value.language))) {
    throw new Error("Invalid summary metadata");
  }
  const { id, source, confidence, reason } = value.template;
  const { count, digest } = value.notes;
  if (typeof id !== "string" || id === "auto" || !SUMMARY_TEMPLATE_SETTING.test(id) || !SUMMARY_TEMPLATE_SOURCES.includes(String(source)) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      typeof reason !== "string" || reason.length > SUMMARY_SECTION_LIMITS.reasonCharacters || CONTROL_CHARACTERS.test(reason) ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 100_000 ||
      typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid summary metadata");
  }
  return {
    schemaVersion: 2,
    specId: value.specId,
    template: { id, source: source as SummaryTemplateSource, confidence, reason },
    language: value.language as SummaryMeta["language"],
    notes: { count, digest }
  };
};

export const validateSummary = (
  value: unknown,
  provider: SummaryProvider,
  model: string
): RecordingSummary => {
  if (!isObject(value)) {
    throw new Error("Summary response is not an object");
  }
  const overview = assertShortString(value.overview, "overview", 10000);
  const topics = parseStringArray(value.topics, "topics");
  const decisions = parseStringArray(value.decisions, "decisions");
  if (!Array.isArray(value.actionItems) || value.actionItems.length > 100) {
    throw new Error("actionItems must be an array with at most 100 items");
  }
  const actionItems = value.actionItems.map((item) => {
    if (!isObject(item)) {
      throw new Error("Summary action item is invalid");
    }
    return {
      description: assertShortString(item.description, "actionItems.description", 1000),
      owner: parseOptionalString(item.owner, "actionItems.owner", 500),
      dueDate: parseOptionalString(item.dueDate, "actionItems.dueDate", 100)
    };
  });
  let citations: SummaryCitation[] | undefined;
  if (value.citations !== undefined) {
    if (!Array.isArray(value.citations) || value.citations.length > 500) throw new Error("Invalid summary citations");
    citations = value.citations.map((citation) => {
      if (!isObject(citation) || !["overview", "topic", "decision", "action"].includes(String(citation.section)) ||
          !Number.isSafeInteger(citation.index) || (citation.index as number) < 0 ||
          !Array.isArray(citation.segmentIds) || citation.segmentIds.length < 1 || citation.segmentIds.length > 8 ||
          citation.segmentIds.some((id) => typeof id !== "string" || !/^s\d{6}$/.test(id)) ||
          new Set(citation.segmentIds).size !== citation.segmentIds.length ||
          !["clear", "uncertain"].includes(String(citation.uncertainty))) throw new Error("Invalid summary citation");
      const count = citation.section === "overview" ? 1 : citation.section === "topic" ? topics.length : citation.section === "decision" ? decisions.length : actionItems.length;
      if ((citation.index as number) >= count) throw new Error("Summary citation references a missing claim");
      return citation as SummaryCitation;
    });
  }
  const limitations = value.limitations === undefined ? undefined : parseStringArray(value.limitations, "limitations");
  const sections = value.sections === undefined ? undefined : parseSummarySections(value.sections);
  const meta = value.meta === undefined ? undefined : parseSummaryMeta(value.meta);
  let support: SummarySupport | undefined;
  if (value.support !== undefined) {
    const item = value.support;
    if (!isObject(item) || item.version !== 1 || typeof item.mediaSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.mediaSha256) ||
        typeof item.transcriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.transcriptSha256) ||
        !["segment", "approximate-block", "none"].includes(String(item.timingQuality)) || typeof item.reviewRequired !== "boolean" ||
        !Array.isArray(item.references) || item.references.length > 8000 || item.references.some((ref) => !isObject(ref) ||
          typeof ref.id !== "string" || !/^s\d{6}$/.test(ref.id) || typeof ref.start !== "number" || !Number.isFinite(ref.start) || ref.start < 0 ||
          typeof ref.end !== "number" || !Number.isFinite(ref.end) || ref.end < ref.start) ||
        new Set(item.references.map((ref) => ref.id)).size !== item.references.length) throw new Error("Invalid summary support");
    support = item as SummarySupport;
    const ids = new Set(support.references.map((reference) => reference.id));
    if (citations?.some((citation) => citation.segmentIds.some((id) => !ids.has(id)))) throw new Error("Stored summary citation has no supporting reference");
    // Section items cite segments the same way; each needs its supporting reference.
    if (sections?.some((section) => section.items.some((item) => item.segmentIds.some((id) => !ids.has(id))))) {
      throw new Error("Stored summary citation has no supporting reference");
    }
  }
  return {
    version: JOB_VERSION,
    provider,
    model,
    title:
      value.title === undefined
        ? validateMeetingTitle(deriveMeetingTitle(overview))
        : validateMeetingTitle(value.title),
    overview,
    topics,
    decisions,
    actionItems,
    ...(citations === undefined ? {} : { citations }),
    ...(limitations === undefined ? {} : { limitations }),
    ...(sections === undefined ? {} : { sections }),
    ...(meta === undefined ? {} : { meta }),
    ...(support === undefined ? {} : { support })
  };
};

export const validateTranscript = (value: unknown): Transcript => {
  if (!isObject(value) || value.version !== JOB_VERSION) {
    throw new Error("Unsupported transcript version");
  }
  if (!["openai", "whisper-cpp", "gemini"].includes(String(value.provider))) {
    throw new Error("Unsupported transcript provider");
  }
  if (typeof value.text !== "string" || value.text.length > 10_000_000) {
    throw new Error("Transcript text must be a string up to 10000000 characters");
  }
  const parseSegments = (items: unknown, field: string): TranscriptSegment[] => {
    if (!Array.isArray(items) || items.length > 100_000) {
      throw new Error(`Transcript ${field} must be an array with at most 100000 items`);
    }
    return items.map((segment, index): TranscriptSegment => {
      if (!isObject(segment)) {
        throw new Error(`Transcript ${field} ${index} is invalid`);
      }
      const start = segment.start;
      const end = segment.end;
      const text = segment.text;
      const speaker = segment.speaker;
      if (
        typeof start !== "number" ||
        !Number.isFinite(start) ||
        start < 0 ||
        typeof end !== "number" ||
        !Number.isFinite(end) ||
        end < start ||
        typeof text !== "string" ||
        text.length > 10_000 ||
        (speaker !== undefined && (typeof speaker !== "string" || speaker.length > 200))
      ) {
        throw new Error(`Transcript ${field} ${index} is invalid`);
      }
      return {
        start,
        end,
        text,
        speaker: speaker as string | undefined
      };
    });
  };
  return {
    version: JOB_VERSION,
    provider: value.provider as TranscriptionProvider,
    model: assertShortString(value.model, "transcript.model"),
    language: assertShortString(value.language, "transcript.language", 16),
    text: value.text,
    segments: parseSegments(value.segments, "segments"),
    ...(value.words === undefined ? {} : { words: parseSegments(value.words, "words") })
  };
};

export const validateJobStatus = (value: unknown): JobStatus => {
  if (!isObject(value) || value.version !== JOB_VERSION) {
    throw new Error("Unsupported job status version");
  }
  const state = String(value.state);
  if (!["pending", "transferring", "queued", "processing", "completed", "failed"].includes(state)) {
    throw new Error("Invalid job status state");
  }
  return {
    version: JOB_VERSION,
    id: validateJobId(assertShortString(value.id, "id", 36)),
    state: state as JobState,
    updatedAt: assertShortString(value.updatedAt, "updatedAt", 40),
    error: typeof value.error === "string" ? value.error.slice(0, 5000) : undefined,
    archiveRelative:
      typeof value.archiveRelative === "string" &&
      /^[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}$/.test(value.archiveRelative)
        ? value.archiveRelative
        : undefined
  };
};

export const validateJobRecord = (value: unknown): JobRecord => {
  const manifest = validateJobManifest(value);
  if (!isObject(value)) {
    throw new Error("Job record is invalid");
  }
  const state = String(value.state);
  const target = String(value.target);
  if (!["pending", "transferring", "queued", "processing", "completed", "failed"].includes(state)) {
    throw new Error("Invalid job record state");
  }
  if (!["local", "remote"].includes(target)) {
    throw new Error("Invalid job target");
  }
  const sourcePath = assertShortString(value.sourcePath, "sourcePath", 4096);
  const artifactDir = assertShortString(value.artifactDir, "artifactDir", 4096);
  if (!sourcePath.startsWith("/") || !artifactDir.startsWith("/")) {
    throw new Error("Job paths must be absolute");
  }
  return {
    ...manifest,
    sourcePath,
    artifactDir,
    target: target as ExecutionTarget,
    state: state as JobState,
    updatedAt: assertShortString(value.updatedAt, "updatedAt", 40),
    error: typeof value.error === "string" ? value.error.slice(0, 5000) : undefined
  };
};
