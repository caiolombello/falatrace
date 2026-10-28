import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { sanitizeKnowledgeText } from "../knowledge/context";
import { Bm25Index, foldText } from "../library-index/bm25";
import { type MeetingSegment, type MeetingSource, type NoteInput, readMeetingSource, type SourceDeps } from "../library-index/build";
import type { AssistantIndexReader } from "../library-index/index";
import type { SegmentInfo } from "../library-index/store";
import type { ChunkHit, JobFacts, LibraryIndexReader } from "../library-index/types";
import type { ContextRef } from "./citations";
import type { AssistantScope } from "./types";

/**
 * Builds the excerpts sent with a question. Every line that can be cited carries a marker
 * (`[s000123 12:03 Ana]` for one meeting, `[m2:s000123 12:03 Ana]` across meetings), and the
 * refs map records every marker sent, so citations in the answer can be checked afterwards.
 */

export const RETRIEVAL_ERRORS = {
  scope: "Escopo da pergunta inválido.",
  meetingMissing: "Reunião não encontrada.",
  meetingUnreadable: "Esta reunião ainda não tem uma transcrição utilizável.",
  personMissing: "Pessoa não encontrada.",
  noMeetings: "Nenhuma reunião registrada corresponde a este escopo."
} as const;

export type MeetingContent = {
  jobId: string;
  title: string;
  date: string;
  overview: string;
  topics: string[];
  decisions: string[];
  actions: Array<{ text: string; owner: string; dueDate: string }>;
  segments: MeetingSegment[];
  notes: NoteInput[];
};

export type AssistantReaders = {
  /** Reviewed content of one meeting, sanitized. */
  meeting(jobId: string, signal?: AbortSignal): Promise<MeetingContent>;
  /** Name and aliases of a person (the people module). Without it, only "name:<name>" ids resolve. */
  person?(personId: string): Promise<{ name: string; aliases: string[] } | undefined>;
};

export type ContextPack = {
  text: string;
  refs: Map<string, ContextRef>;
  /** Job ids sent, in label order (m1 is jobs[0]). */
  jobs: string[];
  truncated: boolean;
  meetings: Array<{ jobId: string; title: string; date: string; label?: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;
const PERSON_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|name:\P{Cc}{1,200})$/iu;
const MIN_BUDGET = 4_000;
const MAX_BUDGET = 400_000;
const MAX_LIBRARY_MEETINGS = 12;
const FALLBACK_MEETINGS = 8;
const LIBRARY_HITS = 80;

/** Strict copy of a scope received from the UI or a stored thread. */
export const validateAssistantScope = (value: unknown): AssistantScope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(RETRIEVAL_ERRORS.scope);
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (item.kind === "library" && keys.length === 1) return { kind: "library" };
  if (item.kind === "meeting" && keys.length === 2 && typeof item.jobId === "string" && UUID.test(item.jobId)) return { kind: "meeting", jobId: item.jobId.toLowerCase() };
  if (item.kind === "person" && keys.length === 2 && typeof item.personId === "string" && PERSON_ID.test(item.personId)) return { kind: "person", personId: item.personId };
  if (item.kind === "client" && keys.length === 2 && typeof item.clientCode === "string" && CLIENT_CODE.test(item.clientCode)) return { kind: "client", clientCode: item.clientCode };
  throw new Error(RETRIEVAL_ERRORS.scope);
};

/** Stable text form of a scope, for consent keys and thread lists. */
export const scopeKey = (scope: AssistantScope): string =>
  scope.kind === "library" ? "library" : scope.kind === "meeting" ? `meeting:${scope.jobId}` : scope.kind === "person" ? `person:${scope.personId}` : `client:${scope.clientCode}`;

/** Same normalization as people pages: NFC, trimmed, single spaces, lower case, no accents. */
export const personKey = (name: string): string =>
  foldText(name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")).normalize("NFC");

/** `12:03`, or `1:02:03` past one hour. */
export const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
};

