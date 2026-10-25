import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { listActionsForFacts, type ListedAction } from "../../actions/list";
import { ActionsStore } from "../../actions/store";
import type { JobFacts } from "../../library-index/types";
import { action, attendee, facts, fakeReader, fixedClock, mediaSha, removeTempDirs, speaker, tempDir, uuid } from "../../people/__tests__/fixtures";
import { PeopleDirectory, PeopleStore } from "../../people/store";
import type { TimesheetContext } from "../../timesheet/types";
import { BRIEF_ERRORS, BRIEF_KNOWN_ERRORS, BRIEF_LIMITS, type BriefEvent, type PreMeetingBrief, briefLines, buildBrief } from "../build";
import { buildBriefForEvent } from "../index";

afterEach(removeTempDirs);

const SERIES = "a".repeat(64);
const EVENT_ID = "e".repeat(64);

/** An event on 2026-10-30, after every fixture recording (dated 2026-10-01..29). */
const event = (extra: Partial<BriefEvent> = {}): BriefEvent => ({
  title: "Alinhamento semanal",
  startAt: "2026-10-30T13:00:00.000Z",
  endAt: "2026-10-30T14:00:00.000Z",
  attendees: [attendee("Caio", true)],
  recurring: false,
  ...extra
});

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "ACME", name: "Acme Brasil", aliases: ["acme"], responsibleNames: [] },
    { code: "BETA", name: "Beta Saúde", aliases: [], responsibleNames: [] }
  ]
};

const listed = async (items: JobFacts[], people = new PeopleDirectory()): Promise<ListedAction[]> =>
  listActionsForFacts(items, {}, { store: new ActionsStore(join(await tempDir("brief-actions-"), "actions"), { now: fixedClock().now }), people });

describe("buildBrief: nothing relevant → null", () => {
  test("an empty library", async () => {
    expect(await buildBrief(fakeReader([]), event())).toBeNull();
  });

  test("no series, no shared people, no client, no same title", async () => {
    const reader = fakeReader([facts(1, { title: "Outra coisa", speakers: [speaker("Dora")], attendees: [attendee("Caio", true)] })]);
    expect(await buildBrief(reader, event({ attendees: [attendee("Caio", true), attendee("Ana")] }))).toBeNull();
  });

  test("sharing only the user is not sharing people", async () => {
    const reader = fakeReader([facts(1, { title: "Outra coisa", attendees: [attendee("Caio", true)], speakers: [speaker("Caio")] })]);
    expect(await buildBrief(reader, event({ attendees: [attendee("Caio", true)] }))).toBeNull();
    // Known self names count as the user even when the calendar does not flag them.
    expect(await buildBrief(reader, event({ attendees: [attendee("caio")] }), { selfNames: ["Caio"] })).toBeNull();
  });

  test("a generic title is not a match", async () => {
    const reader = fakeReader([facts(1, { title: "Reunião" }), facts(2, { title: "1:1" })]);
    expect(await buildBrief(reader, event({ title: "Reunião" }))).toBeNull();
    expect(await buildBrief(reader, event({ title: "1:1" }))).toBeNull();
  });

  test("recordings of this event or after it do not count", async () => {
    const reader = fakeReader([
      facts(1, { calendar: { title: "Alinhamento semanal", recurring: true, seriesIdHash: SERIES, eventIdHash: EVENT_ID } }),
      facts(2, { date: "2026-10-31T13:00:00.000Z", calendar: { title: "Alinhamento semanal", recurring: true, seriesIdHash: SERIES } })
    ]);
    expect(await buildBrief(reader, event({ seriesIdHash: SERIES, eventIdHash: EVENT_ID }))).toBeNull();
  });

  test("hidden people (rooms, bots) do not make two meetings related", async () => {
    const peopleStore = new PeopleStore(join(await tempDir("brief-people-"), "people"), { newId: () => uuid(600) });
    await peopleStore.setHidden("name:sala grande", true, { currentName: "Sala Grande" });
    const people = new PeopleDirectory(await peopleStore.read());
    const reader = fakeReader([facts(1, { title: "Outra coisa", attendees: [attendee("Sala Grande")] })]);
    expect(await buildBrief(reader, event({ attendees: [attendee("Sala Grande")] }), { people })).toBeNull();
  });
});

