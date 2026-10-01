export const TIME_ENTRY_VERSION = 1 as const;

// New installations supply their own catalog; existing persisted numeric IDs remain unchanged.
export const DEFAULT_TASK_TYPES: readonly TimesheetTaskType[] = [];

export type TimeEntryStatus = "capturing" | "draft" | "ready" | "synced";
export type TimeEntryClassificationStatus =
  | "pending"
  | "completed"
  | "failed"
  | "disabled";
export type TimeEntryClassificationSource = "openai" | "rules" | "manual";
export type TimeEntrySourceKind = "call" | "timer" | "manual";
export type TimeEntryEditableField =
  | "client"
  | "taskType"
  | "start"
  | "end"
  | "hours"
  | "card"
  | "description";

export type TimeEntrySource = {
  kind: TimeEntrySourceKind;
  app?: "slack" | "zen" | "helium";
  sessionId?: string;
  recordingPath?: string;
  jobId?: string;
};

export type TimeEntryConfidence = {
  client: number;
  taskType: number;
  description: number;
};

export type TimeEntryActivityConfidence = TimeEntryConfidence & {
  timing: number;
};

export type TimeEntryActivitySuggestion = {
  clientCode?: string;
  taskTypeId?: number;
  description: string;
  cardId?: string;
  startSeconds?: number;
  endSeconds?: number;
  confidence: TimeEntryActivityConfidence;
  evidence: string[];
};

export type TimeEntryActivityPlan = {
  recommendation: "consolidate" | "split";
  reason: string;
  splittable: boolean;
  activities: TimeEntryActivitySuggestion[];
};

export type TimeEntry = {
  version: typeof TIME_ENTRY_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  activityDate: string;
  startAt?: string;
  endAt?: string;
  hours?: number;
  clientCode?: string;
  clientName?: string;
  taskTypeId?: number;
  taskTypeName?: string;
  cardId?: string;
  description?: string;
  source: TimeEntrySource;
  status: TimeEntryStatus;
  classificationStatus: TimeEntryClassificationStatus;
  classificationSource?: TimeEntryClassificationSource;
  confidence: TimeEntryConfidence;
  evidence: string[];
  lockedFields: TimeEntryEditableField[];
  classificationError?: string;
  activityPlan?: TimeEntryActivityPlan;
  splitGroupId?: string;
  splitIndex?: number;
  splitCount?: number;
};

export type TimesheetColleague = {
  name: string;
  email?: string;
  aliases: string[];
};

export type TimesheetClient = {
  code: string;
  name: string;
  aliases: string[];
  responsibleNames: string[];
};

export type TimesheetTaskType = {
  id: number;
  name: string;
  slug: string;
};

export type TimesheetContext = {
  version: typeof TIME_ENTRY_VERSION;
  ownerName?: string;
  colleagues: TimesheetColleague[];
  clients: TimesheetClient[];
  taskTypes: TimesheetTaskType[];
};

export type TimeEntrySuggestion = {
  clientCode?: string;
  taskTypeId?: number;
  description?: string;
  cardId?: string;
  confidence: TimeEntryConfidence;
  evidence: string[];
  activities: TimeEntryActivitySuggestion[];
  classificationSource?: Exclude<TimeEntryClassificationSource, "manual">;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shortString = (
  value: unknown,
  field: string,
  maximum: number,
  optional = false
): string | undefined => {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
};

const optionalText = (
  value: unknown,
  field: string,
  maximum: number
): string | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${field} must be a string up to ${maximum} characters`);
  }
  return value || undefined;
};

const parseIsoDate = (value: unknown, field: string): string => {
  const parsed = shortString(value, field, 40)!;
  if (Number.isNaN(new Date(parsed).getTime())) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return parsed;
};

const parseConfidence = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
};

const parseStringArray = (
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number
): string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${field} must contain at most ${maximumItems} items`);
  }
  return value.map((item) => shortString(item, field, maximumLength)!);
};