const localDate = (iso: string): string => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso.slice(0, 16);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Calendar periods are a recall hint, never an exclusion: older meetings may contain a deadline in this period. */
const questionPeriod = (question: string, now: Date): { start: Date; end: Date } | undefined => {
  const matches = [...foldText(question).matchAll(/\b(esta semana|nesta semana|this week|semana passada|last week|semana pasada|hoje|today|hoy|ontem|yesterday|ayer)\b/g)];
  if (matches.length !== 1) return undefined;
  const phrase = matches[0]![0];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const week = /semana|week/.test(phrase);
  if (week) start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (/passada|last|pasada/.test(phrase)) start.setDate(start.getDate() - 7);
  if (/ontem|yesterday|ayer/.test(phrase)) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + (week ? 7 : 1));
  return { start, end };
};

/**
 * The excerpt block's tags and their look-alikes (`< /meeting-excerpts>`, `</meeting_excerpts>`,
 * `&lt;/meeting-excerpts&gt;`): text from a meeting, a calendar invitation or an earlier answer
 * must not open or close the block.
 */
export const EXCERPT_TAG = /(?:<|&lt;)\s*\/?\s*meeting[\s_-]*excerpts\s*\/?\s*(?:>|&gt;)/gi;

/** Meeting text as data: no fake markers, no closing of the excerpt block. */
export const excerptText = (value: string, maximum: number): string =>
  sanitizeKnowledgeText(value, maximum + 64)
    .replace(EXCERPT_TAG, " ")
    // "[s000123" or "[m2:s000123" said in the meeting would look like a line header or a citation.
    .replace(/\[(?=\s*(?:m\d{1,4}\s*:\s*)?s\d{6})/gi, "(")
    // Every "[" before "[" (and "]" before "]"), so "[[[" cannot re-form a marker.
    .replace(/\[(?=\[)/g, "[ ")
    .replace(/\](?=\])/g, "] ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maximum);

/** A speaker label inside a line header: no brackets, so it cannot end the header early. */
const speakerText = (value: string): string => excerptText(value, 80).replace(/\[/g, "(").replace(/\]/g, ")");

const segmentLine = (label: string | undefined, segment: { id: string; start: number; speaker?: string }, text: string): string => {
  const speaker = segment.speaker ? speakerText(segment.speaker) : "";
  return `[${label ? `${label}:` : ""}${segment.id} ${clock(segment.start)}${speaker ? ` ${speaker}` : ""}] ${text}`;
};

const lineCost = (lines: ReadonlyArray<string>): number => lines.reduce((total, line) => total + line.length + 1, 0);

/** Default readers over the job store and the validated artifacts. */
export const createAssistantReaders = (deps: { jobs?: Pick<JobStore, "get">; source?: SourceDeps; person?: AssistantReaders["person"] } = {}): AssistantReaders => ({
  async meeting(jobId, signal) {
    signal?.throwIfAborted();
    if (!UUID.test(jobId)) throw new Error(RETRIEVAL_ERRORS.meetingMissing);
    let job: JobRecord;
    try { job = await (deps.jobs ?? new JobStore()).get(jobId); }
    catch { throw new Error(RETRIEVAL_ERRORS.meetingMissing); }
    let source: MeetingSource;
    try { source = await readMeetingSource(job, deps.source); }
    catch { throw new Error(RETRIEVAL_ERRORS.meetingUnreadable); }
    const summary = source.summary;
    return {
      jobId: job.id,
      title: source.title,
      date: source.date,
      overview: summary ? sanitizeKnowledgeText(summary.overview, 4_000) : "",
      topics: (summary?.topics || []).map((topic) => sanitizeKnowledgeText(topic, 300)).filter(Boolean).slice(0, 30),
      decisions: (summary?.decisions || []).map((decision) => sanitizeKnowledgeText(decision, 1_000)).filter(Boolean).slice(0, 50),
      actions: (summary?.actionItems || []).slice(0, 50).map((item) => ({ text: sanitizeKnowledgeText(item.description, 1_000),
        owner: sanitizeKnowledgeText(item.owner, 200), dueDate: sanitizeKnowledgeText(item.dueDate, 100) })).filter((item) => item.text),
      segments: source.segments,
      notes: source.notes
    };
  },
  ...(deps.person ? { person: deps.person } : {})
});

const peopleOf = (facts: JobFacts | undefined): string[] => {
  if (!facts) return [];
  const names = [...facts.speakers.filter((speaker) => speaker.confirmed).map((speaker) => speaker.label), ...facts.attendees.map((attendee) => attendee.name)];
  const seen = new Set<string>();
  return names.filter((name) => { const key = personKey(name); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 10);
};

const summaryLines = (content: Pick<MeetingContent, "overview" | "topics" | "decisions" | "actions">, maximum: number): string[] => {
  const lines: string[] = [];
  if (content.overview) lines.push(`Resumo (gerado por IA, pode conter erros): ${excerptText(content.overview, 2_000)}`);
  if (content.topics.length) lines.push(`Tópicos: ${excerptText(content.topics.join("; "), 600)}`);
  for (const decision of content.decisions.slice(0, 15)) lines.push(`- Decisão: ${excerptText(decision, 400)}`);
  for (const action of content.actions.slice(0, 15)) {
    const details = [action.owner ? `responsável: ${action.owner}` : "", action.dueDate ? `prazo: ${action.dueDate}` : ""].filter(Boolean).join("; ");
    lines.push(`- Ação: ${excerptText(action.text, 400)}${details ? ` (${excerptText(details, 200)})` : ""}`);
  }
  return fitLines(lines, maximum);
};

const noteLines = (notes: ReadonlyArray<NoteInput>, maximum: number): string[] => {
  if (!notes.length) return [];
  const lines = ["Notas que a pessoa usuária escreveu durante a reunião (palavras dela):",
    ...notes.map((note) => `- ${note.offsetSeconds !== null ? `[${clock(note.offsetSeconds)}] ` : ""}${excerptText(note.text, 500)}`)];
  return fitLines(lines, maximum);
};

/** Keeps whole lines, in order, while they fit. */
const fitLines = (lines: ReadonlyArray<string>, maximum: number): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maximum) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
};

const budgetOf = (config: AppConfig): number => {
  const value = config.assistant.maxContextCharacters;
  return Number.isSafeInteger(value) ? Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, value)) : 60_000;
};

