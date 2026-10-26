// Home (upcoming meetings with their plan and brief, open actions, notes being generated),
// per-meeting record/skip decisions, deep-link inbox, first-run celebration and library search
// (DESIGN-STUDIO §4 "Home and calendar", "Deep links", "First run", "Library search").
import { basename } from "node:path";
import { listActionsForFacts } from "../actions/list";
import { briefLines, buildBrief, BRIEF_KNOWN_ERRORS } from "../brief";
import { readAutomationState } from "../calls/control";
import { listUpcomingEvents, UPCOMING_ERRORS, UPCOMING_KNOWN_ERRORS, upcomingEventSources, type UpcomingEvent } from "../calendar/upcoming";
import { readClientCatalog } from "../clients/catalog";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import { sanitizeKnowledgeText } from "../knowledge/context";
import type { LibraryIndexReader } from "../library-index/types";
import { FIRST_RUN_KNOWN_ERRORS, firstSummaryDelayMs, markFirstRun, readFirstRun, type FirstRunMetrics } from "../metrics/first-run";
import { callMonitorRecords } from "../reminders";
import { clearMeetingOverride, OVERRIDE_KNOWN_ERRORS, readMeetingOverrides, setMeetingOverride, type MeetingOverride } from "../reminders/overrides";
import { effectiveRecordingMode, effectiveReminderMode } from "../reminders/scheduler";
import { listTemplates, selectTemplate, templateName, type SummaryTemplate } from "../templates";
import { type BridgeCall, type BridgeFamily, integer, invalid, line, matches, oneOf, SHA256 } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";
import { OPEN_REQUEST_KNOWN_ERRORS, takeStudioOpens } from "./open-request";
import { LIBRARY_REFRESH_MIN_AGE_MS, studioLanguage } from "./studio-services";

export const HOME_BRIDGE_OPERATIONS = ["home-read", "meeting-override", "inbox-take", "first-run-dismiss", "library-search"] as const;

export const HOME_BRIDGE_MESSAGES = Object.freeze({
  homeFailed: "Não foi possível montar o início agora; tente de novo.",
  eventGone: "Esta reunião não está mais na agenda das próximas horas.",
  overrideFailed: "Não foi possível salvar a escolha para esta reunião.",
  searchFailed: "Não foi possível buscar nas transcrições agora.",
  inboxFailed: "Não foi possível ler os pedidos de abertura do Studio.",
  firstRunFailed: "Não foi possível guardar que o aviso foi visto."
});

export const HOME_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(HOME_BRIDGE_MESSAGES), ...UPCOMING_KNOWN_ERRORS, ...OVERRIDE_KNOWN_ERRORS, ...OPEN_REQUEST_KNOWN_ERRORS, ...FIRST_RUN_KNOWN_ERRORS,
    ...BRIEF_KNOWN_ERRORS
  ])
]);

/** Home shows meetings that started up to half an hour ago and those of the next hours (12 h window at most). */
export const HOME_WINDOW = Object.freeze({ beforeMs: 30 * 60_000, afterMs: 11.5 * 60 * 60_000, events: 10, openActions: 5, processing: 10 });
export const LIBRARY_SEARCH_LIMIT = 50;

const ALLOWED: Record<(typeof HOME_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "home-read": [],
  "meeting-override": ["eventIdHash", "decision"],
  "inbox-take": [],
  "first-run-dismiss": [],
  "library-search": ["query", "limit"]
};

const validate = (call: BridgeCall): void => {
  const p = call.payload;
  if (call.op === "meeting-override") {
    matches(p, "eventIdHash", SHA256);
    oneOf(p, "decision", ["skip", "record", "clear"]);
  } else if (call.op === "library-search") {
    line(p, "query", 500);
    integer(p, "limit", 1, LIBRARY_SEARCH_LIMIT, { optional: true });
  }
};

/** The first-run milestones as ux-capabilities reports them. */
export const firstRunView = (metrics: FirstRunMetrics) => {
  const ttfsMs = firstSummaryDelayMs(metrics);
  return {
    ...(metrics.wizardOpenedAt ? { wizardOpenedAt: metrics.wizardOpenedAt } : {}),
    ...(metrics.firstRecordingAt ? { firstRecordingAt: metrics.firstRecordingAt } : {}),
    ...(metrics.firstSummaryAt ? { firstSummaryAt: metrics.firstSummaryAt } : {}),
    ...(ttfsMs !== null ? { ttfsMs } : {}),
    ...(metrics.celebrationDismissedAt ? { celebrationDismissedAt: metrics.celebrationDismissedAt } : {})
  };
};

type Plan = "record" | "notify" | "skip" | "record-override";

