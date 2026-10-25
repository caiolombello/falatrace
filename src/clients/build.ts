import { type ListActionsDeps, type ListedAction, latestFactsPerMedia, listActionsForFacts } from "../actions/list";
import type { ActionsStore } from "../actions/store";
import type { JobRecord } from "../jobs/types";
import { sanitizeKnowledgeText } from "../knowledge/context";
import type { FactClient, JobFacts, LibraryIndexReader } from "../library-index/types";
import { PeopleDirectory, factParticipants, personKey } from "../people/store";
import type { TimeEntry, TimesheetContext } from "../timesheet/types";
import { type ClientOverridesFile, effectiveClients, overrideFor } from "./overrides";
import { type MeetingClientSource, indexTimeEntries, resolveMeetingClients } from "./resolve";

/** Clients pages: the catalog joined with the recordings assigned to each client. */

export type ClientMeeting = { jobId: string; title: string; date: string; source: MeetingClientSource; confidence: number };

export type ClientSummary = {
  code: string;
  name: string;
  aliases: string[];
  responsibleNames: string[];
  /** Newest first, at most CLIENT_BUILD_LIMITS.meetingsPerClient. */
  meetings: ClientMeeting[];
  meetingCount: number;
  lastMeetingAt: string | null;
  openActions: number;
};

export type ClientDetail = ClientSummary & {
  recentDecisions: Array<{ jobId: string; title: string; date: string; text: string; segmentIds: string[] }>;
  openActionItems: ListedAction[];
  people: Array<{ id: string; name: string; meetings: number }>;
};

export type BuildClientsOptions = {
  overrides?: ClientOverridesFile;
  /** Actions already listed; when omitted they are listed with `actionsStore`; false skips the counts. */
  actions?: ListedAction[] | false;
  actionsStore?: ActionsStore;
  people?: PeopleDirectory;
  actionDeps?: Omit<ListActionsDeps, "store" | "people" | "overrides" | "catalog">;
};

export const CLIENTS_ERRORS = { notFound: "Cliente não encontrado." } as const;
export const CLIENTS_KNOWN_ERRORS: readonly string[] = Object.values(CLIENTS_ERRORS);
export const CLIENT_BUILD_LIMITS = { meetingsPerClient: 200, recentDecisions: 10, openActionItems: 50, people: 30 } as const;

type Assigned = { client: FactClient; facts: JobFacts };

const assignments = (facts: readonly JobFacts[], catalog: TimesheetContext, overrides?: ClientOverridesFile): Map<string, Assigned[]> => {
  const byCode = new Map<string, Assigned[]>();
  for (const item of facts) {
    for (const client of effectiveClients(item, overrides, catalog)) byCode.set(client.code, [...(byCode.get(client.code) || []), { client, facts: item }]);
  }
  for (const list of byCode.values()) list.sort((a, b) => b.facts.date.localeCompare(a.facts.date) || a.facts.jobId.localeCompare(b.facts.jobId));
  return byCode;
};

const summarize = (client: TimesheetContext["clients"][number], assigned: Assigned[], actions: readonly ListedAction[]): ClientSummary => ({
  code: client.code,
  name: client.name,
  aliases: [...client.aliases],
  responsibleNames: [...client.responsibleNames],
  meetings: assigned.slice(0, CLIENT_BUILD_LIMITS.meetingsPerClient).map(({ client: assignment, facts }) => ({
    jobId: facts.jobId,
    title: sanitizeKnowledgeText(facts.title, 160),
    date: facts.date,
    source: assignment.source,
    confidence: assignment.confidence
  })),
  meetingCount: assigned.length,
  lastMeetingAt: assigned[0]?.facts.date ?? null,
  openActions: actions.filter((action) => action.status === "open" && action.matchState === "current" && action.clientCodes.includes(client.code)).length
});

const load = async (reader: LibraryIndexReader, catalog: TimesheetContext, options: BuildClientsOptions) => {
  const allFacts = await reader.listFacts();
  const facts = latestFactsPerMedia(allFacts);
  const actions = options.actions === false
    ? []
    : options.actions ?? await listActionsForFacts(allFacts, {}, {
      ...options.actionDeps, store: options.actionsStore, people: options.people, overrides: options.overrides, catalog
    });
  return { facts, actions, byCode: assignments(facts, catalog, options.overrides) };
};

/**
 * Every catalog client with its recordings, most recently met first. An invalid catalog is
 * passed in as an empty one (readClientCatalog), so the page shows no clients instead of failing.
 */
export const buildClients = async (reader: LibraryIndexReader, catalog: TimesheetContext, options: BuildClientsOptions = {}): Promise<ClientSummary[]> => {
  const { actions, byCode } = await load(reader, catalog, options);
  return catalog.clients
    .map((client) => summarize(client, byCode.get(client.code) ?? [], actions))
    .sort((a, b) => (b.lastMeetingAt ?? "").localeCompare(a.lastMeetingAt ?? "") || a.name.localeCompare(b.name, "pt-BR"));
};

