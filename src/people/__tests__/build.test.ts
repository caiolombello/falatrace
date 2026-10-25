import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { listActionsForFacts } from "../../actions/list";
import { ActionsStore } from "../../actions/store";
import type { JobFacts } from "../../library-index/types";
import { PEOPLE_BUILD_LIMITS, buildPeople, personDetail } from "../build";
import { PEOPLE_ERRORS, PeopleDirectory, type PeopleFile, PeopleStore } from "../store";
import { action, attendee, facts, fakeReader, fixedClock, mediaSha, removeTempDirs, speaker, tempDir, uuid } from "./fixtures";

afterEach(removeTempDirs);

const emptyStore = { read: async (): Promise<PeopleFile> => ({ version: 1, rev: 0, people: [] }) };

const newPeopleStore = async () => {
  let next = 100;
  return new PeopleStore(join(await tempDir("people-build-"), "people"), { now: fixedClock().now, newId: () => uuid(next++) });
};

const newActionsStore = async () => new ActionsStore(join(await tempDir("people-actions-"), "actions"), { now: fixedClock().now });

describe("buildPeople", () => {
  test("groups the same name across meetings by identity (case, accents, spacing)", async () => {
    const reader = fakeReader([
      facts(1, { speakers: [speaker("Aná  Souza")] }),
      facts(2, { speakers: [speaker("ana souza")], attendees: [attendee("Bruno Lima")] }),
      facts(3, { attendees: [attendee("Ana Souza"), attendee("Bruno Lima")], speakers: [speaker("Ana Souza", true, "S02")] })
    ]);
    const people = await buildPeople(reader, emptyStore, { actions: false });
    expect(people.map((person) => person.id)).toEqual(["name:ana souza", "name:bruno lima"]);
    const ana = people[0]!;
    expect(ana.meetings.map((meeting) => meeting.jobId)).toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(ana.meetingCount).toBe(3);
    expect(ana.lastMeetingAt).toBe(facts(3).date);
    // The spelling used most often wins; a tie goes to the most recent one.
    expect(ana.name).toBe("Ana Souza");
    expect(ana.aliases).toEqual([]);
    expect(ana.self).toBe(false);
    expect(ana.hidden).toBe(false);
  });

  test("a speaker in the same meeting is reported as speaker, not attendee", async () => {
    const reader = fakeReader([facts(1, { attendees: [attendee("Ana")], speakers: [speaker("Ana")] })]);
    const [ana] = await buildPeople(reader, emptyStore, { actions: false });
    expect(ana!.meetings).toEqual([{ jobId: uuid(1), title: "Reunião 1", date: facts(1).date, role: "speaker" }]);
  });

  test("unconfirmed and default diarizer labels are not people", async () => {
    const reader = fakeReader([facts(1, {
      speakers: [speaker("Falante 1"), speaker("Speaker 2"), speaker("Carla", false), speaker("  "), speaker("x".repeat(201))],
      attendees: [attendee("Participante 3")]
    })]);
    expect(await buildPeople(reader, emptyStore, { actions: false })).toEqual([]);
  });

  test("a reprocessed recording (same media) counts once, from its newest job", async () => {
    const old = facts(1, { speakers: [speaker("Ana")] });
    const reprocessed = facts(2, { mediaSha256: old.mediaSha256, speakers: [speaker("Ana")] });
    const [ana] = await buildPeople(fakeReader([old, reprocessed]), emptyStore, { actions: false });
    expect(ana!.meetings.map((meeting) => meeting.jobId)).toEqual([uuid(2)]);
  });

  test("malformed facts entries are skipped instead of trusted", async () => {
    const broken = [{ ...facts(1, { speakers: [speaker("Ana")] }), jobId: "../x" }, { ...facts(2), speakers: "Ana" }] as unknown as JobFacts[];
    const reader = fakeReader([...broken, facts(3, { speakers: [speaker("Bruno")] })]);
    expect((await buildPeople(reader, emptyStore, { actions: false })).map((person) => person.name)).toEqual(["Bruno"]);
  });

  test("names are sanitized before they reach a page", async () => {
    const reader = fakeReader([facts(1, { speakers: [speaker("ana@example.com")], title: "Com contato ana@example.com" })]);
    const [person] = await buildPeople(reader, emptyStore, { actions: false });
    expect(person!.name).toBe("[e-mail omitido]");
    expect(person!.meetings[0]!.title).toBe("Com contato [e-mail omitido]");
  });

  test("renames and aliases from the people store regroup names under one record", async () => {
    const store = await newPeopleStore();
    await store.rename("name:ana", "Ana Souza", { currentName: "Ana" });
    await store.addAlias(uuid(100), "Aninha");
    const reader = fakeReader([
      facts(1, { speakers: [speaker("Ana")] }),
      facts(2, { speakers: [speaker("Aninha")] }),
      facts(3, { attendees: [attendee("ANA SOUZA")] })
    ]);
    const people = await buildPeople(reader, store, { actions: false });
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: uuid(100), name: "Ana Souza", aliases: ["Ana", "Aninha"], meetingCount: 3 });
  });

  test("merged people answer under the record they were merged into", async () => {
    const store = await newPeopleStore();
    await store.rename("name:bia", "Beatriz", { currentName: "Bia" });           // uuid(100)
    await store.rename("name:beatriz costa", "Beatriz Costa");                     // uuid(101)
    await store.merge(uuid(100), uuid(101));
    await store.merge("name:b. costa", uuid(101), { sourceName: "B. Costa" });
    const reader = fakeReader([
      facts(1, { speakers: [speaker("Bia")] }),
      facts(2, { speakers: [speaker("Beatriz Costa")] }),
      facts(3, { attendees: [attendee("b. costa")] })
    ]);
    const people = await buildPeople(reader, store, { actions: false });
    expect(people).toHaveLength(1);
    expect(people[0]!.id).toBe(uuid(101));
    expect(people[0]!.meetingCount).toBe(3);
    expect(people[0]!.aliases).toEqual(["B. Costa", "Beatriz", "Bia"]);
  });

  test("hidden people are left out unless asked for", async () => {
    const store = await newPeopleStore();
    await store.setHidden("name:sala 3", true, { currentName: "Sala 3" });
    const reader = fakeReader([facts(1, { attendees: [attendee("Sala 3"), attendee("Ana")] })]);
    expect((await buildPeople(reader, store, { actions: false })).map((person) => person.name)).toEqual(["Ana"]);
    const all = await buildPeople(reader, store, { actions: false, includeHidden: true });
    expect(all.find((person) => person.name === "Sala 3")).toMatchObject({ hidden: true, id: uuid(100) });
  });

  test("stored people without meetings stay listed, after the ones met recently", async () => {
    const store = await newPeopleStore();
    await store.rename("name:zelia", "Zélia");
    const people = await buildPeople(fakeReader([facts(1, { speakers: [speaker("Ana")] })]), store, { actions: false });
    expect(people.map((person) => [person.name, person.lastMeetingAt])).toEqual([["Ana", facts(1).date], ["Zélia", null]]);
  });

  test("self: the calendar's own attendee entry or one of the given names", async () => {
    const reader = fakeReader([
      facts(1, { attendees: [attendee("Caio Lombello", true), attendee("Ana")] }),
      facts(2, { speakers: [speaker("Dora")], attendees: [attendee("Bruno")] })
    ]);
    const people = await buildPeople(reader, emptyStore, { actions: false, selfNames: ["dóra", "Ninguém Aqui"] });
    const self = Object.fromEntries(people.map((person) => [person.name, person.self]));
    expect(self).toEqual({ "Caio Lombello": true, Ana: false, Dora: true, Bruno: false });
    expect(people.some((person) => person.name === "Ninguém Aqui")).toBe(false);
  });

  test("voice profiles add their people and link the profile id", async () => {
    const reader = fakeReader([facts(1, { speakers: [speaker("Ana")] })]);
    const voices = async () => [
      { id: uuid(500), name: "ana" },
      { id: uuid(501), name: "Eduardo" },
      { id: "not-a-uuid", name: "Fabio" },
      { id: uuid(502), name: "Falante 2" }
    ];
    // The third argument may be the voice source itself.
    const people = await buildPeople(reader, emptyStore, voices);
    expect(people.map((person) => [person.name, person.voicePersonId, person.meetingCount])).toEqual([
      ["Ana", uuid(500), 1],
      ["Eduardo", uuid(501), 0]
    ]);
  });

  test("an unreadable voice store does not hide anyone else", async () => {
    const reader = fakeReader([facts(1, { speakers: [speaker("Ana")] })]);
    const people = await buildPeople(reader, emptyStore, { actions: false, listVoicePeople: async () => { throw new Error("voices.json quebrado"); } });
    expect(people.map((person) => person.name)).toEqual(["Ana"]);
  });

  test("open actions are counted for the people their owner text names", async () => {
    const items = [
      facts(1, {
        speakers: [speaker("Ana Souza"), speaker("Bruno", true, "S02")],
        actions: [action(0, "Enviar a proposta", { owner: "Ana" }), action(1, "Revisar o contrato", { owner: "Ana e Bruno" }), action(2, "Sem dono")]
      })
    ];
    const actionsStore = await newActionsStore();
    const people = await buildPeople(fakeReader(items), emptyStore, { actionsStore });
    expect(Object.fromEntries(people.map((person) => [person.name, person.openActions]))).toEqual({ "Ana Souza": 2, Bruno: 1 });
    // Listing saved the action state as a side effect.
    expect(await actionsStore.read(mediaSha(1))).toBeDefined();
  });

  test("done actions no longer count", async () => {
    const items = [facts(1, { speakers: [speaker("Ana")], actions: [action(0, "Enviar a proposta", { owner: "Ana" })] })];
    const actionsStore = await newActionsStore();
    const directory = new PeopleDirectory();
    const listed = await listActionsForFacts(items, {}, { store: actionsStore, people: directory });
    await actionsStore.setStatus(mediaSha(1), listed[0]!.actionId, "done");
    const [ana] = await buildPeople(fakeReader(items), emptyStore, { actionsStore });
    expect(ana!.openActions).toBe(0);
  });

  test("meetings per person are bounded but still counted", async () => {
    const items = Array.from({ length: PEOPLE_BUILD_LIMITS.meetingsPerPerson + 5 }, (_, index) => facts(index + 1, {
      date: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(),
      speakers: [speaker("Ana")]
    }));
    const [ana] = await buildPeople(fakeReader(items), emptyStore, { actions: false });
    expect(ana!.meetings).toHaveLength(PEOPLE_BUILD_LIMITS.meetingsPerPerson);
    expect(ana!.meetingCount).toBe(PEOPLE_BUILD_LIMITS.meetingsPerPerson + 5);
  });

  test("an invalid people file is reported, not silently ignored", async () => {
    const store = await newPeopleStore();
    await fs.mkdir(store.root, { recursive: true });
    await fs.writeFile(store.path, "{", { mode: 0o600 });
    await expect(buildPeople(fakeReader([]), store, { actions: false })).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
  });
});

