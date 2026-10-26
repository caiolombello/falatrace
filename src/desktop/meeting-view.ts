// What the redesigned Studio shows about one recording beyond today's list and detail fields:
// people, client, notes, the structured notes document (v2 summary + action state + the user's
// notes) and the shareable note. Everything here reads; nothing is written except the action
// state re-anchoring the Actions page also does.
import { basename } from "node:path";
import { listActionsForFacts, type ListedAction } from "../actions/list";
import { normalizeActionText } from "../actions/store";
import type { AppServices } from "../app/context";
import { readClientCatalog } from "../clients/catalog";
import { ClientOverridesStore, effectiveClients } from "../clients/overrides";
import type { AppConfig } from "../config/defaults";
import type { JobRecord, RecordingSummary } from "../jobs/types";
import { readMeetingArtifacts, type MeetingArtifacts } from "../knowledge/meetings";
import { readCalendarLink } from "../library-index/build";
import type { JobFacts } from "../library-index/types";
import { findNotesForJob, formatNoteOffset, notesDigest, notesText, type MeetingNotes } from "../notes";
import { factParticipants, PeopleStore, personKey } from "../people/store";
import { recordingLink, type ShareInclude, type ShareNote } from "../share";
import { SUMMARY_LABELS } from "../summary/language";
import { getTemplate, templateName } from "../templates";
import type { LibraryEntry } from "../tui/library";
import { clockOf } from "./bridge-family";
import { notesView } from "./notes-bridge";
import type { StudioServices } from "./studio-services";

const LIST_PEOPLE = 5;

const loopback = (url: string): boolean => {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
};

/** Names of the people in a meeting other than the user, unique, in the order the facts list them. */
export const meetingPeople = (facts: Pick<JobFacts, "speakers" | "attendees">): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const participant of factParticipants(facts)) {
    const key = personKey(participant.name);
    if (participant.self || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(participant.name);
  }
  return names;
};

/** The job the Studio addresses a recording by: the completed one, else the newest. */
export const primaryJob = (entry: Pick<LibraryEntry, "jobs">): JobRecord | undefined =>
  entry.jobs.find((job) => job.state === "completed") ?? entry.jobs[0];

/**
 * Extra `list` fields, from the in-memory facts snapshot only (no disk reads, so `list` costs what it
 * did). Fields are omitted until the recording is indexed.
 */
export const listItemExtras = (entry: LibraryEntry, studio: StudioServices) => {
  const job = primaryJob(entry);
  const facts = studio.cachedFacts([...(job ? [job.id] : []), ...entry.jobs.map((item) => item.id)]);
  const people = facts ? meetingPeople(facts).slice(0, LIST_PEOPLE) : [];
  const openActions = facts ? studio.cachedOpenActions(facts.jobId) : undefined;
  return {
    ...(job ? { jobId: job.id } : {}),
    ...(facts?.durationSeconds !== undefined ? { durationSeconds: Math.round(facts.durationSeconds) } : {}),
    ...(people.length ? { people } : {}),
    ...(facts?.clients[0]?.name ? { client: facts.clients[0].name } : {}),
    ...(facts ? { hasNotes: facts.noteCount > 0 } : {}),
    ...(openActions !== undefined ? { openActions } : {})
  };
};

type Citation = { segmentId: string; start: number };
type DocItem = {
  kind: "text" | "decision" | "action";
  origin: "user" | "ai";
  text: string;
  uncertain: boolean;
  at?: string;
  citations: Citation[];
  noteIds: string[];
  action?: { actionId: string; mediaSha256: string; rev: number; status: string; owner: string; dueDate: string };
};

/** Actions of one recording merged with their saved state (re-anchored and saved, as the Actions page does). */
const recordingActions = async (facts: JobFacts | undefined): Promise<ListedAction[]> => {
  if (!facts) return [];
  const people = await new PeopleStore().directory().catch(() => undefined);
  return listActionsForFacts([facts], { jobId: facts.jobId }, { ...(people ? { people } : {}) }).catch(() => []);
};

const segmentStarts = (summary: RecordingSummary, artifacts: MeetingArtifacts): Map<string, number> => {
  const starts = new Map<string, number>();
  for (const segment of artifacts.view.segments) starts.set(segment.id, segment.start);
  for (const reference of summary.support?.references ?? []) starts.set(reference.id, reference.start);
  return starts;
};

