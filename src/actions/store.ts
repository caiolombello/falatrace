import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  PrivateFileError,
  SHA256_PATTERN,
  UUID_PATTERN,
  ensurePrivateDir,
  hasControlCharacters,
  isFileSystemError,
  isIsoTime,
  isRecord,
  readPrivateJson,
  recordingDataDir,
  withLock,
  writePrivateFileAtomic
} from "../people/store";

/**
 * Durable state of action items, one file per recorded media (`<mediaSha256>.json`) so a
 * reprocessed recording keeps it. Items carry an anchor (text fingerprint + cited segments)
 * instead of a summary index, because every summary regeneration rewrites and reorders them.
 */

export type ActionStatus = "open" | "done" | "dismissed";
export type ActionOrigin = "model" | "note" | "user";
export type ActionMatchState = "current" | "orphaned";

export type ActionAnchor = {
  jobId: string;
  /** Empty when the index did not know the transcript artifact. */
  transcriptArtifactSha256: string;
  revision: number;
  fingerprint: string;
  segmentIds: string[];
  summarySource: "original" | "reviewed";
  requestId?: string;
};

export type ActionState = {
  id: string;
  origin: ActionOrigin;
  anchor?: ActionAnchor;
  text: string;
  ownerText?: string;
  ownerPersonId?: string;
  /** ISO date (YYYY-MM-DD) when the due text had one. */
  dueDate?: string;
  status: ActionStatus;
  statusChangedAt?: string;
  matchState: ActionMatchState;
  createdAt: string;
  updatedAt: string;
};

export type ActionsFile = { version: 1; mediaSha256: string; jobIds: string[]; items: ActionState[]; rev: number };

export const ACTION_LIMITS = {
  maxItems: 200,
  /** Actions of the current summary that get state; the rest of the file holds orphans and manual items. */
  maxCurrent: 150,
  maxUserItems: 50,
  maxJobIds: 50,
  maxText: 1_000,
  maxOwner: 500,
  maxSegmentIds: 50,
  maxFileBytes: 1024 * 1024
} as const;

/** Re-matching thresholds: token Jaccard with overlapping cited segments, or a stricter one when either side cites nothing. */
export const ACTION_MATCH = { jaccard: 0.6, jaccardWithoutCitations: 0.8 } as const;

export const ACTIONS_ERRORS = {
  stale: "As ações mudaram em outra janela; recarregue e tente de novo.",
  notFound: "Ação não encontrada; recarregue a lista.",
  invalidFile: "O arquivo de ações desta gravação está danificado; nada foi alterado.",
  invalidStatus: "Estado de ação inválido.",
  invalidRecording: "Gravação inválida.",
  invalidText: "Descreva a ação em uma linha de até 1000 caracteres.",
  invalidOwner: "Responsável inválido: use uma linha de até 500 caracteres.",
  invalidDueDate: "Data de entrega inválida: use AAAA-MM-DD ou DD/MM/AAAA.",
  notManual: "Somente ações adicionadas por você podem ser removidas.",
  full: "Limite de ações desta gravação atingido.",
  invalidFilter: "Filtro de ações inválido.",
  busy: "Outra operação está salvando estes dados; tente de novo em instantes.",
  storage: "Não foi possível ler ou salvar as ações; verifique as permissões e o espaço em disco."
} as const;

export const ACTIONS_KNOWN_ERRORS: readonly string[] = Object.values(ACTIONS_ERRORS);