describe("personDetail", () => {
  const library = (): JobFacts[] => [
    facts(1, {
      speakers: [speaker("Ana"), speaker("Bruno", true, "S02")],
      decisions: [{ index: 0, text: "Adiar o lançamento", segmentIds: ["s000001", 7 as unknown as string] }],
      actions: [action(0, "Enviar a proposta", { owner: "Ana" }), action(1, "Ligar para o fornecedor", { owner: "Bruno" })]
    }),
    facts(2, {
      attendees: [attendee("Ana")],
      decisions: [{ index: 0, text: "Contratar mais uma pessoa", segmentIds: [] }, { index: 1, text: "  ", segmentIds: [] }]
    }),
    facts(3, { speakers: [speaker("Bruno")], decisions: [{ index: 0, text: "Decisão sem a Ana", segmentIds: [] }] })
  ];

  test("adds recent decisions of their meetings and the open actions they own", async () => {
    const detail = await personDetail(fakeReader(library()), emptyStore, "name:ana", { actionsStore: await newActionsStore() });
    expect(detail.name).toBe("Ana");
    expect(detail.meetings.map((meeting) => meeting.jobId)).toEqual([uuid(2), uuid(1)]);
    expect(detail.recentDecisions).toEqual([
      { jobId: uuid(2), title: "Reunião 2", date: facts(2).date, text: "Contratar mais uma pessoa", segmentIds: [] },
      { jobId: uuid(1), title: "Reunião 1", date: facts(1).date, text: "Adiar o lançamento", segmentIds: ["s000001"] }
    ]);
    expect(detail.openActionItems.map((item) => item.text)).toEqual(["Enviar a proposta"]);
    expect(detail.openActions).toBe(1);
    expect(detail.mergedPeople).toEqual([]);
  });

  test("an old id still opens the person after a rename or merge", async () => {
    const store = await newPeopleStore();
    await store.rename("name:ana", "Ana Paula");          // uuid(100)
    await store.rename("name:bruno", "Bruno Dias");       // uuid(101)
    await store.merge(uuid(101), uuid(100));
    const detail = await personDetail(fakeReader(library()), store, "name:bruno", { actions: false });
    expect(detail.id).toBe(uuid(100));
    expect(detail.meetingCount).toBe(3);
    expect(detail.mergedPeople).toEqual([{ id: uuid(101), name: "Bruno Dias" }]);
    expect((await personDetail(fakeReader(library()), store, uuid(101), { actions: false })).id).toBe(uuid(100));
  });

  test("unknown and malformed ids are refused", async () => {
    const reader = fakeReader(library());
    await expect(personDetail(reader, emptyStore, "name:zeca", { actions: false })).rejects.toThrow(PEOPLE_ERRORS.notFound);
    await expect(personDetail(reader, emptyStore, uuid(9), { actions: false })).rejects.toThrow(PEOPLE_ERRORS.notFound);
    await expect(personDetail(reader, emptyStore, "../../etc/passwd", { actions: false })).rejects.toThrow(PEOPLE_ERRORS.invalidId);
    await expect(personDetail(reader, emptyStore, "name:Ana", { actions: false })).rejects.toThrow(PEOPLE_ERRORS.notFound);
  });

  test("recent decisions are bounded", async () => {
    const items = Array.from({ length: 15 }, (_, index) => facts(index + 1, {
      speakers: [speaker("Ana")],
      decisions: [{ index: 0, text: `Decisão ${index + 1}`, segmentIds: [] }]
    }));
    const detail = await personDetail(fakeReader(items), emptyStore, "name:ana", { actions: false });
    expect(detail.recentDecisions).toHaveLength(PEOPLE_BUILD_LIMITS.recentDecisions);
    expect(detail.recentDecisions[0]!.text).toBe("Decisão 15");
  });
});