/** Segments around the question (±2) in relevance order, then evenly spread windows, until the budget is spent. */
const selectWindows = (segments: ReadonlyArray<MeetingSegment>, question: string, budget: number, render: (index: number) => string): number[] => {
  const selected = new Set<number>();
  let used = 0;
  const addWindow = (center: number): boolean => {
    const fresh: number[] = [];
    for (let index = Math.max(0, center - 2); index <= Math.min(segments.length - 1, center + 2); index++) if (!selected.has(index)) fresh.push(index);
    if (!fresh.length) return true;
    const cost = fresh.reduce((total, index) => total + render(index).length + 1, 0) + 6;
    if (used + cost > budget) return false;
    for (const index of fresh) selected.add(index);
    used += cost;
    return true;
  };
  const bm25 = new Bm25Index(segments.map((segment) => ({ fields: [{ text: segment.text, weight: 1 }, { text: segment.speaker || "", weight: 0.5 }] })));
  let misses = 0;
  for (const hit of bm25.search(question, { limit: 200 })) {
    if (!addWindow(hit.index) && ++misses >= 5) break;
  }
  // Spread the rest over the whole meeting, so a broad question still sees its arc.
  const average = segments.length ? Math.max(1, segments.reduce((total, _segment, index) => total + Math.min(render(index).length, 2_000), 0) / segments.length) : 1;
  const windows = Math.floor((budget - used) / (average * 5 + 6));
  if (windows > 0) {
    const step = segments.length / windows;
    for (let window = 0; window < windows; window++) addWindow(Math.min(segments.length - 1, Math.floor(window * step + step / 2)));
  }
  return [...selected].sort((left, right) => left - right);
};

