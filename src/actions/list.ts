import { type ClientOverridesFile, effectiveClients } from "../clients/overrides";
import { sanitizeKnowledgeText } from "../knowledge/context";
import type { JobFacts, LibraryIndexReader } from "../library-index/types";
import { PeopleDirectory, SHA256_PATTERN, UUID_PATTERN, factParticipants, isIsoTime, isRecord, personKey } from "../people/store";
import type { TimesheetContext } from "../timesheet/types";
import { ACTIONS_ERRORS, ActionsStore, type ActionOrigin, type ActionStatus, type CurrentAction, isActionStatus } from "./store";

/** One action as pages show it: the current summary's wording, with its saved status. */
export type ListedAction = {
  actionId: string;
  mediaSha256: string;
  jobId: string;
  title: string;
  date: string;
  text: string;
  owner: string;
  dueDate: string;
  status: ActionStatus;
  origin: ActionOrigin;
  segmentIds: string[];
  start?: number;
  /** "orphaned": the action no longer appears in the current summary; its status is kept. */
  matchState: "current" | "orphaned";
  /** rev of the recording's action file, for setActionStatus(…, expectedRev). */
  rev: number;
  /** People the owner text names (stored ids or "name:<key>"). */
  ownerPersonIds: string[];
  clientCodes: string[];
};

export type ListActionsOptions = {
  status?: ActionStatus;
  personId?: string;
  clientCode?: string;
  jobId?: string;
  /** Default true: actions dropped by a later summary still show, flagged. */
  includeOrphaned?: boolean;
};

export type ListActionsDeps = {
  store?: ActionsStore;
  people?: PeopleDirectory;
  overrides?: ClientOverridesFile;
  catalog?: TimesheetContext;
  /** Start times of cited segments, when the caller can read them. */
  segmentStarts?: (jobId: string, segmentIds: string[]) => Promise<Record<string, number>>;
  /** False for read-only callers (the reminder service): nothing is written. */
  persist?: boolean;
  now?: () => Date;
};

const SEGMENT_ID = /^s\d{6}$/;

/** Facts with the shape this module relies on; anything else is skipped rather than trusted. */
export const usableFacts = (facts: readonly JobFacts[]): JobFacts[] =>
  facts.filter((item) =>
    isRecord(item) && typeof item.jobId === "string" && UUID_PATTERN.test(item.jobId) && typeof item.mediaSha256 === "string" &&
    SHA256_PATTERN.test(item.mediaSha256) && typeof item.title === "string" && isIsoTime(item.date) && Array.isArray(item.speakers) &&
    Array.isArray(item.attendees) && Array.isArray(item.clients) && Array.isArray(item.decisions) && Array.isArray(item.actions) &&
    Array.isArray(item.topics) && typeof item.overview === "string");

/** One facts entry per recorded media: the newest job (reader order is newest first); reprocessed copies are not counted twice. */
export const latestFactsPerMedia = (facts: readonly JobFacts[]): JobFacts[] => {
  const seen = new Set<string>();
  return usableFacts(facts).filter((item) => {
    if (seen.has(item.mediaSha256)) return false;
    seen.add(item.mediaSha256);
    return true;
  });
};

const OWNER_SEPARATOR = /\s*(?:[,;/&+]|\s(?:e|and|y)\s)\s*/iu;

/** The whole owner text, then each name in it ("Ana e Bruno", "Ana, Bruno (financeiro)"). */
export const ownerNameCandidates = (owner: string): string[] => {
  const cleaned = owner.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 500) return [];
  const parts = cleaned.split(OWNER_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  return [...new Set([cleaned, ...parts])].slice(0, 12);
};

type Participant = { id: string; key: string };

/** Everyone who appears in a recording, with every name they are known by (for first-name matching). */
const participantsOf = (facts: JobFacts | undefined, directory: PeopleDirectory): Participant[] => {
  if (!facts) return [];
  const result: Participant[] = [];
  for (const participant of factParticipants(facts)) {
    const id = directory.idForName(participant.name);
    if (!id) continue;
    result.push({ id, key: personKey(participant.name) });
    if (!id.startsWith("name:")) {
      for (const member of directory.members(id)) {
        for (const name of [member.displayName, ...member.aliases]) result.push({ id, key: personKey(name) });
      }
    }
  }
  return result;
};

/**
 * People an owner text refers to: a stored person or someone seen in the library with that
 * name; a lone first name ("Ana") matches when exactly one person of that meeting has it.
 */
