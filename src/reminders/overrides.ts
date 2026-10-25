// Per-meeting decisions made from a reminder (or the tray/Studio): "skip" the automatic recording
// of one meeting, or "record" one that would not be recorded. The call monitor reads them when a
// call starts; it watches the state directory, so the file name is exported for its filter.
import { join } from "node:path";
import {
  ensurePrivateDirectory, isIsoTime, isRecord, parseJson, PrivateFileError, readPrivateFile, recordingStateDir, singleLine,
  type LockOptions, withPrivateLock, writePrivateFile
} from "../runtime/private-file";

export const MEETING_OVERRIDES_FILE = "meeting-overrides.json";

export const MEETING_OVERRIDE_DECISIONS = ["skip", "record"] as const;
export type MeetingOverrideDecision = (typeof MEETING_OVERRIDE_DECISIONS)[number];

export type MeetingOverride = {
  eventIdHash: string;
  title: string;
  startAt: string;
  endAt: string;
  decision: MeetingOverrideDecision;
  createdAt: string;
  /** endAt + the after-end grace; pruned from then on. */
  expiresAt: string;
};

export type MeetingOverridesFile = { version: 1; entries: MeetingOverride[] };

/** A decision applies from 10 minutes before the meeting until 15 minutes after it ends. */
export const OVERRIDE_WINDOW = { beforeStartMs: 10 * 60_000, afterEndMs: 15 * 60_000 } as const;

export const OVERRIDE_LIMITS = {
  maxEntries: 100,
  maxBytes: 128 * 1024,
  maxDurationMs: 24 * 60 * 60_000,
  maxAheadMs: 14 * 24 * 60 * 60_000,
  titleLength: 160
} as const;

export const OVERRIDE_ERRORS = {
  invalidFile: "O arquivo meeting-overrides.json do FalaTrace é inválido; apague-o para continuar.",
  unsafeFile: "O arquivo meeting-overrides.json do FalaTrace não é um arquivo comum; remova-o para continuar.",
  invalidMeeting: "Dados da reunião inválidos para esta escolha.",
  invalidDecision: "Escolha inválida para a reunião; use gravar ou pular.",
  ended: "Esta reunião já terminou; a escolha não vale mais.",
  tooFar: "Só é possível escolher para reuniões das próximas duas semanas.",
  busy: "Outra janela está salvando escolhas de reunião; tente de novo."
} as const;

export const OVERRIDE_KNOWN_ERRORS: readonly string[] = Object.values(OVERRIDE_ERRORS);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_NAME = "meeting-overrides";

export type MeetingOverridesOptions = {
  stateDir?: string;
  now?: Date;
  lockOptions?: LockOptions;
};

export const meetingOverridesPath = (stateDir = recordingStateDir()): string => join(stateDir, MEETING_OVERRIDES_FILE);

const nowMs = (now?: Date): number => {
  const value = now instanceof Date ? now.getTime() : Date.now();
  if (!Number.isFinite(value)) throw new Error(OVERRIDE_ERRORS.invalidMeeting);
  return value;
};

const validEntry = (value: unknown): MeetingOverride | undefined => {
  if (!isRecord(value)) return undefined;
  const { eventIdHash, title, startAt, endAt, decision, createdAt, expiresAt } = value;
  if (typeof eventIdHash !== "string" || !HASH_PATTERN.test(eventIdHash)) return undefined;
  if (typeof title !== "string" || !title || singleLine(title, OVERRIDE_LIMITS.titleLength) !== title) return undefined;
  if (decision !== "skip" && decision !== "record") return undefined;
  if (!isIsoTime(startAt) || !isIsoTime(endAt) || !isIsoTime(createdAt) || !isIsoTime(expiresAt)) return undefined;
  const start = Date.parse(startAt), end = Date.parse(endAt), expires = Date.parse(expiresAt);
  if (end <= start || end - start > OVERRIDE_LIMITS.maxDurationMs || expires < end || expires - end > OVERRIDE_LIMITS.maxDurationMs) return undefined;
  return {
    eventIdHash, title, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), decision,
    createdAt: new Date(Date.parse(createdAt)).toISOString(), expiresAt: new Date(expires).toISOString()
  };
};

