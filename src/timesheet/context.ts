import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "../config/defaults";
import { writeJsonAtomic } from "../jobs/store";
import {
  DEFAULT_TASK_TYPES,
  TIME_ENTRY_VERSION,
  type TimesheetClient,
  type TimesheetContext,
  type TimesheetTaskType,
  validateTimesheetContext
} from "./types";

export const emptyTimesheetContext = (): TimesheetContext => ({
  version: TIME_ENTRY_VERSION,
  colleagues: [],
  clients: [],
  taskTypes: DEFAULT_TASK_TYPES.map((taskType) => ({ ...taskType }))
});

export const loadTimesheetContext = async (
  config: AppConfig
): Promise<TimesheetContext> => {
  try {
    const raw = await fs.readFile(config.timesheet.contextPath, "utf-8");
    return validateTimesheetContext(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyTimesheetContext();
    }
    throw new Error(
      `Invalid timesheet context at ${config.timesheet.contextPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
};

export const writeInitialTimesheetContext = async (
  config: AppConfig
): Promise<string> => {
  await fs.mkdir(dirname(config.timesheet.contextPath), {
    recursive: true,
    mode: 0o700
  });
  try {
    await fs.access(config.timesheet.contextPath);
    throw new Error(`Timesheet context already exists at ${config.timesheet.contextPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeJsonAtomic(config.timesheet.contextPath, emptyTimesheetContext());
  await fs.chmod(config.timesheet.contextPath, 0o600);
  return config.timesheet.contextPath;
};

const normalized = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const findClient = (
  context: TimesheetContext,
  value: string
): TimesheetClient | undefined => {
  const target = normalized(value);
  return context.clients.find((client) =>
    [client.code, client.name, ...client.aliases].some(
      (candidate) => normalized(candidate) === target
    )
  );
};

export const findTaskType = (
  context: TimesheetContext,
  value: string | number
): TimesheetTaskType | undefined => {
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const id = Number(value);
    return context.taskTypes.find((taskType) => taskType.id === id);
  }
  const target = normalized(value);
  return context.taskTypes.find((taskType) =>
    [taskType.name, taskType.slug].some(
      (candidate) => normalized(candidate) === target
    )
  );
};

export const buildTranscriptionKeywords = (
  context: TimesheetContext
): string[] => {
  const terms = [
    ...context.colleagues.map((colleague) => colleague.name),
    ...context.clients.flatMap((client) => [client.code, client.name])
  ];
  return [...new Set(terms)]
    .filter(
      (term) =>
        Boolean(term) &&
        term.length <= 200 &&
        !/[<>\r\n\u0000]/.test(term)
    )
    .slice(0, 100);
};

export const buildTranscriptionContextPrompt = (
  context: TimesheetContext
): string => {
  const glossary = buildTranscriptionKeywords(context).join(", ");
  return glossary ? `Grafias de nomes e clientes: ${glossary}.` : "";
};
