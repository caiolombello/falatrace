import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ActionsStore } from "../../actions/store";
import { CLIENT_OVERRIDE_ERRORS, ClientOverridesStore } from "../../clients/overrides";
import { CLIENTS_ERRORS } from "../../clients/build";
import { addCatalogClient, deleteCatalogClient, readClientCatalog, renameCatalogClient } from "../../clients/catalog";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobFacts } from "../../library-index/types";
import { PEOPLE_ERRORS, PeopleStore } from "../../people/store";
import { emptyTimesheetContext } from "../../timesheet/context";
import { type ActionsCliDeps, runActionsCli } from "../actions";
import { type ClientsCliDeps, runClientsCli } from "../clients";
import { type PeopleCliDeps, runPeopleCli } from "../people";
import { CLI_MESSAGES, CLI_USAGE } from "../shared";
import { captureIO, fakeJobs, tempRoot } from "./cli-helpers";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA = "d".repeat(64);
const facts: JobFacts = {
  version: 1, jobId: JOB, mediaSha256: MEDIA, sourcePath: "/recordings/meeting.mkv", title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z",
  fingerprint: "0".repeat(64), revision: 0,
  speakers: [{ speakerId: "S01", label: "Ana Souza", confirmed: true }, { speakerId: "S02", label: "Falante 2", confirmed: false }],
  attendees: [{ name: "Bruno Lima", self: false }],
  clients: [{ code: "ACME", name: "Acme Corp", source: "content-match", confidence: 0.7 }],
  overview: "Lançamento aprovado.", topics: ["Lançamento"],
  decisions: [{ index: 0, text: "Lançar em março", segmentIds: [] }],
  actions: [{ index: 0, text: "Mandar proposta", owner: "Ana Souza", dueDate: "2026-11-01", segmentIds: [], origin: "model" }],
  noteCount: 0
};

const fakeIndex = () => {
  const refreshes: unknown[] = [];
  return {
    refreshes,
    index: {
      refresh: async (options?: unknown) => { refreshes.push(options ?? null); return {}; },
      listFacts: async () => [facts],
      getFacts: async (id: string) => (id === JOB ? facts : undefined),
      search: async () => []
    }
  };
};

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const root = async (): Promise<string> => { const path = await tempRoot("falatrace-entities-cli-"); roots.push(path); return path; };

test("people list, show and the edits: rename, alias, hide, merge", async () => {
  const dir = await root();
  const store = new PeopleStore(join(dir, "people"));
  const { index, refreshes } = fakeIndex();
  const run = async (...args: string[]) => {
    const capture = captureIO();
    const deps: PeopleCliDeps = { io: capture.io, loadConfig: async () => structuredClone(DEFAULT_CONFIG), index: () => index, store: () => store, options: (options) => options };
    await runPeopleCli(["people", ...args], deps);
    return JSON.parse(capture.out());
  };
  const listed = await run("list");
  expect(listed.map((person: { name: string }) => person.name).sort()).toEqual(["Ana Souza", "Bruno Lima"]);
  expect(refreshes.length).toBe(1);
  const ana = listed.find((person: { name: string }) => person.name === "Ana Souza");
  expect(ana).toMatchObject({ id: "name:ana souza", meetingCount: 1, openActions: 1, hidden: false });
  const detail = await run("show", "name:ana souza");
  expect(detail.meetings).toEqual([{ jobId: JOB, title: "Revisão semanal", date: facts.date, role: "speaker" }]);
  expect(detail.recentDecisions[0].text).toBe("Lançar em março");
  const renamed = await run("rename", "name:ana souza", "Ana", "S.", "Souza");
  expect(renamed.changed).toBe(true);
  const id = renamed.id as string;
  expect((await run("list")).find((person: { id: string }) => person.id === id)).toMatchObject({ name: "Ana S. Souza", aliases: ["Ana Souza"] });
  expect((await run("alias", id, "add", "Aninha")).changed).toBe(true);
  expect((await store.read()).people[0]!.aliases).toContain("Aninha");
  expect((await run("alias", id, "remove", "Aninha")).changed).toBe(true);
  await run("hide", "name:bruno lima");
  expect((await run("list")).map((person: { name: string }) => person.name)).toEqual(["Ana S. Souza"]);
  expect((await run("list", "--all")).length).toBe(2);
  await run("unhide", "name:bruno lima");
  const merged = await run("merge", "name:bruno lima", id);
  expect(merged.id).toBe(id);
  expect((await run("list")).map((person: { name: string }) => person.name)).toEqual(["Ana S. Souza"]);
  await expect(run("show", "name:ninguem")).rejects.toThrow(PEOPLE_ERRORS.notFound);
  await expect(run("alias", id, "rename", "x")).rejects.toThrow(CLI_USAGE.people);
  await expect(run()).rejects.toThrow(CLI_USAGE.people);
});