const STATUSES: readonly ActionStatus[] = ["open", "done", "dismissed"];
const ORIGINS: readonly ActionOrigin[] = ["model", "note", "user"];
const SEGMENT_ID = /^s\d{6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export const defaultActionsDir = (): string => join(recordingDataDir(), "actions");

export const isActionStatus = (value: unknown): value is ActionStatus => STATUSES.includes(value as ActionStatus);

const validText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !hasControlCharacters(value);

const validDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const validateActionsFile = (value: unknown, mediaSha256?: string): ActionsFile => {
  const invalid = (): never => { throw new Error(ACTIONS_ERRORS.invalidFile); };
  if (!isRecord(value) || value.version !== 1 || typeof value.mediaSha256 !== "string" || !SHA256_PATTERN.test(value.mediaSha256) ||
    (mediaSha256 !== undefined && value.mediaSha256 !== mediaSha256) || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0 ||
    !Array.isArray(value.jobIds) || value.jobIds.length > ACTION_LIMITS.maxJobIds ||
    !value.jobIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) || new Set(value.jobIds).size !== value.jobIds.length ||
    !Array.isArray(value.items) || value.items.length > ACTION_LIMITS.maxItems) return invalid();
  const ids = new Set<string>();
  const items = value.items.map((item): ActionState => {
    if (!isRecord(item) || typeof item.id !== "string" || !UUID_PATTERN.test(item.id) || ids.has(item.id) || !ORIGINS.includes(item.origin as ActionOrigin) ||
      !validText(item.text, ACTION_LIMITS.maxText) || !isActionStatus(item.status) || !["current", "orphaned"].includes(item.matchState as string) ||
      !isIsoTime(item.createdAt) || !isIsoTime(item.updatedAt) ||
      (item.ownerText !== undefined && !validText(item.ownerText, ACTION_LIMITS.maxOwner)) ||
      (item.ownerPersonId !== undefined && !validText(item.ownerPersonId, 210)) ||
      (item.dueDate !== undefined && (typeof item.dueDate !== "string" || !validDate(item.dueDate))) ||
      (item.statusChangedAt !== undefined && !isIsoTime(item.statusChangedAt))) return invalid();
    let anchor: ActionAnchor | undefined;
    if (item.anchor !== undefined) {
      const raw = item.anchor;
      if (!isRecord(raw) || typeof raw.jobId !== "string" || !UUID_PATTERN.test(raw.jobId) ||
        typeof raw.transcriptArtifactSha256 !== "string" || (raw.transcriptArtifactSha256 !== "" && !SHA256_PATTERN.test(raw.transcriptArtifactSha256)) ||
        !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || typeof raw.fingerprint !== "string" || !SHA256_PATTERN.test(raw.fingerprint) ||
        !Array.isArray(raw.segmentIds) || raw.segmentIds.length > ACTION_LIMITS.maxSegmentIds ||
        !raw.segmentIds.every((id) => typeof id === "string" && SEGMENT_ID.test(id)) || !["original", "reviewed"].includes(raw.summarySource as string) ||
        (raw.requestId !== undefined && (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)))) return invalid();
      anchor = {
        jobId: raw.jobId,
        transcriptArtifactSha256: raw.transcriptArtifactSha256,
        revision: raw.revision as number,
        fingerprint: raw.fingerprint,
        segmentIds: [...raw.segmentIds as string[]],
        summarySource: raw.summarySource as ActionAnchor["summarySource"],
        ...(raw.requestId ? { requestId: raw.requestId as string } : {})
      };
    }
    if (item.origin !== "user" && !anchor) return invalid();
    ids.add(item.id);
    return {
      id: item.id,
      origin: item.origin as ActionOrigin,
      ...(anchor ? { anchor } : {}),
      text: item.text,
      ...(item.ownerText !== undefined ? { ownerText: item.ownerText as string } : {}),
      ...(item.ownerPersonId !== undefined ? { ownerPersonId: item.ownerPersonId as string } : {}),
      ...(item.dueDate !== undefined ? { dueDate: item.dueDate as string } : {}),
      status: item.status,
      ...(item.statusChangedAt !== undefined ? { statusChangedAt: item.statusChangedAt as string } : {}),
      matchState: item.matchState as ActionMatchState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  });
  return { version: 1, mediaSha256: value.mediaSha256, jobIds: [...value.jobIds as string[]], items, rev: value.rev as number };
};

/* ---------- Matching ---------- */

/** NFD, no accents, lowercase, single spaces. */
export const normalizeActionText = (text: string): string =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export const actionFingerprint = (text: string): string => createHash("sha256").update(normalizeActionText(text)).digest("hex");

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma", "para", "por", "com", "ao", "aos", "as", "os", "que", "se", "ou",
  "the", "to", "of", "and", "for", "in", "on", "at", "an", "by", "with", "or",
  "el", "la", "los", "las", "del", "con", "en", "al", "lo", "y"
]);

