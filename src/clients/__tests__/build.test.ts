import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ActionsStore } from "../../actions/store";
import type { JobRecord } from "../../jobs/types";
import type { FactClient } from "../../library-index/types";
import { action, attendee, facts, fakeReader, fixedClock, mediaSha, removeTempDirs, speaker, tempDir, timeEntry, uuid } from "../../people/__tests__/fixtures";
import { PeopleDirectory, PeopleStore } from "../../people/store";
import type { TimesheetContext } from "../../timesheet/types";
import { CLIENTS_ERRORS, CLIENTS_KNOWN_ERRORS, buildClients, clientDetail, createIndexClientResolver, factsSearchText } from "../build";
import type { ClientOverridesFile } from "../overrides";

afterEach(removeTempDirs);

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "ACME", name: "Acme Brasil", aliases: ["acme"], responsibleNames: ["Ana"] },
    { code: "BETA", name: "Beta Saúde", aliases: [], responsibleNames: [] },
    { code: "IDLE", name: "Sem reuniões", aliases: [], responsibleNames: [] }
  ]
};

const assigned = (code: string, source: FactClient["source"] = "entry-locked", confidence = 1): FactClient => ({ code, name: `${code} (índice)`, source, confidence });

const newActionsStore = async () => new ActionsStore(join(await tempDir("clients-actions-"), "actions"), { now: fixedClock().now });

