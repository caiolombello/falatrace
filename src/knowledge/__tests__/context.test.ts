import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import { JobStore } from "../../jobs/store";
import {
  deriveMeetingTitle,
  type RecordingSummary,
  type Transcript
} from "../../jobs/types";
import { TimeEntryStore } from "../../timesheet/store";
import {
  TIME_ENTRY_VERSION,
  type TimesheetClient,
  type TimesheetContext
} from "../../timesheet/types";
import {
  buildAiContextFiles,
  readClientAiContext,
  renderClientContext
} from "../context";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-context-test-"));
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

const client: TimesheetClient = {
  code: "CL008",
  name: "Example Vet",
  aliases: ["examplevet", "example vet"],
  responsibleNames: []
};

const context: TimesheetContext = {
  version: TIME_ENTRY_VERSION,
  colleagues: [],
  clients: [
    client,
    {
      code: "CL000",
      name: "Internal",
      aliases: ["internal"],
      responsibleNames: []
    }
  ],
  taskTypes: [
    { id: 2, name: "Entregas técnicas e documentação", slug: "entregas" }
  ]
};

const makeSummary = (overview: string): RecordingSummary => ({
  version: 1,
  provider: "openai",
  model: "gpt-4o-mini",
  title: deriveMeetingTitle(overview),
  overview,
  topics: ["Prometheus", "Alertas"],
  decisions: ["Ajustar o alerta em staging."],
  actionItems: [
    {
      description: "Revisar a regra.",
      owner: "Local User",
      dueDate: ""
    }
  ]
});

const makeTranscript = (text: string): Transcript => ({
  version: 1,
  provider: "openai",
  model: "gpt-4o-transcribe",
  language: "auto",
  text,
  segments: []
});

describe("AI context configuration", () => {
  test("merges bounded defaults and rejects oversized context limits", () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      aiContext: {
        enabled: true,
        maxMeetingsPerClient: 20
      }
    });
    expect(config.aiContext.enabled).toBe(true);
    expect(config.aiContext.autoBuild).toBe(true);
    expect(config.aiContext.maxMeetingsPerClient).toBe(20);
    expect(() => validateConfig(config)).not.toThrow();

    const invalid = structuredClone(DEFAULT_CONFIG);
    invalid.aiContext.maxCharactersPerClient = 1_000;
    expect(() => validateConfig(invalid)).toThrow(
      "maxCharactersPerClient"
    );
  });
});