export const resolveOwnerIds = (owner: string, directory: PeopleDirectory, participants: readonly Participant[], known: ReadonlySet<string>): string[] => {
  const ids: string[] = [];
  for (const [index, name] of ownerNameCandidates(owner).entries()) {
    const key = personKey(name);
    if (!key) continue;
    let id = directory.claimantOf(key) ?? (known.has(`name:${key}`) ? `name:${key}` : undefined);
    if (!id && !key.includes(" ")) {
      const firstNames = [...new Set(participants.filter((participant) => participant.key.split(" ")[0] === key).map((participant) => participant.id))];
      if (firstNames.length === 1) id = firstNames[0];
    }
    if (!id) continue;
    if (index === 0) return [id];
    ids.push(id);
  }
  return [...new Set(ids)];
};

/** Ids of everyone seen in any recording plus every stored person. */
export const knownPersonIds = (facts: readonly JobFacts[], directory: PeopleDirectory): Set<string> => {
  const known = new Set(directory.roots().map((person) => person.id));
  for (const item of facts) {
    for (const participant of factParticipants(item)) {
      const id = directory.idForName(participant.name);
      if (id) known.add(id);
    }
  }
  return known;
};

const toCurrentAction = (facts: JobFacts, action: unknown, position: number): CurrentAction | undefined => {
  if (!isRecord(action) || typeof action.text !== "string") return undefined;
  const text = sanitizeKnowledgeText(action.text, 1_000);
  if (!text) return undefined;
  return {
    key: `${facts.jobId}#${Number.isSafeInteger(action.index) ? action.index : position}#${position}`,
    text,
    owner: typeof action.owner === "string" ? sanitizeKnowledgeText(action.owner, 500) : "",
    dueDate: typeof action.dueDate === "string" ? sanitizeKnowledgeText(action.dueDate, 100) : "",
    segmentIds: Array.isArray(action.segmentIds)
      ? [...new Set(action.segmentIds.filter((id): id is string => typeof id === "string" && SEGMENT_ID.test(id)))].slice(0, 50)
      : [],
    origin: action.origin === "note" ? "note" : "model"
  };
};

const validateOptions = (options: ListActionsOptions): void => {
  if (!isRecord(options) ||
    (options.status !== undefined && !isActionStatus(options.status)) ||
    (options.jobId !== undefined && (typeof options.jobId !== "string" || !UUID_PATTERN.test(options.jobId))) ||
    (options.personId !== undefined && (typeof options.personId !== "string" || options.personId.length > 210)) ||
    (options.clientCode !== undefined && (typeof options.clientCode !== "string" || options.clientCode.length > 20)) ||
    (options.includeOrphaned !== undefined && typeof options.includeOrphaned !== "boolean")) {
    throw new Error(ACTIONS_ERRORS.invalidFilter);
  }
};