describe("buildBrief: matching order", () => {
  const library = (): JobFacts[] => [
    facts(1, { title: "Alinhamento semanal", calendar: { title: "Alinhamento semanal", recurring: true, seriesIdHash: SERIES } }),
    facts(2, { title: "Kickoff portal", speakers: [speaker("Ana Souza")], clients: [{ code: "ACME", name: "Acme Brasil", source: "entry-locked", confidence: 1 }] }),
    facts(3, { title: "Revisão de contrato", clients: [{ code: "ACME", name: "Acme Brasil", source: "content-match", confidence: 0.6 }] }),
    facts(4, { title: "ALINHAMENTO   semanal!" }),
    facts(5, { title: "Assunto sem relação", speakers: [speaker("Bruno")] })
  ];

  test("series first, then shared people, then the client in the title, then the same title", async () => {
    const brief = await buildBrief(fakeReader(library()), event({
      title: "Alinhamento semanal Acme",
      seriesIdHash: SERIES,
      attendees: [attendee("Caio", true), attendee("ana souza")]
    }), { catalog });
    expect(brief).not.toBeNull();
    expect(brief!.matchedBy).toEqual(["series", "attendees", "client"]);
    // ≤3 meetings: series (1), attendees+client (2), client (3); the title-only match (4) did not make it.
    expect(brief!.recentMeetings.map((meeting) => [meeting.jobId, meeting.matchedBy])).toEqual([
      [uuid(3), ["client"]],
      [uuid(2), ["attendees", "client"]],
      [uuid(1), ["series"]]
    ]);
    expect(brief!.clientCodes).toEqual(["ACME"]);
    expect(brief!.people).toEqual([{ personId: "name:ana souza", name: "ana souza" }]);
  });

  test("each kind of match works on its own", async () => {
    const reader = fakeReader(library());
    expect((await buildBrief(reader, event({ seriesIdHash: SERIES, title: "Outro nome" })))!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(1)]);
    expect((await buildBrief(reader, event({ title: "Papo", attendees: [attendee("Ana Souza")] })))!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(2)]);
    expect((await buildBrief(reader, event({ title: "Retorno ACME" }), { catalog }))!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(3), uuid(2)]);
    const byTitle = await buildBrief(reader, event({ title: "alinhamento semanal" }));
    expect(byTitle!.matchedBy).toEqual(["title"]);
    expect(byTitle!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(4), uuid(1)]);
  });

  test("without a catalog, client names known to the index are used", async () => {
    const brief = await buildBrief(fakeReader(library()), event({ title: "Retorno Acme Brasil" }));
    expect(brief!.matchedBy).toEqual(["client"]);
  });

  test("more shared people rank higher within the same kind of match", async () => {
    const reader = fakeReader([
      facts(1, { title: "A", speakers: [speaker("Ana"), speaker("Bruno", true, "S02")] }),
      facts(2, { title: "B", speakers: [speaker("Ana")] }),
      facts(3, { title: "C", speakers: [speaker("Bruno")] }),
      facts(4, { title: "D", speakers: [speaker("Bruno")] })
    ]);
    const brief = await buildBrief(reader, event({ title: "Papo", attendees: [attendee("Ana"), attendee("Bruno")] }));
    // Meeting 1 shares both people; then the newest of the rest.
    expect(brief!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(4), uuid(3), uuid(1)]);
  });

  test("a malformed calendar entry in the facts is skipped, not fatal", async () => {
    const reader = fakeReader([
      facts(1, { title: "Alinhamento semanal" }),
      facts(2, { title: "Outra", calendar: { title: 42, recurring: true } as unknown as JobFacts["calendar"] })
    ]);
    expect((await buildBrief(reader, event()))!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(1)]);
  });

  test("a reprocessed recording appears once", async () => {
    const reader = fakeReader([
      facts(1, { title: "Alinhamento semanal" }),
      facts(2, { title: "Alinhamento semanal", mediaSha256: mediaSha(1) })
    ]);
    expect((await buildBrief(reader, event()))!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(2)]);
  });
});

