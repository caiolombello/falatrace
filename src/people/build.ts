import { type ListActionsDeps, type ListedAction, latestFactsPerMedia, listActionsForFacts } from "../actions/list";
import type { ActionsStore } from "../actions/store";
import { sanitizeKnowledgeText } from "../knowledge/context";
import type { JobFacts, LibraryIndexReader } from "../library-index/types";
import {
  GENERIC_SPEAKER_LABEL,
  PEOPLE_ERRORS,
  PeopleDirectory,
  type PeopleFile,
  type StoredPerson,
  UUID_PATTERN,
  factParticipants,
  isRecord,
  personKey
} from "./store";

/**
 * People pages: everyone named in the library (confirmed speaker labels, calendar attendees,
 * known voices), grouped by name identity and by the manual corrections in the people store.
 * Derived on demand from index facts; nothing here is a source of truth.
 */

export type PersonMeeting = { jobId: string; title: string; date: string; role: "speaker" | "attendee" };

export type Person = {
  /** Stored id, or "name:<key>" for a name nobody edited yet. */
  id: string;
  name: string;
  aliases: string[];
  /** Newest first, at most PEOPLE_BUILD_LIMITS.meetingsPerPerson. */
  meetings: PersonMeeting[];
  meetingCount: number;
  lastMeetingAt: string | null;
  openActions: number;
  /** The person using FalaTrace (self attendee in the calendar, or one of `selfNames`). */
  self: boolean;
  hidden: boolean;
  /** Voice profile with the same name, for "forget this voice". */
  voicePersonId?: string;
};

export type PersonDecision = { jobId: string; title: string; date: string; text: string; segmentIds: string[] };

export type PersonDetail = Person & {
  recentDecisions: PersonDecision[];
  openActionItems: ListedAction[];
  /** Records merged into this person, for undoing a merge. */
  mergedPeople: Array<{ id: string; name: string }>;
};

export type VoicePeopleSource = () => Promise<Array<{ id: string; name: string }>>;

export type BuildPeopleOptions = {
  /** Usually `listVoicePeople` from src/speakers/voices.ts (only when voice recognition is on). */
  listVoicePeople?: VoicePeopleSource;
  /** Names that mean "me", e.g. timesheet ownerName or the account's full name. */
  selfNames?: string[];
  includeHidden?: boolean;
  /** Actions already listed; when omitted they are listed with `actionsStore`; false skips the counts. */
  actions?: ListedAction[] | false;
  actionsStore?: ActionsStore;
  actionDeps?: Omit<ListActionsDeps, "store" | "people">;
};

export const PEOPLE_BUILD_LIMITS = { meetingsPerPerson: 200, recentDecisions: 10, openActionItems: 50, voices: 2_000 } as const;

type Accumulated = {
  id: string;
  stored?: StoredPerson;
  spellings: Map<string, { count: number; lastAt: string }>;
  meetings: Map<string, PersonMeeting>;
  self: boolean;
  voicePersonId?: string;
};

const cleanName = (value: string): string => sanitizeKnowledgeText(value, 80);

