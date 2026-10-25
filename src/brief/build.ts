import { type ListedAction, knownPersonIds, latestFactsPerMedia } from "../actions/list";
import type { ChatCitation } from "../assistant/types";
import { type ClientOverridesFile, effectiveClients } from "../clients/overrides";
import { matchClientsInText, normalizeClientText } from "../clients/resolve";
import { sanitizeKnowledgeText } from "../knowledge/context";
import type { JobFacts, LibraryIndexReader } from "../library-index/types";
import { PeopleDirectory, SHA256_PATTERN, factParticipants, isIsoTime, isRecord } from "../people/store";
import type { TimesheetContext } from "../timesheet/types";

/**
 * What to remember before a meeting, from local history only: earlier meetings of the same
 * series, with the same people, for the same client or with the same title, plus their open
 * actions and recent decisions. Nothing relevant → null: no filler.
 */

export type BriefEvent = {
  title: string;
  startAt: string;
  endAt: string;
  attendees: Array<{ name: string; self: boolean }>;
  recurring: boolean;
  seriesIdHash?: string;
  eventIdHash?: string;
};

export type BriefMatch = "series" | "attendees" | "client" | "title";

export type PreMeetingBrief = {
  eventIdHash?: string;
  title: string;
  startAt: string;
  endAt: string;
  matchedBy: BriefMatch[];
  people: Array<{ personId?: string; name: string }>;
  clientCodes: string[];
  /** Newest first. */
  recentMeetings: Array<{ jobId: string; date: string; title: string; matchedBy: BriefMatch[] }>;
  openActions: Array<{ actionId: string; mediaSha256: string; jobId: string; text: string; ownerText?: string; dueDate?: string }>;
  recentDecisions: Array<{ jobId: string; text: string; citation?: ChatCitation }>;
  /** Filled by the caller from meeting overrides ("record" / "skip" for this event). */
  recordDecision?: { choice: "record" | "skip"; decidedAt: string };
};

export type BriefSources = {
  people?: PeopleDirectory;
  /** Listed actions (listActions); open, current ones of matched meetings are shown. */
  actions?: readonly ListedAction[];
  /** Client aliases matched in the event title; without it, client names from the index are used. */
  catalog?: TimesheetContext;
  overrides?: ClientOverridesFile;
  selfNames?: readonly string[];
};

export const BRIEF_LIMITS = { recentMeetings: 3, openActions: 5, recentDecisions: 3, people: 20, clientCodes: 5, lineLength: 120 } as const;
export const BRIEF_ERRORS = { invalidEvent: "Evento de calendário inválido." } as const;
export const BRIEF_KNOWN_ERRORS: readonly string[] = Object.values(BRIEF_ERRORS);

const MATCH_ORDER: readonly BriefMatch[] = ["series", "attendees", "client", "title"];

/** Titles that say nothing about which meeting it is. */
const GENERIC_TITLES = new Set([
  "reuniao", "reunion", "meeting", "call", "chamada", "llamada", "sync", "conversa", "papo", "bate papo", "catch up", "1 1", "one on one",
  "evento", "event", "busy", "ocupado", "ocupada", "sem titulo", "untitled", "sin titulo", "teste", "test"
]);

const titleKey = (value: unknown): string => (typeof value === "string" ? normalizeClientText(value) : "");
const specificTitle = (key: string): boolean => key.length >= 4 && !GENERIC_TITLES.has(key);

const validateEvent = (event: BriefEvent): BriefEvent => {
  if (!isRecord(event) || typeof event.title !== "string" || event.title.length > 2_000 || !isIsoTime(event.startAt) || !isIsoTime(event.endAt) ||
    (event.attendees !== undefined && !Array.isArray(event.attendees))) {
    throw new Error(BRIEF_ERRORS.invalidEvent);
  }
  const hash = (value: unknown): string | undefined => (typeof value === "string" && SHA256_PATTERN.test(value) ? value : undefined);
  const seriesIdHash = hash(event.seriesIdHash);
  const eventIdHash = hash(event.eventIdHash);
  return {
    title: sanitizeKnowledgeText(event.title, 300),
    startAt: new Date(event.startAt).toISOString(),
    endAt: new Date(event.endAt).toISOString(),
    attendees: (event.attendees ?? []).slice(0, 200).filter((attendee) => isRecord(attendee) && typeof attendee.name === "string" && attendee.name.trim() && attendee.name.length <= 200)
      .map((attendee) => ({ name: attendee.name.trim().replace(/\s+/g, " "), self: attendee.self === true })),
    recurring: event.recurring === true,
    ...(seriesIdHash ? { seriesIdHash } : {}),
    ...(eventIdHash ? { eventIdHash } : {})
  };
};