describe("buildBrief: contents", () => {
  test("open actions: matched meetings first, then actions owed by invited people; at most five", async () => {
    const items = [
      facts(1, { title: "Alinhamento semanal", speakers: [speaker("Ana")], actions: [action(0, "Ação da reunião 1"), action(1, "Outra da reunião 1")] }),
      facts(2, { title: "Alinhamento semanal", actions: [action(0, "Ação da reunião 2"), action(1, "Mais uma"), action(2, "E outra"), action(3, "Sexta ação")] }),
      // Not a matched meeting (Ana is not in it), but Ana owns an action there.
      facts(3, { title: "Sem relação", actions: [action(0, "Ana deve isto", { owner: "Ana", dueDate: "2026-11-02" })] })
    ];
    const actions = await listed(items);
    const brief = await buildBrief(fakeReader(items), event({ attendees: [attendee("Ana")] }), { actions });
    expect(brief!.recentMeetings.map((meeting) => meeting.jobId)).toEqual([uuid(2), uuid(1)]);
    expect(brief!.openActions).toHaveLength(BRIEF_LIMITS.openActions);
    // Meeting 1 shares a person (stronger match) so its actions come before those of meeting 2 (same title).
    expect(brief!.openActions.map((item) => item.text)).toEqual(["Ação da reunião 1", "Outra da reunião 1", "Ação da reunião 2", "Mais uma", "E outra"]);

    const fewer = await buildBrief(fakeReader(items), event({ attendees: [attendee("Ana")] }), { actions: actions.filter((item) => item.mediaSha256 !== mediaSha(2)) });
    expect(fewer!.openActions.map((item) => [item.text, item.ownerText, item.dueDate])).toEqual([
      ["Ação da reunião 1", undefined, undefined],
      ["Outra da reunião 1", undefined, undefined],
      ["Ana deve isto", "Ana", "2026-11-02"]
    ]);
  });

  test("done and orphaned actions are left out", async () => {
    const items = [facts(1, { title: "Alinhamento semanal", actions: [action(0, "Feita"), action(1, "Aberta")] })];
    const actions = await listed(items);
    actions[0]!.status = "done";
    actions[1]!.matchState = "orphaned";
    const brief = await buildBrief(fakeReader(items), event(), { actions });
    expect(brief).not.toBeNull();
    expect(brief!.openActions).toEqual([]);
  });

  test("recent decisions carry a citation to their first segment; at most three", async () => {
    const items = [
      facts(1, { title: "Alinhamento semanal", decisions: [{ index: 0, text: "Antiga", segmentIds: [] }] }),
      facts(2, {
        title: "Alinhamento semanal",
        decisions: [
          { index: 0, text: "Usar o fornecedor B", segmentIds: ["bad", "s000042"] },
          { index: 1, text: "", segmentIds: [] },
          { index: 2, text: "Congelar o escopo ana@example.com", segmentIds: [] },
          { index: 3, text: "Contratar", segmentIds: [] }
        ]
      })
    ];
    const brief = await buildBrief(fakeReader(items), event());
    expect(brief!.recentDecisions).toEqual([
      { jobId: uuid(2), text: "Usar o fornecedor B", citation: { ref: "s000042", jobId: uuid(2), segmentId: "s000042", title: "Alinhamento semanal" } },
      { jobId: uuid(2), text: "Congelar o escopo [e-mail omitido]" },
      { jobId: uuid(2), text: "Contratar" }
    ]);
  });

  test("people: invited, not the user, under the name the People page uses", async () => {
    const peopleStore = new PeopleStore(join(await tempDir("brief-people-"), "people"), { newId: () => uuid(700) });
    await peopleStore.rename("name:joao.silva", "João Silva", { currentName: "joao.silva" });
    const people = new PeopleDirectory(await peopleStore.read());
    const reader = fakeReader([facts(1, { title: "Alinhamento semanal", speakers: [speaker("João Silva")] })]);
    const brief = await buildBrief(reader, event({
      attendees: [attendee("Caio", true), attendee("joao.silva"), attendee("JOAO.SILVA"), attendee("Nova Pessoa"), attendee("  ")]
    }), { people });
    expect(brief!.people).toEqual([{ personId: uuid(700), name: "João Silva" }, { name: "Nova Pessoa" }]);
    expect(brief!.matchedBy).toEqual(["attendees", "title"]);
  });

  test("the event's own fields are normalized and sanitized", async () => {
    const reader = fakeReader([facts(1, { title: "Alinhamento semanal" })]);
    const brief = await buildBrief(reader, event({ title: "Alinhamento semanal\u0000 bob@example.com", startAt: "2026-10-30T10:00:00-03:00", eventIdHash: EVENT_ID, seriesIdHash: "not-a-hash" }));
    expect(brief).toBeNull();
    const ok = await buildBrief(reader, event({ startAt: "2026-10-30T10:00:00-03:00", eventIdHash: EVENT_ID }));
    expect(ok).toMatchObject({ eventIdHash: EVENT_ID, startAt: "2026-10-30T13:00:00.000Z", title: "Alinhamento semanal" });
  });

  test("an invalid event is refused", async () => {
    const reader = fakeReader([]);
    for (const bad of [
      { ...event(), title: 42 },
      { ...event(), startAt: "amanhã" },
      { ...event(), endAt: undefined },
      { ...event(), attendees: "Ana" },
      { ...event(), title: "x".repeat(2_001) },
      null
    ]) {
      await expect(buildBrief(reader, bad as never)).rejects.toThrow(BRIEF_ERRORS.invalidEvent);
    }
    expect(BRIEF_KNOWN_ERRORS).toEqual([BRIEF_ERRORS.invalidEvent]);
  });
});

