import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "../jobs/store";
import {
  TIME_ENTRY_VERSION,
  calculateHours,
  type TimeEntry,
  type TimeEntrySource,
  type TimeEntryStatus,
  validateActivityDate,
  validateTimeEntry,
  validateTimeEntryId
} from "./types";

const getStateRoot = (): string =>
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

export const getDefaultTimeEntryDir = (): string =>
  join(getStateRoot(), "recording-cli", "timesheet");

export const getTimeEntryStatusPath = (
  stateDir = getDefaultTimeEntryDir()
): string => join(dirname(stateDir), "timesheet-status.json");

export type TimeEntryCounts = {
  capturing: number;
  draft: number;
  ready: number;
  synced: number;
};

const localActivityDate = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid activity timestamp");
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const emptyConfidence = (): TimeEntry["confidence"] => ({
  client: 0,
  taskType: 0,
  description: 0
});

export class TimeEntryStore {
  constructor(readonly stateDir = getDefaultTimeEntryDir()) {}

  async create(input: {
    activityDate?: string;
    startAt?: string;
    endAt?: string;
    hours?: number;
    source: TimeEntrySource;
    status?: TimeEntryStatus;
    classificationStatus?: TimeEntry["classificationStatus"];
    clientCode?: string;
    clientName?: string;
    taskTypeId?: number;
    taskTypeName?: string;
    cardId?: string;
    description?: string;
  }): Promise<TimeEntry> {
    const now = new Date().toISOString();
    const activityDate = validateActivityDate(
      input.activityDate || localActivityDate(input.startAt || now)
    );
    const hours =
      input.startAt && input.endAt
        ? calculateHours(input.startAt, input.endAt)
        : input.hours;
    const entry = validateTimeEntry({
      version: TIME_ENTRY_VERSION,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      activityDate,
      startAt: input.startAt,
      endAt: input.endAt,
      hours,
      clientCode: input.clientCode,
      clientName: input.clientName,
      taskTypeId: input.taskTypeId,
      taskTypeName: input.taskTypeName,
      cardId: input.cardId,
      description: input.description,
      source: input.source,
      status: input.status || (input.endAt || input.hours ? "draft" : "capturing"),
      classificationStatus: input.classificationStatus || "pending",
      classificationSource:
        input.classificationStatus === "disabled" ? "manual" : undefined,
      confidence: emptyConfidence(),
      evidence: [],
      lockedFields: []
    });
    await this.write(entry);
    return entry;
  }

  async startCall(
    sessionId: string,
    app: "slack" | "zen" | "helium" | undefined,
    startAt: string
  ): Promise<TimeEntry> {
    const existing = (await this.list()).find(
      (entry) =>
        entry.status === "capturing" &&
        entry.source.kind === "call" &&
        entry.source.sessionId === sessionId
    );
    if (existing) return existing;
    return this.create({
      startAt,
      source: { kind: "call", sessionId, app },
      status: "capturing",
      classificationStatus: "pending"
    });
  }

  async finishCall(
    sessionId: string,
    endAt: string,
    recordingPath?: string,
    classificationStatus?: TimeEntry["classificationStatus"]
  ): Promise<TimeEntry | null> {
    const entry = (await this.list()).find(
      (candidate) =>
        candidate.source.kind === "call" &&
        candidate.source.sessionId === sessionId
    );
    if (!entry) return null;
    // A manual stop can finalize this call before the monitor sees it end.
    // Preserve its linked recording and any classification/review completed since.
    if (entry.endAt && entry.source.recordingPath &&
      (!recordingPath || resolve(recordingPath) === entry.source.recordingPath)) return entry;
    const finalEndAt = entry.endAt || endAt;
    return this.replace({
      ...entry,
      endAt: finalEndAt,
      hours: entry.startAt ? calculateHours(entry.startAt, finalEndAt) : entry.hours,
      source: {
        ...entry.source,
        recordingPath: recordingPath ? resolve(recordingPath) : entry.source.recordingPath
      },
      status: "draft",
      classificationStatus:
        classificationStatus ||
        (recordingPath ? "pending" : entry.classificationStatus),
      updatedAt: new Date().toISOString()
    });
  }

  async startRecording(
    recordingPath: string,
    startAt: string
  ): Promise<TimeEntry> {
    const resolvedPath = resolve(recordingPath);
    const existing = (await this.list()).find(
      (entry) =>
        entry.status === "capturing" &&
        entry.source.kind === "manual" &&
        entry.source.recordingPath === resolvedPath
    );
    if (existing) return existing;
    return this.create({
      startAt,
      source: { kind: "manual", recordingPath: resolvedPath },
      status: "capturing",
      classificationStatus: "pending"
    });
  }

