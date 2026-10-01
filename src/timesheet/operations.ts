import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/defaults";
import { refreshAiContextIfEnabled } from "../knowledge/context";
import { allocateActivityHours, buildActivityPlan } from "./allocation";
import { findClient, findTaskType, loadTimesheetContext } from "./context";
import { deriveTimeEntryStatus } from "./classification";
import { TimeEntryStore } from "./store";
import {
  calculateHours,
  type TimeEntry,
  type TimeEntryEditableField,
  validateActivityDate,
  validateCardId,
  validateTimeEntry
} from "./types";

const roundHours = (value: number): number => Math.round(value * 100) / 100;

const parseHours = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const normalized = roundHours(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 24) {
    throw new Error("Hours must be greater than 0 and at most 24");
  }
  return normalized;
};

export const localDateFromTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid timestamp");
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const parseLocalDateTime = (date: string, time: string): string => {
  validateActivityDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    throw new Error("Time must use HH:MM or HH:MM:SS");
  }
  const parsed = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid local date and time");
  return parsed.toISOString();
};

export type TimeEntryChanges = {
  activityDate?: string;
  client?: string | null;
  taskType?: string | number | null;
  startAt?: string | null;
  endAt?: string | null;
  hours?: number | null;
  cardId?: string | null;
  description?: string | null;
};

const addLocked = (
  current: TimeEntryEditableField[],
  field: TimeEntryEditableField
): TimeEntryEditableField[] =>
  current.includes(field) ? current : [...current, field];