/** The structured notes document of a v2 summary; undefined for legacy summaries (the Studio renders their Markdown). */
export const buildNotesDoc = async (input: {
  job: JobRecord; artifacts: MeetingArtifacts; notes: MeetingNotes | undefined; facts: JobFacts | undefined; config: AppConfig; generatedAt?: string;
}) => {
  const { job, artifacts, notes, facts, config } = input;
  const summary = artifacts.summary;
  if (!summary?.meta || !summary.sections?.length) return undefined;
  const meta = summary.meta;
  const labels = SUMMARY_LABELS[meta.language];
  const starts = segmentStarts(summary, artifacts);
  const cite = (ids: readonly string[]): Citation[] => ids.filter((id) => starts.has(id)).map((id) => ({ segmentId: id, start: starts.get(id)! }));
  const offsets = new Map((notes?.entries ?? []).map((entry) => [entry.id, entry.offsetSeconds]));
  const noteAt = (ids: readonly string[]): string | undefined => {
    for (const id of ids) {
      const at = formatNoteOffset(offsets.get(id) ?? null);
      if (at) return at;
    }
    return undefined;
  };
  const decisions = new Set(summary.decisions.map(normalizeActionText));
  const actionTexts = new Set(summary.actionItems.map((item) => normalizeActionText(item.description)));
  const listed = await recordingActions(facts);
  const current = listed.filter((action) => action.matchState === "current");
  // A note the model kept as an action can exist twice (the note and the model's copy): each item takes its own kind first.
  const byOrigin = (origin: "note" | "model") => new Map(current.filter((action) => (origin === "note") === (action.origin === "note")).map((action) => [normalizeActionText(action.text), action]));
  const fromNotes = byOrigin("note"), fromModel = byOrigin("model");
  const item = (raw: NonNullable<RecordingSummary["sections"]>[number]["items"][number]): DocItem => {
    const normalized = normalizeActionText(raw.text);
    const action = raw.origin === "user" ? fromNotes.get(normalized) ?? fromModel.get(normalized) : fromModel.get(normalized) ?? fromNotes.get(normalized);
    const kind = action || actionTexts.has(normalized) ? "action" : decisions.has(normalized) ? "decision" : "text";
    const citations = cite(raw.segmentIds);
    const at = raw.origin === "user" ? noteAt(raw.noteIds) : citations.length ? clockOf(Math.min(...citations.map((citation) => citation.start))) : undefined;
    return {
      kind, origin: raw.origin, text: raw.text, uncertain: raw.uncertainty === "uncertain", ...(at ? { at } : {}), citations, noteIds: [...raw.noteIds],
      ...(action ? { action: { actionId: action.actionId, mediaSha256: action.mediaSha256, rev: action.rev, status: action.status, owner: action.owner, dueDate: action.dueDate } } : {})
    };
  };
  const unused = summary.sections.filter((section) => section.heading === labels.unusedNotes);
  const template = await getTemplate(meta.template.id).catch(() => undefined);
  const currentDigest = notesDigest(notes);
  return {
    version: 2 as const,
    generatedAt: input.generatedAt ?? job.updatedAt,
    model: { label: `${summary.provider} · ${summary.model}`, local: summary.provider === "ollama" && loopback(config.summary.ollamaUrl) },
    template: {
      id: meta.template.id, name: template ? templateName(template, meta.language) : meta.template.id, source: meta.template.source,
      reason: meta.template.reason, confidence: meta.template.confidence
    },
    language: meta.language,
    stale: artifacts.view.derivedStale ? "transcript" as const : currentDigest !== meta.notes.digest ? "notes" as const : null,
    notesDigest: meta.notes.digest,
    overview: {
      text: summary.overview,
      citations: cite((summary.citations ?? []).filter((citation) => citation.section === "overview").flatMap((citation) => citation.segmentIds))
    },
    sections: summary.sections.filter((section) => section.heading !== labels.unusedNotes).map((section) => ({ heading: section.heading, items: section.items.map(item) })),
    unusedNotes: unused.flatMap((section) => section.items).map((raw) => {
      const at = noteAt(raw.noteIds);
      return { text: raw.text, ...(at ? { at } : {}) };
    }),
    orphanActions: listed.filter((action) => action.matchState === "orphaned").map(({ actionId, mediaSha256, text, status }) => ({ actionId, mediaSha256, text, status })),
    limitations: [...(summary.limitations ?? [])]
  };
};

/**
 * Extra `detail` fields (DESIGN-STUDIO §4): notes, people, clients, calendar and the notes
 * document. Each part fails alone and is then omitted; detail itself never fails because of them.
 */