const collect = (facts: readonly JobFacts[], directory: PeopleDirectory, voices: Array<{ id: string; name: string }>, selfNames: readonly string[]): Map<string, Accumulated> => {
  const people = new Map<string, Accumulated>();
  const entry = (id: string): Accumulated => {
    let person = people.get(id);
    if (!person) {
      const stored = id.startsWith("name:") ? undefined : directory.record(id);
      person = { id, ...(stored ? { stored } : {}), spellings: new Map(), meetings: new Map(), self: false };
      people.set(id, person);
    }
    return person;
  };
  for (const item of facts) {
    for (const participant of factParticipants(item)) {
      const id = directory.idForName(participant.name);
      if (!id) continue;
      const person = entry(id);
      const spelling = person.spellings.get(participant.name);
      person.spellings.set(participant.name, { count: (spelling?.count ?? 0) + 1, lastAt: spelling && spelling.lastAt > item.date ? spelling.lastAt : item.date });
      const previous = person.meetings.get(item.jobId);
      if (!previous || (previous.role === "attendee" && participant.role === "speaker")) {
        person.meetings.set(item.jobId, { jobId: item.jobId, title: sanitizeKnowledgeText(item.title, 160), date: item.date, role: participant.role });
      }
      if (participant.self) person.self = true;
    }
  }
  for (const voice of voices.slice(0, PEOPLE_BUILD_LIMITS.voices)) {
    if (!isRecord(voice) || typeof voice.name !== "string" || typeof voice.id !== "string" || !UUID_PATTERN.test(voice.id)) continue;
    const name = voice.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > 200 || GENERIC_SPEAKER_LABEL.test(name)) continue;
    const id = directory.idForName(name);
    if (!id) continue;
    const person = entry(id);
    person.voicePersonId ??= voice.id;
    if (!person.spellings.has(name)) person.spellings.set(name, { count: 0, lastAt: "" });
  }
  // People someone created or renamed stay listed even without meetings.
  for (const stored of directory.roots()) entry(stored.id);
  for (const name of selfNames) {
    const id = typeof name === "string" ? directory.idForName(name) : undefined;
    const person = id ? people.get(id) : undefined;
    if (person) person.self = true;
  }
  return people;
};

const displayName = (person: Accumulated): string => {
  if (person.stored) return cleanName(person.stored.displayName) || person.stored.displayName;
  let best: [string, { count: number; lastAt: string }] | undefined;
  for (const spelling of person.spellings) {
    if (!best || spelling[1].count > best[1].count || (spelling[1].count === best[1].count && spelling[1].lastAt > best[1].lastAt)) best = spelling;
  }
  return cleanName(best?.[0] ?? person.id.slice(5)) || person.id.slice(5);
};

const aliasesOf = (person: Accumulated, directory: PeopleDirectory, name: string): string[] => {
  if (!person.stored) return [];
  const seen = new Set([personKey(name)]);
  const aliases: string[] = [];
  // The record's own names first, then those of the records merged into it.
  const members = directory.members(person.id).sort((a, b) => Number(b.id === person.id) - Number(a.id === person.id));
  for (const member of members) {
    for (const alias of [member.displayName, ...member.aliases]) {
      const key = personKey(alias);
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(cleanName(alias) || alias);
    }
  }
  return aliases;
};

const toPerson = (person: Accumulated, directory: PeopleDirectory, openActions: Map<string, number>): Person => {
  const meetings = [...person.meetings.values()].sort((a, b) => b.date.localeCompare(a.date) || a.jobId.localeCompare(b.jobId));
  const name = displayName(person);
  return {
    id: person.id,
    name,
    aliases: aliasesOf(person, directory, name),
    meetings: meetings.slice(0, PEOPLE_BUILD_LIMITS.meetingsPerPerson),
    meetingCount: meetings.length,
    lastMeetingAt: meetings[0]?.date ?? null,
    openActions: openActions.get(person.id) ?? 0,
    self: person.self,
    hidden: person.stored?.hidden === true,
    ...(person.voicePersonId ? { voicePersonId: person.voicePersonId } : {})
  };
};