const planOf = (config: AppConfig, paused: boolean, override: MeetingOverride | undefined): Plan => {
  if (override?.decision === "skip") return "skip";
  if (override?.decision === "record") return "record-override";
  const mode = effectiveRecordingMode(config);
  return (mode === "record" || mode === "obs") && !paused ? "record" : "notify";
};

const upcomingEvents = async (config: AppConfig, context: BridgeContext, now: number): Promise<{ events: UpcomingEvent[]; error?: string }> => {
  if (!upcomingEventSources(config).length) return { events: [] };
  try {
    const events = await listUpcomingEvents(config, { from: new Date(now - HOME_WINDOW.beforeMs), to: new Date(now + HOME_WINDOW.afterMs), deps: context.deps.upcoming });
    return { events: events.filter((event) => Date.parse(event.endAt) > now).sort((a, b) => a.startAt.localeCompare(b.startAt)).slice(0, HOME_WINDOW.events) };
  } catch (error) {
    return { events: [], error: error instanceof Error && UPCOMING_KNOWN_ERRORS.includes(error.message) ? error.message : UPCOMING_ERRORS.unavailable };
  }
};

/** The template a meeting would get from its calendar title (or the fixed default), when that is decided before the meeting. */
const templateFor = (event: UpcomingEvent, config: AppConfig, templates: readonly SummaryTemplate[], language: "pt-BR" | "en") => {
  const selection = selectTemplate({ configDefault: config.summary.template, detection: "keywords", calendar: { title: event.title, recurring: event.recurring }, templates });
  if (!selection.template || !["user", "default", "calendar"].includes(selection.source)) return undefined;
  return { id: selection.template.id, name: templateName(selection.template, language), source: selection.source, confidence: selection.confidence };
};

