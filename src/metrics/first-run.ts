// First-run milestones, kept only on this computer: when the setup wizard opened and finished,
// the first recording and the first summary. Each milestone is written once (the first time
// wins), so "time to first summary" measures the real first experience.
import { join } from "node:path";
import {
  ensurePrivateDirectory, isIsoTime, isRecord, parseJson, PrivateFileError, readPrivateFile, recordingStateDir,
  type LockOptions, withPrivateLock, writePrivateFile
} from "../runtime/private-file";

export const FIRST_RUN_EVENTS = ["wizardOpened", "wizardFinished", "firstRecording", "firstSummary"] as const;
export type FirstRunEvent = (typeof FIRST_RUN_EVENTS)[number];

export type FirstRunMetrics = {
  version: 1;
  wizardOpenedAt?: string;
  wizardFinishedAt?: string;
  firstRecordingAt?: string;
  firstSummaryAt?: string;
};

const FIELDS: Record<FirstRunEvent, Exclude<keyof FirstRunMetrics, "version">> = {
  wizardOpened: "wizardOpenedAt",
  wizardFinished: "wizardFinishedAt",
  firstRecording: "firstRecordingAt",
  firstSummary: "firstSummaryAt"
};

export const FIRST_RUN_ERRORS = {
  invalidEvent: "Marco de primeiro uso inválido.",
  invalidTime: "Horário inválido para o marco de primeiro uso.",
  unsafeFile: "O arquivo first-run.json do FalaTrace não é um arquivo comum; remova-o para continuar.",
  busy: "Outro processo está salvando os marcos de primeiro uso; tente de novo."
} as const;

export const FIRST_RUN_KNOWN_ERRORS: readonly string[] = Object.values(FIRST_RUN_ERRORS);

const MAX_BYTES = 4 * 1024;
const LOCK_NAME = "first-run-metrics";
const EARLIEST = Date.parse("2020-01-01T00:00:00.000Z");
const LATEST = Date.parse("2100-01-01T00:00:00.000Z");

export type FirstRunOptions = { stateDir?: string; lockOptions?: LockOptions };

export const firstRunPath = (stateDir = recordingStateDir()): string => join(stateDir, "first-run.json");

const validTime = (value: unknown): value is string => isIsoTime(value) && Date.parse(value) >= EARLIEST && Date.parse(value) < LATEST;

/**
 * Rebuild the record field by field. Unknown fields are dropped and an invalid milestone is
 * treated as never recorded: these are local measurements, never a reason to fail the app.
 */
export const validateFirstRunMetrics = (value: unknown): FirstRunMetrics => {
  const metrics: FirstRunMetrics = { version: 1 };
  if (!isRecord(value) || value.version !== 1) return metrics;
  for (const field of Object.values(FIELDS)) {
    const time = value[field];
    if (validTime(time)) metrics[field] = new Date(Date.parse(time)).toISOString();
  }
  return metrics;
};

const read = async (path: string): Promise<FirstRunMetrics> => {
  try {
    const text = await readPrivateFile(path, MAX_BYTES);
    return validateFirstRunMetrics(text === undefined ? undefined : parseJson(text));
  } catch (error) {
    if (error instanceof PrivateFileError) {
      if (error.problem === "unsafe") throw new Error(FIRST_RUN_ERRORS.unsafeFile);
      return { version: 1 };
    }
    throw error;
  }
};

/** The milestones recorded so far (an empty record when none or when the file is damaged). */
export const readFirstRun = async (options: FirstRunOptions = {}): Promise<FirstRunMetrics> => read(firstRunPath(options.stateDir));

/**
 * Record a milestone unless it is already there (the first write wins). Atomic, and serialised
 * with other processes, so two windows reporting at once keep the earlier writer's time.
 */
export const markFirstRun = async (event: FirstRunEvent, at: Date = new Date(), options: FirstRunOptions = {}): Promise<FirstRunMetrics> => {
  const field = (FIRST_RUN_EVENTS as readonly string[]).includes(event) ? FIELDS[event] : undefined;
  if (!field) throw new Error(FIRST_RUN_ERRORS.invalidEvent);
  const time = at instanceof Date ? at.getTime() : Number.NaN;
  if (!Number.isFinite(time) || time < EARLIEST || time >= LATEST) throw new Error(FIRST_RUN_ERRORS.invalidTime);
  const stateDir = options.stateDir ?? recordingStateDir();
  const path = firstRunPath(stateDir);
  return withPrivateLock(LOCK_NAME, FIRST_RUN_ERRORS.busy, async () => {
    const current = await read(path);
    if (current[field]) return current;
    const next: FirstRunMetrics = { ...current, [field]: new Date(time).toISOString() };
    try {
      await ensurePrivateDirectory(stateDir);
      await writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`, MAX_BYTES);
    } catch (error) {
      if (error instanceof PrivateFileError) throw new Error(FIRST_RUN_ERRORS.unsafeFile);
      throw error;
    }
    return next;
  }, options.lockOptions);
};

/** Milliseconds from opening the wizard to the first summary, or null until both are known (or when out of order). */
export const firstSummaryDelayMs = (metrics: FirstRunMetrics): number | null => {
  if (!metrics.wizardOpenedAt || !metrics.firstSummaryAt) return null;
  const delay = Date.parse(metrics.firstSummaryAt) - Date.parse(metrics.wizardOpenedAt);
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
};

/** Time to first summary, read from the milestones file (or from `options.metrics` when already read). */
export const timeToFirstSummary = async (options: FirstRunOptions & { metrics?: FirstRunMetrics } = {}): Promise<number | null> =>
  firstSummaryDelayMs(options.metrics ?? await readFirstRun(options));
