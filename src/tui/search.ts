import type { JobState } from "../jobs/types";
import type { TimeEntry } from "../timesheet/types";
import type { LibraryEntry } from "./library";

export type LibraryStateFilter =
  | "all"
  | "no-job"
  | "active"
  | "completed"
  | "failed";

export type LibraryFilters = {
  query: string;
  state: LibraryStateFilter;
};

const filterOrder: LibraryStateFilter[] = [
  "all",
  "no-job",
  "active",
  "completed",
  "failed"
];

const activeStates = new Set<JobState>([
  "pending",
  "transferring",
  "queued",
  "processing"
]);

const stateSearchTerms: Record<JobState, string> = {
  pending: "pendente",
  transferring: "transferindo enviando",
  queued: "fila enfileirado",
  processing: "processando andamento",
  completed: "concluido completo",
  failed: "falhou falha"
};

export const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();

const dateSearchTerms = (timestamp: number): string => {
  const date = new Date(timestamp);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${year}-${month}-${day} ${day}/${month}/${year} ${day}/${month}`;
};

const matchesState = (
  entry: Pick<LibraryEntry, "jobs">,
  state: LibraryStateFilter
): boolean => {
  if (state === "all") return true;
  const latest = entry.jobs[0];
  if (state === "no-job") return !latest;
  if (!latest) return false;
  if (state === "active") return activeStates.has(latest.state);
  return latest.state === state;
};

const entrySearchText = (
  entry: LibraryEntry,
  allocations: TimeEntry[]
): string => {
  const linked = allocations.filter(
    (allocation) => allocation.source.recordingPath === entry.sourcePath
  );
  const jobs = entry.jobs
    .map((job) => `${job.state} ${stateSearchTerms[job.state]}`)
    .join(" ");
  const clients = linked
    .map((allocation) => `${allocation.clientCode || ""} ${allocation.clientName || ""}`)
    .join(" ");
  return normalizeSearchText([
    entry.meetingTitle || "",
    entry.relativePath,
    entry.sourcePath,
    dateSearchTerms(entry.modifiedAt),
    jobs || "sem job nao processado",
    clients
  ].join(" "));
};

export const filterLibraryEntries = (
  entries: LibraryEntry[],
  allocations: TimeEntry[],
  filters: LibraryFilters
): LibraryEntry[] => {
  const tokens = normalizeSearchText(filters.query).split(" ").filter(Boolean);
  return entries.filter((entry) => {
    if (!matchesState(entry, filters.state)) return false;
    if (tokens.length === 0) return true;
    const searchable = entrySearchText(entry, allocations);
    return tokens.every((token) => searchable.includes(token));
  });
};

export const cycleLibraryStateFilter = (
  current: LibraryStateFilter
): LibraryStateFilter =>
  filterOrder[(filterOrder.indexOf(current) + 1) % filterOrder.length] || "all";

export const libraryStateFilterLabel = (
  state: LibraryStateFilter
): string => ({
  all: "todos",
  "no-job": "sem job",
  active: "em andamento",
  completed: "concluídos",
  failed: "com falha"
})[state];