const parseActivitySuggestion = (
  value: unknown,
  field: string
): TimeEntryActivitySuggestion => {
  if (!isObject(value) || !isObject(value.confidence)) {
    throw new Error(`${field} is invalid`);
  }
  const taskTypeId = value.taskTypeId;
  if (
    taskTypeId !== undefined &&
    (!Number.isSafeInteger(taskTypeId) || Number(taskTypeId) <= 0)
  ) {
    throw new Error(`${field}.taskTypeId must be a positive integer`);
  }
  const startSeconds = value.startSeconds;
  const endSeconds = value.endSeconds;
  if (
    (startSeconds === undefined) !== (endSeconds === undefined) ||
    (startSeconds !== undefined &&
      (typeof startSeconds !== "number" ||
        !Number.isFinite(startSeconds) ||
        startSeconds < 0 ||
        startSeconds > 86_400 ||
        typeof endSeconds !== "number" ||
        !Number.isFinite(endSeconds) ||
        endSeconds <= startSeconds ||
        endSeconds > 86_400))
  ) {
    throw new Error(`${field} contains an invalid time interval`);
  }
  return {
    clientCode: shortString(value.clientCode, `${field}.clientCode`, 20, true),
    taskTypeId: taskTypeId as number | undefined,
    description: shortString(value.description, `${field}.description`, 2_000)!,
    cardId:
      value.cardId === undefined
        ? undefined
        : validateCardId(shortString(value.cardId, `${field}.cardId`, 100)!),
    startSeconds: startSeconds as number | undefined,
    endSeconds: endSeconds as number | undefined,
    confidence: {
      client: parseConfidence(
        value.confidence.client,
        `${field}.confidence.client`
      ),
      taskType: parseConfidence(
        value.confidence.taskType,
        `${field}.confidence.taskType`
      ),
      description: parseConfidence(
        value.confidence.description,
        `${field}.confidence.description`
      ),
      timing: parseConfidence(
        value.confidence.timing,
        `${field}.confidence.timing`
      )
    },
    evidence: parseStringArray(value.evidence, `${field}.evidence`, 8, 500)
  };
};

const parseActivityPlan = (value: unknown): TimeEntryActivityPlan | undefined => {
  if (value === undefined) return undefined;
  if (
    !isObject(value) ||
    !["consolidate", "split"].includes(String(value.recommendation)) ||
    typeof value.splittable !== "boolean" ||
    !Array.isArray(value.activities) ||
    value.activities.length < 2 ||
    value.activities.length > 5
  ) {
    throw new Error("activityPlan is invalid");
  }
  return {
    recommendation: value.recommendation as TimeEntryActivityPlan["recommendation"],
    reason: shortString(value.reason, "activityPlan.reason", 500)!,
    splittable: value.splittable,
    activities: value.activities.map((activity, index) =>
      parseActivitySuggestion(activity, `activityPlan.activities[${index}]`)
    )
  };
};

export const isTimeEntryId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

export const validateTimeEntryId = (value: string): string => {
  if (!isTimeEntryId(value)) throw new Error("Invalid time entry id");
  return value;
};

export const validateActivityDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("activityDate must use YYYY-MM-DD");
  }
  const date = new Date(`${value}T00:00:00`);
  const [year, month, day] = value.split("-").map(Number);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day
  ) {
    throw new Error("activityDate is invalid");
  }
  return value;
};

export const validateCardId = (value: string): string => {
  const trimmed = value.trim();
  // Preserve normalization for legacy issue references, without imposing that syntax on new IDs.
  const normalized = /^[A-Za-z]+-\d+$/.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:#\/-]{0,99}$/.test(normalized)) {
    throw new Error("cardId must be a bounded task reference without whitespace or control characters");
  }
  return normalized;
};

export const calculateHours = (startAt: string, endAt: string): number => {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("end time must be after start time");
  }
  return Math.max(0.01, Math.round(((end - start) / 3_600_000) * 100) / 100);
};

