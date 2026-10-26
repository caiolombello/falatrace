// Actions, people and clients pages (DESIGN-STUDIO §4 "Actions", "People", "Clients"). Pages read the
// library index as it is and say `refreshing` while the background refresh runs.
import { listActions, type ListedAction, type ListActionsDeps } from "../actions/list";
import { ACTIONS_KNOWN_ERRORS, setActionStatus, type ActionStatus } from "../actions/store";
import type { AppServices } from "../app/context";
import { peopleOptions } from "../app/context";
import {
  addCatalogClient, buildClients, clientDetail, CLIENT_CATALOG_ERRORS, CLIENTS_MODULE_KNOWN_ERRORS, deleteCatalogClient, effectiveClients, readClientCatalog,
  renameCatalogClient, updateCatalogClient
} from "../clients";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import { buildPeople, PEOPLE_KNOWN_ERRORS, personDetail, type PeopleDirectory } from "../people";
import { type BridgeCall, type BridgeFamily, bool, CLIENT_CODE, integer, invalid, line, matches, oneOf, PERSON_ID, SHA256, UUID, uuidKey } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";
import { LIBRARY_REFRESH_MIN_AGE_MS } from "./studio-services";

export const ENTITIES_BRIDGE_OPERATIONS = [
  "actions-list", "action-set", "people-list", "person-detail", "person-edit", "clients-list", "client-detail", "client-edit", "meeting-client-set"
] as const;

export const ENTITIES_BRIDGE_MESSAGES = Object.freeze({
  actionsFailed: "Não foi possível ler ou salvar as ações. Nada foi alterado.",
  peopleFailed: "Não foi possível ler ou salvar as pessoas. Nada foi alterado.",
  clientsFailed: "Não foi possível ler ou salvar os clientes. Nada foi alterado."
});

export const ENTITIES_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(ENTITIES_BRIDGE_MESSAGES), ...ACTIONS_KNOWN_ERRORS, ...PEOPLE_KNOWN_ERRORS, ...CLIENTS_MODULE_KNOWN_ERRORS])
]);

/** Rows an Actions page receives at most; `truncated` says when there were more. */
export const ACTIONS_PAGE_LIMIT = 500;
const PERSON_OPS = ["rename", "alias-add", "alias-remove", "merge", "hide", "unhide", "unmerge"] as const;
const CLIENT_OPS = ["add", "rename", "delete", "alias-add", "alias-remove"] as const;

const ALLOWED: Record<(typeof ENTITIES_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "actions-list": ["status", "personId", "clientCode", "jobId"],
  "action-set": ["mediaSha256", "actionId", "status", "expectedRev"],
  "people-list": ["includeHidden"],
  "person-detail": ["personId"],
  "person-edit": ["personId", "op", "value", "targetId", "expectedRev"],
  "clients-list": [],
  "client-detail": ["clientCode"],
  "client-edit": ["op", "code", "name", "value"],
  "meeting-client-set": ["clientCodes", "automatic"]
};

const validate = (call: BridgeCall): void => {
  const p = call.payload;
  switch (call.op) {
    case "actions-list":
      oneOf(p, "status", ["open", "done", "all"]);
      matches(p, "personId", PERSON_ID, { optional: true, max: 210 });
      matches(p, "clientCode", CLIENT_CODE, { optional: true });
      matches(p, "jobId", UUID, { optional: true }); return;
    case "action-set":
      matches(p, "mediaSha256", SHA256);
      matches(p, "actionId", UUID);
      oneOf(p, "status", ["open", "done", "dismissed"]);
      integer(p, "expectedRev", 0, 1_000_000_000, { optional: true }); return;
    case "people-list":
      bool(p, "includeHidden", { optional: true }); return;
    case "person-detail":
      matches(p, "personId", PERSON_ID, { max: 210 }); return;
    case "person-edit":
      matches(p, "personId", PERSON_ID, { max: 210 });
      oneOf(p, "op", PERSON_OPS);
      line(p, "value", 80, { optional: true });
      matches(p, "targetId", PERSON_ID, { optional: true, max: 210 });
      integer(p, "expectedRev", 0, 1_000_000_000, { optional: true });
      if (["rename", "alias-add", "alias-remove"].includes(p.op as string) && p.value === undefined) invalid();
      if (p.op === "merge" && p.targetId === undefined) invalid();
      return;
    case "client-detail":
      matches(p, "clientCode", CLIENT_CODE); return;
    case "client-edit":
      oneOf(p, "op", CLIENT_OPS);
      if (p.op === "add" && (p.code === undefined || p.code === "")) {
        if (p.code !== undefined) line(p, "code", 0, { empty: true });
      } else matches(p, "code", CLIENT_CODE);
      line(p, "name", 200, { optional: true });
      line(p, "value", 200, { optional: true });
      if ((p.op === "add" || p.op === "rename") && p.name === undefined) invalid();
      if ((p.op === "alias-add" || p.op === "alias-remove") && p.value === undefined) invalid();
      return;
    case "meeting-client-set":
      uuidKey(call);
      if (p.automatic !== undefined) {
        if (p.automatic !== true || p.clientCodes !== undefined) invalid();
        return;
      }
      if (!Array.isArray(p.clientCodes) || p.clientCodes.length > 10 || p.clientCodes.some((code) => typeof code !== "string" || !CLIENT_CODE.test(code))) invalid();
      if (new Set(p.clientCodes as string[]).size !== (p.clientCodes as string[]).length) invalid();
      return;
    default:
      return;
  }
};

