import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import { JobStore } from "../../jobs/store";
import type { RecordingSummary, Transcript } from "../../jobs/types";
import { buildActivityPlan } from "../allocation";
import {
  applyTimeEntrySuggestion,
  buildDeterministicSuggestion,
  deriveTimeEntryStatus,
  validateTimeEntrySuggestion
} from "../classification";
import {
  buildTranscriptionContextPrompt,
  buildTranscriptionKeywords,
  findClient,
  findTaskType,
  loadTimesheetContext
} from "../context";
import { formatTimeEntry } from "../format";
import {
  addManualTimeEntry,
  parseLocalDateTime,
  splitTimeEntry,
  updateTimeEntry
} from "../operations";
import { reconcileTimeEntryForJob } from "../reconcile";
import { getTimeEntryStatusPath, TimeEntryStore } from "../store";
import {
  TIME_ENTRY_VERSION,
  calculateHours,
  type TimeEntryActivitySuggestion,
  type TimesheetContext,
  validateTimesheetContext
} from "../types";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-timesheet-test-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});

test("call monitor completion preserves a recording already finalized from the tray", async () => {
  const root = await makeTemporaryDirectory();
  const store = new TimeEntryStore(root);
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await store.startCall(sessionId, "helium", "2026-09-07T20:00:00.000Z");
  const finished = await store.finishCall(sessionId, "2026-09-07T20:15:00.000Z", join(root, "meeting.mkv"));
  const reviewed = await store.replace({ ...finished!, status: "ready", classificationStatus: "completed" });
  expect(await store.finishCall(sessionId, "2026-09-07T20:30:00.000Z", undefined, "disabled")).toEqual(reviewed);
  expect(await store.finishCall(sessionId, "2026-09-07T20:30:00.000Z", reviewed.source.recordingPath)).toEqual(reviewed);
});

const context: TimesheetContext = {
  version: TIME_ENTRY_VERSION,
  ownerName: "Local User",
  colleagues: [
    {
      name: "Internal Colleague",
      email: "colleague@example.test",
      aliases: ["Colleague"]
    }
  ],
  clients: [
    {
      code: "CL000",
      name: "Internal",
      aliases: ["internal"],
      responsibleNames: []
    },
    {
      code: "CL008",
      name: "Example Vet",
      aliases: ["examplevet", "example vet"],
      responsibleNames: ["Internal Colleague"]
    }
  ],
  taskTypes: [
    { id: 2, name: "Entregas técnicas e documentação", slug: "entregas" },
    { id: 3, name: "Comunicação com o cliente", slug: "comunicacao-cliente" },
    { id: 4, name: "Comunicação interna Example Team", slug: "comunicacao-interna" }
  ]
};

const summary: RecordingSummary = {
  version: 1,
  provider: "openai",
  model: "gpt-4o-mini",
  title: "Alertas da Example Vet",
  overview: "Alinhamento sobre os alertas do ambiente da Example Vet.",
  topics: ["Prometheus"],
  decisions: [],
  actionItems: []
};

const transcript: Transcript = {
  version: 1,
  provider: "openai",
  model: "gpt-4o-transcribe",
  language: "auto",
  text: "Vamos ajustar o ambiente da Example Vet no card DEV-123.",
  segments: []
};

const activity = (
  overrides: Partial<TimeEntryActivitySuggestion> = {}
): TimeEntryActivitySuggestion => ({
  clientCode: "CL008",
  taskTypeId: 2,
  description: "Ajustes técnicos no ambiente.",
  startSeconds: 0,
  endSeconds: 2_400,
  confidence: {
    client: 0.95,
    taskType: 0.95,
    description: 0.95,
    timing: 0.95
  },
  evidence: ["Trecho com atividade técnica."],
  ...overrides
});

describe("timesheet config and context", () => {
  test("deeply merges optional timesheet settings", () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { enabled: true, readyConfidence: 0.9 }
    });
    expect(config.timesheet.enabled).toBe(true);
    expect(config.timesheet.automaticFromCalls).toBe(true);
    expect(config.timesheet.readyConfidence).toBe(0.9);
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects unsafe context paths and confidence values", () => {
    const pathConfig = structuredClone(DEFAULT_CONFIG);
    pathConfig.timesheet.contextPath = "../context.json";
    expect(() => validateConfig(pathConfig)).toThrow("contextPath");

    const confidenceConfig = structuredClone(DEFAULT_CONFIG);
    confidenceConfig.timesheet.readyConfidence = 0.2;
    expect(() => validateConfig(confidenceConfig)).toThrow("readyConfidence");
  });

  test("validates catalogs and resolves aliases without exposing emails in prompts", () => {
    const parsed = validateTimesheetContext(context);
    expect(findClient(parsed, "Example Vet")?.code).toBe("CL008");
    expect(findTaskType(parsed, "entregas")?.id).toBe(2);
    const prompt = buildTranscriptionContextPrompt(parsed);
    expect(prompt).toContain("Internal Colleague");
    expect(prompt).toContain("CL008");
    expect(prompt).toContain("Example Vet");
    expect(prompt).not.toContain("examplevet");
    expect(prompt).not.toContain("@example.test");
    expect(buildTranscriptionKeywords(parsed)).toEqual([
      "Internal Colleague",
      "CL000",
      "Internal",
      "CL008",
      "Example Vet"
    ]);
  });

  test("loads the local context with strict validation", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "timesheet-context.json");
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { contextPath }
    });
    expect((await loadTimesheetContext(config)).clients).toHaveLength(2);

    await fs.writeFile(contextPath, '{"version":1,"clients":"bad"}');
    await expect(loadTimesheetContext(config)).rejects.toThrow("invalid catalog");
  });
});

