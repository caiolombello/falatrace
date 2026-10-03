import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { readBoundedArtifact, readTranscriptArtifact } from "../jobs/transcript-access";
import { validateJobId, type JobRecord } from "../jobs/types";
import { DiarizationStore, transcriptChecksum, validateDiarizationResult } from "../diarization/store";
import { acquireSingleton } from "../runtime/singleton";
import { aiContextRoot, invalidateAiContextOwned, withContextPublicationLease } from "../knowledge/invalidation";
import type { ReviewedView, RevisionBase, RevisionHead, RevisionOperation, RevisionSaveInput, RevisionUndoInput } from "./index";

export const REVISION_LIMITS = Object.freeze({ history: 100, operations: 64, notes: 20, noteCharacters: 2000, textCharacters: 10000, jsonBytes: 4 * 1024 * 1024 });
type Overlay = { segmentTexts: Record<string, string>; segmentSpeakers: Record<string, string | null>; speakerLabels: Record<string, string>; turnSpeakers: Record<string, string | null>; notes: string[] };
type Entry = { revision: number; action: "edit" | "undo"; createdAt: string; base: RevisionBase; operations: RevisionOperation[]; overlay: Overlay; restoresRevision?: number };
type Journal = { version: 1; base: RevisionBase; history: Entry[] };
const emptyOverlay = (): Overlay => ({ segmentTexts: {}, segmentSpeakers: {}, speakerLabels: {}, turnSpeakers: {}, notes: [] });
const overlayIdentity = (overlay: Overlay): string => JSON.stringify({ ...overlay,
  segmentTexts: Object.fromEntries(Object.entries(overlay.segmentTexts).sort()), segmentSpeakers: Object.fromEntries(Object.entries(overlay.segmentSpeakers).sort()),
  speakerLabels: Object.fromEntries(Object.entries(overlay.speakerLabels).sort()), turnSpeakers: Object.fromEntries(Object.entries(overlay.turnSpeakers).sort()) });
const hash = (raw: string): string => createHash("sha256").update(raw).digest("hex");
const rootPath = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "revisions");
const filePath = (id: string): string => join(rootPath(), `${validateJobId(id)}.json`);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const equalBase = (a: RevisionBase, b: RevisionBase): boolean => a.jobId === b.jobId && a.mediaSha256 === b.mediaSha256 && a.transcriptArtifactSha256 === b.transcriptArtifactSha256 && a.diarizationSha256 === b.diarizationSha256;
const compatibleHistoricalBase = (a: RevisionBase, b: RevisionBase): boolean => equalBase(a, b) || (!a.diarizationSha256 && !!b.diarizationSha256 && a.jobId === b.jobId && a.mediaSha256 === b.mediaSha256 && a.transcriptArtifactSha256 === b.transcriptArtifactSha256);
const validText = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
const validLabel = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  constructor(message = "A revisão mudou. Releia o conteúdo antes de salvar.", readonly currentRevision?: number) { super(message); this.name = "RevisionConflictError"; }
}