type Loaded = { config: AppConfig; services: AppServices; directory: PeopleDirectory; deps: ListActionsDeps };

/** What actions, people and clients pages share: the directory of people, client overrides, the catalog and cited segment times. */
const load = async (context: BridgeContext): Promise<Loaded> => {
  // The pages read the index as it is; new recordings reach it through a background refresh.
  context.studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  const config = await context.studio.config();
  const services = await context.studio.services(config);
  const [directory, overrides, catalog] = await Promise.all([
    services.people.directory(),
    services.clientOverrides.read().catch(() => undefined),
    readClientCatalog(config.timesheet.contextPath).then((read) => read.context, () => undefined)
  ]);
  return {
    config, services, directory,
    deps: {
      people: directory, ...(overrides ? { overrides } : {}), ...(catalog ? { catalog } : {}),
      segmentStarts: async (jobId, segmentIds) => {
        const info = await services.index.segmentInfo(jobId);
        return Object.fromEntries(segmentIds.filter((id) => info.has(id)).map((id) => [id, info.get(id)!.start]));
      }
    }
  };
};

const actionsList = async (call: BridgeCall, context: BridgeContext) => {
  const p = call.payload;
  const { services, deps } = await load(context);
  const all = await listActions(services.index, {
    ...(typeof p.personId === "string" ? { personId: p.personId } : {}),
    ...(typeof p.clientCode === "string" ? { clientCode: p.clientCode } : {}),
    ...(typeof p.jobId === "string" ? { jobId: p.jobId.toLowerCase() } : {})
  }, deps);
  const counts = { open: 0, done: 0, dismissed: 0, orphaned: 0 };
  for (const action of all) {
    counts[action.status] += 1;
    if (action.matchState === "orphaned") counts.orphaned += 1;
  }
  const filtered = p.status === "all" ? all : all.filter((action) => action.status === p.status);
  return { items: filtered.slice(0, ACTIONS_PAGE_LIMIT), counts, ...(filtered.length > ACTIONS_PAGE_LIMIT ? { truncated: true } : {}), refreshing: context.studio.refreshing };
};

const actionSet = async (call: BridgeCall, context: BridgeContext) => {
  const p = call.payload;
  const file = await setActionStatus(p.mediaSha256 as string, (p.actionId as string).toLowerCase(), p.status as ActionStatus, p.expectedRev as number | undefined);
  const stored = file.items.find((item) => item.id === (p.actionId as string).toLowerCase());
  // The snapshot's open counts follow (list badges); the page has the item already.
  void context.studio.snapshot().catch(() => undefined);
  return {
    rev: file.rev,
    item: stored ? { actionId: stored.id, mediaSha256: file.mediaSha256, status: stored.status, statusChangedAt: stored.statusChangedAt, text: stored.text, matchState: stored.matchState } : undefined
  };
};

const peopleList = async (call: BridgeCall, context: BridgeContext) => {
  const { services, deps } = await load(context);
  const people = await buildPeople(services.index, services.people, peopleOptions({ includeHidden: call.payload.includeHidden === true, actionDeps: { segmentStarts: deps.segmentStarts } }));
  return { people, refreshing: context.studio.refreshing };
};

const personEdit = async (call: BridgeCall, context: BridgeContext) => {
  const p = call.payload;
  const { services } = await load(context);
  const id = p.personId as string;
  const options = p.expectedRev !== undefined ? { expectedRev: p.expectedRev as number } : {};
  // A person nobody edited yet ("name:<key>") gets a record named as the pages show it.
  const shown = id.startsWith("name:")
    ? (await buildPeople(services.index, services.people, peopleOptions({ includeHidden: true, actions: false }))).find((person) => person.id === id)?.name
    : undefined;
  const hint = shown ? { currentName: shown } : {};
  const value = typeof p.value === "string" ? p.value : "";
  const result = p.op === "rename" ? await services.people.rename(id, value, { ...options, ...hint })
    : p.op === "alias-add" ? await services.people.addAlias(id, value, { ...options, ...hint })
      : p.op === "alias-remove" ? await services.people.removeAlias(id, value, options)
        : p.op === "merge" ? await services.people.merge(id, p.targetId as string, { ...options, ...(shown ? { sourceName: shown } : {}) })
          : p.op === "unmerge" ? await services.people.unmerge(id, options)
            : await services.people.setHidden(id, p.op === "hide", { ...options, ...hint });
  return { personId: result.personId, changed: result.changed, rev: result.file.rev };
};