/** Strict check of the whole file; one bad entry makes it invalid. */
export const validateMeetingOverridesFile = (value: unknown): MeetingOverridesFile => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > OVERRIDE_LIMITS.maxEntries) {
    throw new Error(OVERRIDE_ERRORS.invalidFile);
  }
  const seen = new Set<string>();
  const entries = value.entries.map((raw) => {
    const entry = validEntry(raw);
    if (!entry || seen.has(entry.eventIdHash)) throw new Error(OVERRIDE_ERRORS.invalidFile);
    seen.add(entry.eventIdHash);
    return entry;
  });
  return { version: 1, entries };
};

const readFile = async (path: string): Promise<MeetingOverridesFile> => {
  let text: string | undefined;
  try {
    text = await readPrivateFile(path, OVERRIDE_LIMITS.maxBytes);
  } catch (error) {
    if (error instanceof PrivateFileError) throw new Error(error.problem === "unsafe" ? OVERRIDE_ERRORS.unsafeFile : OVERRIDE_ERRORS.invalidFile);
    throw error;
  }
  if (text === undefined) return { version: 1, entries: [] };
  return validateMeetingOverridesFile(parseJson(text));
};

const byStart = (a: MeetingOverride, b: MeetingOverride): number =>
  Date.parse(a.startAt) - Date.parse(b.startAt) || (a.eventIdHash < b.eventIdHash ? -1 : a.eventIdHash > b.eventIdHash ? 1 : 0);

const unexpired = (entries: MeetingOverride[], now: number): MeetingOverride[] => entries.filter((entry) => Date.parse(entry.expiresAt) >= now);

/** Decisions that have not expired yet, soonest meeting first. A missing file means none. */
export const readMeetingOverrides = async (options: MeetingOverridesOptions = {}): Promise<MeetingOverridesFile> => {
  const file = await readFile(meetingOverridesPath(options.stateDir));
  return { version: 1, entries: unexpired(file.entries, nowMs(options.now)).sort(byStart) };
};

const mutate = async <T>(
  options: MeetingOverridesOptions,
  change: (entries: MeetingOverride[], now: number, stored: number) => { entries: MeetingOverride[]; result: T }
): Promise<T> => {
  const stateDir = options.stateDir ?? recordingStateDir();
  const path = meetingOverridesPath(stateDir);
  return withPrivateLock(LOCK_NAME, OVERRIDE_ERRORS.busy, async () => {
    const now = nowMs(options.now);
    const current = await readFile(path);
    const { entries, result } = change(unexpired(current.entries, now), now, current.entries.length);
    const next = entries.sort(byStart);
    // Unchanged content is not rewritten, so a read-only check never touches the disk.
    if (JSON.stringify(next) !== JSON.stringify(current.entries)) {
      try {
        await ensurePrivateDirectory(stateDir);
        await writePrivateFile(path, `${JSON.stringify({ version: 1, entries: next } satisfies MeetingOverridesFile, null, 2)}\n`, OVERRIDE_LIMITS.maxBytes);
      } catch (error) {
        if (error instanceof PrivateFileError) throw new Error(OVERRIDE_ERRORS.unsafeFile);
        throw error;
      }
    }
    return result;
  }, options.lockOptions);
};

export type MeetingOverrideInput = {
  eventIdHash: string;
  title: string;
  startAt: string;
  endAt: string;
  decision: MeetingOverrideDecision;
};

/**
 * Record (or replace) the decision for one meeting occurrence. Refused once the meeting is over or
 * when it is more than two weeks away. Expired decisions are pruned on the way.
 */
