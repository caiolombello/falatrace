import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ClientOverridesFile } from "../../clients/overrides";
import type { JobFacts } from "../../library-index/types";
import { action, attendee, facts, fakeReader, fixedClock, mediaSha, removeTempDirs, speaker, tempDir, uuid } from "../../people/__tests__/fixtures";
import { PeopleDirectory, PeopleStore } from "../../people/store";
import type { TimesheetContext } from "../../timesheet/types";
import { latestFactsPerMedia, listActions, listActionsForFacts, ownerNameCandidates } from "../list";
import { ACTIONS_ERRORS, ActionsStore, setActionStatus } from "../store";

afterEach(removeTempDirs);

const newStore = async () => {
  const clock = fixedClock();
  return { clock, store: new ActionsStore(join(await tempDir("actions-list-"), "actions"), { now: clock.now, lockTimeoutMs: 2_000 }) };
};

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "ACME", name: "Acme", aliases: [], responsibleNames: [] },
    { code: "BETA", name: "Beta", aliases: [], responsibleNames: [] }
  ]
};

describe("listActions", () => {
  test("lists the current summary's actions with saved state and the shape pages need", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, {
      title: "Planejamento",
      actions: [
        action(0, "Enviar a proposta", { owner: "Ana", dueDate: "2026-11-03", segmentIds: ["s000010", "bad", "s000010"] }),
        action(1, "Revisar notas", { origin: "note" })
      ]
    })]);
    const listed = await listActions(reader, {}, { store });
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      mediaSha256: mediaSha(1), jobId: uuid(1), title: "Planejamento", date: facts(1).date, text: "Enviar a proposta",
      owner: "Ana", dueDate: "2026-11-03", status: "open", origin: "model", segmentIds: ["s000010"], matchState: "current", rev: 1
    });
    expect(listed[1]).toMatchObject({ text: "Revisar notas", origin: "note", owner: "", dueDate: "" });
    expect(listed[0]!.actionId).toMatch(/^[0-9a-f-]{36}$/);
    const saved = await store.read(mediaSha(1));
    expect(saved!.items.map((item) => item.id)).toEqual(listed.map((item) => item.actionId));
    // A second listing finds the same ids and writes nothing.
    const again = await listActions(reader, {}, { store });
    expect(again.map((item) => item.actionId)).toEqual(listed.map((item) => item.actionId));
    expect((await store.read(mediaSha(1)))!.rev).toBe(1);
  });

  test("a status set through setActionStatus shows up and filters", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { actions: [action(0, "Enviar a proposta"), action(1, "Ligar para o Bruno")] })]);
    const listed = await listActions(reader, {}, { store });
    await setActionStatus(listed[0]!.mediaSha256, listed[0]!.actionId, "done", listed[0]!.rev, store);
    expect((await listActions(reader, { status: "open" }, { store })).map((item) => item.text)).toEqual(["Ligar para o Bruno"]);
    const done = await listActions(reader, { status: "done" }, { store });
    expect(done.map((item) => [item.text, item.status, item.rev])).toEqual([["Enviar a proposta", "done", 2]]);
  });

  test("a regenerated summary keeps the done state of reworded actions and flags dropped ones", async () => {
    const { store } = await newStore();
    let current: JobFacts[] = [facts(1, {
      actions: [
        action(0, "Enviar a proposta revisada para a Ana", { segmentIds: ["s000010", "s000011"] }),
        action(1, "Agendar treinamento da equipe", { segmentIds: ["s000020"] })
      ]
    })];
    const reader = fakeReader(() => current);
    const first = await listActions(reader, {}, { store });
    for (const item of first) await store.setStatus(item.mediaSha256, item.actionId, "done");

    // Regeneration: reworded, reordered, one action gone, one new.
    current = [facts(1, {
      revision: 1,
      actions: [
        action(0, "Criar relatório mensal", { segmentIds: ["s000030"] }),
        action(1, "Enviar proposta revisada à Ana amanhã", { segmentIds: ["s000011"] })
      ]
    })];
    const second = await listActions(reader, {}, { store });
    const byText = Object.fromEntries(second.map((item) => [item.text, item]));
    expect(byText["Enviar proposta revisada à Ana amanhã"]).toMatchObject({ actionId: first[0]!.actionId, status: "done", matchState: "current", segmentIds: ["s000011"] });
    expect(byText["Criar relatório mensal"]).toMatchObject({ status: "open", matchState: "current" });
    expect(byText["Agendar treinamento da equipe"]).toMatchObject({ actionId: first[1]!.actionId, status: "done", matchState: "orphaned", segmentIds: ["s000020"] });
    // Current actions come first, in summary order; orphans last.
    expect(second.map((item) => item.matchState)).toEqual(["current", "current", "orphaned"]);
    expect((await listActions(reader, { includeOrphaned: false }, { store })).map((item) => item.text))
      .toEqual(["Criar relatório mensal", "Enviar proposta revisada à Ana amanhã"]);
  });

  test("a reprocessed recording shares state with the earlier job of the same media", async () => {
    const { store } = await newStore();
    const old = facts(1, { actions: [action(0, "Enviar a proposta")] });
    const first = await listActions(fakeReader([old]), {}, { store });
    await store.setStatus(mediaSha(1), first[0]!.actionId, "dismissed");
    const reprocessed = facts(2, { mediaSha256: mediaSha(1), actions: [action(0, "Enviar a proposta")] });
    const listed = await listActions(fakeReader([old, reprocessed]), {}, { store });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ actionId: first[0]!.actionId, jobId: uuid(2), status: "dismissed" });
    expect((await store.read(mediaSha(1)))!.jobIds.sort()).toEqual([uuid(1), uuid(2)]);
    // Either job id finds the media's actions.
    expect(await listActions(fakeReader([old, reprocessed]), { jobId: uuid(1) }, { store })).toHaveLength(1);
  });

  test("an orphan points at its own recording while it exists, else at the current one", async () => {
    const { store } = await newStore();
    const old = facts(1, { actions: [action(0, "Ação antiga")] });
    await listActions(fakeReader([old]), {}, { store });
    const reprocessed = facts(2, { mediaSha256: mediaSha(1), title: "Nova versão", actions: [action(0, "Outra coisa totalmente diferente")] });
    const both = await listActions(fakeReader([old, reprocessed]), {}, { store });
    expect(both.find((item) => item.matchState === "orphaned")).toMatchObject({ jobId: uuid(1), title: "Reunião 1" });
    // The old job was deleted: the orphan opens the recording that remains.
    const after = await listActions(fakeReader([reprocessed]), {}, { store });
    expect(after.find((item) => item.matchState === "orphaned")).toMatchObject({ jobId: uuid(2), title: "Nova versão" });
  });

  test("filters by recording, person and client", async () => {
    const { store } = await newStore();
    const people = new PeopleDirectory();
    const items = [
      facts(1, {
        speakers: [speaker("Ana Souza"), speaker("Bruno Lima", true, "S02")],
        clients: [{ code: "ACME", name: "Acme", source: "content-match", confidence: 0.6 }],
        actions: [action(0, "Enviar a proposta", { owner: "Ana" }), action(1, "Revisar contrato", { owner: "Ana e Bruno (jurídico)" })]
      }),
      facts(2, {
        speakers: [speaker("Bruno Lima")],
        clients: [{ code: "BETA", name: "Beta", source: "entry-locked", confidence: 1 }],
        actions: [action(0, "Atualizar planilha", { owner: "bruno lima" })]
      })
    ];
    const reader = fakeReader(items);
    const deps = { store, people, catalog };
    expect((await listActions(reader, { jobId: uuid(1) }, deps)).map((item) => item.text)).toEqual(["Enviar a proposta", "Revisar contrato"]);
    expect(await listActions(reader, { jobId: uuid(99) }, deps)).toEqual([]);
    expect((await listActions(reader, { personId: "name:ana souza" }, deps)).map((item) => item.text)).toEqual(["Enviar a proposta", "Revisar contrato"]);
    expect((await listActions(reader, { personId: "name:bruno lima" }, deps)).map((item) => item.text)).toEqual(["Atualizar planilha", "Revisar contrato"]);
    expect(await listActions(reader, { personId: "name:ninguem" }, deps)).toEqual([]);
    expect(await listActions(reader, { personId: "não é um id" }, deps)).toEqual([]);
    expect((await listActions(reader, { clientCode: "BETA" }, deps)).map((item) => item.text)).toEqual(["Atualizar planilha"]);
    const all = await listActions(reader, {}, deps);
    expect(all.find((item) => item.text === "Revisar contrato")!.ownerPersonIds).toEqual(["name:ana souza", "name:bruno lima"]);
  });

  test("a lone first name names nobody when two people of the meeting share it", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, {
      speakers: [speaker("Ana Souza"), speaker("Ana Lima", true, "S02")],
      actions: [action(0, "Enviar a proposta", { owner: "Ana" })]
    })]);
    const [item] = await listActions(reader, {}, { store });
    expect(item!.ownerPersonIds).toEqual([]);
  });

  test("owners resolve through stored aliases and merges", async () => {
    const { store } = await newStore();
    const peopleStore = new PeopleStore(join(await tempDir("actions-people-"), "people"), { newId: () => uuid(300) });
    await peopleStore.rename("name:ana souza", "Ana Souza");
    await peopleStore.addAlias(uuid(300), "Aninha");
    const people = new PeopleDirectory(await peopleStore.read());
    const reader = fakeReader([facts(1, { speakers: [speaker("Ana Souza")], actions: [action(0, "Enviar a proposta", { owner: "aninha" })] })]);
    const [item] = await listActions(reader, { personId: "name:ana souza" }, { store, people });
    expect(item!.ownerPersonIds).toEqual([uuid(300)]);
  });

  test("manual client choices decide the client filter", async () => {
    const { store } = await newStore();
    const items = [facts(1, {
      clients: [{ code: "ACME", name: "Acme", source: "content-match", confidence: 0.6 }],
      actions: [action(0, "Enviar a proposta")]
    })];
    const overrides: ClientOverridesFile = {
      version: 1, rev: 1, entries: [{ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["BETA"], setAt: "2026-10-20T10:00:00.000Z" }]
    };
    const reader = fakeReader(items);
    expect(await listActions(reader, { clientCode: "ACME" }, { store, overrides, catalog })).toEqual([]);
    expect((await listActions(reader, { clientCode: "BETA" }, { store, overrides, catalog }))[0]!.clientCodes).toEqual(["BETA"]);
  });

  test("manual actions are listed with the recording's actions", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { actions: [action(0, "Enviar a proposta")] })]);
    await listActions(reader, {}, { store });
    await store.addUserAction(mediaSha(1), { jobId: uuid(1), text: "Pagar fornecedor", ownerText: "Caio" });
    const listed = await listActions(reader, {}, { store });
    expect(listed.map((item) => [item.text, item.origin, item.owner])).toEqual([["Enviar a proposta", "model", ""], ["Pagar fornecedor", "user", "Caio"]]);
  });

  test("newest recordings first", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { actions: [action(0, "Primeira")] }), facts(3, { actions: [action(0, "Terceira")] }), facts(2, { actions: [action(0, "Segunda")] })]);
    expect((await listActions(reader, {}, { store })).map((item) => item.text)).toEqual(["Terceira", "Segunda", "Primeira"]);
  });

  test("persist:false lists without writing anything", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { actions: [action(0, "Enviar a proposta")] })]);
    const listed = await listActions(reader, {}, { store, persist: false });
    expect(listed).toHaveLength(1);
    expect(await fs.stat(store.root).catch(() => null)).toBeNull();
    // The ids match the ones a later saved listing gets.
    expect((await listActions(reader, {}, { store }))[0]!.actionId).toBe(listed[0]!.actionId);
  });

  test("segment start times come from the injected reader when available", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { actions: [action(0, "Com citação", { segmentIds: ["s000004", "s000005"] }), action(1, "Sem citação")] })]);
    const calls: Array<[string, string[]]> = [];
    const listed = await listActions(reader, {}, {
      store,
      segmentStarts: async (jobId, ids) => { calls.push([jobId, ids]); return { s000004: 12.5 }; }
    });
    expect(listed.map((item) => item.start)).toEqual([12.5, undefined]);
    expect(calls).toEqual([[uuid(1), ["s000004"]]]);
    const failing = await listActions(reader, {}, { store, segmentStarts: async () => { throw new Error("transcrição ilegível"); } });
    expect(failing.map((item) => item.start)).toEqual([undefined, undefined]);
  });

  test("text from the index is sanitized and malformed actions are skipped", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, {
      actions: [
        action(0, "Mandar para ana@example.com\u0007 hoje", { owner: "ana@example.com" }),
        { index: 1, text: 42, owner: "", dueDate: "", segmentIds: [], origin: "model" } as never,
        action(2, "   ")
      ]
    })]);
    const listed = await listActions(reader, {}, { store });
    expect(listed.map((item) => [item.text, item.owner])).toEqual([["Mandar para [e-mail omitido] hoje", "[e-mail omitido]"]]);
  });

  test("a damaged state file still lists, without touching the file", async () => {
    const { store } = await newStore();
    await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
    await fs.writeFile(store.path(mediaSha(1)), "[]", { mode: 0o600 });
    const listed = await listActions(fakeReader([facts(1, { actions: [action(0, "Enviar a proposta")] })]), {}, { store });
    expect(listed).toHaveLength(1);
    expect(await fs.readFile(store.path(mediaSha(1)), "utf8")).toBe("[]");
  });

  test("invalid filters are refused", async () => {
    const { store } = await newStore();
    const reader = fakeReader([]);
    for (const options of [{ status: "closed" }, { jobId: "../x" }, { clientCode: "x".repeat(21) }, { personId: "x".repeat(211) }, { includeOrphaned: "yes" }]) {
      await expect(listActions(reader, options as never, { store })).rejects.toThrow(ACTIONS_ERRORS.invalidFilter);
    }
  });

  test("attendees can be action owners too", async () => {
    const { store } = await newStore();
    const reader = fakeReader([facts(1, { attendees: [attendee("Dora Lima")], actions: [action(0, "Enviar o contrato", { owner: "Dora" })] })]);
    expect((await listActions(reader, {}, { store }))[0]!.ownerPersonIds).toEqual(["name:dora lima"]);
  });
});

describe("helpers", () => {
  test("owner text candidates: whole text, then each name", () => {
    expect(ownerNameCandidates("Ana e Bruno")).toEqual(["Ana e Bruno", "Ana", "Bruno"]);
    expect(ownerNameCandidates("Ana, Bruno (financeiro); Carla / Dora & Edu")).toEqual(["Ana, Bruno ; Carla / Dora & Edu", "Ana", "Bruno", "Carla", "Dora", "Edu"]);
    expect(ownerNameCandidates("")).toEqual([]);
    expect(ownerNameCandidates("x".repeat(501))).toEqual([]);
  });

  test("one facts entry per media, the first (newest) one", () => {
    const newest = facts(2, { mediaSha256: mediaSha(1) });
    expect(latestFactsPerMedia([newest, facts(1), facts(3)]).map((item) => item.jobId)).toEqual([uuid(2), uuid(3)]);
  });

  test("listActionsForFacts accepts facts already loaded", async () => {
    const { store } = await newStore();
    expect(await listActionsForFacts([facts(1, { actions: [action(0, "Enviar")] })], {}, { store })).toHaveLength(1);
  });
});