export const validateTimeEntry = (value: unknown): TimeEntry => {
  if (!isObject(value) || value.version !== TIME_ENTRY_VERSION) {
    throw new Error("Unsupported time entry version");
  }
  if (!isObject(value.source) || !isObject(value.confidence)) {
    throw new Error("Time entry is missing source or confidence");
  }
  const sourceKind = String(value.source.kind);
  const status = String(value.status);
  const classificationStatus = String(value.classificationStatus);
  const classificationSource = value.classificationSource;
  if (!["call", "timer", "manual"].includes(sourceKind)) {
    throw new Error("Invalid time entry source");
  }
  if (!["capturing", "draft", "ready", "synced"].includes(status)) {
    throw new Error("Invalid time entry status");
  }
  if (!["pending", "completed", "failed", "disabled"].includes(classificationStatus)) {
    throw new Error("Invalid time entry classification status");
  }
  if (
    classificationSource !== undefined &&
    !["openai", "rules", "manual"].includes(String(classificationSource))
  ) {
    throw new Error("Invalid time entry classification source");
  }
  const startAt = value.startAt === undefined ? undefined : parseIsoDate(value.startAt, "startAt");
  const endAt = value.endAt === undefined ? undefined : parseIsoDate(value.endAt, "endAt");
  const hours = value.hours;
  if (
    hours !== undefined &&
    (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 24)
  ) {
    throw new Error("hours must be greater than 0 and at most 24");
  }
  if (startAt && endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error("endAt must be after startAt");
  }
  const lockedFields = parseStringArray(value.lockedFields, "lockedFields", 7, 20);
  if (
    lockedFields.some(
      (field) =>
        !["client", "taskType", "start", "end", "hours", "card", "description"].includes(field)
    )
  ) {
    throw new Error("lockedFields contains an unsupported field");
  }
  const evidence = parseStringArray(value.evidence, "evidence", 20, 500);
  const sourceApp = value.source.app;
  if (
    sourceApp !== undefined &&
    !["slack", "zen", "helium"].includes(String(sourceApp))
  ) {
    throw new Error("Invalid call application");
  }
  const taskTypeId = value.taskTypeId;
  if (
    taskTypeId !== undefined &&
    (!Number.isSafeInteger(taskTypeId) || Number(taskTypeId) <= 0)
  ) {
    throw new Error("taskTypeId must be a positive integer");
  }
  const splitGroupId =
    value.splitGroupId === undefined
      ? undefined
      : validateTimeEntryId(shortString(value.splitGroupId, "splitGroupId", 36)!);
  const splitIndex = value.splitIndex;
  const splitCount = value.splitCount;
  if (
    (splitGroupId === undefined) !== (splitIndex === undefined) ||
    (splitGroupId === undefined) !== (splitCount === undefined) ||
    (splitGroupId !== undefined &&
      (!Number.isSafeInteger(splitIndex) ||
        Number(splitIndex) < 1 ||
        !Number.isSafeInteger(splitCount) ||
        Number(splitCount) < 2 ||
        Number(splitCount) > 5 ||
        Number(splitIndex) > Number(splitCount)))
  ) {
    throw new Error("Split metadata is invalid");
  }
  return {
    version: TIME_ENTRY_VERSION,
    id: validateTimeEntryId(shortString(value.id, "id", 36)!),
    createdAt: parseIsoDate(value.createdAt, "createdAt"),
    updatedAt: parseIsoDate(value.updatedAt, "updatedAt"),
    activityDate: validateActivityDate(shortString(value.activityDate, "activityDate", 10)!),
    startAt,
    endAt,
    hours: hours as number | undefined,
    clientCode: shortString(value.clientCode, "clientCode", 20, true),
    clientName: optionalText(value.clientName, "clientName", 200),
    taskTypeId: taskTypeId as number | undefined,
    taskTypeName: optionalText(value.taskTypeName, "taskTypeName", 200),
    cardId:
      value.cardId === undefined
        ? undefined
        : validateCardId(shortString(value.cardId, "cardId", 100)!),
    description: optionalText(value.description, "description", 5_000),
    source: {
      kind: sourceKind as TimeEntrySourceKind,
      app: sourceApp as TimeEntrySource["app"],
      sessionId: shortString(value.source.sessionId, "source.sessionId", 100, true),
      recordingPath: shortString(
        value.source.recordingPath,
        "source.recordingPath",
        4096,
        true
      ),
      jobId: shortString(value.source.jobId, "source.jobId", 36, true)
    },
    status: status as TimeEntryStatus,
    classificationStatus: classificationStatus as TimeEntryClassificationStatus,
    classificationSource:
      classificationSource as TimeEntryClassificationSource | undefined,
    confidence: {
      client: parseConfidence(value.confidence.client, "confidence.client"),
      taskType: parseConfidence(value.confidence.taskType, "confidence.taskType"),
      description: parseConfidence(
        value.confidence.description,
        "confidence.description"
      )
    },
    evidence,
    lockedFields: lockedFields as TimeEntryEditableField[],
    classificationError: optionalText(
      value.classificationError,
      "classificationError",
      1_000
    ),
    activityPlan: parseActivityPlan(value.activityPlan),
    splitGroupId,
    splitIndex: splitIndex as number | undefined,
    splitCount: splitCount as number | undefined
  };
};

