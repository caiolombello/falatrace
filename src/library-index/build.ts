import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DiarizationStore } from "../diarization/store";
import { JobStore } from "../jobs/store";
import type { JobRecord, RecordingSummary } from "../jobs/types";
import { sanitizeKnowledgeText } from "../knowledge/context";
import { type MeetingArtifacts, readMeetingArtifacts } from "../knowledge/meetings";
import type { ReviewedView } from "../revisions/index";
import { getReviewedSummaryRoot } from "../summary/reviewed";
import { LIBRARY_INDEX_LIMITS, type SegmentInfo, type StoredJobIndex, validateFactClient } from "./store";
import type { CalendarLink, FactAction, FactClient, FactDecision, FactSpeaker, IndexChunk, JobFacts } from "./types";

/**
 * Turns one recording's artifacts into index facts and searchable chunks. Reads go through the
 * same validated readers as meeting search (reviewed view, current summary, transcript).
 */

/** Bumped when facts or chunks are built differently, so every entry is rebuilt once. */
export const INDEX_BUILD_VERSION = "falatrace:library-index:v1";

const MIN_CHUNK_CHARACTERS = 500;
const MAX_CHUNK_CHARACTERS = 800;
/** A segment longer than this (block transcripts) is cut into pieces of about MAX_CHUNK_CHARACTERS. */
const MAX_SEGMENT_CHUNK_CHARACTERS = 2_000;
/** Bound on one segment's text; longer blocks are cut into pieces, not dropped. */
const MAX_SEGMENT_CHARACTERS = 200_000;
const MAX_NOTES = 500;
/** Upper bound of a stored time in seconds (the store refuses larger values). */
const MAX_OFFSET_SECONDS = 1e7;
const CALENDAR_LINK_BYTES = 64 * 1024;
const GENERIC_SPEAKER = /^Falante \d+$/i;
const SEGMENT_ID = /^s\d{6}$/;
const UNCHECKED_ITEM = /^\s*(?:[-*+]\s+)?\[ \]\s+(.+)$/;
const UNTITLED = "Reunião sem título";
/** Thrown when a recording has no transcript to index yet (still processing, or empty). */
export const NO_USABLE_TRANSCRIPT = "A gravação ainda não possui uma transcrição utilizável";

export type NoteInput = { id: string; text: string; offsetSeconds: number | null };
export type NotesReader = (job: JobRecord) => Promise<{ entries: ReadonlyArray<NoteInput> } | undefined>;
export type ClientsReader = (job: JobRecord, facts: JobFacts) => Promise<FactClient[]>;
export type CalendarLinkReader = (job: JobRecord) => Promise<{ link: CalendarLink; sha256: string } | undefined>;

export type MeetingSegment = SegmentInfo & { text: string };

/** Everything the index (and the meeting-scope assistant) needs from one recording, already sanitized. */
export type MeetingSource = {
  job: JobRecord;
  title: string;
  date: string;
  durationSeconds?: number;
  language?: string;
  transcriptSha256: string;
  summarySha256?: string;
  summaryOrigin: "original" | "reviewed-regenerated" | "none";
  revision: number;
  diarizationSha256?: string;
  summary: RecordingSummary | null;
  segments: MeetingSegment[];
  speakers: FactSpeaker[];
  notes: NoteInput[];
  notesDigest: string;
  calendar?: CalendarLink;
  calendarSha256?: string;
};

export type SourceDeps = {
  readArtifacts?: (job: JobRecord) => Promise<MeetingArtifacts>;
  notes?: NotesReader;
  calendarLink?: CalendarLinkReader;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export const calendarLinksDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "calendar-links");

const revisionsPath = (jobId: string): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "revisions", `${jobId}.json`);

const isoOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** A calendar link file of this job, or undefined when it is absent, foreign or malformed. */
export const validateCalendarLink = (value: unknown, job: Pick<JobRecord, "id" | "source">): CalendarLink | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const keys = ["version", "jobId", "mediaSha256", "source", "eventIdHash", "seriesIdHash", "title", "startAt", "endAt", "recurring", "attendees", "capturedAt"];
  if (Object.keys(item).some((key) => !keys.includes(key))) return undefined;
  if (item.version !== 1 || item.jobId !== job.id || item.mediaSha256 !== job.source.sha256) return undefined;
  if (item.source !== "google-calendar" && item.source !== "gnome-calendar") return undefined;
  for (const hash of [item.eventIdHash, item.seriesIdHash]) if (hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return undefined;
  if (typeof item.title !== "string" || item.title.length > 1_000 || typeof item.recurring !== "boolean") return undefined;
  const startAt = isoOrUndefined(item.startAt), endAt = isoOrUndefined(item.endAt), capturedAt = isoOrUndefined(item.capturedAt);
  if (!startAt || !endAt || !capturedAt || !Array.isArray(item.attendees) || item.attendees.length > 50) return undefined;
  const attendees: CalendarLink["attendees"] = [];
  for (const raw of item.attendees) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const attendee = raw as Record<string, unknown>;
    if (Object.keys(attendee).some((key) => key !== "name" && key !== "self") || typeof attendee.name !== "string" || attendee.name.length > 500 || typeof attendee.self !== "boolean") return undefined;
    const name = sanitizeKnowledgeText(attendee.name, 200);
    if (name) attendees.push({ name, self: attendee.self });
  }
  return {
    version: 1, jobId: job.id, mediaSha256: job.source.sha256, source: item.source,
    ...(item.eventIdHash ? { eventIdHash: item.eventIdHash as string } : {}),
    ...(item.seriesIdHash ? { seriesIdHash: item.seriesIdHash as string } : {}),
    title: sanitizeKnowledgeText(item.title, 160), startAt, endAt, recurring: item.recurring, attendees, capturedAt
  };
};

