import { createLibraryIndex } from "../app/context";
import { buildClients, clientDetail } from "../clients/build";
import { addCatalogClient, deleteCatalogClient, readClientCatalog, renameCatalogClient } from "../clients/catalog";
import { ClientOverridesStore } from "../clients/overrides";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { PeopleStore } from "../people/store";
import type { PeopleIndex } from "./people";
import { CLIENTS_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, notice, parseArgs, printJson, processIO, readJob } from "./shared";

export { CLIENTS_HELP };

export type ClientsIndex = PeopleIndex & { refresh(options?: { jobIds?: string[] }): Promise<unknown> };

export type ClientsCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  index: (config: AppConfig) => ClientsIndex;
  overrides: () => Pick<ClientOverridesStore, "read" | "set" | "clear">;
  people: () => Pick<PeopleStore, "directory">;
  jobs: () => { get(id: string): Promise<JobRecord> };
  catalog: {
    read: typeof readClientCatalog;
    add: typeof addCatalogClient;
    rename: typeof renameCatalogClient;
    remove: typeof deleteCatalogClient;
  };
};

export const defaultClientsCliDeps = (): ClientsCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  index: (config) => createLibraryIndex(config),
  overrides: () => new ClientOverridesStore(),
  people: () => new PeopleStore(),
  jobs: () => new JobStore(),
  catalog: { read: readClientCatalog, add: addCatalogClient, rename: renameCatalogClient, remove: deleteCatalogClient }
});

const SUBCOMMANDS = ["list", "show", "add", "rename", "delete", "assign"];

export const runClientsCli = async (args: string[], deps: ClientsCliDeps = defaultClientsCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(CLIENTS_HELP); return; }
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) throw new Error(CLI_USAGE.clients);
  const parsed = parseArgs(rest, subcommand === "add" ? { values: ["--code"], lists: ["--alias"] } : subcommand === "assign" ? { flags: ["--auto"] } : {});
  const config = await deps.loadConfig();
  const path = config.timesheet.contextPath;
  const [first, ...more] = parsed.positionals;

  if (subcommand === "list" || subcommand === "show") {
    const index = deps.index(config);
    await index.refresh().catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
    const catalog = await deps.catalog.read(path);
    // Listing never rewrites action states (persist: false).
    const options = { overrides: await deps.overrides().read(), people: await deps.people().directory(), actionDeps: { persist: false } };
    if (subcommand === "list") {
      if (first) throw new Error(CLI_USAGE.clients);
      printJson(io, {
        catalog: { path, state: catalog.state, ...(catalog.error ? { error: catalog.error } : {}) },
        clients: (await buildClients(index, catalog.context, options)).map(({ meetings: _meetings, ...client }) => client)
      });
      return;
    }
    if (!first || more.length) throw new Error(CLI_USAGE.clients);
    if (catalog.error) throw new Error(catalog.error);
    printJson(io, await clientDetail(index, catalog.context, first, options));
    return;
  }
  if (subcommand === "add") {
    const name = parsed.positionals.join(" ").trim();
    if (!name) throw new Error(CLI_USAGE.clients);
    const result = await deps.catalog.add(path, { name, code: parsed.values["--code"], aliases: parsed.lists["--alias"] ?? [] });
    printJson(io, { client: result.client, path, ...(result.backupPath ? { backupPath: result.backupPath } : {}) });
    return;
  }
  if (subcommand === "rename") {
    const name = more.join(" ").trim();
    if (!first || !name) throw new Error(CLI_USAGE.clients);
    const result = await deps.catalog.rename(path, first, name);
    printJson(io, { client: result.client, path, ...(result.backupPath ? { backupPath: result.backupPath } : {}) });
    return;
  }
  if (subcommand === "delete") {
    if (!first || more.length) throw new Error(CLI_USAGE.clients);
    const result = await deps.catalog.remove(path, first);
    printJson(io, { deleted: first, path, ...(result.backupPath ? { backupPath: result.backupPath } : {}) });
    return;
  }
  // assign <job-id> <code…> | assign <job-id> --auto
  const job = await readJob(deps.jobs(), first);
  const store = deps.overrides();
  const auto = parsed.flags.has("--auto");
  if (auto ? more.length > 0 : more.length === 0) throw new Error(CLI_MESSAGES.clientCodesRequired);
  if (auto) {
    // The whole media goes back to the automatic rule, reprocessed copies included.
    await store.clear(job.id, { mediaSha256: job.source.sha256 });
  } else {
    const catalog = await deps.catalog.read(path);
    if (catalog.error) throw new Error(catalog.error);
    await store.set({ jobId: job.id, mediaSha256: job.source.sha256, clientCodes: more, knownCodes: catalog.context.clients.map((client) => client.code) });
  }
  // The index resolves clients when it builds a recording's facts: rebuild this one now.
  await deps.index(config).refresh({ jobIds: [job.id] }).catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
  printJson(io, { jobId: job.id, clientCodes: auto ? "auto" : more });
};