export const actionTokens = (text: string): Set<string> =>
  // Single digits count: "Relatório 1" and "Relatório 2" are different actions.
  new Set(normalizeActionText(text).split(/[^a-z0-9]+/).filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOPWORDS.has(token)));

export const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
};

/** A due text with a calendar date ("2026-11-03", "03/11/2026") as an ISO date. */
export const parseDueDate = (text: string): string | undefined => {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso && validDate(`${iso[1]}-${iso[2]}-${iso[3]}`)) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (local) {
    const value = `${local[3]}-${local[2]!.padStart(2, "0")}-${local[1]!.padStart(2, "0")}`;
    if (validDate(value)) return value;
  }
  return undefined;
};

/**
 * Stable id for an item first seen with this text: the same state gives the same id, so a
 * listing that cannot be saved (read-only service) still names actions consistently.
 */
export const deriveActionId = (mediaSha256: string, fingerprint: string, taken: ReadonlySet<string>): string => {
  for (let attempt = 0; ; attempt++) {
    const hex = createHash("sha256").update(`falatrace:action:v1\0${mediaSha256}\0${fingerprint}\0${attempt}`).digest("hex");
    const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    if (!taken.has(id)) return id;
  }
};

/** One action of the current summary (or a note), as the index reports it. */
export type CurrentAction = { key: string; text: string; owner: string; dueDate: string; segmentIds: string[]; origin: "model" | "note" };

export type ReconcileInput = {
  jobId: string;
  jobIds: string[];
  transcriptArtifactSha256?: string;
  revision: number;
  summarySource?: "original" | "reviewed";
  actions: CurrentAction[];
  now: string;
};

export type ReconcileResult = { file: ActionsFile; changed: boolean; matches: Map<string, string> };

/** JSON with sorted keys, so equal states compare equal whatever order their fields were set in. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, current: unknown) =>
    isRecord(current) ? Object.fromEntries(Object.keys(current).sort().map((key) => [key, current[key]])) : current);

const comparable = (item: ActionState): string => stableJson({ ...item, updatedAt: "" });

/**
 * Re-anchors stored items on the current actions: same fingerprint first, then token Jaccard
 * with overlapping cited segments; stored items left over become "orphaned" (status kept),
 * actions left over become new open items. Pure: no I/O.
 */
