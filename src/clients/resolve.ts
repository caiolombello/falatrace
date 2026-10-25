import { resolve } from "node:path";
import type { TimeEntry, TimesheetClient, TimesheetContext } from "../timesheet/types";

/**
 * Which client(s) a recording belongs to. One rule for the AI context files, `context search
 * --client`, the index facts and the Clients pages: a manual override, else trusted time
 * entries (split allocations, then the first linked entry), else exactly one client named in
 * the summary (then the transcript). Time entries are trusted when the client field is locked
 * or its confidence reaches `timesheet.readyConfidence`.
 */

export type MeetingClientSource = "entry-locked" | "entry-confident" | "entry-split" | "content-match" | "manual";
export type MeetingClient = { clientCode: string; source: MeetingClientSource; confidence: number; timeEntryId?: string };
export type MeetingClientJob = { id: string; sourcePath: string };

/** Texts read only when the time entries do not decide; each is asked for at most once. */
export type MeetingClientContent = {
  summaryText?: () => string | Promise<string>;
  transcriptText?: () => string | Promise<string>;
};

/** A person's explicit choice; an empty list means "this meeting has no client". */
export type MeetingClientOverride = { clientCodes: readonly string[] };

/** Content matching is a heuristic: below any time entry the person confirmed. */
export const CONTENT_MATCH_CONFIDENCE = 0.6;

export const normalizeClientText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Clients whose code, name or alias (3+ characters) appears as whole words in the text. */
export const matchClientsInText = (context: TimesheetContext, content: string): TimesheetClient[] => {
  const searchable = ` ${normalizeClientText(content)} `;
  return context.clients.filter((client) =>
    [client.code, client.name, ...client.aliases].some((candidate) => {
      const term = normalizeClientText(candidate);
      return term.length >= 3 && searchable.includes(` ${term} `);
    })
  );
};

/** The entry's client when a person locked it or the classifier was confident enough. */
export const trustedEntryClient = (
  entry: TimeEntry | undefined,
  context: TimesheetContext,
  readyConfidence: number
): string | undefined => {
  if (!entry?.clientCode || !context.clients.some((client) => client.code === entry.clientCode)) return undefined;
  return entry.lockedFields.includes("client") || entry.confidence.client >= readyConfidence ? entry.clientCode : undefined;
};

/** Entries linked to recordings, looked up by job id first and then by recording path. */
export const indexTimeEntries = (entries: readonly TimeEntry[]): { forJob(job: MeetingClientJob): TimeEntry[] } => {
  const byJob = new Map<string, TimeEntry[]>();
  const byRecording = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    if (entry.source.jobId) byJob.set(entry.source.jobId, [...(byJob.get(entry.source.jobId) || []), entry]);
    if (entry.source.recordingPath) {
      const path = resolve(entry.source.recordingPath);
      byRecording.set(path, [...(byRecording.get(path) || []), entry]);
    }
  }
  return {
    forJob: (job) => {
      const seen = new Set<string>();
      return [...(byJob.get(job.id) || []), ...(byRecording.get(resolve(job.sourcePath)) || [])].filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
    }
  };
};

export const entriesForJob = (job: MeetingClientJob, entries: readonly TimeEntry[]): TimeEntry[] => indexTimeEntries(entries).forJob(job);

const entryConfidence = (entry: TimeEntry): number => (entry.lockedFields.includes("client") ? 1 : entry.confidence.client);

/** Clients decided by time entries alone; empty when the content has to decide. */
export const resolveEntryClients = (
  job: MeetingClientJob,
  entries: readonly TimeEntry[],
  context: TimesheetContext,
  readyConfidence: number
): MeetingClient[] => {
  const linked = entriesForJob(job, entries);
  const split = linked.filter((entry) => entry.splitGroupId && trustedEntryClient(entry, context, readyConfidence));
  if (split.length > 0) {
    return split.map((entry) => ({ clientCode: entry.clientCode!, source: "entry-split", confidence: entryConfidence(entry), timeEntryId: entry.id }));
  }
  const entry = linked[0];
  const trusted = trustedEntryClient(entry, context, readyConfidence);
  if (!entry || !trusted) return [];
  return [{
    clientCode: trusted,
    source: entry.lockedFields.includes("client") ? "entry-locked" : "entry-confident",
    confidence: entryConfidence(entry),
    timeEntryId: entry.id
  }];
};

/** Override codes that still exist in the catalog; undefined when there is no override or it cannot apply. */
export const manualMeetingClients = (override: MeetingClientOverride | null | undefined, context: TimesheetContext): MeetingClient[] | undefined => {
  if (!override) return undefined;
  if (override.clientCodes.length === 0) return [];
  const known = new Set(context.clients.map((client) => client.code));
  const codes = [...new Set(override.clientCodes)].filter((code) => known.has(code));
  // Every chosen client was deleted from the catalog: fall back to the automatic rule.
  if (codes.length === 0) return undefined;
  return codes.map((clientCode) => ({ clientCode, source: "manual", confidence: 1 }));
};

export const resolveMeetingClients = async (
  job: MeetingClientJob,
  entries: readonly TimeEntry[],
  context: TimesheetContext,
  readyConfidence: number,
  options: { content?: MeetingClientContent; override?: MeetingClientOverride | null } = {}
): Promise<MeetingClient[]> => {
  const manual = manualMeetingClients(options.override, context);
  if (manual) return manual;
  const byEntries = resolveEntryClients(job, entries, context, readyConfidence);
  if (byEntries.length > 0 || context.clients.length === 0) return byEntries;
  const summaryText = options.content?.summaryText ? await options.content.summaryText() : "";
  let matched = summaryText ? matchClientsInText(context, summaryText) : [];
  if (matched.length === 0 && options.content?.transcriptText) {
    const transcriptText = await options.content.transcriptText();
    if (transcriptText) matched = matchClientsInText(context, transcriptText);
  }
  return matched.length === 1 ? [{ clientCode: matched[0]!.code, source: "content-match", confidence: CONTENT_MATCH_CONFIDENCE }] : [];
};
