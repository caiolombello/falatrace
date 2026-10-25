import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { JobStore } from "../../jobs/store";
import { buildAiContextFiles, readClientAiContext } from "../../knowledge/context";
import { searchMeetings } from "../../knowledge/meetings";
import { removeTempDirs, tempDir, uuid } from "../../people/__tests__/fixtures";
import { TimeEntryStore } from "../../timesheet/store";
import type { TimesheetContext } from "../../timesheet/types";
import type { ClientOverridesFile } from "../overrides";

/** The knowledge layer (AI context files, `context search --client`) uses the same client rule as the Clients pages. */

const oldState = process.env.XDG_STATE_HOME;
afterEach(async () => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  await removeTempDirs();
});

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "CL008", name: "Example Vet", aliases: ["examplevet"], responsibleNames: [] },
    { code: "CL009", name: "Outra Empresa", aliases: [], responsibleNames: [] }
  ]
};

const summary = (overview: string) => ({
  version: 1, provider: "openai", model: "gpt-4o-mini", title: overview.slice(0, 60), overview,
  topics: [], decisions: [], actionItems: []
});

const overridesOf = (entries: ClientOverridesFile["entries"]) => ({ read: async (): Promise<ClientOverridesFile> => ({ version: 1, rev: 1, entries }) });

describe("context search --client", () => {
  const fixture = async () => {
    const root = await tempDir("knowledge-clients-");
    process.env.XDG_STATE_HOME = join(root, "state");
    const stateRoot = join(root, "state", "recording-cli");
    await fs.mkdir(join(stateRoot, "jobs"), { recursive: true });
    const contextPath = join(stateRoot, "timesheet-context.json");
    await fs.writeFile(contextPath, JSON.stringify(catalog));
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.contextPath = contextPath;
    const timeStore = new TimeEntryStore();
    const jobs: Record<string, { id: string; sourcePath: string; sha256: string }> = {};
    const addJob = async (name: string, n: number, overview: string, transcript = "Conversa gravada.") => {
      const id = uuid(n);
      const sourcePath = join(root, `${name}.mkv`);
      const artifactDir = join(root, `${name}.recording`, id);
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(sourcePath, "media");
      const sha256 = String(n).repeat(64).slice(0, 64).replace(/[^0-9]/g, "a");
      await fs.writeFile(join(stateRoot, "jobs", `${id}.json`), JSON.stringify({
        version: 1, id, createdAt: `2026-09-${String(n).padStart(2, "0")}T18:00:00.000Z`, updatedAt: "2026-09-30T19:00:00.000Z",
        source: { originalName: `${name}.mkv`, mediaFile: "source.mkv", size: 5, sha256 },
        transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
        summary: { provider: "openai", model: "gpt-4o-mini" }, sourcePath, artifactDir, target: "local", state: "completed"
      }));
      await fs.writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary(overview)));
      await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify({
        version: 1, provider: "openai", model: "gpt-transcribe", language: "pt", text: transcript, segments: [{ start: 0, end: 1, text: transcript }]
      }));
      jobs[name] = { id, sourcePath, sha256 };
    };
    const addEntry = async (name: string, clientCode: string, trust: { locked?: boolean; confidence?: number }) => {
      const created = await timeStore.create({ activityDate: "2026-09-01", hours: 1, clientCode, source: { kind: "call", jobId: jobs[name]!.id }, status: "ready", classificationStatus: "completed" });
      await timeStore.replace({ ...created, confidence: { client: trust.confidence ?? 0, taskType: 0, description: 0 }, lockedFields: trust.locked ? ["client"] : [] });
    };
    return { config, jobs, addJob, addEntry };
  };

  test("untrusted time entries no longer assign a client; trusted ones and content matches do", async () => {
    const f = await fixture();
    await f.addJob("by-content", 1, "Ajustes nos alertas da Example Vet.");
    await f.addJob("untrusted", 2, "Conversa técnica genérica.");
    await f.addJob("locked", 3, "Conversa técnica genérica.");
    await f.addJob("confident", 4, "Conversa técnica genérica.");
    await f.addJob("other-client", 5, "Ajustes nos alertas da Example Vet.");
    await f.addJob("in-transcript", 6, "Conversa técnica genérica.", "A examplevet pediu ajustes.");
    await f.addEntry("untrusted", "CL008", { confidence: 0.5 });
    await f.addEntry("locked", "CL008", { locked: true });
    await f.addEntry("confident", "CL008", { confidence: 0.9 });
    await f.addEntry("other-client", "CL009", { locked: true });
    const found = await searchMeetings(f.config, { client: "Example Vet" }, { clientOverrides: overridesOf([]) });
    expect(found.items.map((item) => item.jobId).sort()).toEqual([f.jobs["by-content"]!.id, f.jobs.locked!.id, f.jobs.confident!.id, f.jobs["in-transcript"]!.id].sort());
    expect((await searchMeetings(f.config, { client: "CL009" }, { clientOverrides: overridesOf([]) })).items.map((item) => item.jobId)).toEqual([f.jobs["other-client"]!.id]);
    expect((await searchMeetings(f.config, { client: "Desconhecido" }, { clientOverrides: overridesOf([]) })).items).toEqual([]);
  });

  test("manual choices decide before entries and content; unreadable choices are ignored", async () => {
    const f = await fixture();
    await f.addJob("content-but-none", 1, "Ajustes nos alertas da Example Vet.");
    await f.addJob("locked-other", 2, "Conversa técnica genérica.");
    await f.addJob("chosen", 3, "Conversa técnica genérica.");
    await f.addEntry("locked-other", "CL009", { locked: true });
    const overrides = overridesOf([
      { jobId: f.jobs["content-but-none"]!.id, mediaSha256: f.jobs["content-but-none"]!.sha256, clientCodes: [], setAt: "2026-10-01T00:00:00.000Z" },
      { jobId: f.jobs["locked-other"]!.id, mediaSha256: f.jobs["locked-other"]!.sha256, clientCodes: ["CL008", "CL009"], setAt: "2026-10-01T00:00:00.000Z" },
      { jobId: f.jobs.chosen!.id, mediaSha256: f.jobs.chosen!.sha256, clientCodes: ["CL008"], setAt: "2026-10-01T00:00:00.000Z" }
    ]);
    const found = await searchMeetings(f.config, { client: "CL008" }, { clientOverrides: overrides });
    expect(found.items.map((item) => item.jobId).sort()).toEqual([f.jobs["locked-other"]!.id, f.jobs.chosen!.id].sort());
    const broken = { read: async (): Promise<ClientOverridesFile> => { throw new Error("arquivo inválido"); } };
    expect((await searchMeetings(f.config, { client: "CL008" }, { clientOverrides: broken })).items.map((item) => item.jobId)).toEqual([f.jobs["content-but-none"]!.id]);
  });

  test("without a client filter the choices file is not read", async () => {
    const f = await fixture();
    await f.addJob("any", 1, "Conversa técnica genérica.");
    let reads = 0;
    const found = await searchMeetings(f.config, {}, { clientOverrides: { read: async () => { reads++; return { version: 1, rev: 0, entries: [] }; } } });
    expect(found.items).toHaveLength(1);
    expect(reads).toBe(0);
  });
});

