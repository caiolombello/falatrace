import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobRecord } from "../../jobs/types";
import { readMeetingArtifacts } from "../../knowledge/meetings";
import { foldText } from "../bm25";
import { LIBRARY_INDEX_BUSY, LIBRARY_INDEX_CANCELLED, LibraryIndex, type LibraryIndexDeps } from "../index";
import { IndexStore } from "../store";
import { deleteJob, type FixtureRoot, filler, makeRoot, touchJob, writeJob, writeSummary } from "./fixtures";

let fixture: FixtureRoot;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await fixture?.restore();
});

const budgetMeeting = (fixture: FixtureRoot, extra: Partial<Parameters<typeof writeJob>[1]> = {}) => writeJob(fixture, {
  name: "orcamento", createdAt: "2026-10-01T13:00:00.000Z",
  segments: [
    { start: 0, end: 8, text: "Bom dia, hoje a pauta é o orçamento de marketing do próximo trimestre.", speaker: "S1" },
    { start: 9, end: 20, text: "A agência pediu mais verba para a campanha de lançamento.", speaker: "S2" },
    { start: 21, end: 30, text: "Decidimos aprovar o orçamento com um corte de dez por cento.", speaker: "S1" },
    ...filler("a campanha", 8, 31)
  ],
  summary: { title: "Orçamento de marketing", overview: "Aprovação do orçamento de marketing com corte.", topics: ["Orçamento"],
    decisions: ["Aprovar o orçamento com corte de 10%"], actionItems: [{ description: "Enviar a planilha revisada", owner: "Ana", dueDate: "sexta" }],
    citations: [{ section: "decision", index: 0, segmentIds: ["s000002"], uncertainty: "clear" }] },
  ...extra
});

const migrationMeeting = (fixture: FixtureRoot) => writeJob(fixture, {
  name: "migracao", createdAt: "2026-10-05T13:00:00.000Z",
  segments: [
    { start: 0, end: 10, text: "A migração do banco de dados vai para a próxima sprint.", speaker: "S1" },
    { start: 11, end: 20, text: "Precisamos testar o backup antes da migração.", speaker: "S2" },
    ...filler("a migração", 6, 21)
  ],
  summary: { title: "Migração do banco", overview: "Planejamento da migração.", topics: [], decisions: [], actionItems: [] }
});

const counting = (deps: LibraryIndexDeps = {}) => {
  const calls: string[] = [];
  return { calls, deps: { ...deps, readArtifacts: async (job: JobRecord) => { calls.push(job.id); return readMeetingArtifacts(job); } } };
};