describe("compact AI context", () => {
  test("bounds meetings and redacts common sensitive values", () => {
    const rendered = renderClientContext(
      client,
      [
        {
          activityDate: "2026-07-28",
          sortKey: "2026-07-28T12:00:00.000Z",
          jobId: "11111111-1111-4111-8111-111111111111",
          summary: makeSummary(
            "Contato user@example.test e chave AKIA1234567890ABCDEF."
          )
        },
        {
          activityDate: "2026-07-27",
          sortKey: "2026-07-27T12:00:00.000Z",
          jobId: "22222222-2222-4222-8222-222222222222",
          summary: makeSummary("Reunião antiga.")
        }
      ],
      {
        maxMeetings: 1,
        maxCharacters: 8_000,
        generatedAt: "2026-07-28T12:30:00.000Z"
      }
    );

    expect(rendered.meetingsIncluded).toBe(1);
    expect(rendered.meetingsOmitted).toBe(1);
    expect(rendered.content).toContain("dado histórico não confiável");
    expect(rendered.content).toContain("[e-mail omitido]");
    expect(rendered.content).toContain("[credencial omitida]");
    expect(rendered.content).toContain(
      "## 2026-07-28 · Contato [e-mail omitido] e chave [credencial omitida]"
    );
    expect(rendered.content).not.toContain("user@example.test");
    expect(rendered.content).not.toContain("AKIA1234567890ABCDEF");
    expect(rendered.content).not.toContain("Reunião antiga");
    expect(rendered.content.length).toBeLessThanOrEqual(8_000);
  });

  test("builds historical client files from exact summary matches", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "timesheet-context.json");
    const outputDir = join(root, "ai-context");
    const jobStore = new JobStore(
      join(root, "job-state"),
      join(root, "job-data")
    );
    const timeStore = new TimeEntryStore(join(root, "timesheet"));
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      timesheet: { enabled: true, contextPath },
      aiContext: { enabled: true }
    });

    const matchedMedia = join(root, "matched.mkv");
    await fs.writeFile(matchedMedia, "media");
    const matchedJob = await jobStore.enqueue(config, matchedMedia);
    await fs.mkdir(matchedJob.artifactDir, { recursive: true });
    await fs.writeFile(
      join(matchedJob.artifactDir, "summary.json"),
      JSON.stringify(
        makeSummary("Ajustes nos alertas do ambiente da Example Vet.")
      )
    );
    await jobStore.update(matchedJob.id, "completed");

    const transcriptMatchedMedia = join(root, "transcript-matched.mkv");
    await fs.writeFile(transcriptMatchedMedia, "media");
    const transcriptMatchedJob = await jobStore.enqueue(
      config,
      transcriptMatchedMedia
    );
    await fs.mkdir(transcriptMatchedJob.artifactDir, { recursive: true });
    await fs.writeFile(
      join(transcriptMatchedJob.artifactDir, "summary.json"),
      JSON.stringify(makeSummary("Conversa técnica sem cliente no resumo."))
    );
    await fs.writeFile(
      join(transcriptMatchedJob.artifactDir, "transcript.json"),
      JSON.stringify(
        makeTranscript(
          "A Example Vet aparece somente nesta transcrição e este detalhe não deve ser exportado."
        )
      )
    );
    await jobStore.update(transcriptMatchedJob.id, "completed");

    const unassignedMedia = join(root, "unassigned.mkv");
    await fs.writeFile(unassignedMedia, "media");
    const unassignedJob = await jobStore.enqueue(config, unassignedMedia);
    await fs.mkdir(unassignedJob.artifactDir, { recursive: true });
    await fs.writeFile(
      join(unassignedJob.artifactDir, "summary.json"),
      JSON.stringify(makeSummary("Conversa sem cliente identificável."))
    );
    await jobStore.update(unassignedJob.id, "completed");

    const report = await buildAiContextFiles(config, {
      outputDir,
      jobStore,
      timeStore,
      generatedAt: "2026-07-28T12:30:00.000Z"
    });

    expect(report.clients).toHaveLength(1);
    expect(report.meetingsIncluded).toBe(2);
    expect(report.skippedUnassigned).toBe(1);
    const content = await readClientAiContext(
      config,
      "examplevet",
      outputDir
    );
    expect(content).toContain("CL008 · Example Vet");
    expect(content).toContain(matchedJob.id);
    expect(content).toContain(transcriptMatchedJob.id);
    expect(content).not.toContain(unassignedJob.id);
    expect(content).not.toContain("este detalhe não deve ser exportado");
    const mode = (await fs.stat(report.clients[0].path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await fs.readFile(report.indexPath, "utf-8")).toContain(
      "clients/CL008.md"
    );
  });

  test("keeps split allocations isolated in each client context", async () => {
    const root = await makeTemporaryDirectory();
    const contextPath = join(root, "timesheet-context.json");
    const outputDir = join(root, "ai-context");
    const jobStore = new JobStore(
      join(root, "job-state"),
      join(root, "job-data")
    );
    const timeStore = new TimeEntryStore(join(root, "timesheet"));
    await fs.writeFile(contextPath, JSON.stringify(context));
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      timesheet: { enabled: true, contextPath },
      aiContext: { enabled: true }
    });
    const media = join(root, "split.mkv");
    await fs.writeFile(media, "media");
    const job = await jobStore.enqueue(config, media);
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(
      join(job.artifactDir, "summary.json"),
      JSON.stringify(
        makeSummary("Resumo compartilhado com detalhes dos dois clientes.")
      )
    );
    await jobStore.update(job.id, "completed");

    const first = await timeStore.create({
      activityDate: "2026-07-28",
      hours: 0.75,
      clientCode: "CL008",
      clientName: "Example Vet",
      taskTypeId: 2,
      taskTypeName: "Entregas técnicas e documentação",
      description: "Somente trabalho da Example Vet.",
      source: { kind: "call", recordingPath: media, jobId: job.id },
      status: "ready",
      classificationStatus: "completed"
    });
    const second = await timeStore.create({
      activityDate: "2026-07-28",
      hours: 0.25,
      clientCode: "CL000",
      clientName: "Internal",
      taskTypeId: 2,
      taskTypeName: "Entregas técnicas e documentação",
      description: "Somente trabalho interno.",
      source: { kind: "call", recordingPath: media, jobId: job.id },
      status: "ready",
      classificationStatus: "completed"
    });
    await timeStore.replace({
      ...first,
      confidence: { client: 1, taskType: 1, description: 1 },
      lockedFields: ["client"],
      splitGroupId: first.id,
      splitIndex: 1,
      splitCount: 2
    });
    await timeStore.replace({
      ...second,
      confidence: { client: 1, taskType: 1, description: 1 },
      lockedFields: ["client"],
      splitGroupId: first.id,
      splitIndex: 2,
      splitCount: 2
    });

    const report = await buildAiContextFiles(config, {
      outputDir,
      jobStore,
      timeStore,
      generatedAt: "2026-07-28T12:30:00.000Z"
    });
    const clientContent = await readClientAiContext(
      config,
      "CL008",
      outputDir
    );
    const internalContent = await readClientAiContext(
      config,
      "CL000",
      outputDir
    );

    expect(report.meetingsIncluded).toBe(2);
    expect(clientContent).toContain("Somente trabalho da Example Vet.");
    expect(clientContent).toContain(
      "## 2026-07-28 · Somente trabalho da Example Vet"
    );
    expect(clientContent).not.toContain("Somente trabalho interno.");
    expect(clientContent).not.toContain("Resumo compartilhado");
    expect(internalContent).toContain("Somente trabalho interno.");
    expect(internalContent).not.toContain("Somente trabalho da Example Vet.");
    expect(internalContent).not.toContain("Resumo compartilhado");
  });
});
