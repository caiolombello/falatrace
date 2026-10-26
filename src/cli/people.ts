import { createLibraryIndex, peopleOptions } from "../app/context";
import type { AppConfig } from "../config/defaults";
import type { LibraryIndexReader } from "../library-index/types";
import { buildPeople, type BuildPeopleOptions, type Person, personDetail } from "../people/build";
import { PeopleStore } from "../people/store";
import { PEOPLE_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, notice, parseArgs, printJson, processIO } from "./shared";

export { PEOPLE_HELP };

/** The index to read people from; refreshed before reading, so new recordings count. */
export type PeopleIndex = LibraryIndexReader & { refresh(): Promise<unknown> };

export type PeopleCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  index: (config: AppConfig) => PeopleIndex;
  store: () => PeopleStore;
  /** Options for buildPeople (voice profiles); listing never writes action states. */
  options: (overrides: BuildPeopleOptions) => BuildPeopleOptions;
};

export const defaultPeopleCliDeps = (): PeopleCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  index: (config) => createLibraryIndex(config),
  store: () => new PeopleStore(),
  options: (overrides) => peopleOptions(overrides)
});

const brief = (person: Person) => ({
  id: person.id, name: person.name, aliases: person.aliases, meetingCount: person.meetingCount, lastMeetingAt: person.lastMeetingAt,
  openActions: person.openActions, self: person.self, hidden: person.hidden, ...(person.voicePersonId ? { voicePersonId: person.voicePersonId } : {})
});

export const runPeopleCli = async (args: string[], deps: PeopleCliDeps = defaultPeopleCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(PEOPLE_HELP); return; }
  if (!subcommand || !["list", "show", "rename", "merge", "alias", "hide", "unhide"].includes(subcommand)) throw new Error(CLI_USAGE.people);
  const parsed = parseArgs(rest, subcommand === "list" ? { flags: ["--all"] } : {});
  const config = await deps.loadConfig();
  const index = deps.index(config);
  await index.refresh().catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
  const store = deps.store();
  const readOnly = { actionDeps: { persist: false } } as const;
  const everyone = (): Promise<Person[]> => buildPeople(index, store, deps.options({ ...readOnly, actions: false, includeHidden: true }));
  // Names nobody edited yet have no record: edits need the spelling shown in the lists.
  const nameOf = async (id: string): Promise<string | undefined> => (await everyone()).find((person) => person.id === id)?.name;
  const [first, second, ...more] = parsed.positionals;

  if (subcommand === "list") {
    printJson(io, (await buildPeople(index, store, deps.options({ ...readOnly, includeHidden: parsed.flags.has("--all") }))).map(brief));
    return;
  }
  if (subcommand === "show") {
    if (!first) throw new Error(CLI_USAGE.people);
    printJson(io, await personDetail(index, store, first, deps.options(readOnly)));
    return;
  }
  if (subcommand === "rename") {
    const name = [second, ...more].filter(Boolean).join(" ");
    if (!first || !name) throw new Error(CLI_USAGE.people);
    const result = await store.rename(first, name, { currentName: await nameOf(first) });
    printJson(io, { id: result.personId, changed: result.changed });
    return;
  }
  if (subcommand === "merge") {
    if (!first || !second || more.length) throw new Error(CLI_USAGE.people);
    const result = await store.merge(first, second, { sourceName: await nameOf(first), targetName: await nameOf(second) });
    printJson(io, { id: result.personId, changed: result.changed });
    return;
  }
  if (subcommand === "alias") {
    const alias = more.join(" ");
    if (!first || (second !== "add" && second !== "remove") || !alias) throw new Error(CLI_USAGE.people);
    const result = second === "add" ? await store.addAlias(first, alias, { currentName: await nameOf(first) }) : await store.removeAlias(first, alias);
    printJson(io, { id: result.personId, changed: result.changed });
    return;
  }
  if (!first || second !== undefined) throw new Error(CLI_USAGE.people);
  const result = await store.setHidden(first, subcommand === "hide", { currentName: await nameOf(first) });
  printJson(io, { id: result.personId, hidden: subcommand === "hide", changed: result.changed });
};