describe("AI context files", () => {
  test("manual choices move a recording to the chosen client(s) or out of every client", async () => {
    const root = await tempDir("knowledge-ai-");
    const contextPath = join(root, "timesheet-context.json");
    await fs.writeFile(contextPath, JSON.stringify(catalog));
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      timesheet: { enabled: true, contextPath },
      aiContext: { enabled: true }
    });
    const jobStore = new JobStore(join(root, "job-state"), join(root, "job-data"));
    const timeStore = new TimeEntryStore(join(root, "timesheet"));
    const add = async (name: string, overview: string) => {
      const media = join(root, `${name}.mkv`);
      await fs.writeFile(media, `media ${name}`);
      const job = await jobStore.enqueue(config, media);
      await fs.mkdir(job.artifactDir, { recursive: true });
      await fs.writeFile(join(job.artifactDir, "summary.json"), JSON.stringify(summary(overview)));
      await jobStore.update(job.id, "completed");
      return job;
    };
    const vet = await add("vet", "Ajustes nos alertas da Example Vet.");
    const both = await add("both", "Conversa sem cliente no resumo.");
    const outputDir = join(root, "ai-context");

    const automatic = await buildAiContextFiles(config, { outputDir, jobStore, timeStore, clientOverrides: overridesOf([]), generatedAt: "2026-10-25T12:00:00.000Z" });
    expect(automatic.meetingsIncluded).toBe(1);
    expect(automatic.skippedUnassigned).toBe(1);

    const chosen = overridesOf([
      { jobId: vet.id, mediaSha256: vet.source.sha256, clientCodes: [], setAt: "2026-10-01T00:00:00.000Z" },
      { jobId: both.id, mediaSha256: both.source.sha256, clientCodes: ["CL008", "CL009"], setAt: "2026-10-01T00:00:00.000Z" }
    ]);
    const report = await buildAiContextFiles(config, { outputDir, jobStore, timeStore, clientOverrides: chosen, generatedAt: "2026-10-25T12:00:00.000Z" });
    expect(report.meetingsIncluded).toBe(2);
    expect(report.skippedUnassigned).toBe(1);
    const vetContext = await readClientAiContext(config, "CL008", outputDir);
    const otherContext = await readClientAiContext(config, "CL009", outputDir);
    expect(vetContext).toContain(both.id);
    expect(vetContext).not.toContain(vet.id);
    expect(otherContext).toContain(both.id);
  });
});