type Candidate = { facts: JobFacts; matchedBy: BriefMatch[]; tier: number; overlap: number };

/** Client codes whose code, name or alias appears in the title. */
const titleClients = (title: string, facts: readonly JobFacts[], catalog?: TimesheetContext): Set<string> => {
  const context: TimesheetContext = catalog ?? {
    version: 1, colleagues: [], taskTypes: [],
    clients: [...new Map(facts.flatMap((item) => item.clients).filter((client) => isRecord(client) && typeof client.code === "string" && typeof client.name === "string")
      .map((client) => [client.code, { code: client.code, name: client.name, aliases: [], responsibleNames: [] }])).values()]
  };
  return new Set(matchClientsInText(context, title).map((client) => client.code));
};

const clip = (text: string, maximum: number): string => (text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text);

export const buildBrief = async (reader: LibraryIndexReader, input: BriefEvent, sources: BriefSources = {}): Promise<PreMeetingBrief | null> => {
  const event = validateEvent(input);
  const directory = sources.people ?? new PeopleDirectory();
  const facts = latestFactsPerMedia(await reader.listFacts());
  const startsAt = Date.parse(event.startAt);
  // A recording of this very event (started a little early) is not "an earlier meeting".
  const earlier = facts.filter((item) => Date.parse(item.date) < startsAt && !(event.eventIdHash && item.calendar?.eventIdHash === event.eventIdHash));

  const selfIds = new Set((sources.selfNames ?? []).map((name) => directory.idForName(name)).filter((id): id is string => !!id));
  for (const attendee of event.attendees) {
    const id = attendee.self ? directory.idForName(attendee.name) : undefined;
    if (id) selfIds.add(id);
  }
  const known = knownPersonIds(facts, directory);
  const people: PreMeetingBrief["people"] = [];
  const eventPeople = new Set<string>();
  for (const attendee of event.attendees) {
    const id = directory.idForName(attendee.name);
    // Hidden people (rooms, bots, shared accounts) say nothing about which meeting this is.
    if (!id || attendee.self || selfIds.has(id) || eventPeople.has(id) || directory.isHidden(id)) continue;
    eventPeople.add(id);
    if (people.length < BRIEF_LIMITS.people) {
      // A person renamed or merged on the People page shows under that name.
      const name = sanitizeKnowledgeText(directory.record(id)?.displayName ?? attendee.name, 80);
      if (name) people.push({ ...(known.has(id) ? { personId: id } : {}), name });
    }
  }

  const eventTitle = titleKey(event.title);
  const codesInTitle = titleClients(event.title, facts, sources.catalog);
  const candidates: Candidate[] = [];
  for (const item of earlier) {
    const matchedBy: BriefMatch[] = [];
    if (event.seriesIdHash && item.calendar?.seriesIdHash === event.seriesIdHash) matchedBy.push("series");
    const participantIds = new Set(factParticipants(item).filter((participant) => !participant.self)
      .map((participant) => directory.idForName(participant.name)).filter((id): id is string => !!id && !selfIds.has(id)));
    const overlap = [...eventPeople].filter((id) => participantIds.has(id)).length;
    if (overlap > 0) matchedBy.push("attendees");
    if (codesInTitle.size > 0 && effectiveClients(item, sources.overrides, sources.catalog).some((client) => codesInTitle.has(client.code))) matchedBy.push("client");
    if (specificTitle(eventTitle) && (titleKey(item.calendar?.title) === eventTitle || titleKey(item.title) === eventTitle)) matchedBy.push("title");
    if (matchedBy.length > 0) candidates.push({ facts: item, matchedBy, tier: MATCH_ORDER.indexOf(matchedBy[0]!), overlap });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.tier - b.tier || b.overlap - a.overlap || b.facts.date.localeCompare(a.facts.date));

  const selected = candidates.slice(0, BRIEF_LIMITS.recentMeetings);
  const recentMeetings = selected
    .map((candidate) => ({ jobId: candidate.facts.jobId, date: candidate.facts.date, title: sanitizeKnowledgeText(candidate.facts.title, 160), matchedBy: candidate.matchedBy }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const recentDecisions: PreMeetingBrief["recentDecisions"] = [];
  for (const candidate of candidates) {
    for (const decision of candidate.facts.decisions) {
      if (recentDecisions.length >= BRIEF_LIMITS.recentDecisions) break;
      const text = isRecord(decision) && typeof decision.text === "string" ? sanitizeKnowledgeText(decision.text, 300) : "";
      if (!text) continue;
      const segmentId = Array.isArray(decision.segmentIds) ? decision.segmentIds.find((id) => typeof id === "string" && /^s\d{6}$/.test(id)) : undefined;
      recentDecisions.push({
        jobId: candidate.facts.jobId,
        text,
        ...(segmentId ? { citation: { ref: segmentId, jobId: candidate.facts.jobId, segmentId, title: sanitizeKnowledgeText(candidate.facts.title, 160) } } : {})
      });
    }
    if (recentDecisions.length >= BRIEF_LIMITS.recentDecisions) break;
  }

  // Open actions of the matched meetings first, then those owned by someone invited.
  const rankOfMedia = new Map<string, number>();
  candidates.forEach((candidate, index) => { if (!rankOfMedia.has(candidate.facts.mediaSha256)) rankOfMedia.set(candidate.facts.mediaSha256, index); });
  const open = (sources.actions ?? []).filter((action) => action.status === "open" && action.matchState === "current");
  const fromMeetings = open.filter((action) => rankOfMedia.has(action.mediaSha256))
    .map((action, order) => ({ action, order })).sort((a, b) => rankOfMedia.get(a.action.mediaSha256)! - rankOfMedia.get(b.action.mediaSha256)! || a.order - b.order)
    .map(({ action }) => action);
  const owedByPeople = open.filter((action) => !rankOfMedia.has(action.mediaSha256) && action.ownerPersonIds.some((id) => eventPeople.has(id)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const openActions = [...fromMeetings, ...owedByPeople].slice(0, BRIEF_LIMITS.openActions).map((action) => ({
    actionId: action.actionId,
    mediaSha256: action.mediaSha256,
    jobId: action.jobId,
    text: sanitizeKnowledgeText(action.text, 300),
    ...(action.owner ? { ownerText: sanitizeKnowledgeText(action.owner, 120) } : {}),
    ...(action.dueDate ? { dueDate: sanitizeKnowledgeText(action.dueDate, 60) } : {})
  }));

  const clientCodes = [...new Set([
    ...codesInTitle,
    ...selected.flatMap((candidate) => effectiveClients(candidate.facts, sources.overrides, sources.catalog).map((client) => client.code))
  ])].slice(0, BRIEF_LIMITS.clientCodes);

  return {
    ...(event.eventIdHash ? { eventIdHash: event.eventIdHash } : {}),
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    matchedBy: MATCH_ORDER.filter((match) => selected.some((candidate) => candidate.matchedBy.includes(match))),
    people,
    clientCodes,
    recentMeetings,
    openActions,
    recentDecisions
  };
};

export type BriefLanguage = "pt-BR" | "en" | "es";

const LINE_LABELS: Record<BriefLanguage, { last: string; actions: (count: number) => string; decision: string }> = {
  "pt-BR": { last: "Última reunião", actions: (count) => (count === 1 ? "1 ação aberta" : `${count} ações abertas`), decision: "Decisão" },
  en: { last: "Last meeting", actions: (count) => (count === 1 ? "1 open action" : `${count} open actions`), decision: "Decision" },
  es: { last: "Última reunión", actions: (count) => (count === 1 ? "1 acción abierta" : `${count} acciones abiertas`), decision: "Decisión" }
};

const shortDate = (iso: string, language: BriefLanguage, timeZone?: string): string => {
  try {
    return new Intl.DateTimeFormat(language, { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

/** At most three short lines for a notification body: last meeting, open actions, a decision. */
export const briefLines = (brief: PreMeetingBrief, language: string, options: { timeZone?: string } = {}): string[] => {
  const lang: BriefLanguage = language === "en" || language === "es" ? language : "pt-BR";
  const labels = LINE_LABELS[lang];
  const lines: string[] = [];
  const last = brief.recentMeetings[0];
  if (last) lines.push(`${labels.last}: ${shortDate(last.date, lang, options.timeZone)} · ${last.title}`);
  const action = brief.openActions[0];
  if (action) lines.push(`${labels.actions(brief.openActions.length)}: ${action.text}${action.ownerText ? ` (${action.ownerText})` : ""}`);
  const decision = brief.recentDecisions[0];
  if (decision) lines.push(`${labels.decision}: ${decision.text}`);
  return lines.slice(0, 3).map((line) => clip(sanitizeKnowledgeText(line, 400), BRIEF_LIMITS.lineLength));
};