const meetingPack = async (jobId: string, question: string, index: LibraryIndexReader, readers: AssistantReaders, budget: number, signal?: AbortSignal): Promise<ContextPack> => {
  // Facts only add the title and people; the meeting itself is read directly, so a broken index does not block it.
  const [facts, content] = await Promise.all([index.getFacts(jobId).catch(() => undefined), readers.meeting(jobId, signal)]);
  const title = facts?.title || content.title;
  const date = facts?.date || content.date;
  const people = peopleOf(facts);
  const header = [`Reunião: "${excerptText(title, 160)}" — ${localDate(date)}`, ...(people.length ? [`Pessoas identificadas: ${excerptText(people.join(", "), 400)}`] : [])];
  const refFor = (segment: MeetingSegment): ContextRef => ({ jobId, segmentId: segment.id, start: segment.start, end: segment.end, title });
  const fullLines = content.segments.map((segment) => segmentLine(undefined, segment, excerptText(segment.text, Number.MAX_SAFE_INTEGER)));
  const summary = summaryLines(content, Number.MAX_SAFE_INTEGER);
  const notes = noteLines(content.notes, Number.MAX_SAFE_INTEGER);
  const full = [...header, ...summary, ...notes, "Transcrição completa:", ...fullLines];
  const meetings = [{ jobId, title, date }];
  if (lineCost(full) <= budget) {
    return { text: full.join("\n"), refs: new Map(content.segments.map((segment) => [segment.id, refFor(segment)])), jobs: [jobId], truncated: false, meetings };
  }
  const fixed = [...header, ...summaryLines(content, Math.floor(budget * 0.2)), ...noteLines(content.notes, Math.floor(budget * 0.15)),
    "Trechos da transcrição (seleção; a reunião completa é mais longa):"];
  const lineLimit = Math.max(400, Math.min(4_000, Math.floor(budget / 4)));
  const rendered = new Map<number, string>();
  const render = (position: number): string => {
    let line = rendered.get(position);
    if (line === undefined) {
      const segment = content.segments[position]!;
      const text = excerptText(segment.text, Number.MAX_SAFE_INTEGER);
      line = segmentLine(undefined, segment, text.length > lineLimit ? `${text.slice(0, lineLimit)}…` : text);
      rendered.set(position, line);
    }
    return line;
  };
  const chosen = selectWindows(content.segments, question, Math.max(0, budget - lineCost(fixed)), render);
  const lines = [...fixed];
  chosen.forEach((position, order) => {
    if (order > 0 && position !== chosen[order - 1]! + 1) lines.push("[…]");
    lines.push(render(position));
  });
  return { text: lines.join("\n"), refs: new Map(chosen.map((position) => [content.segments[position]!.id, refFor(content.segments[position]!)])),
    jobs: [jobId], truncated: true, meetings };
};

const candidatesFor = async (scope: Exclude<AssistantScope, { kind: "meeting" }>, facts: JobFacts[], readers: AssistantReaders): Promise<JobFacts[]> => {
  if (scope.kind === "library") return facts;
  if (scope.kind === "client") {
    const code = scope.clientCode.toLowerCase();
    return facts.filter((item) => item.clients.some((client) => client.code.toLowerCase() === code));
  }
  const person = readers.person ? await readers.person(scope.personId)
    : scope.personId.startsWith("name:") ? { name: scope.personId.slice(5), aliases: [] } : undefined;
  if (!person) throw new Error(RETRIEVAL_ERRORS.personMissing);
  const keys = new Set([person.name, ...person.aliases].map(personKey).filter(Boolean));
  if (!keys.size) throw new Error(RETRIEVAL_ERRORS.personMissing);
  return facts.filter((item) => item.speakers.some((speaker) => speaker.confirmed && keys.has(personKey(speaker.label))) ||
    item.attendees.some((attendee) => keys.has(personKey(attendee.name))));
};