/** Reads `calendar-links/<jobId>.json` (written when the job was created), refusing links and shared-writable files. */
export const readCalendarLink: CalendarLinkReader = async (job) => {
  let handle: FileHandle;
  try { handle = await fs.open(join(calendarLinksDir(), `${job.id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (missing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CALENDAR_LINK_BYTES || (stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return undefined;
    const raw = (await handle.readFile()).toString("utf8");
    if (raw.length > CALENDAR_LINK_BYTES) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    const link = validateCalendarLink(parsed, job);
    return link ? { link, sha256: sha256(raw) } : undefined;
  } finally {
    await handle.close();
  }
};

/**
 * Validated, sanitized notes from the injected reader (none by default). A reader that fails
 * (for example an unreadable notes file) means "no notes": it never makes the recording
 * unindexable or unanswerable.
 */
export const readNotesInput = async (job: JobRecord, reader?: NotesReader): Promise<NoteInput[]> => {
  if (!reader) return [];
  let value: Awaited<ReturnType<NotesReader>>;
  try { value = await reader(job); } catch { return []; }
  if (!value || !Array.isArray(value.entries)) return [];
  const notes: NoteInput[] = [];
  const ids = new Set<string>();
  for (const entry of value.entries.slice(0, MAX_NOTES)) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(entry.id) || typeof entry.text !== "string") continue;
    // Note ids name chunks (`<jobId>:note:<id>`); a repeated id would make the whole entry invalid.
    if (ids.has(entry.id)) continue;
    const offset = entry.offsetSeconds;
    // Same bound as stored times (store.ts `seconds`); a wilder offset has no usable moment.
    const offsetSeconds = typeof offset === "number" && Number.isFinite(offset) && offset >= 0 && offset <= MAX_OFFSET_SECONDS ? offset : null;
    const text = sanitizeKnowledgeText(entry.text.slice(0, 4_000), 2_000);
    if (!text) continue;
    ids.add(entry.id);
    notes.push({ id: entry.id, text, offsetSeconds });
  }
  return notes;
};

export const notesDigestOf = (notes: ReadonlyArray<NoteInput>): string =>
  sha256(JSON.stringify(notes.map((note) => [note.id, note.text, note.offsetSeconds])));

/** Speaker of a segment as the Studio shows it: the human label only when a person bound the segment to a voice. */
const segmentSpeaker = (view: ReviewedView, segment: ReviewedView["segments"][number]): string | undefined => {
  if (!segment.speakerId) return undefined;
  const label = segment.humanSpeakerEdited ? view.diarization?.labels[segment.speakerId] || segment.speakerId : segment.speakerId;
  return sanitizeKnowledgeText(label, 80) || undefined;
};

const factSpeakers = (view: ReviewedView): FactSpeaker[] =>
  Object.entries(view.diarization?.labels || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 100)
    .map(([speakerId, raw]) => {
      const label = sanitizeKnowledgeText(raw, 80) || speakerId;
      return { speakerId: speakerId.slice(0, 20), label, confirmed: !GENERIC_SPEAKER.test(label.trim()) };
    });

/** Reads and sanitizes one recording. Throws when it has no usable transcript. */
export const readMeetingSource = async (job: JobRecord, deps: SourceDeps = {}): Promise<MeetingSource> => {
  const artifacts = await (deps.readArtifacts ?? readMeetingArtifacts)(job);
  const { view, summary } = artifacts;
  const segments: MeetingSegment[] = [];
  for (const segment of view.segments.slice(0, LIBRARY_INDEX_LIMITS.segmentsPerJob)) {
    if (!SEGMENT_ID.test(segment.id)) continue;
    const text = sanitizeKnowledgeText(segment.text.slice(0, MAX_SEGMENT_CHARACTERS + 1_000), MAX_SEGMENT_CHARACTERS);
    if (!text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) continue;
    const speaker = segmentSpeaker(view, segment);
    segments.push({ id: segment.id, start: Math.max(0, segment.start), end: Math.max(0, segment.end, segment.start), ...(speaker ? { speaker } : {}), text });
  }
  if (!segments.length) throw new Error(NO_USABLE_TRANSCRIPT);
  // Calendar details are extras: an unreadable link file leaves them out instead of failing the recording.
  const [notes, calendar] = await Promise.all([readNotesInput(job, deps.notes), (deps.calendarLink ?? readCalendarLink)(job).catch(() => undefined)]);
  const meeting = job.summary.context?.meeting;
  const title = [summary?.title, calendar?.link.title, meeting?.title, job.source.originalName]
    .map((candidate) => sanitizeKnowledgeText(candidate || "", 160)).find(Boolean) || UNTITLED;
  const date = calendar?.link.startAt ?? isoOrUndefined(meeting?.startAt) ?? new Date(job.createdAt).toISOString();
  const duration = segments.reduce((maximum, segment) => Math.max(maximum, segment.end), 0);
  const language = sanitizeKnowledgeText(view.transcript.language || "", 20);
  return {
    job, title, date,
    ...(duration > 0 ? { durationSeconds: duration } : {}),
    ...(language ? { language } : {}),
    transcriptSha256: sha256(artifacts.transcriptRaw),
    ...(summary && artifacts.summaryRaw ? { summarySha256: sha256(artifacts.summaryRaw) } : {}),
    summaryOrigin: !summary ? "none" : artifacts.summaryProvenance.origin === "reviewed-regenerated" ? "reviewed-regenerated" : "original",
    revision: view.revision.revision,
    ...(view.revision.base.diarizationSha256 ? { diarizationSha256: view.revision.base.diarizationSha256 } : {}),
    summary,
    segments,
    speakers: factSpeakers(view),
    notes,
    notesDigest: notesDigestOf(notes),
    ...(calendar ? { calendar: calendar.link, calendarSha256: calendar.sha256 } : {})
  };
};

const citedSegments = (summary: RecordingSummary, section: "overview" | "decision" | "action", index: number): string[] =>
  [...new Set((summary.citations || [])
    .filter((citation) => citation.section === section && citation.index === index)
    .flatMap((citation) => citation.segmentIds)
    .filter((id) => SEGMENT_ID.test(id)))].slice(0, 64);

const noteActions = (notes: ReadonlyArray<NoteInput>, firstIndex: number): FactAction[] => {
  const actions: FactAction[] = [];
  for (const note of notes) {
    const match = UNCHECKED_ITEM.exec(note.text);
    const text = match ? sanitizeKnowledgeText(match[1]!, 1_000) : "";
    if (text) actions.push({ index: firstIndex + actions.length, text, owner: "", dueDate: "", segmentIds: [], origin: "note" });
  }
  return actions.slice(0, 100);
};

/** Fingerprint of everything the facts and chunks came from (see the library index contract). */
export const sourceFingerprint = (source: MeetingSource, clients: ReadonlyArray<FactClient>): string =>
  sha256(JSON.stringify([INDEX_BUILD_VERSION, source.job.updatedAt, source.job.state, source.transcriptSha256, source.summarySha256 ?? null,
    source.summaryOrigin, source.revision, source.diarizationSha256 ?? null, source.notesDigest, source.calendarSha256 ?? null,
    sha256(JSON.stringify(clients))]));

/** Facts without clients and fingerprint, which depend on the injected client resolver. */
export const buildFacts = (source: MeetingSource): JobFacts => {
  const { job, summary } = source;
  const decisions: FactDecision[] = (summary?.decisions || []).slice(0, 200).flatMap((raw, index) => {
    const text = sanitizeKnowledgeText(raw, 1_000);
    return text ? [{ index, text, segmentIds: citedSegments(summary!, "decision", index) }] : [];
  });
  const modelActions: FactAction[] = (summary?.actionItems || []).slice(0, 200).flatMap((item, index) => {
    const text = sanitizeKnowledgeText(item.description, 1_000);
    return text ? [{ index, text, owner: sanitizeKnowledgeText(item.owner, 500), dueDate: sanitizeKnowledgeText(item.dueDate, 100),
      segmentIds: citedSegments(summary!, "action", index), origin: "model" as const }] : [];
  });
  const calendar = source.calendar
    ? { title: source.calendar.title, ...(source.calendar.eventIdHash ? { eventIdHash: source.calendar.eventIdHash } : {}),
      ...(source.calendar.seriesIdHash ? { seriesIdHash: source.calendar.seriesIdHash } : {}), recurring: source.calendar.recurring }
    : job.summary.context?.meeting
      ? { title: sanitizeKnowledgeText(job.summary.context.meeting.title, 160), recurring: job.summary.context.meeting.recurring }
      : undefined;
  return {
    version: 1,
    jobId: job.id,
    mediaSha256: job.source.sha256,
    sourcePath: job.sourcePath,
    title: source.title,
    date: source.date,
    ...(source.durationSeconds !== undefined ? { durationSeconds: source.durationSeconds } : {}),
    fingerprint: "0".repeat(64),
    transcriptArtifactSha256: source.transcriptSha256,
    ...(source.summarySha256 ? { summaryArtifactSha256: source.summarySha256 } : {}),
    revision: source.revision,
    ...(source.language ? { language: source.language } : {}),
    speakers: source.speakers,
    attendees: (source.calendar?.attendees || []).slice(0, 50),
    ...(calendar ? { calendar } : {}),
    clients: [],
    overview: summary ? sanitizeKnowledgeText(summary.overview, 4_000) : "",
    topics: (summary?.topics || []).map((topic) => sanitizeKnowledgeText(topic, 300)).filter(Boolean).slice(0, 50),
    decisions,
    actions: [...modelActions, ...noteActions(source.notes, modelActions.length)],
    noteCount: source.notes.length
  };
};

/** Splits a long block into pieces near MAX_CHUNK_CHARACTERS at spaces. */
const pieces = (text: string): string[] => {
  const result: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK_CHARACTERS) {
    let cut = rest.lastIndexOf(" ", MAX_CHUNK_CHARACTERS);
    if (cut < MIN_CHUNK_CHARACTERS / 2) cut = /[\uD800-\uDBFF]/.test(rest[MAX_CHUNK_CHARACTERS - 1]!) ? MAX_CHUNK_CHARACTERS - 1 : MAX_CHUNK_CHARACTERS;
    result.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) result.push(rest);
  return result;
};

/** Segment chunks: runs of consecutive segments of about 500–800 characters, one segment per line. */
export const segmentChunks = (jobId: string, segments: ReadonlyArray<MeetingSegment>): IndexChunk[] => {
  const chunks: IndexChunk[] = [];
  let run: MeetingSegment[] = [];
  let length = 0;
  const close = (): void => {
    if (!run.length) return;
    const first = run[0]!, last = run[run.length - 1]!;
    const speakers = [...new Set(run.map((segment) => segment.speaker).filter((value): value is string => Boolean(value)))].slice(0, 50);
    chunks.push({ chunkId: `${jobId}:${first.id}-${last.id}`, jobId, kind: "segments", segmentIds: run.map((segment) => segment.id),
      start: first.start, end: last.end, ...(speakers.length ? { speakers } : {}), text: run.map((segment) => segment.text).join("\n") });
    run = []; length = 0;
  };
  for (const segment of segments) {
    if (segment.text.length > MAX_SEGMENT_CHUNK_CHARACTERS) {
      close();
      for (const [index, text] of pieces(segment.text).entries()) {
        chunks.push({ chunkId: `${jobId}:${segment.id}-${segment.id}:p${index + 1}`, jobId, kind: "segments",
          segmentIds: [segment.id], start: segment.start, end: segment.end, ...(segment.speaker ? { speakers: [segment.speaker] } : {}), text });
      }
      continue;
    }
    if (run.length && (length + 1 + segment.text.length > MAX_CHUNK_CHARACTERS || run.length >= LIBRARY_INDEX_LIMITS.segmentIdsPerChunk)) close();
    run.push(segment);
    length += (run.length > 1 ? 1 : 0) + segment.text.length;
    if (length >= MIN_CHUNK_CHARACTERS) close();
  }
  close();
  return chunks;
};

/** Segments overlapping [offset − 90 s, offset + 10 s], nearest first: a note is usually typed just after the moment. */
export const segmentsNearNote = (offsetSeconds: number | null, segments: ReadonlyArray<SegmentInfo>, limit = 4): string[] => {
  if (offsetSeconds === null) return [];
  const from = offsetSeconds - 90, to = offsetSeconds + 10;
  return segments
    .filter((segment) => segment.end >= from && segment.start <= to)
    .map((segment) => ({ id: segment.id, distance: segment.end < offsetSeconds ? offsetSeconds - segment.end : Math.max(0, segment.start - offsetSeconds) }))
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((segment) => segment.id);
};

const summaryChunks = (jobId: string, summary: RecordingSummary | null, facts: JobFacts): IndexChunk[] => {
  if (!summary) return [];
  const chunks: IndexChunk[] = [];
  const add = (text: string, segmentIds: string[]): void => {
    const value = text.slice(0, LIBRARY_INDEX_LIMITS.chunkCharacters).trim();
    if (value) chunks.push({ chunkId: `${jobId}:summary:${chunks.length}`, jobId, kind: "summary", segmentIds, text: value });
  };
  const topics = facts.topics.length ? `\nTópicos: ${facts.topics.join("; ")}` : "";
  add(`${facts.overview.slice(0, 2_500)}${topics.slice(0, 1_200)}`, citedSegments(summary, "overview", 0));
  for (const decision of facts.decisions) add(`Decisão: ${decision.text}`, decision.segmentIds);
  for (const action of facts.actions.filter((item) => item.origin === "model")) {
    const details = [action.owner ? `responsável: ${action.owner}` : "", action.dueDate ? `prazo: ${action.dueDate}` : ""].filter(Boolean).join("; ");
    add(`Ação: ${action.text}${details ? ` (${details})` : ""}`, action.segmentIds);
  }
  return chunks;
};

const noteChunks = (jobId: string, notes: ReadonlyArray<NoteInput>, segments: ReadonlyArray<SegmentInfo>): IndexChunk[] =>
  notes.map((note) => ({ chunkId: `${jobId}:note:${note.id}`, jobId, kind: "note" as const, segmentIds: segmentsNearNote(note.offsetSeconds, segments),
    ...(note.offsetSeconds !== null ? { start: note.offsetSeconds } : {}), text: note.text }));

/** The stored index entry for a recording; `clients` come from the injected resolver. */
export const buildJobIndex = (source: MeetingSource, clients: ReadonlyArray<FactClient>, probe: string): StoredJobIndex => {
  const facts = buildFacts(source);
  facts.clients = clients.map(validateFactClient).slice(0, 50);
  facts.fingerprint = sourceFingerprint(source, facts.clients);
  const segments: SegmentInfo[] = source.segments.map(({ id, start, end, speaker }) => ({ id, start, end, ...(speaker ? { speaker } : {}) }));
  const chunks = [
    ...summaryChunks(source.job.id, source.summary, facts),
    ...noteChunks(source.job.id, source.notes, segments),
    ...segmentChunks(source.job.id, source.segments)
  ].slice(0, LIBRARY_INDEX_LIMITS.chunksPerJob);
  return { version: 1, probe, facts, chunks, segments };
};

/**
 * Validated clients from the injected resolver (none by default). A resolver that fails (for
 * example an invalid client catalog) means "no clients": pages degrade instead of the recording,
 * or the whole library, dropping out of the index.
 */
export const resolveClients = async (job: JobRecord, facts: JobFacts, reader?: ClientsReader): Promise<FactClient[]> => {
  if (!reader) return [];
  let value: unknown;
  try { value = await reader(job, facts); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const clients: FactClient[] = [];
  for (const client of value.slice(0, 50)) {
    // A malformed entry from the resolver is dropped; it never blocks indexing the recording.
    try {
      clients.push(validateFactClient({ code: client?.code, name: typeof client?.name === "string" ? sanitizeKnowledgeText(client.name, 200) : client?.name,
        source: client?.source, confidence: client?.confidence }));
    } catch { /* skipped */ }
  }
  return clients;
};

const signature = async (path: string): Promise<string> => {
  try {
    const stat = await fs.lstat(path);
    return `${stat.isSymbolicLink() ? "l" : "f"}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return "-";
    throw error;
  }
};

/** Files whose change means the recording must be re-read. */
export const probePaths = (job: JobRecord, jobs: Pick<JobStore, "getWorkDir"> = new JobStore()): string[] => [
  join(job.artifactDir, "transcript.json"),
  join(job.artifactDir, "transcript-receipt.json"),
  join(job.artifactDir, "summary.json"),
  join(jobs.getWorkDir(job.id), "transcript.json"),
  join(jobs.getWorkDir(job.id), "transcript-receipt.json"),
  revisionsPath(job.id),
  join(getReviewedSummaryRoot(), job.id, "index.json"),
  new DiarizationStore().resultPath(job.id),
  join(calendarLinksDir(), `${job.id}.json`)
];

/** Cheap signature (stat of the source files, job state, notes): equal probes skip re-reading artifacts. */
export const probeJob = async (job: JobRecord, notesDigest: string, paths: ReadonlyArray<string>): Promise<string> => {
  const signatures = await Promise.all(paths.map(signature));
  return sha256(JSON.stringify([INDEX_BUILD_VERSION, job.id, job.updatedAt, job.state, job.target, job.sourcePath, job.artifactDir, notesDigest, ...signatures]));
};