describe("LibraryIndex refresh", () => {
  test("indexes completed and local recordings, newest first", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const migration = await migrationMeeting(fixture);
    // Remote and still processing: not part of the library yet.
    await writeJob(fixture, { name: "remota", target: "remote", state: "processing", segments: filler("x", 2) });
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    const report = await index.refresh();
    expect(report).toMatchObject({ indexed: 2, rebuilt: 2, unchanged: 0, removed: 0, failed: 0, embeddings: "off" });
    const facts = await index.listFacts();
    expect(facts.map((item) => item.jobId)).toEqual([migration.id, budget.id]);
    const budgetFacts = await index.getFacts(budget.id);
    expect(budgetFacts?.title).toBe("Orçamento de marketing");
    expect(budgetFacts?.decisions[0]).toEqual({ index: 0, text: "Aprovar o orçamento com corte de 10%", segmentIds: ["s000002"] });
    expect(await index.getFacts("not-an-id")).toBeUndefined();
    const store = new IndexStore();
    expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(store.jobsDir, `${budget.id}.json`))).mode & 0o777).toBe(0o600);
  });

  test("a second refresh reads nothing when no source changed", async () => {
    fixture = await makeRoot();
    await budgetMeeting(fixture);
    await migrationMeeting(fixture);
    const { calls, deps } = counting();
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), deps);
    await index.refresh();
    expect(calls).toHaveLength(2);
    const again = await index.refresh();
    expect(again).toMatchObject({ indexed: 2, rebuilt: 0, unchanged: 2 });
    expect(calls).toHaveLength(2);
    // A new process (fresh instance) also skips by probe.
    const other = counting();
    await new LibraryIndex(structuredClone(DEFAULT_CONFIG), other.deps).refresh();
    expect(other.calls).toHaveLength(0);
  });

  test("rebuilds only the recording whose summary changed", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    await migrationMeeting(fixture);
    const { calls, deps } = counting();
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), deps);
    await index.refresh();
    const before = (await index.getFacts(budget.id))!.fingerprint;
    await writeSummary(budget, { title: "Orçamento revisto", overview: "Nova versão.", topics: [], decisions: [], actionItems: [] });
    const report = await index.refresh();
    expect(report).toMatchObject({ rebuilt: 1, unchanged: 1 });
    expect(calls.filter((id) => id === budget.id)).toHaveLength(2);
    const after = await index.getFacts(budget.id);
    expect(after?.title).toBe("Orçamento revisto");
    expect(after?.fingerprint).not.toBe(before);
  });

  test("re-reads when the job record changes and when notes or clients change", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    let notes: Array<{ id: string; text: string; offsetSeconds: number | null }> = [];
    let clients: Array<{ code: string; name: string; source: "manual"; confidence: number }> = [];
    const { calls, deps } = counting({ notes: async () => ({ entries: notes }), clients: async () => clients });
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), deps);
    await index.refresh();
    await touchJob(fixture, budget, { updatedAt: "2026-10-02T00:00:00.000Z" });
    expect((await index.refresh()).rebuilt).toBe(1);
    notes = [{ id: "n000001", text: "[ ] ligar para a agência", offsetSeconds: 15 }];
    expect((await index.refresh()).rebuilt).toBe(1);
    expect((await index.getFacts(budget.id))?.actions.some((action) => action.origin === "note")).toBe(true);
    clients = [{ code: "CL001", name: "Acme", source: "manual", confidence: 1 }];
    expect((await index.refresh()).rebuilt).toBe(1);
    expect((await index.getFacts(budget.id))?.clients.map((client) => client.code)).toEqual(["CL001"]);
    expect((await index.refresh()).unchanged).toBe(1);
    expect(calls).toHaveLength(4);
  });

  test("drops recordings whose job was deleted or became unreadable", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const migration = await migrationMeeting(fixture);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    await index.refresh();
    await deleteJob(fixture, budget);
    const report = await index.refresh();
    expect(report).toMatchObject({ removed: 1, indexed: 1 });
    expect(await index.getFacts(budget.id)).toBeUndefined();
    expect((await index.search("orçamento")).some((hit) => hit.chunk.jobId === budget.id)).toBe(false);
    await fs.rm(join(migration.artifactDir, "transcript.json"));
    const broken = await index.refresh();
    // No transcript any more: skipped (not a failure), and its stale entry is dropped.
    expect(broken).toMatchObject({ skipped: 1, failed: 0, removed: 1, indexed: 0 });
    expect(await index.listFacts()).toEqual([]);
  });

  test("refreshes only the requested recordings", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const migration = await migrationMeeting(fixture);
    const { calls, deps } = counting();
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), deps);
    expect(await index.refresh({ jobIds: [budget.id] })).toMatchObject({ indexed: 1, rebuilt: 1 });
    expect(calls).toEqual([budget.id]);
    expect(await index.getFacts(migration.id)).toBeUndefined();
    await index.refresh({ jobIds: [migration.id] });
    await deleteJob(fixture, migration);
    // A targeted refresh removes a requested recording that is gone, and leaves the others.
    expect(await index.refresh({ jobIds: [migration.id] })).toMatchObject({ removed: 1, indexed: 0 });
    expect((await index.listFacts()).map((item) => item.jobId)).toEqual([budget.id]);
    await expect(index.refresh({ jobIds: ["../x"] })).rejects.toThrow("Identificador de gravação inválido.");
  });

  test("rebuilds a corrupt entry and ignores it meanwhile", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    await index.refresh();
    const path = join(new IndexStore().jobsDir, `${budget.id}.json`);
    await fs.writeFile(path, "{corrupt", { mode: 0o600 });
    const fresh = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    expect(await fresh.listFacts()).toEqual([]);
    expect(await fresh.refresh()).toMatchObject({ rebuilt: 1 });
    expect((await fresh.listFacts()).map((item) => item.jobId)).toEqual([budget.id]);
  });

  test("picks up a refresh made by another instance", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const writer = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    const reader = new LibraryIndex(structuredClone(DEFAULT_CONFIG), { revalidateMs: 0 });
    expect(await reader.listFacts()).toEqual([]);
    await writer.refresh();
    expect((await reader.listFacts()).map((item) => item.jobId)).toEqual([budget.id]);
    await writeSummary(budget, { title: "Título novo", overview: "Resumo novo.", topics: [], decisions: [], actionItems: [] });
    await writer.refresh();
    expect((await reader.getFacts(budget.id))?.title).toBe("Título novo");
    await writer.removeJob(budget.id);
    expect(await reader.listFacts()).toEqual([]);
  });

  test("shares one full refresh, waits for the lock and can be cancelled", async () => {
    fixture = await makeRoot();
    await budgetMeeting(fixture);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    const first = index.refresh();
    expect(index.refresh()).toBe(first);
    await first;
    const busy = new LibraryIndex(structuredClone(DEFAULT_CONFIG), { lockWaitMs: 50, acquireLock: async (name) => { throw new Error(`${name} is already running`); } });
    await expect(busy.refresh()).rejects.toThrow(LIBRARY_INDEX_BUSY);
    const controller = new AbortController();
    controller.abort();
    await expect(index.refresh({ signal: controller.signal })).rejects.toThrow(LIBRARY_INDEX_CANCELLED);
    let released = 0;
    const counted = new LibraryIndex(structuredClone(DEFAULT_CONFIG), { acquireLock: async () => ({ release: async () => { released++; } }) });
    await counted.refresh();
    expect(released).toBe(1);
  });
});