const homeRead = async (context: BridgeContext) => {
  context.studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  const config = await context.studio.config();
  const services = await context.studio.services(config);
  const now = (context.deps.now ?? (() => new Date()))().getTime();
  const language = studioLanguage(config);
  const [{ events, error }, overrides, paused, templates, directory, catalog, clientOverrides, facts] = await Promise.all([
    upcomingEvents(config, context, now),
    readMeetingOverrides({ ...context.deps.overrides }).then((file) => file.entries, () => [] as MeetingOverride[]),
    readAutomationState().then((state) => state.paused, () => false),
    listTemplates(context.deps.templatesDir ? { dir: context.deps.templatesDir } : undefined).catch(() => [] as SummaryTemplate[]),
    services.people.directory().catch(() => undefined),
    readClientCatalog(config.timesheet.contextPath).then((read) => read.context, () => undefined),
    services.clientOverrides.read().catch(() => undefined),
    services.index.listFacts().catch(() => [])
  ]);
  const open = await listActionsForFacts(facts, { status: "open", includeOrphaned: false }, {
    persist: false, ...(directory ? { people: directory } : {}), ...(clientOverrides ? { overrides: clientOverrides } : {}), ...(catalog ? { catalog } : {})
  }).catch(() => []);
  // The facts were just read: briefs reuse them instead of asking the index again per meeting.
  const reader: LibraryIndexReader = { listFacts: async () => facts, getFacts: (jobId) => services.index.getFacts(jobId), search: (query, options) => services.index.search(query, options) };
  const upcoming = [];
  for (const event of events) {
    const override = overrides.find((entry) => entry.eventIdHash === event.eventIdHash);
    const template = templateFor(event, config, templates, language);
    const brief = config.reminders.brief
      ? await buildBrief(reader, { title: event.title, startAt: event.startAt, endAt: event.endAt, attendees: event.attendees, recurring: event.recurring,
        ...(event.seriesIdHash ? { seriesIdHash: event.seriesIdHash } : {}), eventIdHash: event.eventIdHash },
      { ...(directory ? { people: directory } : {}), actions: open, ...(catalog ? { catalog } : {}), ...(clientOverrides ? { overrides: clientOverrides } : {}) }).catch(() => null)
      : null;
    upcoming.push({
      eventIdHash: event.eventIdHash, title: event.title, startAt: event.startAt, endAt: event.endAt, attendees: event.attendees, recurring: event.recurring,
      plan: planOf(config, paused, override), ...(template ? { template } : {}),
      ...(brief ? { brief: { ...brief, lines: briefLines(brief, language) } } : {})
    });
  }
  const titles = new Map(facts.map((item) => [item.jobId, item.title]));
  const jobs = await (context.deps.jobs ?? new JobStore()).list().catch(() => []);
  const processing = jobs.filter((job) => ["pending", "transferring", "queued", "processing"].includes(job.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, HOME_WINDOW.processing)
    .map((job) => ({ jobId: job.id, key: job.sourcePath, state: job.state, title: titles.get(job.id) ?? basename(job.sourcePath), createdAt: job.createdAt }));
  return {
    upcoming,
    openActions: open.slice(0, HOME_WINDOW.openActions),
    openActionsTotal: open.length,
    processing,
    calendarConnected: upcomingEventSources(config).length > 0,
    ...(error ? { calendarError: error } : {}),
    reminderMode: effectiveReminderMode(config),
    refreshing: context.studio.refreshing
  };
};

const meetingOverride = async (call: BridgeCall, context: BridgeContext) => {
  const config = await context.studio.config();
  const hash = call.payload.eventIdHash as string;
  const decision = call.payload.decision as "skip" | "record" | "clear";
  const options = { ...context.deps.overrides, ...(context.deps.now ? { now: context.deps.now() } : {}) };
  const paused = await readAutomationState().then((state) => state.paused, () => false);
  if (decision === "clear") {
    await clearMeetingOverride(hash, options);
    return { eventIdHash: hash, decision, saved: true, plan: planOf(config, paused, undefined) };
  }
  // Only a decision for a meeting on the calendar: the title and times come from there, never from the page.
  const now = (context.deps.now ?? (() => new Date()))().getTime();
  const event = (await upcomingEvents(config, context, now)).events.find((item) => item.eventIdHash === hash);
  if (!event) throw new Error(HOME_BRIDGE_MESSAGES.eventGone);
  // A "record" decision only acts when the call monitor can record; otherwise the Studio starts a capture itself.
  if (decision === "record" && !(await callMonitorRecords(config))) {
    return { eventIdHash: hash, decision, saved: false, startCapture: true, title: event.title, plan: planOf(config, paused, undefined) };
  }
  const saved = await setMeetingOverride({ eventIdHash: hash, title: event.title, startAt: event.startAt, endAt: event.endAt, decision }, options);
  return { eventIdHash: hash, decision, saved: true, plan: planOf(config, paused, saved) };
};

const fold = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** About 240 characters of the chunk around the first word of the query it contains. */
export const searchSnippet = (text: string, query: string): string => {
  const clean = sanitizeKnowledgeText(text, 20_000).replace(/\s+/g, " ").trim();
  const folded = fold(clean);
  const words = fold(query).match(/[a-z0-9]{2,}/g) ?? [];
  const at = words.map((word) => folded.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 80);
  const snippet = clean.slice(start, start + 240).trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + 240 < clean.length ? "…" : ""}`;
};

const librarySearch = async (call: BridgeCall, context: BridgeContext) => {
  context.studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  const services = await context.studio.services();
  const query = call.payload.query as string;
  const limit = (call.payload.limit as number | undefined) ?? 20;
  const hits = await services.index.search(query, { limit });
  const results = [];
  for (const hit of hits) {
    const facts = await services.index.getFacts(hit.chunk.jobId).catch(() => undefined);
    if (!facts) continue;
    results.push({
      jobId: facts.jobId, key: facts.sourcePath, title: facts.title, date: facts.date, kind: hit.chunk.kind,
      ...(hit.chunk.segmentIds[0] ? { segmentId: hit.chunk.segmentIds[0] } : {}),
      ...(hit.chunk.start !== undefined ? { start: hit.chunk.start } : {}),
      snippet: searchSnippet(hit.chunk.text, query)
    });
  }
  return { hits: results, refreshing: context.studio.refreshing };
};

export const homeBridge: BridgeFamily<BridgeContext> = {
  operations: HOME_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    switch (call.op) {
      case "home-read": return homeRead(context);
      case "meeting-override": return meetingOverride(call, context);
      case "inbox-take": return { uris: (await takeStudioOpens(context.deps.inbox)).map((request) => request.uri) };
      case "first-run-dismiss": {
        const options = context.deps.firstRun ?? {};
        await markFirstRun("celebrationDismissed", context.deps.now?.() ?? new Date(), options);
        return { firstRun: firstRunView(await readFirstRun(options)) };
      }
      case "library-search": return librarySearch(call, context);
      default: return invalid();
    }
  },
  knownErrors: HOME_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op === "meeting-override" ? HOME_BRIDGE_MESSAGES.overrideFailed : op === "library-search" ? HOME_BRIDGE_MESSAGES.searchFailed
    : op === "inbox-take" ? HOME_BRIDGE_MESSAGES.inboxFailed : op === "first-run-dismiss" ? HOME_BRIDGE_MESSAGES.firstRunFailed : HOME_BRIDGE_MESSAGES.homeFailed
};