  async finishRecording(
    recordingPath: string,
    endAt: string,
    finalRecordingPath = recordingPath
  ): Promise<TimeEntry | null> {
    const resolvedPath = resolve(recordingPath);
    const entry = (await this.list()).find(
      (candidate) =>
        candidate.status === "capturing" &&
        candidate.source.kind === "manual" &&
        candidate.source.recordingPath === resolvedPath
    );
    if (!entry) return null;
    return this.replace({
      ...entry,
      endAt,
      hours: entry.startAt ? calculateHours(entry.startAt, endAt) : entry.hours,
      source: {
        ...entry.source,
        recordingPath: resolve(finalRecordingPath)
      },
      status: "draft",
      classificationStatus: "pending",
      updatedAt: new Date().toISOString()
    });
  }

  async findForJob(jobId: string, recordingPath: string): Promise<TimeEntry | null> {
    const resolvedRecording = resolve(recordingPath);
    const matches = (await this.list()).filter(
      (entry) =>
        entry.source.jobId === jobId ||
        (entry.source.recordingPath &&
          resolve(entry.source.recordingPath) === resolvedRecording)
    );
    return (
      matches.find((entry) => !entry.splitGroupId) ||
      matches.find((entry) => entry.splitIndex === 1) ||
      matches[0] ||
      null
    );
  }

  async linkJob(
    entryId: string,
    jobId: string,
    recordingPath: string
  ): Promise<TimeEntry> {
    const entry = await this.get(entryId);
    return this.replace({
      ...entry,
      source: {
        ...entry.source,
        jobId,
        recordingPath: resolve(recordingPath)
      },
      updatedAt: new Date().toISOString()
    });
  }

  async get(id: string): Promise<TimeEntry> {
    validateTimeEntryId(id);
    const raw = await fs.readFile(join(this.stateDir, `${id}.json`), "utf-8");
    return validateTimeEntry(JSON.parse(raw));
  }

  async list(): Promise<TimeEntry[]> {
    try {
      const names = (await fs.readdir(this.stateDir))
        .filter((name) => name.endsWith(".json"))
        .slice(0, 100_000);
      const entries = await Promise.all(
        names.map((name) => this.get(name.slice(0, -5)))
      );
      return entries.sort(
        (left, right) =>
          right.activityDate.localeCompare(left.activityDate) ||
          (right.startAt || right.createdAt).localeCompare(
            left.startAt || left.createdAt
          )
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async replace(entry: TimeEntry): Promise<TimeEntry> {
    const validated = validateTimeEntry(entry);
    await this.write(validated);
    return validated;
  }

  async remove(id: string): Promise<void> {
    validateTimeEntryId(id);
    await fs.rm(join(this.stateDir, `${id}.json`), { force: true });
    await this.writeCounts();
  }

  async counts(): Promise<TimeEntryCounts> {
    const entries = await this.list();
    return {
      capturing: entries.filter((entry) => entry.status === "capturing").length,
      draft: entries.filter((entry) => entry.status === "draft").length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      synced: entries.filter((entry) => entry.status === "synced").length
    };
  }

  private async write(entry: TimeEntry): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.stateDir, `${entry.id}.json`), entry);
    await this.writeCounts();
  }

  private async writeCounts(): Promise<void> {
    const counts = await this.countsWithoutStatusWrite();
    await fs.mkdir(dirname(getTimeEntryStatusPath(this.stateDir)), {
      recursive: true,
      mode: 0o700
    });
    await writeJsonAtomic(getTimeEntryStatusPath(this.stateDir), counts);
  }

  private async countsWithoutStatusWrite(): Promise<TimeEntryCounts> {
    const entries = await this.list();
    return {
      capturing: entries.filter((entry) => entry.status === "capturing").length,
      draft: entries.filter((entry) => entry.status === "draft").length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      synced: entries.filter((entry) => entry.status === "synced").length
    };
  }
}

export const readTimeEntryCounts = async (): Promise<TimeEntryCounts> => {
  try {
    const value = JSON.parse(
      await fs.readFile(getTimeEntryStatusPath(), "utf-8")
    ) as TimeEntryCounts;
    for (const field of ["capturing", "draft", "ready", "synced"] as const) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
        throw new Error("Invalid timesheet status");
      }
    }
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { capturing: 0, draft: 0, ready: 0, synced: 0 };
    }
    throw err;
  }
};