describe("buildClients", () => {
  test("joins every catalog client with its recordings, most recently met first", async () => {
    const reader = fakeReader([
      facts(1, { clients: [assigned("BETA", "content-match", 0.6)] }),
      facts(2, { clients: [assigned("ACME")] }),
      facts(3, { clients: [assigned("ACME", "entry-split", 0.9), assigned("BETA", "entry-split", 0.9)] }),
      facts(4, { clients: [assigned("GONE")] })
    ]);
    const clients = await buildClients(reader, catalog, { actions: false });
    expect(clients.map((client) => [client.code, client.meetingCount, client.lastMeetingAt])).toEqual([
      ["ACME", 2, facts(3).date],
      ["BETA", 2, facts(3).date],
      ["IDLE", 0, null]
    ]);
    expect(clients[0]).toMatchObject({ name: "Acme Brasil", aliases: ["acme"], responsibleNames: ["Ana"] });
    expect(clients[0]!.meetings).toEqual([
      { jobId: uuid(3), title: "Reunião 3", date: facts(3).date, source: "entry-split", confidence: 0.9 },
      { jobId: uuid(2), title: "Reunião 2", date: facts(2).date, source: "entry-locked", confidence: 1 }
    ]);
  });

  test("manual choices move recordings between clients", async () => {
    const overrides: ClientOverridesFile = {
      version: 1, rev: 2,
      entries: [
        { jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"], setAt: "2026-10-20T00:00:00.000Z" },
        { jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: [], setAt: "2026-10-20T00:00:00.000Z" }
      ]
    };
    const reader = fakeReader([facts(1, { clients: [assigned("BETA")] }), facts(2, { clients: [assigned("ACME")] })]);
    const clients = await buildClients(reader, catalog, { overrides, actions: false });
    const byCode = Object.fromEntries(clients.map((client) => [client.code, client]));
    expect(byCode.ACME!.meetings.map((meeting) => [meeting.jobId, meeting.source])).toEqual([[uuid(1), "manual"]]);
    expect(byCode.BETA!.meetingCount).toBe(0);
  });

  test("an empty (or invalid, read as empty) catalog shows no clients", async () => {
    const reader = fakeReader([facts(1, { clients: [assigned("ACME")] })]);
    expect(await buildClients(reader, { ...catalog, clients: [] }, { actions: false })).toEqual([]);
  });

  test("counts the open actions of each client's recordings", async () => {
    const reader = fakeReader([
      facts(1, { clients: [assigned("ACME")], actions: [action(0, "Enviar a proposta"), action(1, "Revisar o contrato")] }),
      facts(2, { clients: [assigned("BETA")], actions: [action(0, "Ligar para a Beta")] })
    ]);
    const actionsStore = await newActionsStore();
    const first = await buildClients(reader, catalog, { actionsStore });
    expect(Object.fromEntries(first.map((client) => [client.code, client.openActions]))).toEqual({ ACME: 2, BETA: 1, IDLE: 0 });
    const saved = (await actionsStore.read(mediaSha(1)))!;
    await actionsStore.setStatus(mediaSha(1), saved.items[0]!.id, "done");
    const second = await buildClients(reader, catalog, { actionsStore });
    expect(second.find((client) => client.code === "ACME")!.openActions).toBe(1);
  });

  test("reprocessed recordings count once", async () => {
    const reader = fakeReader([facts(1, { clients: [assigned("ACME")] }), facts(2, { mediaSha256: mediaSha(1), clients: [assigned("ACME")] })]);
    const [acme] = await buildClients(reader, catalog, { actions: false });
    expect(acme!.meetings.map((meeting) => meeting.jobId)).toEqual([uuid(2)]);
  });
});

describe("clientDetail", () => {
  test("adds decisions, open actions and the people met, without the user", async () => {
    const peopleStore = new PeopleStore(join(await tempDir("clients-people-"), "people"), { newId: () => uuid(400) });
    await peopleStore.setHidden("name:sala 2", true, { currentName: "Sala 2" });
    const people = new PeopleDirectory(await peopleStore.read());
    const reader = fakeReader([
      facts(1, {
        clients: [assigned("ACME")],
        speakers: [speaker("Ana"), speaker("Bruno", true, "S02")],
        attendees: [attendee("Caio", true), attendee("Sala 2")],
        decisions: [{ index: 0, text: "Fechar o escopo", segmentIds: ["s000002"] }],
        actions: [action(0, "Enviar a proposta", { owner: "Ana" })]
      }),
      facts(2, { clients: [assigned("ACME")], speakers: [speaker("Ana")], decisions: [{ index: 0, text: "Adiar a entrega ana@example.com", segmentIds: [] }] }),
      facts(3, { clients: [assigned("BETA")], speakers: [speaker("Dora")], decisions: [{ index: 0, text: "Outro cliente", segmentIds: [] }] })
    ]);
    const detail = await clientDetail(reader, catalog, "ACME", { people, actionsStore: await newActionsStore() });
    expect(detail.meetingCount).toBe(2);
    expect(detail.recentDecisions).toEqual([
      { jobId: uuid(2), title: "Reunião 2", date: facts(2).date, text: "Adiar a entrega [e-mail omitido]", segmentIds: [] },
      { jobId: uuid(1), title: "Reunião 1", date: facts(1).date, text: "Fechar o escopo", segmentIds: ["s000002"] }
    ]);
    expect(detail.openActionItems.map((item) => item.text)).toEqual(["Enviar a proposta"]);
    expect(detail.people).toEqual([{ id: "name:ana", name: "Ana", meetings: 2 }, { id: "name:bruno", name: "Bruno", meetings: 1 }]);
  });

  test("an unknown client is refused", async () => {
    await expect(clientDetail(fakeReader([]), catalog, "NOPE", { actions: false })).rejects.toThrow(CLIENTS_ERRORS.notFound);
    expect(CLIENTS_KNOWN_ERRORS).toContain(CLIENTS_ERRORS.notFound);
  });
});

describe("createIndexClientResolver", () => {
  const job = (n: number): JobRecord => ({ id: uuid(n), sourcePath: `/recordings/${n}.mkv`, source: { sha256: mediaSha(n) } } as JobRecord);

  test("resolves clients for the library index with entries, overrides and content", async () => {
    const loads = { catalog: 0, entries: 0, overrides: 0 };
    const resolver = createIndexClientResolver({
      readyConfidence: 0.8,
      loadCatalog: async () => { loads.catalog++; return catalog; },
      listEntries: async () => {
        loads.entries++;
        return [timeEntry(1, { clientCode: "BETA", lockedFields: ["client"], source: { kind: "call", jobId: uuid(1) } })];
      },
      readOverrides: async () => {
        loads.overrides++;
        return { version: 1, rev: 1, entries: [{ jobId: uuid(3), mediaSha256: mediaSha(3), clientCodes: ["IDLE"], setAt: "2026-10-01T00:00:00.000Z" }] };
      },
      transcriptText: async (record) => (record.id === uuid(4) ? "A Beta Saúde ligou" : "")
    });
    expect(await resolver(job(1), facts(1))).toEqual([{ code: "BETA", name: "Beta Saúde", source: "entry-locked", confidence: 1 }]);
    expect(await resolver(job(2), facts(2, { overview: "Portal da Acme" }))).toEqual([{ code: "ACME", name: "Acme Brasil", source: "content-match", confidence: 0.6 }]);
    expect(await resolver(job(3), facts(3, { overview: "Portal da Acme" }))).toEqual([{ code: "IDLE", name: "Sem reuniões", source: "manual", confidence: 1 }]);
    expect(await resolver(job(4), facts(4))).toEqual([{ code: "BETA", name: "Beta Saúde", source: "content-match", confidence: 0.6 }]);
    expect(await resolver(job(5), facts(5))).toEqual([]);
    // One load serves the whole refresh.
    expect(loads).toEqual({ catalog: 1, entries: 1, overrides: 1 });
  });

  test("inputs are reloaded once the cache is older than cacheMs", async () => {
    let clock = 1_000;
    let current = catalog;
    const resolver = createIndexClientResolver({
      readyConfidence: 0.8, cacheMs: 5_000, now: () => clock,
      loadCatalog: async () => current,
      listEntries: async () => []
    });
    const recording = facts(1, { overview: "Beta Saúde" });
    expect((await resolver(job(1), recording))[0]!.code).toBe("BETA");
    current = { ...catalog, clients: catalog.clients.filter((client) => client.code !== "BETA") };
    clock += 4_999;
    expect((await resolver(job(1), recording))[0]!.code).toBe("BETA");
    clock += 1;
    expect(await resolver(job(1), recording)).toEqual([]);
  });

  test("unreadable inputs give no clients instead of failing the index", async () => {
    const resolver = createIndexClientResolver({
      readyConfidence: 0.8,
      loadCatalog: async () => { throw new Error("O catálogo de clientes é inválido"); },
      listEntries: async () => { throw new Error("EACCES"); },
      readOverrides: async () => { throw new Error("quebrado"); },
      transcriptText: async () => { throw new Error("sem transcrição"); }
    });
    expect(await resolver(job(1), facts(1, { overview: "Acme" }))).toEqual([]);
    const partial = createIndexClientResolver({
      readyConfidence: 0.8,
      loadCatalog: async () => catalog,
      listEntries: async () => { throw new Error("EACCES"); },
      transcriptText: async () => { throw new Error("sem transcrição"); }
    });
    expect((await partial(job(1), facts(1, { overview: "Acme" })))[0]!.code).toBe("ACME");
    expect(await partial(job(2), facts(2))).toEqual([]);
  });

  test("the summary-like text covers title, overview, topics, decisions and actions", () => {
    const text = factsSearchText(facts(1, {
      title: "T", overview: "O", topics: ["P"], decisions: [{ index: 0, text: "D", segmentIds: [] }],
      actions: [action(0, "A", { owner: "Dono", dueDate: "sexta" })]
    }));
    expect(text.split("\n")).toEqual(["T", "O", "P", "D", "A", "Dono", "sexta"]);
  });
});
