// Notepad and live transcript operations of the Studio bridge (DESIGN-STUDIO §4 "Notes", "Live transcript").
import { formatNoteOffset, NOTES_KNOWN_ERRORS, NotesStore, findNotesForJob, notesCaptureReference, notesText, type MeetingNotes } from "../notes";
import { LIVE_KNOWN_ERRORS, LIVE_PAGE_MAX, readLiveTranscript } from "../live/store";
import { JobStore } from "../jobs/store";
import { RecordingSessionStore } from "../recording/session";
import { type BridgeCall, type BridgeFamily, bool, integer, invalid, line, text, uuidKey } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";

export const NOTES_BRIDGE_OPERATIONS = ["notes-read", "notes-save", "live-read", "live-set"] as const;

export const NOTES_BRIDGE_MESSAGES = Object.freeze({
  readFailed: "Não foi possível ler as notas desta reunião.",
  saveFailed: "Não foi possível confirmar o salvamento das notas; o texto continua na tela.",
  liveFailed: "O texto ao vivo não está disponível agora.",
  liveConsent: "Confirme o envio do áudio ao provedor antes de ligar o texto ao vivo.",
  liveProviderChanged: "O provedor do texto ao vivo mudou. Confirme de novo para onde o áudio vai."
});

export const NOTES_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([...NOTES_KNOWN_ERRORS, ...LIVE_KNOWN_ERRORS, ...Object.values(NOTES_BRIDGE_MESSAGES)])
]);

/** Raw notepad text accepted from the Studio (the store keeps at most 64 KiB of lines). */
export const NOTES_TEXT_MAX_CHARACTERS = 256 * 1024;
/** The only live provider that keeps the audio on this computer; any other one (today openai, groq) needs consent. */
export const LOCAL_LIVE_PROVIDERS: readonly string[] = ["whisper-cpp"];

const ALLOWED: Record<(typeof NOTES_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "notes-read": [],
  "notes-save": ["text", "expectedRev", "title"],
  "live-read": ["sinceSeq", "limit"],
  "live-set": ["enabled", "consent", "provider"]
};

const validate = (call: BridgeCall): void => {
  uuidKey(call);
  const p = call.payload;
  if (call.op === "notes-save") {
    text(p, "text", NOTES_TEXT_MAX_CHARACTERS);
    integer(p, "expectedRev", 0, 1_000_000_000);
    line(p, "title", 200, { optional: true, empty: true });
  } else if (call.op === "live-read") {
    integer(p, "sinceSeq", 0, 1_000_000_000);
    integer(p, "limit", 1, LIVE_PAGE_MAX, { optional: true });
  } else if (call.op === "live-set") {
    bool(p, "enabled");
    bool(p, "consent", { optional: true });
    line(p, "provider", 40, { optional: true });
  }
};

/** The notes shape of notes-read, notes-save and detail.notes. */
export const notesView = (id: string, notes: MeetingNotes | undefined) => ({
  id: notes?.id ?? id.toLowerCase(),
  rev: notes?.rev ?? 0,
  text: notesText(notes),
  entries: (notes?.entries ?? []).map((entry) => {
    const at = formatNoteOffset(entry.offsetSeconds);
    return { id: entry.id, ...(at ? { at } : {}), ...(entry.offsetSeconds !== null ? { offsetSeconds: entry.offsetSeconds } : {}), text: entry.text };
  }),
  updatedAt: notes?.updatedAt ?? null,
  ...(notes?.title ? { title: notes.title } : {})
});

const readNotes = async (key: string, context: BridgeContext) => {
  const store = new NotesStore();
  const own = await store.read(key);
  if (own) return notesView(key, own);
  // A job created later for a capture's file keeps the capture's notes under the capture id.
  const job = await (context.deps.jobs ?? new JobStore()).get(key).catch(() => undefined);
  const found = job ? await findNotesForJob(job, store) : undefined;
  return notesView(key, found);
};

const saveNotes = async (call: BridgeCall, context: BridgeContext) => {
  const id = call.key!.toLowerCase();
  const p = call.payload;
  const session = await (context.deps.sessions ?? new RecordingSessionStore()).read().catch(() => null);
  // Typed during (or right after) this capture: place the lines on its media timeline.
  const reference = session?.id.toLowerCase() === id ? notesCaptureReference(session) : undefined;
  const before = p.expectedRev as number;
  const saved = await new NotesStore().save(id, {
    text: p.text as string,
    expectedRev: before,
    ...(context.deps.now ? { now: context.deps.now() } : {}),
    ...(reference ? { mediaStartedAt: reference.mediaStartedAt, sourcePath: reference.sourcePath, ...(reference.mediaEndedAt ? { mediaEndedAt: reference.mediaEndedAt } : {}) } : {}),
    ...(typeof p.title === "string" ? { title: p.title.trim() } : {})
  });
  return { ...notesView(id, saved.rev ? saved : undefined), saved: saved.rev !== before };
};

const readLive = async (call: BridgeCall) => {
  const p = call.payload;
  const view = await readLiveTranscript(call.key!.toLowerCase(), p.sinceSeq as number, { ...(p.limit !== undefined ? { limit: p.limit as number } : {}) });
  const status = view.status;
  return {
    lines: view.lines.map(({ seq, start, end, text: line }) => ({ seq, start, end, text: line })),
    lastSeq: view.lastSeq,
    hasMore: view.hasMore,
    status: status?.state ?? "idle",
    stale: view.stale,
    ...(status ? { provider: status.provider, rtf: status.rtf, backlog: status.backlog } : {}),
    ...(status?.error && LIVE_KNOWN_ERRORS.includes(status.error) ? { error: status.error } : {})
  };
};

const setLive = async (call: BridgeCall, context: BridgeContext) => {
  const config = await context.studio.config();
  const enabled = call.payload.enabled === true;
  // Fail closed: a provider added later counts as external until it is listed as local.
  const external = !LOCAL_LIVE_PROVIDERS.includes(config.live.provider);
  // The audio of the meeting goes to the provider while the capture runs: the person agrees first,
  // to the provider the consent named (one changed in Settings since then asks again).
  if (enabled && external && call.payload.consent !== true) throw new Error(NOTES_BRIDGE_MESSAGES.liveConsent);
  if (enabled && external && call.payload.provider !== config.live.provider) throw new Error(NOTES_BRIDGE_MESSAGES.liveProviderChanged);
  // The live transcript (worker, audio tap, providers) loads on first use; the bridge starts without it.
  const { setLiveForSession } = await import("../live");
  const result = await setLiveForSession(call.key!.toLowerCase(), enabled, {
    config, ...context.deps.live, ...(context.deps.sessions ? { sessions: context.deps.sessions } : {})
  });
  return { enabled: result.active, status: result.active ? "running" : "stopped", changed: result.changed, provider: config.live.provider, external };
};

export const notesBridge: BridgeFamily<BridgeContext> = {
  operations: NOTES_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    if (call.op === "notes-read") return readNotes(call.key!, context);
    if (call.op === "notes-save") return saveNotes(call, context);
    if (call.op === "live-read") return readLive(call);
    if (call.op === "live-set") return setLive(call, context);
    return invalid();
  },
  knownErrors: NOTES_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op === "notes-read" ? NOTES_BRIDGE_MESSAGES.readFailed : op === "notes-save" ? NOTES_BRIDGE_MESSAGES.saveFailed : NOTES_BRIDGE_MESSAGES.liveFailed
};