type Block = { label: string; facts: JobFacts; head: string[]; items: Array<{ order: number; line: string }>; segments: Map<string, SegmentInfo> };

const libraryPack = async (scope: Exclude<AssistantScope, { kind: "meeting" }>, question: string, index: LibraryIndexReader & Partial<AssistantIndexReader>,
  readers: AssistantReaders, budget: number, signal?: AbortSignal, period?: { start: Date; end: Date }): Promise<ContextPack> => {
  const facts = await index.listFacts();
  const candidates = await candidatesFor(scope, facts, readers);
  if (!candidates.length) throw new Error(RETRIEVAL_ERRORS.noMeetings);
  const byId = new Map(candidates.map((item) => [item.jobId, item]));
  signal?.throwIfAborted();
  const hits: ChunkHit[] = (await index.search(question, { ...(scope.kind === "library" ? {} : { jobIds: candidates.map((item) => item.jobId) }), limit: LIBRARY_HITS, signal }))
    .filter((hit) => byId.has(hit.chunk.jobId));
  const order: string[] = [];
  for (const hit of hits) if (!order.includes(hit.chunk.jobId)) order.push(hit.chunk.jobId);
  const fallback = !order.length;
  const recent = period ? candidates.filter((item) => {
    const time = new Date(item.date).getTime();
    return time >= period.start.getTime() && time < period.end.getTime();
  }).map((item) => item.jobId) : [];
  // Interleave so a busy week cannot fill every slot before an older, directly relevant hit.
  const ranked = [...new Set(Array.from({ length: Math.max(recent.length, order.length) }, (_value, index) => [recent[index], order[index]])
    .flat().filter((id): id is string => id !== undefined))];
  if (fallback) for (const item of candidates.slice(0, FALLBACK_MEETINGS)) if (!ranked.includes(item.jobId)) ranked.push(item.jobId);
  const chosen = ranked.slice(0, MAX_LIBRARY_MEETINGS);
  const broad = fallback || Boolean(period);
  const refs = new Map<string, ContextRef>();
  const intro = [fallback
    ? "Nenhum trecho correspondeu diretamente à pergunta; seguem as reuniões mais recentes deste escopo (rótulos m1, m2…)."
    : "Reuniões com trechos relacionados à pergunta (rótulos m1, m2…; a seleção não inclui tudo o que foi dito).",
    ...(period ? [`Período mencionado na pergunta: ${localDate(period.start.toISOString())} até ${localDate(period.end.toISOString())} (fim exclusivo, horário local). ` +
      `${recent.length} reunião(ões) deste escopo começaram nesse período. As datas nos cabeçalhos são das reuniões, não dos prazos das ações. Resultados de outras datas podem aparecer como contexto.`] : [])];
  let used = lineCost(intro);
  // Ranked chunks cannot establish complete coverage, even when supplemented with speech.
  let truncated = !fallback || candidates.length > chosen.length;
  const blocks: Block[] = [];
  /** Line with the segment markers that support a summary item; refs are recorded only if the line is sent. */
  const withEvidence = (block: Block, order: number, line: string, segmentIds: ReadonlyArray<string>): boolean => {
    const markers: Array<[string, ContextRef]> = [];
    for (const id of segmentIds.slice(0, 6)) {
      const info = block.segments.get(id);
      if (info) markers.push([`${block.label}:${id}`, { jobId: block.facts.jobId, segmentId: id, start: info.start, end: info.end, title: block.facts.title }]);
    }
    const rendered = markers.length ? `${line} (trechos: ${markers.map(([key]) => key).join(", ")})` : line;
    // Broad questions also need primary evidence, rather than spending the whole pack on summaries.
    if (broad && used + rendered.length + 1 > budget * 0.5) { truncated = true; return false; }
    const sent = add(block, order, rendered);
    if (sent) for (const [key, ref] of markers) refs.set(key, ref);
    return sent;
  };
  // Headers first: every chosen meeting gets its title, date and overview while 40% of the budget lasts.
  for (const jobId of chosen) {
    const item = byId.get(jobId)!;
    const label = `m${blocks.length + 1}`;
    const people = peopleOf(item);
    const clients = item.clients.map((client) => client.name || client.code);
    const head = [
      `## ${label} — "${excerptText(item.title, 160)}" — ${localDate(item.date)}`,
      ...(people.length ? [`Pessoas: ${excerptText(people.join(", "), 300)}`] : []),
      ...(clients.length ? [`Clientes: ${excerptText(clients.join(", "), 200)}`] : []),
      ...(item.overview ? [`Resumo (gerado por IA): ${excerptText(item.overview, 600)}`] : [])
    ];
    // +1: the blank line before each meeting.
    if (used + lineCost(head) + 1 > budget * 0.4 && blocks.length) { truncated = true; break; }
    used += lineCost(head) + 1;
    blocks.push({ label, facts: item, head, items: [], segments: index.segmentInfo ? await index.segmentInfo(jobId) : new Map() });
  }
  const blockOf = new Map(blocks.map((block) => [block.facts.jobId, block]));
  let ceiling = budget;
  const add = (block: Block, order: number, line: string): boolean => {
    if (used + line.length + 1 > ceiling) { truncated = true; return false; }
    block.items.push({ order, line });
    used += line.length + 1;
    return true;
  };
  if (broad || scope.kind !== "library") {
    // Without matching excerpts, or for a person or client, recent decisions and actions are the useful facts.
    for (const block of blocks) {
      for (const decision of block.facts.decisions.slice(0, 5)) withEvidence(block, -2, `- Decisão: ${excerptText(decision.text, 300)}`, decision.segmentIds);
      for (const action of block.facts.actions.slice(0, 5)) {
        const details = [action.owner ? `responsável: ${action.owner}` : "", action.dueDate ? `prazo: ${action.dueDate}` : "",
          action.origin === "note" ? "das notas da pessoa usuária" : ""].filter(Boolean).join("; ");
        withEvidence(block, -1, `- Ação: ${excerptText(action.text, 300)}${details ? ` (${excerptText(details, 160)})` : ""}`, action.segmentIds);
      }
    }
  }
  const seenSegments = new Set<string>();
  // Preserve ranked hits (including semantic hits and notes), leaving room for broader recall.
  if (broad) ceiling = used + Math.floor((budget - used) / 2);
  for (const hit of hits) {
    const block = blockOf.get(hit.chunk.jobId);
    if (!block) continue;
    const { chunk } = hit;
    if (chunk.kind === "segments") {
      const texts = chunk.text.split("\n");
      // Pieces of one long segment carry a single id and a part of its text.
      const piece = Number(/:p(\d+)$/.exec(chunk.chunkId)?.[1] ?? 0);
      const aligned = texts.length === chunk.segmentIds.length;
      for (const [position, id] of chunk.segmentIds.entries()) {
        const key = `${block.label}:${id}`;
        if (seenSegments.has(key) && !piece) continue;
        const info = block.segments.get(id) ?? { id, start: chunk.start ?? 0, end: chunk.end ?? chunk.start ?? 0 };
        const text = excerptText(aligned ? texts[position]! : chunk.text, 1_500);
        if (!add(block, Number(id.slice(1)) * 1_000 + Math.min(piece, 999), segmentLine(block.label, { ...info, id }, text))) break;
        seenSegments.add(key);
        refs.set(key, { jobId: block.facts.jobId, segmentId: id, start: info.start, end: info.end, title: block.facts.title });
        if (!aligned) break;
      }
    } else if (chunk.kind === "summary") {
      withEvidence(block, -3, `- ${excerptText(chunk.text, 600)}`, chunk.segmentIds);
    } else {
      add(block, -4, `- Nota da pessoa usuária${chunk.start !== undefined ? ` [${clock(chunk.start)}]` : ""}: ${excerptText(chunk.text, 500)}`);
    }
  }
  ceiling = budget;
  if (broad) {
    // A lexical miss (including an English question about Portuguese audio) is not evidence
    // that the transcript has no answer. Read reviewed speech, sharing the remaining budget.
    for (const [position, block] of blocks.entries()) {
      signal?.throwIfAborted();
      let content: MeetingContent;
      try { content = await readers.meeting(block.facts.jobId, signal); }
      catch {
        signal?.throwIfAborted();
        truncated = true;
        add(block, 0, "Transcrição indisponível; apenas os fatos indexados foram incluídos.");
        continue;
      }
      const share = Math.max(0, Math.floor((budget - used) / (blocks.length - position)) - 6);
      const limit = Math.max(80, Math.min(4_000, Math.floor(share / 4)));
      const segments = content.segments.filter((segment) => !seenSegments.has(`${block.label}:${segment.id}`));
      const rendered = segments.map((segment) => {
        const text = excerptText(segment.text, Number.MAX_SAFE_INTEGER);
        if (text.length > limit) truncated = true;
        return segmentLine(block.label, segment, text.length > limit ? `${text.slice(0, limit)}…` : text);
      });
      const selected = lineCost(rendered) <= share ? segments.map((_segment, index) => index)
        : selectWindows(segments, question, share, (index) => rendered[index]!);
      if (selected.length < segments.length) truncated = true;
      for (const [order, index] of selected.entries()) {
        const segment = segments[index]!;
        const offset = Number(segment.id.slice(1)) * 1_000;
        if (order > 0 && index !== selected[order - 1]! + 1) add(block, offset - 1, "[…]");
        if (add(block, offset, rendered[index]!)) refs.set(`${block.label}:${segment.id}`, {
          jobId: block.facts.jobId, segmentId: segment.id, start: segment.start, end: segment.end, title: block.facts.title
        });
      }
    }
  }
  const lines = [...intro];
  for (const block of blocks) {
    lines.push("", ...block.head);
    const seen = new Set<string>();
    for (const item of block.items.sort((left, right) => left.order - right.order)) {
      if (seen.has(item.line)) continue;
      seen.add(item.line);
      lines.push(item.line);
    }
  }
  return {
    text: lines.join("\n"),
    refs,
    jobs: blocks.map((block) => block.facts.jobId),
    truncated,
    meetings: blocks.map((block) => ({ jobId: block.facts.jobId, title: block.facts.title, date: block.facts.date, label: block.label }))
  };
};

/** The excerpts for one question, within `assistant.maxContextCharacters`. */
export const buildContextPack = async (input: {
  scope: AssistantScope;
  question: string;
  index: LibraryIndexReader & Partial<AssistantIndexReader>;
  config: AppConfig;
  readers: AssistantReaders;
  signal?: AbortSignal;
  /** The runner's local clock, shared with the date given to the provider. */
  now?: Date;
  /** Recipes can add search terms; their untrusted data must not decide the calendar period. */
  query?: string;
}): Promise<ContextPack> => {
  const scope = validateAssistantScope(input.scope);
  const budget = budgetOf(input.config);
  const original = typeof input.question === "string" ? input.question.slice(0, 8_000) : "";
  const question = typeof input.query === "string" ? input.query.slice(0, 8_000) : original;
  input.signal?.throwIfAborted();
  return scope.kind === "meeting"
    ? meetingPack(scope.jobId, question, input.index, input.readers, budget, input.signal)
    : libraryPack(scope, question, input.index, input.readers, budget, input.signal, questionPeriod(original, input.now ?? new Date()));
};