const catalogPath = (config: AppConfig): string => config.timesheet.contextPath;

const clientsList = async (context: BridgeContext) => {
  const { config, services, directory, deps } = await load(context);
  const catalog = await readClientCatalog(catalogPath(config));
  const clients = await buildClients(services.index, catalog.context, {
    ...(deps.overrides ? { overrides: deps.overrides } : {}), people: directory, actionDeps: { segmentStarts: deps.segmentStarts }
  });
  return {
    clients, editable: catalog.editable && catalog.state !== "invalid",
    ...(catalog.state === "invalid" ? { catalogError: CLIENT_CATALOG_ERRORS.invalid } : {}), refreshing: context.studio.refreshing
  };
};

const clientEdit = async (call: BridgeCall, context: BridgeContext) => {
  const p = call.payload;
  const config = await context.studio.config();
  const path = catalogPath(config);
  const code = typeof p.code === "string" ? p.code : "";
  let result: Awaited<ReturnType<typeof addCatalogClient>>;
  if (p.op === "add") result = await addCatalogClient(path, { ...(code ? { code } : {}), name: p.name as string });
  else if (p.op === "rename") result = await renameCatalogClient(path, code, p.name as string);
  else if (p.op === "delete") result = await deleteCatalogClient(path, code);
  else {
    const current = (await readClientCatalog(path)).context.clients.find((client) => client.code === code);
    if (!current) throw new Error(CLIENT_CATALOG_ERRORS.notFound);
    const value = (p.value as string).trim();
    const aliases = p.op === "alias-add" ? [...current.aliases, value] : current.aliases.filter((alias) => alias !== value);
    result = await updateCatalogClient(path, code, { aliases });
  }
  // Client assignments are part of the index facts: re-index in the background.
  context.studio.refreshInBackground();
  return { code: result.client?.code ?? code, ...(result.client ? { client: result.client } : {}), revision: result.revision };
};

const meetingClientSet = async (call: BridgeCall, context: BridgeContext) => {
  const jobId = call.key!.toLowerCase();
  const config = await context.studio.config();
  const services = await context.studio.services(config);
  const job = await (context.deps.jobs ?? new JobStore()).get(jobId);
  if (call.payload.automatic === true) {
    await services.clientOverrides.clear(jobId, { mediaSha256: job.source.sha256 });
  } else {
    const catalog = await readClientCatalog(catalogPath(config));
    if (catalog.state === "invalid") throw new Error(CLIENT_CATALOG_ERRORS.invalid);
    await services.clientOverrides.set({
      jobId, mediaSha256: job.source.sha256, clientCodes: call.payload.clientCodes as string[], knownCodes: catalog.context.clients.map((client) => client.code)
    });
  }
  // Pages apply the overrides on top of the indexed facts, as here; the facts catch up on the next refresh.
  context.studio.refreshJobs([jobId]);
  const [facts, overrides, catalog] = await Promise.all([
    services.index.getFacts(jobId).catch(() => undefined),
    services.clientOverrides.read(),
    readClientCatalog(catalogPath(config)).then((read) => read.context, () => undefined)
  ]);
  const clients = effectiveClients(facts ?? { jobId, mediaSha256: job.source.sha256, clients: [] }, overrides, catalog);
  // A choice the person made, "no client" included, so the Studio can tell "Nenhum" from "Automático".
  const manual = call.payload.automatic !== true && (clients.length === 0 || clients.some((client) => client.source === "manual"));
  return { jobId, clients: clients.map(({ code, name, source }) => ({ code, name, source })), manual };
};

export const entitiesBridge: BridgeFamily<BridgeContext> = {
  operations: ENTITIES_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    switch (call.op) {
      case "actions-list": return actionsList(call, context);
      case "action-set": return actionSet(call, context);
      case "people-list": return peopleList(call, context);
      case "person-detail": {
        const { services, deps } = await load(context);
        return personDetail(services.index, services.people, call.payload.personId as string, peopleOptions({ includeHidden: true, actionDeps: { segmentStarts: deps.segmentStarts } }));
      }
      case "person-edit": return personEdit(call, context);
      case "clients-list": return clientsList(context);
      case "client-detail": {
        const { config, services, directory, deps } = await load(context);
        const catalog = await readClientCatalog(catalogPath(config));
        return clientDetail(services.index, catalog.context, call.payload.clientCode as string, {
          ...(deps.overrides ? { overrides: deps.overrides } : {}), people: directory, actionDeps: { segmentStarts: deps.segmentStarts }
        });
      }
      case "client-edit": return clientEdit(call, context);
      case "meeting-client-set": return meetingClientSet(call, context);
      default: return invalid();
    }
  },
  knownErrors: ENTITIES_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op.startsWith("action") ? ENTITIES_BRIDGE_MESSAGES.actionsFailed
    : op.startsWith("people") || op.startsWith("person") ? ENTITIES_BRIDGE_MESSAGES.peopleFailed : ENTITIES_BRIDGE_MESSAGES.clientsFailed
};

export type { ListedAction };