export const validateTimesheetContext = (value: unknown): TimesheetContext => {
  if (!isObject(value) || value.version !== TIME_ENTRY_VERSION) {
    throw new Error("Unsupported timesheet context version");
  }
  if (
    !Array.isArray(value.colleagues) ||
    value.colleagues.length > 500 ||
    !Array.isArray(value.clients) ||
    value.clients.length > 500 ||
    !Array.isArray(value.taskTypes) ||
    value.taskTypes.length > 100
  ) {
    throw new Error("Timesheet context contains an invalid catalog");
  }
  const colleagues = value.colleagues.map((item, index): TimesheetColleague => {
    if (!isObject(item)) throw new Error(`colleagues[${index}] is invalid`);
    const email = optionalText(item.email, `colleagues[${index}].email`, 254);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error(`colleagues[${index}].email is invalid`);
    }
    return {
      name: shortString(item.name, `colleagues[${index}].name`, 200)!,
      email,
      aliases: parseStringArray(
        item.aliases || [],
        `colleagues[${index}].aliases`,
        20,
        200
      )
    };
  });
  const clients = value.clients.map((item, index): TimesheetClient => {
    if (!isObject(item)) throw new Error(`clients[${index}] is invalid`);
    const code = shortString(item.code, `clients[${index}].code`, 20)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/.test(code)) {
      throw new Error(`clients[${index}].code is invalid`);
    }
    return {
      code,
      name: shortString(item.name, `clients[${index}].name`, 200)!,
      aliases: parseStringArray(item.aliases || [], `clients[${index}].aliases`, 30, 200),
      responsibleNames: parseStringArray(
        item.responsibleNames || [],
        `clients[${index}].responsibleNames`,
        30,
        200
      )
    };
  });
  const taskTypes = value.taskTypes.map((item, index): TimesheetTaskType => {
    if (!isObject(item)) throw new Error(`taskTypes[${index}] is invalid`);
    if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0) {
      throw new Error(`taskTypes[${index}].id is invalid`);
    }
    return {
      id: Number(item.id),
      name: shortString(item.name, `taskTypes[${index}].name`, 200)!,
      slug: shortString(item.slug, `taskTypes[${index}].slug`, 100)!
    };
  });
  if (new Set(clients.map((client) => client.code)).size !== clients.length) {
    throw new Error("Client codes must be unique");
  }
  if (new Set(taskTypes.map((taskType) => taskType.id)).size !== taskTypes.length) {
    throw new Error("Task type ids must be unique");
  }
  return {
    version: TIME_ENTRY_VERSION,
    ownerName: optionalText(value.ownerName, "ownerName", 200),
    colleagues,
    clients,
    taskTypes
  };
};
