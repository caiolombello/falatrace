// The v2 summary request end to end: what goes in (template choice, language, the user's
// notes), how a model answer becomes a stored RecordingSummary, and the deterministic steps
// after the model (template resolution, notes it did not use, merging parts).
import type { AppConfig, SummaryProvider } from "../config/defaults";
import {
  validateSummary,
  type RecordingSummary,
  type SummaryContext,
  type SummaryMeta,
  type SummarySection,
  type Transcript
} from "../jobs/types";
import { sanitizeKnowledgeText } from "../knowledge/context";
import { notesDigest, notesForSummary, type AlignableSegment, type NoteForSummary } from "../notes/align";
import { NOTE_LIMITS, noteHeadings, type NoteEntry } from "../notes/lines";
import { findNotesForJob, type MeetingNotes } from "../notes/store";
import { BUILT_IN_TEMPLATES, GENERAL_TEMPLATE, GENERAL_TEMPLATE_ID, sectionTitle, validateTemplate, type SummaryTemplate } from "../templates/catalog";
import { resolveModelChoice, selectTemplate, type TemplateSelection } from "../templates/select";
import { listTemplates } from "../templates/store";
import type { SummaryInputEvidence } from "./evidence";
import { SUMMARY_LABELS, isContentLanguage, resolveSummaryLanguage, type ContentLanguage } from "./language";
import { findSummaryPrefsForJob, type SummaryPrefs } from "./prefs";
import { buildSummarySpec, summarySpecId, unusedNoteIds, validateSummaryV2Output, type SummarySpec } from "./spec";

export type SummaryNotesInfo = { count: number; digest: string };
/** A note as the summary shows it when the model did not place it. */
export type SummaryNoteText = { id: string; text: string };

/** Everything one v2 summary needs besides the transcript; serializable (reviewed plans store it). */
export type SummaryV2Request = {
  /** Spec of the first (or only) request. */
  spec: SummarySpec;
  selection: TemplateSelection;
  language: ContentLanguage;
  /** Notes that may be sent to the model: sanitized and bounded by notesForSummary. */
  notes: NoteForSummary[];
  /** Every note of the meeting, sanitized, so none is ever dropped from the summary. */
  allNotes: SummaryNoteText[];
  notesInfo: SummaryNotesInfo;
  /** Limitations known before the model runs (notes that could not be read). */
  limitations: string[];
};

/** One provider request of a v2 summary: the spec in force and the notes of this part. */
export type SummaryChunkRequest = {
  spec: SummarySpec;
  selection: TemplateSelection;
  notes: NoteForSummary[];
  notesInfo: SummaryNotesInfo;
};

/** Choices made for one summary run (reviewed regeneration); the recording's saved preferences apply when absent. */
export type SummaryChoices = { templateId?: string; language?: string; useNotes?: boolean };

/** Where the inputs come from; injectable for tests. */
export type SummaryInputSources = {
  notes?: (job: { id: string; sourcePath: string }) => Promise<MeetingNotes | undefined>;
  prefs?: (job: { id: string; sourcePath: string }) => Promise<SummaryPrefs | undefined>;
  templates?: () => Promise<SummaryTemplate[]>;
};

// Half of a surrogate pair is not valid Unicode; strict JSON parsers of model APIs refuse it.
const wellFormed = (text: string): string => {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1];
        index++;
      } else out += String.fromCharCode(0xfffd);
    } else if (code >= 0xdc00 && code <= 0xdfff) out += String.fromCharCode(0xfffd);
    else out += text[index];
  }
  return out;
};

const oneLine = (value: string, max: number): string => {
  let flat = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    flat += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : value[index];
  }
  return wellFormed(flat.replace(/\s+/g, " ").trim().slice(0, max));
};

const transcriptText = (transcript: Pick<Transcript, "text" | "segments">): string =>
  transcript.text.trim() ? transcript.text : transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join("\n");

export type SummaryV2Inputs = {
  transcriptText: string;
  /** Transcript segments in order (their position gives the s000000 ids). */
  segments: readonly AlignableSegment[];
  notes?: { entries: readonly NoteEntry[] };
  notesUnreadable?: boolean;
  templates: readonly SummaryTemplate[];
  /** Template chosen for this recording. */
  templateOverride?: string;
  /** summary.template of the job (manifest binding) or of the settings. */
  templateDefault: string;
  detection: "ai" | "keywords";
  calendar?: { title: string; recurring: boolean };
  /** summary.language of the recording, the job or the settings ("auto" or a language). */
  languageSetting: string;
};