test("clients add, list, show, rename, assign (and back to automatic) and delete", async () => {
  const dir = await root();
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.contextPath = join(dir, "timesheet-context.json");
  const overrides = new ClientOverridesStore(join(dir, "client-overrides.json"));
  const { index, refreshes } = fakeIndex();
  const run = async (...args: string[]) => {
    const capture = captureIO();
    const deps: ClientsCliDeps = {
      io: capture.io, loadConfig: async () => config, index: () => index, overrides: () => overrides, people: () => new PeopleStore(join(dir, "people")),
      jobs: () => fakeJobs([{ id: JOB, source: { sha256: MEDIA } as never }]),
      catalog: { read: readClientCatalog, add: addCatalogClient, rename: renameCatalogClient, remove: deleteCatalogClient }
    };
    await runClientsCli(["clients", ...args], deps);
    return JSON.parse(capture.out());
  };
  const added = await run("add", "Acme", "Corp", "--code", "ACME", "--alias", "acme", "--alias", "acme corporation");
  expect(added.client).toEqual({ code: "ACME", name: "Acme Corp", aliases: ["acme", "acme corporation"], responsibleNames: [] });
  const listed = await run("list");
  expect(listed.catalog.state).toBe("ok");
  expect(listed.clients[0]).toMatchObject({ code: "ACME", meetingCount: 1, openActions: 1 });
  const detail = await run("show", "ACME");
  expect(detail.meetings[0]).toMatchObject({ jobId: JOB, title: "Revisão semanal" });
  expect((await run("rename", "ACME", "Acme", "Ltda")).client.name).toBe("Acme Ltda");
  expect(await run("assign", JOB, "ACME")).toEqual({ jobId: JOB, clientCodes: ["ACME"] });
  expect((await overrides.read()).entries).toMatchObject([{ jobId: JOB, mediaSha256: MEDIA, clientCodes: ["ACME"] }]);
  // The recording's facts are rebuilt so its pages show the choice.
  expect(refreshes[refreshes.length - 1]).toEqual({ jobIds: [JOB] });
  await expect(run("assign", JOB, "NOPE")).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.unknownClient);
  await expect(run("assign", JOB)).rejects.toThrow(CLI_MESSAGES.clientCodesRequired);
  await expect(run("assign", JOB, "ACME", "--auto")).rejects.toThrow(CLI_MESSAGES.clientCodesRequired);
  expect(await run("assign", JOB, "--auto")).toEqual({ jobId: JOB, clientCodes: "auto" });
  expect((await overrides.read()).entries).toEqual([]);
  await expect(run("assign", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ACME")).rejects.toThrow(CLI_MESSAGES.jobNotFound);
  expect((await run("delete", "ACME")).deleted).toBe("ACME");
  await expect(run("show", "ACME")).rejects.toThrow(CLIENTS_ERRORS.notFound);
  await expect(run("merge")).rejects.toThrow(CLI_USAGE.clients);
});

test("actions list reads without writing; done, reopen and dismiss save the state", async () => {
  const dir = await root();
  const store = new ActionsStore(join(dir, "actions"));
  const { index } = fakeIndex();
  const run = async (...args: string[]) => {
    const capture = captureIO();
    const deps: ActionsCliDeps = {
      io: capture.io, loadConfig: async () => structuredClone(DEFAULT_CONFIG), index: () => index, store: () => store,
      listDeps: async () => ({ people: await new PeopleStore(join(dir, "people")).directory(), overrides: { version: 1, rev: 0, entries: [] }, catalog: emptyTimesheetContext() })
    };
    await runActionsCli(["actions", ...args], deps);
    return capture.out();
  };
  const lines = (await run("list")).trim().split("\n");
  expect(lines).toHaveLength(1);
  const ref = lines[0]!.split("  ").pop()!;
  expect(ref).toMatch(new RegExp(`^${MEDIA}:[0-9a-f-]{36}$`));
  expect(lines[0]).toBe(`[ ] Mandar proposta — Ana Souza · até 2026-11-01 · Revisão semanal (2026-10-25)  ${ref}`);
  // Listing wrote nothing.
  expect(await store.read(MEDIA)).toBeUndefined();
  const done = JSON.parse(await run("done", ref));
  expect(done).toMatchObject({ action: ref, status: "done" });
  expect((await store.read(MEDIA))?.items[0]?.status).toBe("done");
  expect(await run("list")).toBe("");
  const listedDone = JSON.parse(await run("list", "--status", "done", "--json"));
  expect(listedDone).toMatchObject([{ text: "Mandar proposta", status: "done", jobId: JOB }]);
  expect(JSON.parse(await run("reopen", ref)).status).toBe("open");
  expect(JSON.parse(await run("dismiss", ref)).status).toBe("dismissed");
  expect(JSON.parse(await run("list", "--status", "all", "--meeting", JOB, "--json"))).toMatchObject([{ status: "dismissed" }]);
  await expect(run("done", "abc")).rejects.toThrow(CLI_MESSAGES.actionRefInvalid);
  await expect(run("list", "--status", "late")).rejects.toThrow(CLI_MESSAGES.actionStatusInvalid);
  await expect(run("toString", ref)).rejects.toThrow(CLI_USAGE.actions);
});