export const setMeetingOverride = async (input: MeetingOverrideInput, options: MeetingOverridesOptions = {}): Promise<MeetingOverride> => {
  if (!isRecord(input)) throw new Error(OVERRIDE_ERRORS.invalidMeeting);
  if (input.decision !== "skip" && input.decision !== "record") throw new Error(OVERRIDE_ERRORS.invalidDecision);
  const title = typeof input.title === "string" ? singleLine(input.title, OVERRIDE_LIMITS.titleLength) : "";
  const start = isIsoTime(input.startAt) ? Date.parse(input.startAt) : Number.NaN;
  const end = isIsoTime(input.endAt) ? Date.parse(input.endAt) : Number.NaN;
  if (typeof input.eventIdHash !== "string" || !HASH_PATTERN.test(input.eventIdHash) || !title ||
    !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > OVERRIDE_LIMITS.maxDurationMs) {
    throw new Error(OVERRIDE_ERRORS.invalidMeeting);
  }
  const decision = input.decision;
  const eventIdHash = input.eventIdHash;
  return mutate(options, (entries, now) => {
    if (end + OVERRIDE_WINDOW.afterEndMs < now) throw new Error(OVERRIDE_ERRORS.ended);
    if (start - now > OVERRIDE_LIMITS.maxAheadMs) throw new Error(OVERRIDE_ERRORS.tooFar);
    const entry: MeetingOverride = {
      eventIdHash, title, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), decision,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(end + OVERRIDE_WINDOW.afterEndMs).toISOString()
    };
    const others = entries.filter((existing) => existing.eventIdHash !== eventIdHash).sort(byStart);
    // Over the cap, the meetings furthest away give way: they are the least likely to be needed soon.
    while (others.length >= OVERRIDE_LIMITS.maxEntries) others.pop();
    const kept = [...others, entry];
    return { entries: kept, result: entry };
  });
};

/** Forget the decision for one meeting. True when there was one. */
export const clearMeetingOverride = async (eventIdHash: string, options: MeetingOverridesOptions = {}): Promise<boolean> => {
  if (typeof eventIdHash !== "string" || !HASH_PATTERN.test(eventIdHash)) throw new Error(OVERRIDE_ERRORS.invalidMeeting);
  return mutate(options, (entries) => {
    const kept = entries.filter((entry) => entry.eventIdHash !== eventIdHash);
    return { entries: kept, result: kept.length !== entries.length };
  });
};

/** Drop expired decisions from the file. Returns how many were removed. */
export const pruneMeetingOverrides = async (options: MeetingOverridesOptions = {}): Promise<number> =>
  mutate(options, (entries, _now, stored) => ({ entries, result: stored - entries.length }));

/** Whether `now` falls in the decision's window: [startAt − 10 min, endAt + 15 min]. */
export const overrideCovers = (entry: MeetingOverride, now: number): boolean =>
  now >= Date.parse(entry.startAt) - OVERRIDE_WINDOW.beforeStartMs && now <= Date.parse(entry.endAt) + OVERRIDE_WINDOW.afterEndMs;

/**
 * The decision that applies at `now`. With overlapping windows, a meeting in progress wins over
 * one that just ended or is about to start, then the closest start, then the latest decision.
 */
export const pickActiveOverride = (entries: readonly MeetingOverride[], now: number): MeetingOverride | undefined => {
  const inProgress = (entry: MeetingOverride): number => (now >= Date.parse(entry.startAt) && now <= Date.parse(entry.endAt) ? 0 : 1);
  return entries
    .filter((entry) => overrideCovers(entry, now))
    .sort((a, b) => inProgress(a) - inProgress(b) ||
      Math.abs(Date.parse(a.startAt) - now) - Math.abs(Date.parse(b.startAt) - now) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
};

/** The decision for the meeting happening now, if any. Throws a known error when the file is damaged. */
export const activeOverride = async (now: Date = new Date(), options: Omit<MeetingOverridesOptions, "now"> = {}): Promise<MeetingOverride | undefined> => {
  const file = await readMeetingOverrides({ ...options, now });
  return pickActiveOverride(file.entries, nowMs(now));
};