/** Pure: picks language, template and spec, and prepares the notes. */
export const buildSummaryV2Request = (input: SummaryV2Inputs): SummaryV2Request => {
  const language = resolveSummaryLanguage(input.languageSetting, input.transcriptText);
  const templates = input.templates.some((template) => template.id === GENERAL_TEMPLATE_ID)
    ? input.templates : [...BUILT_IN_TEMPLATES, ...input.templates];
  const notes = notesForSummary(input.notes, input.segments);
  const selection = selectTemplate({
    override: input.templateOverride, configDefault: input.templateDefault, detection: input.detection,
    calendar: input.calendar, transcriptSample: input.transcriptText, noteHeadings: noteHeadings(input.notes), templates
  });
  const spec = buildSummarySpec({ language, selection, notesIncluded: notes.length > 0 });
  const sent = new Map(notes.map((note) => [note.id, note.text]));
  const allNotes = (input.notes?.entries || [])
    .map((entry) => ({ id: entry.id, text: sent.get(entry.id) ?? wellFormed(sanitizeKnowledgeText(entry.text, NOTE_LIMITS.maxLineChars)) }))
    .filter((note) => note.text.trim());
  return {
    spec, selection, language, notes, allNotes,
    notesInfo: { count: input.notes?.entries.length ?? 0, digest: notesDigest(input.notes) },
    limitations: input.notesUnreadable ? [SUMMARY_LABELS[language].limitation.notesUnreadable] : []
  };
};

/**
 * Reads the inputs of one summary and builds its request. Notes are read only when notes are on
 * and the summary may use them; notes that cannot be read never stop the summary (it goes on
 * from the transcript with a limitation). The recording's saved choices override the job's
 * bound settings, which override the current settings.
 */
export const resolveSummaryV2Request = async (input: {
  config: AppConfig;
  job: { id: string; sourcePath: string };
  summary: { language?: string; template?: string; context?: SummaryContext };
  transcript: Pick<Transcript, "text" | "segments">;
  choices?: SummaryChoices;
}, sources: SummaryInputSources = {}): Promise<SummaryV2Request> => {
  const useNotes = input.config.notes.enabled && (input.choices?.useNotes ?? input.config.summary.useNotes);
  let notes: MeetingNotes | undefined;
  let notesUnreadable = false;
  if (useNotes) {
    try { notes = await (sources.notes ?? ((job) => findNotesForJob(job)))(input.job); }
    catch { notesUnreadable = true; }
  }
  // Damaged choices are left alone; the summary uses the settings instead.
  const prefs = await (sources.prefs ?? ((job) => findSummaryPrefsForJob(job)))(input.job).catch(() => undefined);
  const templates = await (sources.templates ?? (() => listTemplates()))().catch(() => [...BUILT_IN_TEMPLATES]);
  const meeting = input.summary.context?.meeting;
  return buildSummaryV2Request({
    transcriptText: transcriptText(input.transcript),
    segments: input.transcript.segments,
    notes, notesUnreadable, templates,
    templateOverride: input.choices?.templateId ?? prefs?.templateId,
    templateDefault: input.summary.template ?? input.config.summary.template,
    detection: input.config.summary.templateDetection,
    calendar: meeting ? { title: meeting.title, recurring: meeting.recurring } : undefined,
    languageSetting: input.choices?.language ?? prefs?.language ?? input.summary.language ?? input.config.summary.language
  });
};

const summaryMeta = (specId: string, language: ContentLanguage, selection: TemplateSelection, notesInfo: SummaryNotesInfo): SummaryMeta => ({
  schemaVersion: 2,
  specId,
  template: {
    id: (selection.template ?? GENERAL_TEMPLATE).id,
    source: selection.source,
    confidence: Math.min(1, Math.max(0, Number.isFinite(selection.confidence) ? selection.confidence : 0)),
    reason: oneLine(selection.reason, 1000)
  },
  language,
  notes: { count: notesInfo.count, digest: notesInfo.digest }
});

/** The request of one part: the first spec, or the fixed spec once the model chose a template. */
export const chunkRequestFor = (
  request: SummaryV2Request,
  notes: NoteForSummary[],
  fixed?: { spec: SummarySpec; selection: TemplateSelection }
): SummaryChunkRequest => ({
  spec: fixed?.spec ?? request.spec,
  selection: fixed?.selection ?? request.selection,
  notes: request.spec.notesIncluded ? notes : [],
  notesInfo: request.notesInfo
});