export const reconcileActions = (current: ActionsFile | undefined, mediaSha256: string, input: ReconcileInput): ReconcileResult => {
  const base: ActionsFile = current ?? { version: 1, mediaSha256, jobIds: [], items: [], rev: 0 };
  const actions = input.actions.slice(0, ACTION_LIMITS.maxCurrent);
  const fingerprints = actions.map((action) => actionFingerprint(action.text));
  const anchored = base.items.filter((item) => item.origin !== "user" && item.anchor);
  const matched = new Map<number, ActionState>();
  const used = new Set<string>();

  actions.forEach((_, index) => {
    const item = anchored.find((candidate) => !used.has(candidate.id) && candidate.anchor!.fingerprint === fingerprints[index]);
    if (item) {
      matched.set(index, item);
      used.add(item.id);
    }
  });

  const pairs: Array<{ index: number; item: ActionState; order: number; score: number }> = [];
  actions.forEach((action, index) => {
    if (matched.has(index)) return;
    const tokens = actionTokens(action.text);
    anchored.forEach((item, order) => {
      if (used.has(item.id)) return;
      const score = jaccard(tokens, actionTokens(item.text));
      const cited = action.segmentIds.length > 0 && item.anchor!.segmentIds.length > 0;
      const overlap = cited && action.segmentIds.some((id) => item.anchor!.segmentIds.includes(id));
      if (cited ? overlap && score >= ACTION_MATCH.jaccard : score >= ACTION_MATCH.jaccardWithoutCitations) pairs.push({ index, item, order, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.index - b.index || a.order - b.order);
  for (const pair of pairs) {
    if (matched.has(pair.index) || used.has(pair.item.id)) continue;
    matched.set(pair.index, pair.item);
    used.add(pair.item.id);
  }

  const summarySource = input.summarySource ?? (input.revision > 0 ? "reviewed" : "original");
  const describe = (action: CurrentAction, index: number): Pick<ActionState, "origin" | "anchor" | "text" | "ownerText" | "dueDate"> => {
    const dueDate = parseDueDate(action.dueDate);
    return {
      origin: action.origin,
      anchor: {
        jobId: input.jobId,
        transcriptArtifactSha256: input.transcriptArtifactSha256 ?? "",
        revision: input.revision,
        fingerprint: fingerprints[index]!,
        segmentIds: action.segmentIds.slice(0, ACTION_LIMITS.maxSegmentIds),
        summarySource
      },
      text: action.text,
      ...(action.owner ? { ownerText: action.owner } : {}),
      ...(dueDate ? { dueDate } : {})
    };
  };

  const matches = new Map<string, string>();
  const byItem = new Map<string, number>();
  for (const [index, item] of matched) byItem.set(item.id, index);
  const keep = (previous: ActionState, next: ActionState): ActionState =>
    comparable(previous) === comparable(next) ? previous : { ...next, updatedAt: input.now };

  const items: ActionState[] = base.items.map((item) => {
    if (item.origin === "user" || !item.anchor) return item;
    const index = byItem.get(item.id);
    if (index === undefined) return keep(item, { ...item, matchState: "orphaned" });
    const action = actions[index]!;
    matches.set(action.key, item.id);
    const next: ActionState = { ...item, ...describe(action, index), matchState: "current" };
    if (!action.owner) delete next.ownerText;
    if (!parseDueDate(action.dueDate)) delete next.dueDate;
    return keep(item, next);
  });

  const taken = new Set(items.map((item) => item.id));
  actions.forEach((action, index) => {
    if (matched.has(index)) return;
    const id = deriveActionId(mediaSha256, fingerprints[index]!, taken);
    taken.add(id);
    matches.set(action.key, id);
    items.push({ id, ...describe(action, index), status: "open", matchState: "current", createdAt: input.now, updatedAt: input.now });
  });

  let kept = items;
  if (items.length > ACTION_LIMITS.maxItems) {
    // Orphans go first, oldest and still-open ones before those that record a decision.
    const orphans = items.filter((item) => item.matchState === "orphaned")
      .sort((a, b) => Number(b.status !== "open") - Number(a.status !== "open") || b.updatedAt.localeCompare(a.updatedAt));
    const room = Math.max(0, ACTION_LIMITS.maxItems - (items.length - orphans.length));
    const surviving = new Set(orphans.slice(0, room).map((item) => item.id));
    kept = items.filter((item) => item.matchState !== "orphaned" || surviving.has(item.id));
  }

  // Newest last and each id once (the file validator refuses repeats, which would make every save fail).
  const newestLast = [...new Set(input.jobIds)].reverse().filter((id) => typeof id === "string" && UUID_PATTERN.test(id));
  const jobIds = [...base.jobIds.filter((id) => !newestLast.includes(id)), ...newestLast].slice(-ACTION_LIMITS.maxJobIds);
  const next: ActionsFile = { version: 1, mediaSha256, jobIds, items: kept, rev: base.rev };
  // A recording without actions needs no file.
  const changed = current
    ? stableJson([current.jobIds, current.items]) !== stableJson([next.jobIds, next.items])
    : next.items.length > 0;
  if (changed) next.rev = base.rev + 1;
  return { file: changed ? next : base, changed, matches };
};

/* ---------- Store ---------- */

export type ActionsStoreOptions = { now?: () => Date; lockTimeoutMs?: number };

const mapFileError = (error: unknown): never => {
  if (error instanceof PrivateFileError) throw new Error(error.problem === "busy" ? ACTIONS_ERRORS.busy : ACTIONS_ERRORS.invalidFile);
  if (isFileSystemError(error)) throw new Error(ACTIONS_ERRORS.storage);
  throw error;
};

/** Errors that make a listing fall back to an unsaved, in-memory view (damaged file, busy, read-only home). */
const fallsBackToMemory = (error: unknown): boolean =>
  error instanceof Error && (ACTIONS_KNOWN_ERRORS.includes(error.message) || isFileSystemError(error));

const cleanUserText = (value: unknown, maximum: number = ACTION_LIMITS.maxText, message: string = ACTIONS_ERRORS.invalidText): string => {
  if (typeof value !== "string" || value.length > maximum * 4) throw new Error(message);
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > maximum || hasControlCharacters(text)) throw new Error(message);
  return text;
};

/** An optional one-line field: absent or blank means none. */
const cleanOptional = (value: unknown, maximum: number, message: string): string | undefined =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "") ? undefined : cleanUserText(value, maximum, message);

export class ActionsStore {
  constructor(readonly root = defaultActionsDir(), private readonly options: ActionsStoreOptions = {}) {}

  path(mediaSha256: string): string {
    if (typeof mediaSha256 !== "string" || !SHA256_PATTERN.test(mediaSha256)) throw new Error(ACTIONS_ERRORS.invalidRecording);
    return join(this.root, `${mediaSha256}.json`);
  }

  async read(mediaSha256: string): Promise<ActionsFile | undefined> {
    const raw = await readPrivateJson(this.path(mediaSha256), ACTION_LIMITS.maxFileBytes).catch(mapFileError);
    return raw ? validateActionsFile(raw.value, mediaSha256) : undefined;
  }

  /**
   * Re-anchors this media's state on the current actions and saves it when it changed. With
   * `persist: false`, or when the state cannot be saved (read-only service, damaged file), the
   * result is computed in memory and nothing on disk is touched.
   */
  async reconcile(mediaSha256: string, input: ReconcileInput, options: { persist?: boolean } = {}): Promise<ReconcileResult & { persisted: boolean }> {
    this.path(mediaSha256);
    let current: ActionsFile | undefined;
    let readable = true;
    try {
      current = await this.read(mediaSha256);
    } catch (error) {
      if (!fallsBackToMemory(error)) throw error;
      readable = false;
    }
    // Most listings change nothing: answer without taking the lock.
    const preview = reconcileActions(current, mediaSha256, input);
    // A state that was not saved keeps the rev on disk: setStatus(…, expectedRev) compares with that file.
    const unsaved = (): ReconcileResult & { persisted: boolean } =>
      ({ ...preview, file: { ...preview.file, rev: current?.rev ?? 0 }, persisted: false });
    if (!preview.changed && readable) return { ...preview, persisted: true };
    if (options.persist === false || !readable) return unsaved();
    try {
      return await withLock(this.lockName(mediaSha256), async () => {
        const result = reconcileActions(await this.read(mediaSha256), mediaSha256, input);
        if (result.changed) await this.write(result.file);
        return { ...result, persisted: true };
      }, this.options.lockTimeoutMs).catch(mapFileError);
    } catch (error) {
      if (!fallsBackToMemory(error)) throw error;
      return unsaved();
    }
  }

  async setStatus(mediaSha256: string, actionId: string, status: ActionStatus, expectedRev?: number): Promise<ActionsFile> {
    if (!isActionStatus(status)) throw new Error(ACTIONS_ERRORS.invalidStatus);
    if (typeof actionId !== "string" || !UUID_PATTERN.test(actionId)) throw new Error(ACTIONS_ERRORS.notFound);
    return this.mutate(mediaSha256, expectedRev, (file, now) => {
      const item = file?.items.find((candidate) => candidate.id === actionId);
      if (!file || !item) throw new Error(ACTIONS_ERRORS.notFound);
      if (item.status === status) return undefined;
      item.status = status;
      item.statusChangedAt = now;
      item.updatedAt = now;
      return file;
    });
  }

  /** An action typed by the person for this recording; it never needs re-matching. */
  async addUserAction(mediaSha256: string, input: { jobId: string; text: string; ownerText?: string; dueDate?: string }, expectedRev?: number): Promise<{ file: ActionsFile; item: ActionState }> {
    if (!isRecord(input) || typeof input.jobId !== "string" || !UUID_PATTERN.test(input.jobId)) throw new Error(ACTIONS_ERRORS.invalidRecording);
    const text = cleanUserText(input.text);
    const ownerText = cleanOptional(input.ownerText, ACTION_LIMITS.maxOwner, ACTIONS_ERRORS.invalidOwner);
    const dueText = cleanOptional(input.dueDate, 100, ACTIONS_ERRORS.invalidDueDate);
    const dueDate = dueText === undefined ? undefined : parseDueDate(dueText);
    if (dueText !== undefined && !dueDate) throw new Error(ACTIONS_ERRORS.invalidDueDate);
    let created: ActionState | undefined;
    const file = await this.mutate(mediaSha256, expectedRev, (current, now) => {
      const draft: ActionsFile = current ?? { version: 1, mediaSha256, jobIds: [], items: [], rev: 0 };
      if (draft.items.length >= ACTION_LIMITS.maxItems || draft.items.filter((item) => item.origin === "user").length >= ACTION_LIMITS.maxUserItems) {
        throw new Error(ACTIONS_ERRORS.full);
      }
      const taken = new Set(draft.items.map((item) => item.id));
      created = {
        id: deriveActionId(mediaSha256, actionFingerprint(`user\0${now}\0${text}`), taken),
        origin: "user",
        text,
        ...(ownerText ? { ownerText } : {}),
        ...(dueDate ? { dueDate } : {}),
        status: "open",
        matchState: "current",
        createdAt: now,
        updatedAt: now
      };
      draft.items.push(created);
      if (!draft.jobIds.includes(input.jobId)) draft.jobIds = [...draft.jobIds, input.jobId].slice(-ACTION_LIMITS.maxJobIds);
      return draft;
    });
    return { file, item: created! };
  }

  async removeUserAction(mediaSha256: string, actionId: string, expectedRev?: number): Promise<ActionsFile> {
    return this.mutate(mediaSha256, expectedRev, (file) => {
      const item = file?.items.find((candidate) => candidate.id === actionId);
      if (!file || !item) throw new Error(ACTIONS_ERRORS.notFound);
      if (item.origin !== "user") throw new Error(ACTIONS_ERRORS.notManual);
      file.items = file.items.filter((candidate) => candidate.id !== actionId);
      return file;
    });
  }

  /** Forgets the state of a media (when no recording of it remains). */
  async remove(mediaSha256: string): Promise<void> {
    const path = this.path(mediaSha256);
    await withLock(this.lockName(mediaSha256), async () => {
      const stat = await fs.lstat(path).catch(() => undefined);
      if (stat && (stat.isFile() || stat.isSymbolicLink())) await fs.rm(path, { force: true });
    }, this.options.lockTimeoutMs).catch(mapFileError);
  }

  private lockName(mediaSha256: string): string {
    return `actions-${mediaSha256.slice(0, 16)}`;
  }

  private async write(file: ActionsFile): Promise<void> {
    const valid = validateActionsFile(file, file.mediaSha256);
    const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
    if (bytes.length > ACTION_LIMITS.maxFileBytes) throw new Error(ACTIONS_ERRORS.full);
    await ensurePrivateDir(this.root).catch(mapFileError);
    await writePrivateFileAtomic(this.path(file.mediaSha256), bytes).catch(mapFileError);
  }

  private async mutate(mediaSha256: string, expectedRev: number | undefined, change: (file: ActionsFile | undefined, now: string) => ActionsFile | undefined): Promise<ActionsFile> {
    this.path(mediaSha256);
    if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0)) throw new Error(ACTIONS_ERRORS.stale);
    return withLock(this.lockName(mediaSha256), async () => {
      const current = await this.read(mediaSha256);
      if (expectedRev !== undefined && (current?.rev ?? 0) !== expectedRev) throw new Error(ACTIONS_ERRORS.stale);
      const draft = current ? structuredClone(current) : undefined;
      const next = change(draft, (this.options.now?.() ?? new Date()).toISOString());
      if (!next) return current!;
      next.rev = (current?.rev ?? 0) + 1;
      await this.write(next);
      return validateActionsFile(next, mediaSha256);
    }, this.options.lockTimeoutMs).catch(mapFileError);
  }
}

/** Marks one action open, done or dismissed (CAS on the file's rev when expectedRev is given). */
export const setActionStatus = (
  mediaSha256: string,
  actionId: string,
  status: ActionStatus,
  expectedRev?: number,
  store: ActionsStore = new ActionsStore()
): Promise<ActionsFile> => store.setStatus(mediaSha256, actionId, status, expectedRev);