/** listActions over facts already loaded (people and client pages reuse one listing). */
export const listActionsForFacts = async (facts: readonly JobFacts[], options: ListActionsOptions = {}, deps: ListActionsDeps = {}): Promise<ListedAction[]> => {
  validateOptions(options);
  const usable = usableFacts(facts);
  const store = deps.store ?? new ActionsStore();
  const directory = deps.people ?? new PeopleDirectory();
  const now = (deps.now?.() ?? new Date()).toISOString();
  const byJob = new Map(usable.map((item) => [item.jobId, item]));
  const groups = new Map<string, JobFacts[]>();
  for (const item of usable) groups.set(item.mediaSha256, [...(groups.get(item.mediaSha256) || []), item]);

  let mediaFilter: string | undefined;
  if (options.jobId !== undefined) {
    const target = byJob.get(options.jobId);
    if (!target) return [];
    mediaFilter = target.mediaSha256;
  }
  let personFilter: string | undefined;
  if (options.personId !== undefined) {
    const resolved = directory.resolveId(options.personId);
    if (!resolved) return [];
    personFilter = resolved.id;
  }

  const known = knownPersonIds(usable, directory);
  const participants = new Map<string, Participant[]>();
  const participantsFor = (jobId: string): Participant[] => {
    if (!participants.has(jobId)) participants.set(jobId, participantsOf(byJob.get(jobId), directory));
    return participants.get(jobId)!;
  };
  const listed: Array<{ action: ListedAction; sort: [string, number, number, number] }> = [];

  let groupOrder = 0;
  for (const [mediaSha256, group] of groups) {
    groupOrder++;
    if (mediaFilter && mediaSha256 !== mediaFilter) continue;
    const current = group[0]!;
    const actions = current.actions.map((action, position) => toCurrentAction(current, action, position)).filter((action): action is CurrentAction => !!action);
    const { file, matches } = await store.reconcile(mediaSha256, {
      jobId: current.jobId,
      jobIds: group.map((item) => item.jobId),
      transcriptArtifactSha256: typeof current.transcriptArtifactSha256 === "string" && SHA256_PATTERN.test(current.transcriptArtifactSha256) ? current.transcriptArtifactSha256 : undefined,
      revision: Number.isSafeInteger(current.revision) && current.revision >= 0 ? current.revision : 0,
      actions,
      now
    }, { persist: deps.persist });
    const positions = new Map(actions.map((action, position) => [action.key, position]));
    const currentById = new Map<string, { action: CurrentAction; position: number }>();
    for (const [key, id] of matches) {
      const position = positions.get(key);
      if (position !== undefined) currentById.set(id, { action: actions[position]!, position });
    }

    for (const item of file.items) {
      const match = item.origin !== "user" && item.matchState === "current" ? currentById.get(item.id) : undefined;
      const orphaned = item.origin !== "user" && !match;
      // An orphan points at the recording it came from while that recording is still indexed.
      const jobFacts = (orphaned && item.anchor && byJob.get(item.anchor.jobId)) || current;
      const owner = match ? match.action.owner : item.ownerText ?? "";
      const action: ListedAction = {
        actionId: item.id,
        mediaSha256,
        jobId: jobFacts.jobId,
        title: sanitizeKnowledgeText(jobFacts.title, 160),
        date: jobFacts.date,
        text: match ? match.action.text : sanitizeKnowledgeText(item.text, 1_000),
        owner: sanitizeKnowledgeText(owner, 500),
        dueDate: match ? match.action.dueDate : item.dueDate ?? "",
        status: item.status,
        origin: item.origin,
        segmentIds: match ? match.action.segmentIds : item.anchor?.segmentIds ?? [],
        matchState: orphaned ? "orphaned" : "current",
        rev: file.rev,
        ownerPersonIds: owner ? resolveOwnerIds(owner, directory, participantsFor(jobFacts.jobId), known) : [],
        clientCodes: effectiveClients(jobFacts, deps.overrides, deps.catalog).map((client) => client.code)
      };
      const rank = match ? 0 : item.origin === "user" ? 1 : 2;
      const position = match ? match.position : rank === 1 ? Date.parse(item.createdAt) : -Date.parse(item.updatedAt);
      listed.push({ action, sort: [current.date, groupOrder, rank, position] });
    }
  }

  const includeOrphaned = options.includeOrphaned !== false;
  const result = listed
    .filter(({ action }) =>
      (options.status === undefined || action.status === options.status) &&
      (includeOrphaned || action.matchState === "current") &&
      (personFilter === undefined || action.ownerPersonIds.includes(personFilter)) &&
      (options.clientCode === undefined || action.clientCodes.includes(options.clientCode)))
    .sort((a, b) => b.sort[0].localeCompare(a.sort[0]) || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2] || a.sort[3] - b.sort[3])
    .map(({ action }) => action);

  if (deps.segmentStarts) {
    const wanted = new Map<string, Set<string>>();
    for (const action of result) {
      if (action.segmentIds[0]) wanted.set(action.jobId, (wanted.get(action.jobId) || new Set()).add(action.segmentIds[0]));
    }
    for (const [jobId, ids] of wanted) {
      const starts = await deps.segmentStarts(jobId, [...ids]).catch(() => ({} as Record<string, number>));
      for (const action of result) {
        const start = action.jobId === jobId && action.segmentIds[0] ? starts[action.segmentIds[0]] : undefined;
        if (typeof start === "number" && Number.isFinite(start) && start >= 0) action.start = start;
      }
    }
  }
  return result;
};

/**
 * Actions across the library (or one recording, person or client), merged with their saved
 * state. The state of each recording is re-anchored and saved as a side effect, unless
 * `deps.persist` is false.
 */
export const listActions = async (reader: LibraryIndexReader, options: ListActionsOptions = {}, deps: ListActionsDeps = {}): Promise<ListedAction[]> => {
  validateOptions(options);
  return listActionsForFacts(await reader.listFacts(), options, deps);
};