/** The template a model-choice summary ended with: the model's answer in the first part, else general. */
export const resolvedSelection = (request: SummaryV2Request, first?: RecordingSummary): TemplateSelection =>
  request.selection.mode === "model-choice" ? resolveModelChoice(request.selection, first?.meta?.template.id) : request.selection;

/** After the first part of a model-choice summary, the later parts use the template it chose. */
export const templateAfterFirstPart = (request: SummaryV2Request, first: RecordingSummary): { spec: SummarySpec; selection: TemplateSelection } | undefined => {
  if (request.selection.mode !== "model-choice") return undefined;
  const selection = resolvedSelection(request, first);
  const template = selection.template ?? GENERAL_TEMPLATE;
  return {
    selection,
    spec: buildSummarySpec({ language: request.language, selection: { mode: "fixed", template, candidates: [template] }, notesIncluded: request.spec.notesIncluded })
  };
};

/**
 * A model answer to a v2 request as a stored summary: strict v2 validation (note ids among the
 * notes sent, segment ids among this part's evidence, template among the offered ones), then
 * every legacy field kept filled so existing readers work, plus `sections` and `meta`.
 */
export const summaryFromV2Response = (
  value: unknown,
  request: SummaryChunkRequest,
  evidence: SummaryInputEvidence | undefined,
  provider: SummaryProvider,
  model: string
): RecordingSummary => {
  const output = validateSummaryV2Output(value, {
    spec: request.spec,
    noteIds: request.notes.map((note) => note.id),
    ...(evidence ? { segmentIds: evidence.segments.filter((segment) => segment.text.trim()).map((segment) => segment.id) } : {})
  });
  const selection = request.selection.mode === "model-choice" ? resolveModelChoice(request.selection, output.templateId) : request.selection;
  return validateSummary({
    title: output.title,
    overview: output.overview,
    topics: output.topics,
    decisions: output.decisions,
    actionItems: output.actionItems,
    citations: output.citations,
    limitations: output.limitations,
    sections: output.sections.filter((section) => section.items.length > 0),
    meta: summaryMeta(request.spec.id, request.spec.language, selection, request.notesInfo)
  }, provider, model);
};

const headingKey = (heading: string): string => heading.normalize("NFC").trim().toLocaleLowerCase();

/** Sections of several parts joined by heading: the template's order first, then any other heading as first seen. */
export const mergeSummarySections = (
  parts: ReadonlyArray<readonly SummarySection[] | undefined>,
  order: readonly string[]
): SummarySection[] | undefined => {
  if (parts.every((sections) => !sections)) return undefined;
  const byHeading = new Map<string, SummarySection>();
  for (const sections of parts) {
    for (const section of sections || []) {
      const key = headingKey(section.heading);
      const existing = byHeading.get(key);
      if (existing) existing.items.push(...section.items.map((item) => ({ ...item })));
      else byHeading.set(key, { heading: section.heading, items: section.items.map((item) => ({ ...item })) });
    }
  }
  const merged: SummarySection[] = [];
  for (const heading of order) {
    const key = headingKey(heading);
    const section = byHeading.get(key);
    if (section) { merged.push(section); byHeading.delete(key); }
  }
  return [...merged, ...byHeading.values()];
};

/** Section titles of the template a selection resolved to, in the summary language. */
export const templateHeadings = (selection: TemplateSelection, language: ContentLanguage): string[] =>
  (selection.template ?? GENERAL_TEMPLATE).sections.map((section) => sectionTitle(section, language));

// Fixed limitation phrases were written in Portuguese by code that does not know the language
// (legacy checkpoints, injected adapters): carry them over to the summary language.
const localizeLimitations = (limitations: readonly string[], language: ContentLanguage): string[] => {
  if (language === "pt-BR") return [...limitations];
  const source = SUMMARY_LABELS["pt-BR"].limitation as Record<string, string>;
  const target = SUMMARY_LABELS[language].limitation as Record<string, string>;
  const byText = new Map(Object.keys(source).map((key) => [source[key], target[key]]));
  return limitations.map((limitation) => byText.get(limitation) ?? limitation);
};

/**
 * Deterministic end of a v2 summary: notes the model did not place are appended as user items
 * under "Notas suas que o modelo não usou" (never dropped), known limitations are added, and
 * `meta` records the spec, the resolved template, the language and the notes.
 */