export const updateTimeEntry = async (
  config: AppConfig,
  store: TimeEntryStore,
  id: string,
  changes: TimeEntryChanges
): Promise<TimeEntry> => {
  const context = await loadTimesheetContext(config);
  const current = await store.get(id);
  let updated: TimeEntry = { ...current, lockedFields: [...current.lockedFields] };

  if (changes.activityDate !== undefined) {
    updated.activityDate = validateActivityDate(changes.activityDate);
    const clock = (timestamp: string): string => {
      const date = new Date(timestamp);
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    if (updated.startAt) {
      updated.startAt = parseLocalDateTime(updated.activityDate, clock(updated.startAt));
    }
    if (updated.endAt) {
      updated.endAt = parseLocalDateTime(updated.activityDate, clock(updated.endAt));
      if (
        updated.startAt &&
        new Date(updated.endAt).getTime() <= new Date(updated.startAt).getTime()
      ) {
        updated.endAt = new Date(
          new Date(updated.endAt).getTime() + 24 * 60 * 60 * 1_000
        ).toISOString();
      }
    }
  }
  if (changes.client !== undefined) {
    const client = changes.client === null ? undefined : findClient(context, changes.client);
    if (changes.client !== null && !client) throw new Error("Unknown client");
    updated.clientCode = client?.code;
    updated.clientName = client?.name;
    updated.confidence = { ...updated.confidence, client: client ? 1 : 0 };
    updated.lockedFields = addLocked(updated.lockedFields, "client");
  }
  if (changes.taskType !== undefined) {
    const taskType =
      changes.taskType === null ? undefined : findTaskType(context, changes.taskType);
    if (changes.taskType !== null && !taskType) throw new Error("Unknown task type");
    updated.taskTypeId = taskType?.id;
    updated.taskTypeName = taskType?.name;
    updated.confidence = { ...updated.confidence, taskType: taskType ? 1 : 0 };
    updated.lockedFields = addLocked(updated.lockedFields, "taskType");
  }
  if (changes.startAt !== undefined) {
    updated.startAt = changes.startAt || undefined;
    updated.lockedFields = addLocked(updated.lockedFields, "start");
  }
  if (changes.endAt !== undefined) {
    updated.endAt = changes.endAt || undefined;
    updated.lockedFields = addLocked(updated.lockedFields, "end");
  }
  if (changes.hours !== undefined) {
    updated.hours = changes.hours === null ? undefined : parseHours(changes.hours);
    updated.lockedFields = addLocked(updated.lockedFields, "hours");
  }
  if (changes.cardId !== undefined) {
    updated.cardId =
      changes.cardId === null || !changes.cardId.trim()
        ? undefined
        : validateCardId(changes.cardId);
    updated.lockedFields = addLocked(updated.lockedFields, "card");
  }
  if (changes.description !== undefined) {
    const description = changes.description?.trim() || undefined;
    if (description && (description.length > 5_000 || /[\0]/.test(description))) {
      throw new Error("Description must contain at most 5000 characters");
    }
    updated.description = description;
    updated.confidence = {
      ...updated.confidence,
      description: description ? 1 : 0
    };
    updated.lockedFields = addLocked(updated.lockedFields, "description");
  }
  if (updated.startAt && updated.endAt) {
    updated.hours = calculateHours(updated.startAt, updated.endAt);
  } else if (updated.hours !== undefined) {
    updated.hours = parseHours(updated.hours);
  }
  if (
    changes.client !== undefined ||
    changes.taskType !== undefined ||
    changes.startAt !== undefined ||
    changes.endAt !== undefined ||
    changes.cardId !== undefined ||
    changes.description !== undefined
  ) {
    updated.activityPlan = undefined;
  }
  updated.updatedAt = new Date().toISOString();
  updated.status = deriveTimeEntryStatus(
    updated,
    context,
    config.timesheet.readyConfidence
  );
  const saved = await store.replace(updated);
  await refreshAiContextIfEnabled(config);
  return saved;
};

export const startManualTimer = async (
  config: AppConfig,
  store: TimeEntryStore,
  changes: Pick<TimeEntryChanges, "client" | "taskType" | "cardId" | "description"> = {}
): Promise<TimeEntry> => {
  const active = (await store.list()).find(
    (entry) => entry.status === "capturing" && entry.source.kind === "timer"
  );
  if (active) throw new Error(`A manual timer is already active: ${active.id}`);
  const now = new Date().toISOString();
  const entry = await store.create({
    startAt: now,
    source: { kind: "timer" },
    status: "capturing",
    classificationStatus: "disabled"
  });
  return updateTimeEntry(config, store, entry.id, changes);
};

export const stopManualTimer = async (
  config: AppConfig,
  store: TimeEntryStore,
  changes: Pick<TimeEntryChanges, "client" | "taskType" | "cardId" | "description"> = {}
): Promise<TimeEntry> => {
  const active = (await store.list()).find(
    (entry) => entry.status === "capturing" && entry.source.kind === "timer"
  );
  if (!active) throw new Error("No manual timer is active");
  const endAt = new Date().toISOString();
  const ended = await store.replace({
    ...active,
    endAt,
    hours: calculateHours(active.startAt!, endAt),
    status: "draft",
    updatedAt: new Date().toISOString()
  });
  return updateTimeEntry(config, store, ended.id, changes);
};

export const addManualTimeEntry = async (
  config: AppConfig,
  store: TimeEntryStore,
  changes: TimeEntryChanges
): Promise<TimeEntry> => {
  const now = new Date().toISOString();
  const entry = await store.create({
    activityDate: changes.activityDate || localDateFromTimestamp(now),
    startAt: changes.startAt || undefined,
    endAt: changes.endAt || undefined,
    hours: changes.hours || undefined,
    source: { kind: "manual" },
    status: "draft",
    classificationStatus: "disabled"
  });
  return updateTimeEntry(config, store, entry.id, changes);
};

const splitLockedFields: TimeEntryEditableField[] = [
  "client",
  "taskType",
  "start",
  "end",
  "hours",
  "card",
  "description"
];

export const splitTimeEntry = async (
  config: AppConfig,
  store: TimeEntryStore,
  id: string
): Promise<TimeEntry[]> => {
  const [entry, context] = await Promise.all([
    store.get(id),
    loadTimesheetContext(config)
  ]);
  if (entry.status === "capturing" || entry.status === "synced") {
    throw new Error("Capturing or synced time entries cannot be split");
  }
  if (entry.splitGroupId) {
    throw new Error("This time entry has already been split");
  }
  if (!entry.activityPlan || entry.activityPlan.activities.length < 2) {
    throw new Error("This time entry does not have multiple detected activities");
  }
  if (entry.hours === undefined) {
    throw new Error("The detected activities do not have reliable time intervals");
  }
  const verifiedPlan = buildActivityPlan(
    entry.activityPlan.activities,
    entry.hours,
    config.timesheet.readyConfidence
  );
  if (!verifiedPlan?.splittable) {
    throw new Error("The detected activities do not have reliable time intervals");
  }
  const hours = allocateActivityHours(verifiedPlan, entry.hours);
  const now = new Date().toISOString();
  const splitCount = verifiedPlan.activities.length;
  const entries = verifiedPlan.activities.map(
    (activity, index): TimeEntry => {
      const client = activity.clientCode
        ? context.clients.find((item) => item.code === activity.clientCode)
        : undefined;
      const taskType = activity.taskTypeId
        ? context.taskTypes.find((item) => item.id === activity.taskTypeId)
        : undefined;
      const candidate: TimeEntry = {
        ...entry,
        id: index === 0 ? entry.id : randomUUID(),
        createdAt: index === 0 ? entry.createdAt : now,
        updatedAt: now,
        startAt: undefined,
        endAt: undefined,
        hours: hours[index],
        clientCode: client?.code,
        clientName: client?.name,
        taskTypeId: taskType?.id,
        taskTypeName: taskType?.name,
        cardId: activity.cardId,
        description: activity.description,
        status: "draft",
        classificationStatus: "completed",
        confidence: {
          client: activity.confidence.client,
          taskType: activity.confidence.taskType,
          description: activity.confidence.description
        },
        evidence: [
          ...activity.evidence,
          `Divisão confirmada pelo usuário a partir do apontamento ${entry.id}.`
        ],
        lockedFields: splitLockedFields,
        classificationError: undefined,
        activityPlan: undefined,
        splitGroupId: entry.id,
        splitIndex: index + 1,
        splitCount
      };
      candidate.status = deriveTimeEntryStatus(
        candidate,
        context,
        config.timesheet.readyConfidence
      );
      return validateTimeEntry(candidate);
    }
  );

  const createdIds: string[] = [];
  try {
    for (const splitEntry of entries.slice(1)) {
      await store.replace(splitEntry);
      createdIds.push(splitEntry.id);
    }
    await store.replace(entries[0]);
  } catch (err) {
    await Promise.all(
      createdIds.map((createdId) =>
        store.remove(createdId).catch(() => undefined)
      )
    );
    throw err;
  }
  await refreshAiContextIfEnabled(config);
  return entries;
};