export const withRevisionLease = async <T>(jobId: string, action: () => Promise<T>): Promise<T> => {
  validateJobId(jobId);
  const name = `revision-${hash(`${rootPath()}:${jobId}`).slice(0, 32)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const lease = await acquireSingleton(name);
      try { return await action(); } finally { await lease.release(); }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== `${name} is already running` || attempt >= 200) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
};

const assertParents = async (path: string): Promise<void> => {
  let current = parse(resolve(path)).root;
  for (const component of resolve(path).slice(current.length).split("/")) {
    current = join(current, component);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error("Diretório de revisão contém link simbólico"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
};
const privateRoot = async (create: boolean): Promise<boolean> => {
  const root = rootPath();
  await assertParents(root);
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(root) !== resolve(root) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw Error("Diretório de revisão inseguro");
    return true;
  } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const validateBase = (value: unknown): RevisionBase => {
  if (!object(value) || !exactKeys(value, ["jobId", "mediaSha256", "transcriptArtifactSha256", "diarizationSha256"]) || typeof value.jobId !== "string" || ![value.mediaSha256, value.transcriptArtifactSha256].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) || (value.diarizationSha256 !== undefined && (typeof value.diarizationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.diarizationSha256)))) throw Error("Base de revisão inválida");
  validateJobId(value.jobId);
  return value as RevisionBase;
};
const validateOverlay = (value: unknown, view: ReviewedView): Overlay => {
  if (!object(value) || !exactKeys(value, ["segmentTexts", "segmentSpeakers", "speakerLabels", "turnSpeakers", "notes"]) || ![value.segmentTexts, value.segmentSpeakers, value.speakerLabels, value.turnSpeakers].every(object) || !Array.isArray(value.notes) || value.notes.length > REVISION_LIMITS.notes || value.notes.some(n => !validText(n, REVISION_LIMITS.noteCharacters) || !n.trim())) throw Error("Overlay de revisão inválido");
  const overlay = value as Overlay;
  const segments = new Map(view.segments.map(s => [s.id, s]));
  const speakers = new Set(Object.keys(view.diarization?.labels || {}));
  const turns = new Set(view.diarization?.turns.map(t => t.id) || []);
  for (const [id, text] of Object.entries(overlay.segmentTexts)) if (!segments.get(id)?.textRange || !validText(text, REVISION_LIMITS.textCharacters)) throw Error("Texto de segmento sem origem comprovada");
  for (const [id, speaker] of Object.entries(overlay.segmentSpeakers)) if (!segments.has(id) || (speaker !== null && !speakers.has(speaker))) throw Error("Atribuição de segmento inválida");
  for (const [id, label] of Object.entries(overlay.speakerLabels)) if (!speakers.has(id) || !validLabel(label)) throw Error("Rótulo de falante inválido");
  for (const [id, speaker] of Object.entries(overlay.turnSpeakers)) if (!turns.has(id) || (speaker !== null && !speakers.has(speaker))) throw Error("Atribuição de fala inválida");
  return overlay;
};
const readJournal = async (view: ReviewedView): Promise<Journal | undefined> => {
  if (!await privateRoot(false)) return undefined;
  const path = filePath(view.revision.base.jobId);
  try {
    const stat = await fs.lstat(path);
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw Error("Arquivo de revisão não é privado");
    const value = JSON.parse(await readBoundedArtifact(path, REVISION_LIMITS.jsonBytes));
    if (!object(value) || !exactKeys(value, ["version", "base", "history"]) || value.version !== 1 || !Array.isArray(value.history) || !value.history.length || value.history.length > REVISION_LIMITS.history) throw Error("Histórico de revisão inválido");
    const base = validateBase(value.base);
    if (!compatibleHistoricalBase(base, view.revision.base)) throw new RevisionConflictError("A origem da transcrição ou diarização mudou; a revisão anterior foi preservada.");
    for (const [index, entry] of value.history.entries()) {
      if (!object(entry) || !exactKeys(entry, ["revision", "action", "createdAt", "base", "operations", "overlay", "restoresRevision"]) || entry.revision !== index + 1 || !["edit", "undo"].includes(String(entry.action)) || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) || !Array.isArray(entry.operations) || entry.operations.length > REVISION_LIMITS.operations || (entry.action === "undo" && (!Number.isSafeInteger(entry.restoresRevision) || Number(entry.restoresRevision) < 0 || Number(entry.restoresRevision) >= index + 1)) || (entry.action === "edit" && entry.restoresRevision !== undefined)) throw Error("Entrada do histórico inválida");
      const entryBase = validateBase(entry.base);
      if (!compatibleHistoricalBase(entryBase, view.revision.base)) throw new RevisionConflictError("A origem acústica de uma revisão anterior mudou; histórico preservado.");
      validateOverlay(entry.overlay, view);
      const overlay = entry.overlay as Overlay;
      if (!entryBase.diarizationSha256 && ([overlay.speakerLabels, overlay.segmentSpeakers, overlay.turnSpeakers].some(map => Object.keys(map).length) || entry.operations.some((op: unknown) => object(op) && ["speaker-label", "segment-speaker", "turn-speaker"].includes(String(op.kind))))) throw Error("Revisão de falante sem origem acústica");
      for (const operation of entry.operations) validateOperation(operation, view);
    }
    return value as Journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

/** Allows legacy summary-only context without overlooking a saved human overlay. */
export const hasSavedRevision = async (jobId: string): Promise<boolean> => {
  if (!await privateRoot(false)) return false;
  try { await fs.lstat(filePath(jobId)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

const readOriginalView = async (job: JobRecord): Promise<ReviewedView> => {
  const original = await readTranscriptArtifact(job);
  const base: RevisionBase = { jobId: job.id, mediaSha256: job.source.sha256, transcriptArtifactSha256: original.provenance.transcriptSha256 };
  let cursor = 0;
  const segments = original.transcript.segments.map((segment, index) => {
    const id = `s${String(index).padStart(6, "0")}`;
    const found = segment.text ? original.transcript.text.indexOf(segment.text, cursor) : -1;
    const textRange = found >= 0 ? { start: found, end: found + segment.text.length } : undefined;
    if (textRange) cursor = textRange.end;
    return { id, canonicalId: `${job.id}:${base.transcriptArtifactSha256}:${id}`, ...segment, originalText: segment.text, speakerId: segment.speaker, humanEdited: false, humanSpeakerEdited: false, ...(textRange ? { textRange } : {}) };
  });
  const view: ReviewedView = { original, transcript: structuredClone(original.transcript), segments, revision: { version: 1, revision: 0, base, humanReviewed: false }, notes: [], derivedStale: false, canUndo: false };
  const store = new DiarizationStore();
  try {
    await assertParents(store.root);
    const directory = await fs.lstat(store.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || await fs.realpath(store.root) !== resolve(store.root)) throw Error("Diretório de diarização inseguro");
    const raw = await readBoundedArtifact(store.resultPath(job.id), 20 * 1024 * 1024);
    const result = validateDiarizationResult(JSON.parse(raw));
    if (result.jobId === job.id && result.mediaSha256 === job.source.sha256 && result.transcriptSha256 === transcriptChecksum(original.transcript.text)) {
      base.diarizationSha256 = hash(raw);
      view.diarization = { original: result, labels: { ...result.labels }, turns: result.turns.map((turn, index) => ({ ...turn, id: `t${String(index).padStart(6, "0")}`, label: result.labels[turn.speaker], humanSpeakerEdited: false })) };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return view;
};
const applyOverlay = (view: ReviewedView, overlay: Overlay, revision: number): ReviewedView => {
  view.notes = [...overlay.notes]; view.revision.revision = revision; view.revision.humanReviewed = revision > 0; view.derivedStale = revision > 0;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, segment] of view.segments.entries()) {
    if (Object.prototype.hasOwnProperty.call(overlay.segmentTexts, segment.id)) {
      segment.text = overlay.segmentTexts[segment.id]!; segment.humanEdited = segment.text !== segment.originalText;
      edits.push({ ...segment.textRange!, text: segment.text });
      view.transcript.segments[index]!.text = segment.text;
    }
    if (Object.prototype.hasOwnProperty.call(overlay.segmentSpeakers, segment.id)) {
      segment.speakerId = overlay.segmentSpeakers[segment.id] ?? undefined; segment.humanSpeakerEdited = true;
      view.transcript.segments[index]!.speaker = segment.speakerId;
    }
  }
  let text = view.original.transcript.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  view.transcript.text = text;
  if (edits.some(edit => edit.text !== view.original.transcript.text.slice(edit.start, edit.end))) delete view.transcript.words;
  if (view.diarization) {
    Object.assign(view.diarization.labels, overlay.speakerLabels);
    for (const turn of view.diarization.turns) {
      if (Object.prototype.hasOwnProperty.call(overlay.turnSpeakers, turn.id)) { turn.speaker = overlay.turnSpeakers[turn.id] ?? undefined; turn.humanSpeakerEdited = true; }
      turn.label = turn.speaker ? view.diarization.labels[turn.speaker] : undefined;
    }
  }
  return view;
};
export const readReviewedView = async (job: JobRecord): Promise<ReviewedView> => {
  const view = await readOriginalView(job); const journal = await readJournal(view);
  if (!journal) return view;
  const head = journal.history[journal.history.length - 1]!;
  view.canUndo = (head.action === "undo" ? head.restoresRevision! : head.revision) > 0;
  return applyOverlay(view, head.overlay, journal.history.length);
};

function validateOperation(value: unknown, view: ReviewedView): asserts value is RevisionOperation {
  if (!object(value)) throw Error("Operação de revisão inválida");
  const keys: Record<string, string[]> = { "segment-text": ["kind", "segmentId", "text"], "speaker-label": ["kind", "speakerId", "label"], "segment-speaker": ["kind", "segmentId", "speakerId"], "turn-speaker": ["kind", "turnId", "speakerId"], note: ["kind", "text"] };
  if (typeof value.kind !== "string" || !keys[value.kind] || !exactKeys(value, keys[value.kind]!)) throw Error("Campos de revisão inválidos");
  const operation = value as RevisionOperation;
  if (["speaker-label", "segment-speaker", "turn-speaker"].includes(operation.kind) && !view.diarization) throw Error("A gravação ainda não possui falantes com origem acústica");
  const segment = "segmentId" in operation ? view.segments.find(s => s.id === operation.segmentId) : undefined;
  const speakers = new Set(Object.keys(view.diarization?.labels || {}));
  if (operation.kind === "segment-text" && (!segment?.textRange || !validText(operation.text, REVISION_LIMITS.textCharacters))) throw Error("Este segmento não possui faixa textual comprovada; use uma nota sem tempo.");
  if (operation.kind === "speaker-label" && (!speakers.has(operation.speakerId) || !validLabel(operation.label))) throw Error("Informe um rótulo de até 80 caracteres, sem controles ou quebras de linha");
  if (operation.kind === "segment-speaker" && (!segment || (operation.speakerId !== null && !speakers.has(operation.speakerId)))) throw Error("Atribuição de segmento inválida");
  if (operation.kind === "turn-speaker" && (!view.diarization?.turns.some(t => t.id === operation.turnId) || (operation.speakerId !== null && !speakers.has(operation.speakerId)))) throw Error("Atribuição de fala inválida");
  if (operation.kind === "note" && (!validText(operation.text, REVISION_LIMITS.noteCharacters) || !operation.text.trim())) throw Error("Informe uma nota sem controles, com até 2000 caracteres");
}
const editedOverlay = (view: ReviewedView, before: Overlay, operations: RevisionOperation[]): Overlay => {
  const next = structuredClone(before);
  for (const operation of operations) {
    validateOperation(operation, view);
    if (operation.kind === "segment-text") {
      const original = view.segments.find(s => s.id === operation.segmentId)!.originalText;
      if (operation.text === original) delete next.segmentTexts[operation.segmentId]; else next.segmentTexts[operation.segmentId] = operation.text;
    } else if (operation.kind === "speaker-label") {
      const label = operation.label.trim();
      if (label === view.diarization!.original.labels[operation.speakerId]) delete next.speakerLabels[operation.speakerId]; else next.speakerLabels[operation.speakerId] = label;
    } else if (operation.kind === "segment-speaker") {
      // Canonical speaker codes and acoustic voice IDs have separate namespaces.
      // An explicit binding is human evidence even when their strings coincide.
      next.segmentSpeakers[operation.segmentId] = operation.speakerId;
    } else if (operation.kind === "turn-speaker") {
      const original = view.diarization!.original.turns[Number(operation.turnId.slice(1))]!.speaker;
      if (operation.speakerId === original) delete next.turnSpeakers[operation.turnId]; else next.turnSpeakers[operation.turnId] = operation.speakerId;
    }
    else next.notes.push(operation.text.trim());
  }
  validateOverlay(next, view);
  return next;
};
const publish = async (job: JobRecord, journal: Journal, base: RevisionBase): Promise<void> => {
  const raw = JSON.stringify(journal, null, 2);
  if (Buffer.byteLength(raw) > REVISION_LIMITS.jsonBytes) throw Error("Histórico atingiu o limite de 4 MiB; nenhuma revisão foi apagada");
  await privateRoot(true);
  await withContextPublicationLease(aiContextRoot(), async () => {
    const latest = await readOriginalView(job);
    if (!equalBase(base, latest.revision.base)) throw new RevisionConflictError("A origem mudou durante a revisão; nenhum conteúdo original foi alterado.");
    if (await invalidateAiContextOwned(aiContextRoot(), "human-revision") === "failed") throw Error("Não foi possível invalidar o contexto; revisão não salva");
    const path = filePath(job.id), temporary = join(dirname(path), `.${job.id}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      await privateRoot(false);
      const existing = await fs.lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) throw Error("Arquivo de revisão inseguro");
      await fs.rename(temporary, path);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  });
};
const mutate = async (job: JobRecord, input: RevisionUndoInput, action: "edit" | "undo", operations?: RevisionOperation[]): Promise<RevisionHead> => {
  validateJobId(job.id); validateBase(input.base);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error("Revisão esperada inválida");
  return withRevisionLease(job.id, async () => {
    const view = await readOriginalView(job), journal = await readJournal(view);
    const revision = journal?.history.length || 0;
    if (revision !== input.expectedRevision || !equalBase(input.base, view.revision.base)) throw new RevisionConflictError(undefined, revision);
    const before = journal?.history[revision - 1]?.overlay || emptyOverlay();
    let next: Overlay; let restoresRevision: number | undefined;
    if (action === "edit") {
      if (!Array.isArray(operations) || !operations.length || operations.length > REVISION_LIMITS.operations) throw Error("Informe de 1 a 64 operações de revisão");
      next = editedOverlay(view, before, operations);
    } else {
      const head = journal?.history[revision - 1];
      const activeRevision = head?.action === "undo" ? head.restoresRevision! : revision;
      if (!activeRevision) throw Error("Não há revisão para desfazer");
      const previous = journal!.history[activeRevision - 2];
      restoresRevision = previous?.action === "undo" ? previous.restoresRevision! : activeRevision - 1;
      next = structuredClone(journal!.history[restoresRevision - 1]?.overlay || emptyOverlay());
    }
    if (overlayIdentity(next) === overlayIdentity(before)) return { version: 1, revision, base: view.revision.base };
    if (revision >= REVISION_LIMITS.history) throw Error("Histórico atingiu 100 revisões; nenhuma revisão foi apagada");
    const updated: Journal = journal || { version: 1, base: view.revision.base, history: [] };
    updated.base = { ...view.revision.base };
    updated.history.push({ revision: revision + 1, action, createdAt: new Date().toISOString(), base: { ...view.revision.base }, operations: operations || [], overlay: next, ...(restoresRevision !== undefined ? { restoresRevision } : {}) });
    await publish(job, updated, view.revision.base);
    return { version: 1, revision: revision + 1, base: view.revision.base };
  });
};
export const saveRevision = async (job: JobRecord, input: RevisionSaveInput): Promise<RevisionHead> => {
  if (!object(input) || Object.keys(input).sort().join(",") !== "base,expectedRevision,operations" || !Array.isArray(input.operations) || !input.operations.length || input.operations.length > REVISION_LIMITS.operations) throw Error("Informe somente base, expectedRevision e de 1 a 64 operações de revisão");
  const snapshot = structuredClone(input);
  return mutate(job, snapshot, "edit", snapshot.operations);
};
export const undoRevision = async (job: JobRecord, input: RevisionUndoInput): Promise<RevisionHead> => {
  if (!object(input) || Object.keys(input).sort().join(",") !== "base,expectedRevision") throw Error("Informe somente base e expectedRevision para desfazer");
  return mutate(job, structuredClone(input), "undo");
};
