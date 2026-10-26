import type { ListedAction } from "../actions/list";
import type { JobRecord } from "../jobs/types";
import { buildFacts, type MeetingSource, readMeetingSource } from "../library-index/build";
import type { JobFacts } from "../library-index/types";
import { findNotesForJob } from "../notes";
import { meetingPeople } from "../recipes/prepare";
import { isContentLanguage, toContentLanguage } from "../summary/language";
import { recordingLink, SHARE_LIMITS, type ShareAction, type ShareLanguage, type ShareNote, validateShareNote } from "./render";

/**
 * The ShareNote of one recording, built from what is on disk: the reviewed transcript and the
 * current summary (readMeetingSource), the notes typed during the meeting, the people and client
 * from the library index, and the done state of the action items. Values are passed raw: the
 * renderer cleans and bounds every one of them again.
 */

export type ShareNoteSources = {
  /** Reviewed content of the recording; defaults to readMeetingSource with the notes module. */
  readSource?: (job: JobRecord) => Promise<MeetingSource>;
  /** Index facts (client names, attendees); recordings not indexed yet use the facts derived here. */
  facts?: (jobId: string) => Promise<JobFacts | undefined>;
  /** Action items of this recording with their saved state; the summary's own list is used without it. */
  actions?: (job: JobRecord) => Promise<ListedAction[]>;
};

const defaultReadSource = (job: JobRecord): Promise<MeetingSource> =>
  readMeetingSource(job, { notes: (current) => findNotesForJob(current).catch(() => undefined) });

/** `12:03`, or `1:02:03` past one hour. */
const at = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
};

/** Language of the shared note: the summary's language, else the conversation's, else Portuguese. */
export const shareLanguageOf = (source: Pick<MeetingSource, "summary" | "language">): ShareLanguage => {
  const meta = source.summary?.meta?.language;
  if (isContentLanguage(meta)) return meta;
  return toContentLanguage(source.language);
};

const shareActions = (source: MeetingSource, listed: ListedAction[] | undefined): ShareAction[] => {
  // Listed actions carry the person's done/dismissed choices; orphaned ones left the current summary.
  const current = (listed ?? []).filter((action) => action.matchState === "current");
  // The summary's own list only stands in when nothing was listed (not indexed yet): actions the
  // person dismissed, even all of them, never come back as open ones.
  if (!current.length) return (source.summary?.actionItems ?? []).map((item) => ({ text: item.description, owner: item.owner, dueDate: item.dueDate, done: false }));
  return current.filter((action) => action.status !== "dismissed")
    .map((action) => ({ text: action.text, owner: action.owner, dueDate: action.dueDate, done: action.status === "done" }));
};

/** Everything a share can include; the render options decide what is shown (notes, transcript). */
export const buildShareNote = async (job: JobRecord, sources: ShareNoteSources = {}): Promise<ShareNote> => {
  const source = await (sources.readSource ?? defaultReadSource)(job);
  const indexed = await sources.facts?.(job.id).catch(() => undefined);
  const facts = indexed ?? buildFacts(source);
  const listed = await sources.actions?.(job).catch(() => undefined);
  const summary = source.summary;
  const template = summary?.meta?.template.id;
  const client = facts.clients[0]?.name;
  return validateShareNote({
    jobId: job.id,
    title: source.title,
    date: source.date,
    people: meetingPeople(facts),
    ...(client ? { client } : {}),
    ...(template ? { template } : {}),
    // Summaries merged from many parts can outgrow what a share note accepts; the renderer cuts the
    // overview to SHARE_LIMITS.overview anyway, so the excess is dropped here instead of failing.
    overview: (summary?.overview ?? "").slice(0, SHARE_LIMITS.overview * 2),
    ...(summary?.sections?.length
      ? {
        sections: summary.sections.filter((section) => section.heading.trim()).slice(0, SHARE_LIMITS.sections).map((section) => ({
          heading: section.heading,
          items: section.items.filter((item) => item.text.trim()).slice(0, SHARE_LIMITS.sectionItems).map((item) => ({ text: item.text, origin: item.origin }))
        }))
      }
      : {}),
    decisions: (summary?.decisions ?? []).slice(0, SHARE_LIMITS.decisions),
    actions: shareActions(source, listed).filter((action) => action.text.trim()).slice(0, SHARE_LIMITS.actions),
    ...(source.notes.length ? { notes: source.notes.map((note) => note.text).slice(0, SHARE_LIMITS.notes) } : {}),
    transcript: source.segments.slice(0, SHARE_LIMITS.transcriptLines)
      .map((segment) => ({ at: at(segment.start), ...(segment.speaker ? { speaker: segment.speaker } : {}), text: segment.text })),
    link: recordingLink(job.id)
  });
};

/** The note and the language it should be rendered in. */
export const buildShareNoteWithLanguage = async (job: JobRecord, sources: ShareNoteSources = {}): Promise<{ note: ShareNote; language: ShareLanguage }> => {
  const read = sources.readSource ?? defaultReadSource;
  let captured: MeetingSource | undefined;
  const note = await buildShareNote(job, {
    ...sources,
    readSource: async (current) => {
      captured = await read(current);
      return captured;
    }
  });
  return { note, language: captured ? shareLanguageOf(captured) : "pt-BR" };
};