describe("LibraryIndex search", () => {
  test("ranks Portuguese chunks by BM25 with or without accents and filters by recording", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const migration = await migrationMeeting(fixture);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    await index.refresh();
    const accented = await index.search("migração do banco");
    expect(accented[0]!.chunk.jobId).toBe(migration.id);
    expect((await index.search("MIGRACAO banco")).map((hit) => hit.chunk.chunkId)).toEqual(accented.map((hit) => hit.chunk.chunkId));
    const budgetHits = await index.search("orçamento corte");
    expect(budgetHits[0]!.chunk.jobId).toBe(budget.id);
    // The summary decision is boosted over transcript text with the same words.
    expect(budgetHits[0]!.chunk.kind).toBe("summary");
    expect(foldText(budgetHits[0]!.chunk.text)).toContain("corte");
    const only = await index.search("migração orçamento", { jobIds: [budget.id] });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((hit) => hit.chunk.jobId === budget.id)).toBe(true);
    expect(await index.search("migração", { limit: 1 })).toHaveLength(1);
    expect(await index.search("   ")).toEqual([]);
    expect(await index.search("de que a o")).toEqual([]);
    const scores = accented.map((hit) => hit.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  test("segment chunks keep one line per segment with ids and times", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    await index.refresh();
    const chunks = (await index.chunksOf(budget.id)).filter((chunk) => chunk.kind === "segments");
    expect(chunks[0]!.segmentIds[0]).toBe("s000000");
    expect(chunks[0]!.text.split("\n")[0]).toContain("orçamento de marketing");
    const info = await index.segmentInfo(budget.id);
    expect(info.get("s000002")).toEqual({ id: "s000002", start: 21, end: 30, speaker: "S1" });
    expect((await index.segmentInfo("bad")).size).toBe(0);
  });
});

describe("LibraryIndex embeddings", () => {
  // Deterministic fake: one dimension per concept, so semantic matches are predictable.
  const concepts = [/orcamento|budget|verba/, /migracao|database|banco/, /ferias|vacation/];
  const embed = (text: string): number[] => { const folded = foldText(text); return [...concepts.map((pattern) => pattern.test(folded) ? 1 : 0), 0.05]; };
  const fakeOllama = (status = 200, model = "fake-embed") => {
    const inputs: string[][] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
      const body = await request.json() as { input: string[]; model: string };
      inputs.push(body.input);
      if (status !== 200 || body.model !== model) return new Response("down", { status: status === 200 ? 404 : status });
      return Response.json({ embeddings: body.input.map(embed) });
    } });
    servers.push(server);
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.ollamaUrl = `http://127.0.0.1:${server.port}`;
    config.assistant.embeddingModel = model;
    return { config, inputs };
  };

  test("embeds chunks once and fuses semantic matches with keyword search", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    await migrationMeeting(fixture);
    const { config, inputs } = fakeOllama();
    const index = new LibraryIndex(config);
    const report = await index.refresh();
    expect(report).toMatchObject({ embeddings: "ready", embedded: 2 });
    const store = new IndexStore();
    expect((await store.readEmbeddings(budget.id))?.value.model).toBe("fake-embed");
    const requests = inputs.length;
    expect((await index.refresh()).embedded).toBe(0);
    expect(inputs.length).toBe(requests);
    // "budget" never appears in the Portuguese text: only the semantic side can find it.
    const hits = await index.search("budget");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.jobId).toBe(budget.id);
  });

  test("re-embeds when the model changes and keeps keyword search when Ollama is down", async () => {
    fixture = await makeRoot();
    const budget = await budgetMeeting(fixture);
    const { config } = fakeOllama();
    await new LibraryIndex(config).refresh();
    // Same model and content: nothing to embed again.
    expect((await new LibraryIndex(config).refresh()).embedded).toBe(0);
    const other = fakeOllama(200, "other-embed");
    expect((await new LibraryIndex(other.config).refresh()).embedded).toBe(1);
    const down = fakeOllama(500, "third-embed");
    const index = new LibraryIndex(down.config);
    const report = await index.refresh();
    expect(report.embeddings).toBe("unavailable");
    expect(report.failed).toBe(0);
    expect(down.inputs).toHaveLength(1);
    const hits = await index.search("orçamento");
    expect(hits[0]!.chunk.jobId).toBe(budget.id);
    // Vectors made for another server's model are not mixed in.
    expect(await index.search("budget")).toEqual([]);
  });

  test("never embeds through a remote Ollama", async () => {
    fixture = await makeRoot();
    await budgetMeeting(fixture);
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.ollamaUrl = "https://ollama.example.com";
    config.assistant.embeddingModel = "fake-embed";
    let calls = 0;
    const index = new LibraryIndex(config, { fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
    expect((await index.refresh()).embeddings).toBe("off");
    await index.search("orçamento");
    expect(calls).toBe(0);
  });
});