describe("briefLines", () => {
  const brief = (extra: Partial<PreMeetingBrief> = {}): PreMeetingBrief => ({
    title: "Alinhamento", startAt: "2026-10-30T13:00:00.000Z", endAt: "2026-10-30T14:00:00.000Z",
    matchedBy: ["series"], people: [], clientCodes: [],
    recentMeetings: [{ jobId: uuid(1), date: "2026-10-23T13:00:00.000Z", title: "Alinhamento semanal", matchedBy: ["series"] }],
    openActions: [
      { actionId: uuid(10), mediaSha256: mediaSha(1), jobId: uuid(1), text: "Enviar a proposta", ownerText: "Ana" },
      { actionId: uuid(11), mediaSha256: mediaSha(1), jobId: uuid(1), text: "Revisar" }
    ],
    recentDecisions: [{ jobId: uuid(1), text: "Adiar o lançamento" }],
    ...extra
  });

  test("three short lines in the requested language", () => {
    expect(briefLines(brief(), "pt-BR", { timeZone: "UTC" })).toEqual([
      "Última reunião: 23 de out. · Alinhamento semanal",
      "2 ações abertas: Enviar a proposta (Ana)",
      "Decisão: Adiar o lançamento"
    ]);
    expect(briefLines(brief(), "en", { timeZone: "UTC" })).toEqual([
      "Last meeting: Oct 23 · Alinhamento semanal",
      "2 open actions: Enviar a proposta (Ana)",
      "Decision: Adiar o lançamento"
    ]);
    expect(briefLines(brief({ openActions: [brief().openActions[1]!] }), "es", { timeZone: "UTC" })[1]).toBe("1 acción abierta: Revisar");
    // Unknown languages fall back to Portuguese.
    expect(briefLines(brief(), "fr", { timeZone: "UTC" })[2]).toBe("Decisão: Adiar o lançamento");
  });

  test("lines only for what exists, each clipped", () => {
    expect(briefLines(brief({ openActions: [], recentDecisions: [] }), "pt-BR", { timeZone: "UTC" })).toHaveLength(1);
    const long = briefLines(brief({ recentDecisions: [{ jobId: uuid(1), text: "palavra ".repeat(60) }] }), "pt-BR")[2]!;
    expect(long.length).toBeLessThanOrEqual(BRIEF_LIMITS.lineLength);
    expect(long.endsWith("…")).toBe(true);
    expect(briefLines(brief({ recentDecisions: [{ jobId: uuid(1), text: "linha\nquebrada ana@example.com" }] }), "pt-BR")[2]).toBe("Decisão: linha quebrada [e-mail omitido]");
  });
});

describe("buildBriefForEvent", () => {
  test("reads people and open actions without writing anything", async () => {
    const actionsRoot = join(await tempDir("brief-ro-"), "actions");
    const items = [facts(1, { title: "Alinhamento semanal", actions: [action(0, "Enviar a proposta")] })];
    const reader = fakeReader(items);
    const brief = await buildBriefForEvent(reader, event(), {
      actionsStore: new ActionsStore(actionsRoot),
      peopleStore: { read: async () => { throw new Error("arquivo de pessoas inválido"); } }
    });
    expect(brief!.openActions.map((item) => item.text)).toEqual(["Enviar a proposta"]);
    expect(await fs.stat(actionsRoot).catch(() => null)).toBeNull();
    // The index is asked once.
    expect(reader.calls).toBe(1);
  });

  test("a damaged action file only costs the actions", async () => {
    const actionsRoot = join(await tempDir("brief-ro-"), "actions");
    await fs.mkdir(actionsRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(actionsRoot, `${mediaSha(1)}.json`), "{", { mode: 0o600 });
    const items = [facts(1, { title: "Alinhamento semanal", actions: [action(0, "Enviar a proposta")] })];
    const brief = await buildBriefForEvent(fakeReader(items), event(), { actionsStore: new ActionsStore(actionsRoot) });
    expect(brief!.recentMeetings).toHaveLength(1);
    expect(await fs.readFile(join(actionsRoot, `${mediaSha(1)}.json`), "utf8")).toBe("{");
  });
});
