import { listActionsForFacts } from "../actions/list";
import type { ActionsStore } from "../actions/store";
import type { ClientOverridesFile } from "../clients/overrides";
import type { LibraryIndexReader } from "../library-index/types";
import { PeopleDirectory, type PeopleFile, PeopleStore } from "../people/store";
import type { TimesheetContext } from "../timesheet/types";
import { type BriefEvent, type PreMeetingBrief, buildBrief } from "./build";

export * from "./build";

export type BriefForEventDeps = {
  peopleStore?: { read(): Promise<PeopleFile> };
  actionsStore?: ActionsStore;
  catalog?: TimesheetContext;
  overrides?: ClientOverridesFile;
  selfNames?: readonly string[];
};

/**
 * The brief for a reminder: loads people and open actions without writing anything (the
 * reminder service runs with a read-only home), and degrades to fewer details instead of
 * failing when a store cannot be read.
 */
export const buildBriefForEvent = async (reader: LibraryIndexReader, event: BriefEvent, deps: BriefForEventDeps = {}): Promise<PreMeetingBrief | null> => {
  const people = new PeopleDirectory(await (deps.peopleStore ?? new PeopleStore()).read().catch(() => undefined));
  const facts = await reader.listFacts();
  const actions = await listActionsForFacts(facts, { status: "open", includeOrphaned: false }, {
    store: deps.actionsStore, people, overrides: deps.overrides, catalog: deps.catalog, persist: false
  }).catch(() => []);
  // The facts were just read: the brief reuses them instead of asking the index again.
  const loaded: LibraryIndexReader = { listFacts: async () => facts, getFacts: (jobId) => reader.getFacts(jobId), search: (query, options) => reader.search(query, options) };
  return buildBrief(loaded, event, { people, actions, catalog: deps.catalog, overrides: deps.overrides, selfNames: deps.selfNames });
};
