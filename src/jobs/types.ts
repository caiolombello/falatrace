import { basename, extname } from "node:path";
import type {
  ExecutionTarget,
  SummaryProvider,
  TranscriptionProvider
} from "../config/defaults";
import { TRANSCRIPTION_PROMPT_MAX_LENGTH } from "../config/defaults";

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
  source: "gnome-calendar";
  title: string;
  startAt: string;
  endAt: string;
  recurring: boolean;
  confidence: number;
  app?: "slack" | "zen" | "helium";
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
  support?: SummarySupport;
};

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
    if (!isObject(value.meeting) || value.meeting.source !== "gnome-calendar") {
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
        !["slack", "zen", "helium"].includes(String(value.meeting.app)))
    ) {
      throw new Error("summary.context.meeting is invalid");
    }
    meeting = {
      source: "gnome-calendar",
      title: validateMeetingTitle(value.meeting.title),
      startAt,
      endAt,
      recurring: value.meeting.recurring,
      confidence: value.meeting.confidence,
      app: value.meeting.app as "slack" | "zen" | "helium" | undefined
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
          : parseSummaryContext(summary.context)
    }
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