export const finalizeSummaryV2 = (
  summary: RecordingSummary,
  request: SummaryV2Request,
  selection: TemplateSelection,
  provider: SummaryProvider,
  model: string
): RecordingSummary => {
  const labels = SUMMARY_LABELS[request.language];
  const sections = (summary.sections || []).map((section) => ({ heading: section.heading, items: section.items.map((item) => ({ ...item })) }));
  const unused = new Set(unusedNoteIds({ sections }, request.allNotes));
  const extra = [...request.limitations];
  if (unused.size) {
    sections.push({
      heading: labels.unusedNotes,
      items: request.allNotes.filter((note) => unused.has(note.id))
        .map((note) => ({ text: note.text, origin: "user" as const, noteIds: [note.id], segmentIds: [], uncertainty: "clear" as const }))
    });
    extra.push(labels.limitation.notesNotUsed);
  }
  const base = localizeLimitations(summary.limitations || [], request.language).filter((limitation) => !extra.includes(limitation));
  const limitations = [...new Set(base)].slice(0, 100 - extra.length).concat([...new Set(extra)]);
  return validateSummary({
    ...summary,
    limitations,
    ...(sections.length ? { sections } : {}),
    meta: summaryMeta(request.spec.id, request.language, selection, request.notesInfo)
  }, provider, model);
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const SELECTION_SOURCES = ["user", "default", "calendar", "keywords", "ai", "fallback"];

/**
 * Checks a request read back from a stored reviewed plan. The plan's hashes already bind its exact
 * bytes; this refuses shapes the code cannot use and returns the same object (key order matters
 * for those hashes). The spec must still carry its own id: an edited prompt is refused.
 */
export const validateStoredSummaryRequest = (value: unknown): SummaryV2Request => {
  const invalid = (): never => { throw new Error("Invalid stored summary request"); };
  if (!isRecord(value) || !isRecord(value.spec) || !isRecord(value.selection) || !Array.isArray(value.notes) || !Array.isArray(value.allNotes) ||
      !isRecord(value.notesInfo) || !Array.isArray(value.limitations)) return invalid();
  const { spec, selection, notesInfo } = value;
  if (spec.version !== 2 || typeof spec.system !== "string" || !isRecord(spec.schema) || typeof spec.id !== "string" ||
      summarySpecId(spec.system, spec.schema) !== spec.id || !isContentLanguage(spec.language) || value.language !== spec.language ||
      (spec.mode !== "fixed" && spec.mode !== "model-choice") || !Array.isArray(spec.templateIds) || !spec.templateIds.length ||
      spec.templateIds.some((id) => typeof id !== "string") || typeof spec.notesIncluded !== "boolean") return invalid();
  if ((selection.mode !== "fixed" && selection.mode !== "model-choice") || !Array.isArray(selection.candidates) ||
      !SELECTION_SOURCES.includes(String(selection.source)) || typeof selection.confidence !== "number" || !Number.isFinite(selection.confidence) ||
      typeof selection.reason !== "string" || selection.reason.length > 4000 || !Array.isArray(selection.matched) ||
      selection.matched.some((item) => typeof item !== "string")) return invalid();
  // Templates go back into prompts (the fixed spec after a model choice): only valid ones.
  for (const template of [...selection.candidates, ...(selection.template === undefined ? [] : [selection.template])]) validateTemplate(template);
  if (selection.mode === "fixed" && selection.template === undefined) return invalid();
  for (const note of value.notes) {
    if (!isRecord(note) || typeof note.id !== "string" || !/^n\d{6}$/.test(note.id) || typeof note.text !== "string" || note.text.length > NOTE_LIMITS.maxLineChars ||
        (note.at !== null && typeof note.at !== "string") || (note.offsetSeconds !== null && typeof note.offsetSeconds !== "number") ||
        !Array.isArray(note.nearSegmentIds) || note.nearSegmentIds.some((id) => typeof id !== "string")) return invalid();
  }
  for (const note of value.allNotes) {
    if (!isRecord(note) || typeof note.id !== "string" || !/^n\d{6}$/.test(note.id) || typeof note.text !== "string" || note.text.length > NOTE_LIMITS.maxLineChars) return invalid();
  }
  if (typeof notesInfo.count !== "number" || !Number.isSafeInteger(notesInfo.count) || notesInfo.count < 0 ||
      typeof notesInfo.digest !== "string" || !/^[a-f0-9]{64}$/.test(notesInfo.digest) || value.limitations.some((item) => typeof item !== "string")) return invalid();
  return value as unknown as SummaryV2Request;
};