describe("time entry storage and duration", () => {
  test("uses candidate start and real signal end instead of debounce duration", async () => {
    const root = await makeTemporaryDirectory();
    const store = new TimeEntryStore(join(root, "timesheet"));
    const startAt = "2026-07-28T12:00:00.000Z";
    const endAt = "2026-07-28T12:45:00.000Z";
    const started = await store.startCall("session-1", "zen", startAt);
    const finished = await store.finishCall(
      "session-1",
      endAt,
      "/home/example/Videos/Recordings/call.mkv"
    );

    expect(started.status).toBe("capturing");
    expect(finished?.hours).toBe(0.75);
    expect(finished?.startAt).toBe(startAt);
    expect(finished?.endAt).toBe(endAt);
    expect(finished?.source.recordingPath).toEndWith("call.mkv");
    expect(await store.counts()).toEqual({
      capturing: 0,
      draft: 1,
      ready: 0,
      synced: 0
    });
    expect(
      JSON.parse(await fs.readFile(getTimeEntryStatusPath(store.stateDir), "utf-8"))
    ).toMatchObject({ draft: 1 });
  });

  test("rounds calculated durations to the configured precision", () => {
    expect(
      calculateHours(
        "2026-07-28T12:00:00.000Z",
        "2026-07-28T13:14:30.000Z"
      )
    ).toBe(1.24);
  });

  test("creates and validates a complete manual entry", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "context.json");
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { enabled: true, contextPath }
    });
    const store = new TimeEntryStore(join(root, "timesheet"));
    const entry = await addManualTimeEntry(config, store, {
      activityDate: "2026-07-28",
      startAt: parseLocalDateTime("2026-07-28", "09:00"),
      endAt: parseLocalDateTime("2026-07-28", "10:30"),
      client: "CL008",
      taskType: "entregas",
      description: "Ajustes no ambiente de staging.",
      cardId: "dev-123"
    });

    expect(entry.status).toBe("ready");
    expect(entry.hours).toBe(1.5);
    expect(entry.clientCode).toBe("CL008");
    expect(entry.taskTypeId).toBe(2);
    expect(entry.cardId).toBe("DEV-123");
    expect(entry.classificationSource).toBe("manual");
  });
});