export const clientDetail = async (reader: LibraryIndexReader, catalog: TimesheetContext, code: string, options: BuildClientsOptions = {}): Promise<ClientDetail> => {
  const client = catalog.clients.find((candidate) => candidate.code === code);
  if (!client) throw new Error(CLIENTS_ERRORS.notFound);
  const { actions, byCode } = await load(reader, catalog, options);
  const assigned = byCode.get(code) ?? [];
  const directory = options.people ?? new PeopleDirectory();
  const recentDecisions: ClientDetail["recentDecisions"] = [];
  const people = new Map<string, { id: string; names: Map<string, number>; meetings: Set<string> }>();
  for (const { facts } of assigned) {
    for (const decision of facts.decisions) {
      if (recentDecisions.length >= CLIENT_BUILD_LIMITS.recentDecisions) break;
      const text = typeof decision?.text === "string" ? sanitizeKnowledgeText(decision.text, 500) : "";
      if (text) {
        recentDecisions.push({
          jobId: facts.jobId, title: sanitizeKnowledgeText(facts.title, 160), date: facts.date, text,
          segmentIds: Array.isArray(decision.segmentIds) ? decision.segmentIds.filter((segment) => typeof segment === "string").slice(0, 20) : []
        });
      }
    }
    for (const participant of factParticipants(facts)) {
      if (participant.self) continue;
      const id = directory.idForName(participant.name);
      if (!id) continue;
      const person = people.get(id) ?? { id, names: new Map<string, number>(), meetings: new Set<string>() };
      person.names.set(participant.name, (person.names.get(participant.name) ?? 0) + 1);
      person.meetings.add(facts.jobId);
      people.set(id, person);
    }
  }
  return {
    ...summarize(client, assigned, actions),
    recentDecisions,
    openActionItems: actions
      .filter((action) => action.status === "open" && action.matchState === "current" && action.clientCodes.includes(code))
      .slice(0, CLIENT_BUILD_LIMITS.openActionItems),
    people: [...people.values()]
      .filter((person) => !directory.isHidden(person.id))
      .map((person) => {
        const stored = person.id.startsWith("name:") ? undefined : directory.record(person.id);
        const spoken = [...person.names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? person.id;
        return { id: person.id, name: sanitizeKnowledgeText(stored?.displayName ?? spoken, 80), meetings: person.meetings.size };
      })
      .sort((a, b) => b.meetings - a.meetings || personKey(a.name).localeCompare(personKey(b.name)))
      .slice(0, CLIENT_BUILD_LIMITS.people)
  };
};

/** Summary-like text of indexed facts, for content matching while the index is being built. */
export const factsSearchText = (facts: Pick<JobFacts, "title" | "overview" | "topics" | "decisions" | "actions">): string =>
  [
    facts.title,
    facts.overview,
    ...(facts.topics || []),
    ...(facts.decisions || []).map((decision) => decision.text),
    ...(facts.actions || []).flatMap((action) => [action.text, action.owner, action.dueDate])
  ].filter((value) => typeof value === "string" && value).join("\n");

export type IndexClientResolverDeps = {
  readyConfidence: number;
  /** For example `() => readClientCatalog(config.timesheet.contextPath).then((read) => read.context)`. */
  loadCatalog: () => Promise<TimesheetContext>;
  listEntries: () => Promise<TimeEntry[]>;
  readOverrides?: () => Promise<ClientOverridesFile>;
  /** Reviewed transcript text, for recordings whose summary names no client. */
  transcriptText?: (job: JobRecord) => Promise<string>;
  /** How long the catalog, time entries and overrides are reused (default 5 s). */
  cacheMs?: number;
  now?: () => number;
};

type ResolverInputs = { catalog: TimesheetContext; entries: ReturnType<typeof indexTimeEntries>; overrides?: ClientOverridesFile };

const EMPTY_CATALOG: TimesheetContext = { version: 1, colleagues: [], clients: [], taskTypes: [] };

/**
 * `deps.clients` for the library index: resolveMeetingClients with overrides, the catalog and
 * time entries, reloaded at most every `cacheMs` so one refresh reads them once. A catalog or
 * entry list that cannot be read gives no clients rather than failing the index.
 */
export const createIndexClientResolver = (deps: IndexClientResolverDeps) => {
  const cacheMs = deps.cacheMs ?? 5_000;
  const now = deps.now ?? Date.now;
  let cached: { at: number; inputs: Promise<ResolverInputs> } | undefined;
  const load = (): Promise<ResolverInputs> =>
    Promise.all([
      deps.loadCatalog().catch(() => EMPTY_CATALOG),
      deps.listEntries().catch(() => [] as TimeEntry[]),
      deps.readOverrides ? deps.readOverrides().catch(() => undefined) : Promise.resolve(undefined)
    ]).then(([catalog, entries, overrides]) => ({ catalog, entries: indexTimeEntries(entries), ...(overrides ? { overrides } : {}) }));
  return async (job: JobRecord, facts: Pick<JobFacts, "mediaSha256" | "title" | "overview" | "topics" | "decisions" | "actions">): Promise<FactClient[]> => {
    const at = now();
    if (!cached || at - cached.at >= cacheMs || at < cached.at) cached = { at, inputs: load() };
    const { catalog, entries, overrides } = await cached.inputs;
    const transcriptText = deps.transcriptText;
    const resolved = await resolveMeetingClients(job, entries.forJob(job), catalog, deps.readyConfidence, {
      override: overrideFor(overrides, job.id, facts.mediaSha256),
      content: {
        summaryText: () => factsSearchText(facts),
        ...(transcriptText ? { transcriptText: () => transcriptText(job).catch(() => "") } : {})
      }
    });
    const names = new Map(catalog.clients.map((client) => [client.code, client.name]));
    return resolved.map((client) => ({
      code: client.clientCode,
      name: names.get(client.clientCode) ?? client.clientCode,
      source: client.source,
      confidence: client.confidence
    }));
  };
};
