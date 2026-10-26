import { listActions, listActionsForFacts, type ListActionsDeps, type ListActionsOptions, type ListedAction } from "../actions/list";
import { ACTIONS_ERRORS, type ActionsFile, ActionsStore, type ActionStatus } from "../actions/store";
import { createLibraryIndex } from "../app/context";
import { readClientCatalog } from "../clients/catalog";
import { ClientOverridesStore } from "../clients/overrides";
import type { AppConfig } from "../config/defaults";
import { PeopleStore } from "../people/store";
import { ACTIONS_HELP } from "./help";
import type { PeopleIndex } from "./people";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, localDay, notice, oneLine, parseArgs, printJson, printLine, processIO } from "./shared";

export { ACTIONS_HELP };

export type ActionsCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  index: (config: AppConfig) => PeopleIndex;
  store: () => ActionsStore;
  /** People, client overrides and catalog for the person and client filters. */
  listDeps: (config: AppConfig) => Promise<Omit<ListActionsDeps, "persist" | "store">>;
};

export const defaultActionsCliDeps = (): ActionsCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  index: (config) => createLibraryIndex(config),
  store: () => new ActionsStore(),
  listDeps: async (config) => ({
    people: await new PeopleStore().directory(),
    overrides: await new ClientOverridesStore().read(),
    catalog: (await readClientCatalog(config.timesheet.contextPath)).context
  })
});

const STATUS_VERBS: Record<string, ActionStatus> = { done: "done", reopen: "open", dismiss: "dismissed" };
const MEDIA = /^[a-f0-9]{64}$/;
const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<media sha256>:<action id>` as printed by `actions list`. */
export const parseActionRef = (value: string | undefined): { mediaSha256: string; actionId: string } => {
  const [media, id, ...extra] = (value ?? "").toLowerCase().split(":");
  if (!media || !id || extra.length || !MEDIA.test(media) || !ACTION_ID.test(id)) throw new Error(CLI_MESSAGES.actionRefInvalid);
  return { mediaSha256: media, actionId: id };
};

export const actionRef = (action: Pick<ListedAction, "mediaSha256" | "actionId">): string => `${action.mediaSha256}:${action.actionId}`;

const MARKS: Record<ActionStatus, string> = { open: "[ ]", done: "[x]", dismissed: "[-]" };

/** `[ ] text — owner · due · title (date)  <media>:<id>` */
export const actionLine = (action: ListedAction): string => {
  const details = [action.owner, action.dueDate ? `até ${action.dueDate}` : ""].map((part) => oneLine(part, 80)).filter(Boolean).join(" · ");
  const orphan = action.matchState === "orphaned" ? " (fora do resumo atual)" : "";
  return `${MARKS[action.status]} ${oneLine(action.text, 200)}${details ? ` — ${details}` : ""} · ${oneLine(action.title, 80)} (${localDay(action.date)})${orphan}  ${actionRef(action)}`;
};

export const runActionsCli = async (args: string[], deps: ActionsCliDeps = defaultActionsCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(ACTIONS_HELP); return; }
  if (subcommand === "list") {
    const parsed = parseArgs(rest, { values: ["--status", "--person", "--client", "--meeting"], flags: ["--json"] });
    if (parsed.positionals.length) throw new Error(CLI_USAGE.actions);
    const status = parsed.values["--status"] ?? "open";
    if (!["open", "done", "all"].includes(status)) throw new Error(CLI_MESSAGES.actionStatusInvalid);
    const options: ListActionsOptions = {
      ...(status === "all" ? {} : { status: status as ActionStatus }),
      ...(parsed.values["--person"] ? { personId: parsed.values["--person"] } : {}),
      ...(parsed.values["--client"] ? { clientCode: parsed.values["--client"] } : {}),
      ...(parsed.values["--meeting"] ? { jobId: parsed.values["--meeting"].toLowerCase() } : {})
    };
    const config = await deps.loadConfig();
    const index = deps.index(config);
    await index.refresh().catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
    // A listing only reads: the saved states are re-anchored by the commands that change them.
    const actions = await listActions(index, options, { ...(await deps.listDeps(config)), store: deps.store(), persist: false });
    if (parsed.flags.has("--json")) { printJson(io, actions); return; }
    for (const action of actions) printLine(io, actionLine(action));
    return;
  }
  const status = subcommand && Object.getOwnPropertyDescriptor(STATUS_VERBS, subcommand) ? STATUS_VERBS[subcommand] : undefined;
  if (!status) throw new Error(CLI_USAGE.actions);
  const parsed = parseArgs(rest);
  if (parsed.positionals.length !== 1) throw new Error(CLI_USAGE.actions);
  const { mediaSha256, actionId } = parseActionRef(parsed.positionals[0]);
  const store = deps.store();
  let file: ActionsFile;
  try {
    file = await store.setStatus(mediaSha256, actionId, status);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ACTIONS_ERRORS.notFound) throw error;
    // The action may not have a saved state yet (listings do not write): anchor this media's actions, then retry.
    const config = await deps.loadConfig();
    const index = deps.index(config);
    await index.refresh().catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
    const facts = (await index.listFacts()).filter((item) => item.mediaSha256 === mediaSha256);
    await listActionsForFacts(facts, {}, { ...(await deps.listDeps(config)), store });
    file = await store.setStatus(mediaSha256, actionId, status);
  }
  const item = file.items.find((candidate) => candidate.id === actionId);
  printJson(io, { action: `${mediaSha256}:${actionId}`, status: item?.status ?? status, rev: file.rev });
};