export const detailExtras = async (input: {
  job: JobRecord | undefined; config: AppConfig; studio: StudioServices; summaryReady: boolean; generatedAt?: string;
}) => {
  const { job, config, studio } = input;
  if (!job) return {};
  const facts = studio.cachedFacts([job.id]);
  const notes = await findNotesForJob(job).catch(() => undefined);
  const directory = facts ? await new PeopleStore().directory().catch(() => undefined) : undefined;
  const people = facts && directory
    ? [...new Map(meetingPeople(facts).map((name) => [directory.idForName(name) ?? `name:${personKey(name)}`, name])).entries()].map(([id, name]) => ({ id, name: directory.record(id)?.displayName ?? name }))
    : undefined;
  let clients: Array<{ code: string; name: string; source: string }> | undefined;
  if (facts) {
    const [overrides, catalog] = await Promise.all([
      new ClientOverridesStore().read().catch(() => undefined),
      readClientCatalog(config.timesheet.contextPath).then((read) => read.context, () => undefined)
    ]);
    clients = effectiveClients(facts, overrides, catalog).map(({ code, name, source }) => ({ code, name, source }));
  }
  const link = await readCalendarLink(job).catch(() => undefined);
  let notesDoc: Awaited<ReturnType<typeof buildNotesDoc>>;
  if (input.summaryReady) {
    const artifacts = await readMeetingArtifacts(job).catch(() => undefined);
    notesDoc = artifacts ? await buildNotesDoc({ job, artifacts, notes, facts, config, generatedAt: input.generatedAt }).catch(() => undefined) : undefined;
  }
  return {
    ...(notes ? { notes: { ...notesView(notes.id, notes), digest: notesDigest(notes) } } : {}),
    ...(people ? { people } : {}),
    ...(clients ? { clients } : {}),
    ...(link ? { calendar: { title: link.link.title, startAt: link.link.startAt, endAt: link.link.endAt } } : {}),
    ...(notesDoc ? { notesDoc } : {})
  };
};

/** The note `share-preview` renders for a recording; values are raw, renderShare sanitizes them again. */
export const meetingShareNote = async (job: JobRecord, services: AppServices, include: ShareInclude): Promise<{ note: ShareNote; language?: "pt-BR" | "en" | "es" }> => {
  const artifacts = await readMeetingArtifacts(job);
  const summary = artifacts.summary;
  const facts = await services.index.getFacts(job.id).catch(() => undefined);
  const link = await readCalendarLink(job).catch(() => undefined);
  const notes = include === "summary" ? undefined : await findNotesForJob(job).catch(() => undefined);
  const listed = await recordingActions(facts);
  const done = new Set(listed.filter((action) => action.status === "done").map((action) => normalizeActionText(action.text)));
  const labels = summary?.meta ? SUMMARY_LABELS[summary.meta.language] : undefined;
  const speakerLabels = artifacts.view.diarization?.labels ?? {};
  const note: ShareNote = {
    jobId: job.id,
    title: link?.link.title || facts?.title || summary?.title || basename(job.sourcePath),
    date: link?.link.startAt || facts?.date || job.createdAt,
    people: facts ? meetingPeople(facts) : [],
    ...(facts?.clients[0]?.name ? { client: facts.clients[0].name } : {}),
    ...(summary?.meta?.template.id ? { template: summary.meta.template.id } : {}),
    overview: summary?.overview ?? "",
    ...(summary?.sections?.length ? {
      sections: summary.sections.filter((section) => section.heading !== labels?.unusedNotes)
        .map((section) => ({ heading: section.heading, items: section.items.map((item) => ({ text: item.text, origin: item.origin })) }))
    } : {}),
    decisions: summary?.decisions ?? [],
    actions: (summary?.actionItems ?? []).map((item) => ({ text: item.description, owner: item.owner, dueDate: item.dueDate, done: done.has(normalizeActionText(item.description)) })),
    ...(notes ? { notes: notesText(notes).split("\n").filter((line) => line.trim()) } : {}),
    ...(include === "full" ? {
      transcript: artifacts.view.segments.filter((segment) => segment.text.trim()).map((segment) => ({
        at: clockOf(segment.start), ...(segment.speakerId && speakerLabels[segment.speakerId] ? { speaker: speakerLabels[segment.speakerId] } : {}), text: segment.text
      }))
    } : {}),
    link: recordingLink(job.id)
  };
  return { note, ...(summary?.meta ? { language: summary.meta.language } : {}) };
};
