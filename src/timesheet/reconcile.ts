import { promises as fs } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import type { JobRecord } from "../jobs/types";
import { validateSummary, validateTranscript } from "../jobs/types";
import { loadTimesheetContext } from "./context";
import {
  applyTimeEntrySuggestion,
  classifyTimeEntry,
  deriveTimeEntryStatus
} from "./classification";
import { notifyTimeEntryClassified } from "./notifier";
import { TimeEntryStore } from "./store";
import type { TimeEntry } from "./types";
import { hasSavedRevision } from "../revisions/service";
import { withRevisionLease, RevisionConflictError } from "../revisions";

const assertOriginalClassification = async (jobId: string): Promise<void> => {
  if (await hasSavedRevision(jobId)) throw new RevisionConflictError("A gravação tem revisão humana. A classificação legada foi preservada; não será refeita com artefatos originais desatualizados.");
};

const MAX_TRANSCRIPT_JSON_BYTES = 12 * 1024 * 1024;
const MAX_SUMMARY_JSON_BYTES = 2 * 1024 * 1024;

const sanitizeError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err))
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, 1_000);

const readArtifactJson = async (
  record: JobRecord,
  name: "transcript.json" | "summary.json",
  maximumBytes: number
): Promise<unknown> => {
  const expectedArtifactDir = join(
    dirname(record.sourcePath),
    `${parse(record.sourcePath).name}.recording`,
    record.id
  );
  if (resolve(record.artifactDir) !== resolve(expectedArtifactDir)) {
    throw new Error("Job artifact path does not match its recording");
  }
  const path = join(record.artifactDir, name);
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error(`${name} is not a safe bounded regular file`);
  }
  const [realArtifactDir, realPath] = await Promise.all([
    fs.realpath(record.artifactDir),
    fs.realpath(path)
  ]);
  if (dirname(realPath) !== realArtifactDir) {
    throw new Error("Job artifact path does not match its recording");
  }
  return JSON.parse(await fs.readFile(realPath, "utf-8"));
};

const markClassificationFailed = async (
  config: AppConfig,
  store: TimeEntryStore,
  entry: TimeEntry,
  err: unknown
): Promise<TimeEntry> => {
  const current = await store.get(entry.id);
  const updated: TimeEntry = {
    ...current,
    classificationStatus: "failed",
    classificationError: sanitizeError(err),
    updatedAt: new Date().toISOString()
  };
  try {
    updated.status = deriveTimeEntryStatus(
      updated,
      await loadTimesheetContext(config),
      config.timesheet.readyConfidence
    );
  } catch {
    updated.status = updated.status === "capturing" ? "capturing" : "draft";
  }
  return store.replace(updated);
};

export const reconcileTimeEntryForJob = async (
  config: AppConfig,
  record: JobRecord,
  store = new TimeEntryStore(),
  options: { force?: boolean; notify?: boolean } = {}
): Promise<TimeEntry | null> => {
  if (!config.timesheet.enabled || record.state !== "completed") return null;
  await assertOriginalClassification(record.id);
  let entry = await store.findForJob(record.id, record.sourcePath);
  if (!entry) return null;
  if (entry.splitGroupId) return entry;
  if (!entry.source.jobId) {
    entry = await withRevisionLease(record.id, async () => {
      await assertOriginalClassification(record.id);
      return store.linkJob(entry!.id, record.id, record.sourcePath);
    });
  }
  if (
    !options.force &&
    entry.classificationStatus === "completed" &&
    entry.source.jobId === record.id
  ) {
    return entry;
  }
  try {
    const [context, transcriptValue, summaryValue] = await Promise.all([
      loadTimesheetContext(config),
      readArtifactJson(
        record,
        "transcript.json",
        MAX_TRANSCRIPT_JSON_BYTES
      ),
      readArtifactJson(record, "summary.json", MAX_SUMMARY_JSON_BYTES)
    ]);
    const transcript = validateTranscript(transcriptValue);
    const summary = validateSummary(
      summaryValue,
      record.summary.provider,
      record.summary.model
    );
    await assertOriginalClassification(record.id);
    const suggestion = await classifyTimeEntry(
      config,
      entry,
      summary,
      transcript,
      context
    );
    const saved = await withRevisionLease(record.id, async () => {
    await assertOriginalClassification(record.id);
    const current = await store.get(entry.id);
    const updated = applyTimeEntrySuggestion(
      current,
      suggestion,
      context,
      config.timesheet.readyConfidence
    );
    return store.replace(updated);
    });
    if (options.notify !== false) {
      await notifyTimeEntryClassified(saved).catch(() => undefined);
    }
    return saved;
  } catch (err) {
    if (err instanceof RevisionConflictError) throw err;
    const failed = await withRevisionLease(record.id, async () => {
      await assertOriginalClassification(record.id);
      return markClassificationFailed(config, store, entry, err);
    });
    console.error(JSON.stringify({
      event: "timesheet.classification-failed",
      entryId: failed.id,
      jobId: record.id,
      error: failed.classificationError
    }));
    return failed;
  }
};