const openActionCounts = (actions: readonly ListedAction[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const action of actions) {
    if (action.status !== "open" || action.matchState !== "current") continue;
    for (const id of action.ownerPersonIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

type Loaded = { facts: JobFacts[]; directory: PeopleDirectory; people: Map<string, Accumulated>; actions: ListedAction[] };

const load = async (reader: LibraryIndexReader, store: { read(): Promise<PeopleFile> }, options: BuildPeopleOptions): Promise<Loaded> => {
  const [allFacts, file, voices] = await Promise.all([
    reader.listFacts(),
    store.read(),
    // Voice profiles only add names; an unreadable voice store must not hide everyone else.
    options.listVoicePeople ? Promise.resolve().then(options.listVoicePeople).catch(() => []) : Promise.resolve([])
  ]);
  const facts = latestFactsPerMedia(allFacts);
  const directory = new PeopleDirectory(file);
  const actions = options.actions === false
    ? []
    : options.actions ?? await listActionsForFacts(allFacts, {}, { ...options.actionDeps, store: options.actionsStore, people: directory });
  return { facts, directory, people: collect(facts, directory, Array.isArray(voices) ? voices : [], options.selfNames ?? []), actions };
};

const peopleOptions = (value: VoicePeopleSource | BuildPeopleOptions | undefined): BuildPeopleOptions =>
  typeof value === "function" ? { listVoicePeople: value } : value ?? {};

/**
 * Everyone in the library, most recently met first. Hidden people are left out unless asked for.
 * The third argument is the voice-profile source (`() => listVoicePeople()`) or the full options.
 */
export const buildPeople = async (
  reader: LibraryIndexReader,
  store: { read(): Promise<PeopleFile> },
  voicesOrOptions?: VoicePeopleSource | BuildPeopleOptions
): Promise<Person[]> => {
  const options = peopleOptions(voicesOrOptions);
  const { directory, people, actions } = await load(reader, store, options);
  const counts = openActionCounts(actions);
  return [...people.values()]
    .map((person) => toPerson(person, directory, counts))
    .filter((person) => options.includeHidden || !person.hidden)
    .sort((a, b) => (b.lastMeetingAt ?? "").localeCompare(a.lastMeetingAt ?? "") || a.name.localeCompare(b.name, "pt-BR"));
};

/** One person's page: meetings, recent decisions in those meetings, the actions they own. */
export const personDetail = async (
  reader: LibraryIndexReader,
  store: { read(): Promise<PeopleFile> },
  id: string,
  options: BuildPeopleOptions = {}
): Promise<PersonDetail> => {
  const { facts, directory, people, actions } = await load(reader, store, options);
  const ref = directory.resolveId(id);
  if (!ref) throw new Error(typeof id === "string" && (id.startsWith("name:") || /^[0-9a-f-]{36}$/.test(id)) ? PEOPLE_ERRORS.notFound : PEOPLE_ERRORS.invalidId);
  const accumulated = people.get(ref.id);
  if (!accumulated) throw new Error(PEOPLE_ERRORS.notFound);
  const person = toPerson(accumulated, directory, openActionCounts(actions));
  const factsById = new Map(facts.map((item) => [item.jobId, item]));
  const recentDecisions: PersonDecision[] = [];
  for (const meeting of [...accumulated.meetings.values()].sort((a, b) => b.date.localeCompare(a.date))) {
    const item = factsById.get(meeting.jobId);
    for (const decision of item?.decisions ?? []) {
      if (recentDecisions.length >= PEOPLE_BUILD_LIMITS.recentDecisions) break;
      const text = typeof decision?.text === "string" ? sanitizeKnowledgeText(decision.text, 500) : "";
      if (text) {
        recentDecisions.push({
          jobId: meeting.jobId, title: meeting.title, date: meeting.date, text,
          segmentIds: Array.isArray(decision.segmentIds) ? decision.segmentIds.filter((segment) => typeof segment === "string").slice(0, 20) : []
        });
      }
    }
    if (recentDecisions.length >= PEOPLE_BUILD_LIMITS.recentDecisions) break;
  }
  return {
    ...person,
    recentDecisions,
    openActionItems: actions
      .filter((action) => action.status === "open" && action.matchState === "current" && action.ownerPersonIds.includes(ref.id))
      .slice(0, PEOPLE_BUILD_LIMITS.openActionItems),
    mergedPeople: ref.stored
      ? directory.members(ref.id).filter((member) => member.id !== ref.id).map((member) => ({ id: member.id, name: cleanName(member.displayName) || member.displayName }))
      : []
  };
};