describe("automatic classification", () => {
  test("builds a safe fallback from explicit catalog matches", () => {
    expect(buildDeterministicSuggestion(summary, transcript, context)).toMatchObject({
      clientCode: "CL008",
      description: summary.overview,
      cardId: "DEV-123",
      classificationSource: "rules",
      confidence: { client: 0.9, taskType: 0, description: 0.85 }
    });
  });

  test("rejects clients and task types invented by the model", () => {
    expect(() =>
      validateTimeEntrySuggestion(
        {
          clientCode: "CL999",
          taskTypeId: 2,
          description: "Descrição",
          cardId: "",
          clientConfidence: 0.9,
          taskTypeConfidence: 0.9,
          descriptionConfidence: 0.9,
          evidence: []
        },
        context
      )
    ).toThrow("unknown client");

    expect(() =>
      validateTimeEntrySuggestion(
        {
          clientCode: "CL008",
          taskTypeId: 2,
          description: "Descrição",
          cardId: "",
          clientConfidence: 0.9,
          taskTypeConfidence: 0.9,
          descriptionConfidence: 0.9,
          evidence: [],
          activities: [
            {
              clientCode: "CL999",
              taskTypeId: 2,
              description: "Atividade inventada",
              cardId: "",
              startSeconds: 0,
              endSeconds: 60,
              clientConfidence: 0.9,
              taskTypeConfidence: 0.9,
              descriptionConfidence: 0.9,
              timingConfidence: 0.9,
              evidence: []
            }
          ]
        },
        context
      )
    ).toThrow("activity referenced an unknown client");

    expect(() =>
      validateTimeEntrySuggestion(
        {
          clientCode: "CL008",
          taskTypeId: 2,
          description: "Descrição",
          cardId: "",
          clientConfidence: 0.9,
          taskTypeConfidence: 0.9,
          descriptionConfidence: 0.9,
          evidence: [],
          activities: [
            {
              clientCode: "CL008",
              taskTypeId: 2,
              description: "Linha um\nLinha dois",
              cardId: "",
              startSeconds: 0,
              endSeconds: 60,
              clientConfidence: 0.9,
              taskTypeConfidence: 0.9,
              descriptionConfidence: 0.9,
              timingConfidence: 0.9,
              evidence: []
            }
          ]
        },
        context
      )
    ).toThrow("activity description is invalid");
  });

  test("preserves manual corrections when a late AI result arrives", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "context.json");
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { enabled: true, contextPath }
    });
    const store = new TimeEntryStore(join(root, "timesheet"));
    const created = await store.create({
      startAt: "2026-07-28T12:00:00.000Z",
      endAt: "2026-07-28T13:00:00.000Z",
      source: { kind: "call", sessionId: "session" },
      status: "draft"
    });
    const manuallyEdited = await updateTimeEntry(config, store, created.id, {
      client: "CL000",
      taskType: "comunicacao-interna",
      description: "Alinhamento interno sobre a operação."
    });
    const suggested = applyTimeEntrySuggestion(
      manuallyEdited,
      {
        clientCode: "CL008",
        taskTypeId: 3,
        description: "Descrição substituta",
        classificationSource: "openai",
        confidence: { client: 0.95, taskType: 0.95, description: 0.95 },
        evidence: ["Sugestão tardia"],
        activities: []
      },
      context,
      0.8
    );

    expect(suggested.clientCode).toBe("CL000");
    expect(suggested.taskTypeId).toBe(4);
    expect(suggested.description).toBe("Alinhamento interno sobre a operação.");
    expect(deriveTimeEntryStatus(suggested, context, 0.8)).toBe("ready");
    expect(formatTimeEntry(suggested, context)).toContain(
      "Cliente: CL000 Internal  (= confirmado manualmente)"
    );
  });

  test("consolidates brief secondary work and recommends material splits", () => {
    const brief = buildActivityPlan(
      [
        activity({ endSeconds: 3_000 }),
        activity({
          taskTypeId: 3,
          description: "Alinhamento final.",
          startSeconds: 3_000,
          endSeconds: 3_600
        })
      ],
      1,
      0.8
    );
    expect(brief).toMatchObject({
      recommendation: "consolidate",
      splittable: true
    });

    const material = buildActivityPlan(
      [
        activity(),
        activity({
          taskTypeId: 3,
          description: "Alinhamento com o cliente.",
          startSeconds: 2_400,
          endSeconds: 3_600
        })
      ],
      1,
      0.8
    );
    expect(material).toMatchObject({
      recommendation: "split",
      splittable: true
    });
  });

  test("recommends a client split without inventing timing", () => {
    const plan = buildActivityPlan(
      [
        activity({
          startSeconds: undefined,
          endSeconds: undefined,
          confidence: {
            client: 0.95,
            taskType: 0.95,
            description: 0.95,
            timing: 0
          }
        }),
        activity({
          clientCode: "CL000",
          taskTypeId: 4,
          description: "Alinhamento interno.",
          startSeconds: undefined,
          endSeconds: undefined,
          confidence: {
            client: 0.95,
            taskType: 0.95,
            description: 0.95,
            timing: 0
          }
        })
      ],
      1,
      0.8
    );
    expect(plan).toMatchObject({
      recommendation: "split",
      splittable: false
    });
  });

  test("shows the multi-activity recommendation in the time entry view", async () => {
    const root = await makeTemporaryDirectory();
    const store = new TimeEntryStore(join(root, "timesheet"));
    const entry = await store.create({
      hours: 1,
      source: { kind: "call", sessionId: "session" },
      status: "draft"
    });
    const classified = applyTimeEntrySuggestion(
      entry,
      {
        clientCode: "CL008",
        taskTypeId: 2,
        description: "Trabalho consolidado.",
        classificationSource: "openai",
        confidence: { client: 0.95, taskType: 0.95, description: 0.95 },
        evidence: [],
        activities: [
          activity(),
          activity({
            clientCode: "CL000",
            taskTypeId: 4,
            description: "Alinhamento interno.",
            startSeconds: 2_400,
            endSeconds: 3_600
          })
        ]
      },
      context,
      0.8
    );

    const formatted = formatTimeEntry(classified, context);
    expect(formatted).toContain("Cliente: CL008 Example Vet  (~ sugestão OpenAI)");
    expect(formatted).toContain("Classificação: concluída · OpenAI");
    expect(formatted).toContain("Atividades detectadas: 2");
    expect(formatted).toContain("Recomendação: dividir");
    expect(formatted).toContain("Divisão pela TUI: disponível");
    expect(formatted).toContain("Alinhamento interno.");
  });

  test("discards a stale activity plan after a manual classification correction", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "context.json");
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { enabled: true, contextPath }
    });
    const store = new TimeEntryStore(join(root, "timesheet"));
    const entry = await store.create({
      hours: 1,
      source: { kind: "call", sessionId: "session" },
      status: "draft"
    });
    const classified = applyTimeEntrySuggestion(
      entry,
      {
        clientCode: "CL008",
        taskTypeId: 2,
        description: "Trabalho consolidado.",
        confidence: { client: 0.95, taskType: 0.95, description: 0.95 },
        evidence: [],
        activities: [
          activity(),
          activity({
            clientCode: "CL000",
            taskTypeId: 4,
            description: "Alinhamento interno.",
            startSeconds: 2_400,
            endSeconds: 3_600
          })
        ]
      },
      context,
      0.8
    );
    await store.replace(classified);

    const corrected = await updateTimeEntry(config, store, entry.id, {
      client: "CL000"
    });

    expect(corrected.activityPlan).toBeUndefined();
  });

  test("splits only after confirmation and preserves the exact total", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "context.json");
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      timesheet: { enabled: true, contextPath }
    });
    const store = new TimeEntryStore(join(root, "timesheet"));
    const created = await store.create({
      hours: 1.01,
      source: {
        kind: "call",
        sessionId: "session",
        jobId: "11111111-1111-4111-8111-111111111111",
        recordingPath: join(root, "call.mkv")
      },
      status: "draft"
    });
    const classified = applyTimeEntrySuggestion(
      created,
      {
        clientCode: "CL008",
        taskTypeId: 2,
        description: "Trabalho consolidado.",
        confidence: { client: 0.95, taskType: 0.95, description: 0.95 },
        evidence: ["Classificação consolidada."],
        activities: [
          activity(),
          activity({
            clientCode: "CL000",
            taskTypeId: 4,
            description: "Alinhamento interno.",
            startSeconds: 2_400,
            endSeconds: 3_600
          })
        ]
      },
      context,
      0.8
    );
    await store.replace(classified);

    const split = await splitTimeEntry(config, store, created.id);

    expect(split).toHaveLength(2);
    expect(split.reduce((total, entry) => total + (entry.hours || 0), 0)).toBe(
      1.01
    );
    expect(split.map((entry) => entry.hours)).toEqual([0.67, 0.34]);
    expect(split.map((entry) => entry.clientCode)).toEqual(["CL008", "CL000"]);
    expect(split.every((entry) => entry.startAt === undefined)).toBe(true);
    expect(split.every((entry) => entry.endAt === undefined)).toBe(true);
    expect(split.every((entry) => entry.splitGroupId === created.id)).toBe(true);
    expect(await store.list()).toHaveLength(2);
    expect(
      (await store.findForJob(
        "11111111-1111-4111-8111-111111111111",
        join(root, "call.mkv")
      ))?.splitIndex
    ).toBe(1);
  });

  test("reconciles a completed recording without requiring manual description", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "context.json");
    const mediaPath = join(root, "call.mkv");
    await fs.writeFile(contextPath, JSON.stringify(context));
    await fs.writeFile(mediaPath, "media");
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      timesheet: {
        enabled: true,
        aiClassification: false,
        contextPath
      }
    });
    const timeStore = new TimeEntryStore(join(root, "timesheet"));
    const jobStore = new JobStore(join(root, "jobs"), join(root, "job-data"));
    const entry = await timeStore.create({
      startAt: "2026-07-28T12:00:00.000Z",
      endAt: "2026-07-28T13:00:00.000Z",
      source: { kind: "call", sessionId: "session", recordingPath: mediaPath },
      status: "draft"
    });
    await updateTimeEntry(config, timeStore, entry.id, {
      taskType: "entregas"
    });
    const job = await jobStore.enqueue(config, mediaPath);
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(
      join(job.artifactDir, "transcript.json"),
      JSON.stringify(transcript)
    );
    await fs.writeFile(
      join(job.artifactDir, "summary.json"),
      JSON.stringify(summary)
    );
    const completed = await jobStore.update(job.id, "completed");

    const classified = await reconcileTimeEntryForJob(
      config,
      completed,
      timeStore,
      { notify: false }
    );

    expect(classified).toMatchObject({
      status: "ready",
      classificationStatus: "completed",
      clientCode: "CL008",
      taskTypeId: 2,
      description: summary.overview
    });
    expect(classified?.source.jobId).toBe(job.id);
  });
});
