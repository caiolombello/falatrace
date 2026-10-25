import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import type { JobRecord } from "../../jobs/types";
import { readMeetingArtifacts } from "../../knowledge/meetings";
import { encodeVector } from "../embeddings";
import { LibraryIndex, type LibraryIndexDeps, listJobsTolerant } from "../index";
import { INDEX_STORE_UNSAFE, IndexStore } from "../store";
import { type FixtureRoot, filler, makeRoot, writeJob, writeTranscriptReceipt } from "./fixtures";

let fixture: FixtureRoot;
afterEach(async () => { await fixture?.restore(); });

const DAY = 24 * 60 * 60_000;
const config = () => structuredClone(DEFAULT_CONFIG);
const meeting = (fixture: FixtureRoot, name: string, createdAt: string, topic: string) => writeJob(fixture, {
  name, createdAt, segments: filler(topic, 8),
  summary: { title: `Reunião sobre ${topic}`, overview: `Conversa sobre ${topic}.`, topics: [], decisions: [], actionItems: [] }
});

/** Holds readArtifacts for one job until released, to place a removal in the middle of a refresh. */
const gate = (jobId: string) => {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const opened = new Promise<void>((resolve) => { release = resolve; });
  const deps: LibraryIndexDeps = {
    readArtifacts: async (job: JobRecord) => {
      if (job.id === jobId) { entered(); await opened; }
      return readMeetingArtifacts(job);
    }
  };
  return { deps, reached, release };
};

describe("removeJob", () => {
  test("drops a recording at once and keeps it out while its job still exists, until restored", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const roadmap = await meeting(fixture, "roadmap", "2026-10-02T13:00:00.000Z", "roadmap");
    const index = new LibraryIndex(config());
    await index.refresh();
    const other = new LibraryIndex(config(), { revalidateMs: 0 });
    expect((await other.listFacts()).map((facts) => facts.jobId)).toEqual([roadmap.id, budget.id]);
    await index.removeJob(budget.id);
    expect(await index.getFacts(budget.id)).toBeUndefined();
    expect((await index.search("orçamento")).some((hit) => hit.chunk.jobId === budget.id)).toBe(false);
    expect(await other.getFacts(budget.id)).toBeUndefined();
    const store = new IndexStore();
    expect(await store.readJob(budget.id)).toBeUndefined();
    expect((await fs.stat(join(store.tombstonesDir, budget.id))).mode & 0o777).toBe(0o600);
    // The job still exists (deletion not finished): refreshes leave it out.
    expect(await index.refresh()).toMatchObject({ indexed: 1, rebuilt: 0 });
    expect(await index.refresh({ jobIds: [budget.id] })).toMatchObject({ indexed: 0 });
    expect(await index.getFacts(budget.id)).toBeUndefined();
    // An aborted deletion is undone explicitly.
    await index.restoreJob(budget.id);
    expect(await index.refresh()).toMatchObject({ indexed: 2, rebuilt: 1 });
    expect((await index.getFacts(budget.id))?.title).toBe("Reunião sobre orçamento");
    await expect(index.removeJob("../x")).rejects.toThrow("Identificador de gravação inválido.");
    await expect(index.restoreJob("x")).rejects.toThrow("Identificador de gravação inválido.");
  });

  test("a removal while a refresh reads the recording is not undone by that refresh", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    await meeting(fixture, "roadmap", "2026-10-02T13:00:00.000Z", "roadmap");
    const { deps, reached, release } = gate(budget.id);
    const refreshing = new LibraryIndex(config(), deps);
    const running = refreshing.refresh();
    await reached;
    // Another process removes it; it does not wait for the refresh lock.
    await new LibraryIndex(config()).removeJob(budget.id);
    release();
    const report = await running;
    expect(report).toMatchObject({ indexed: 1, removed: 1 });
    expect(await new IndexStore().readJob(budget.id)).toBeUndefined();
    expect(await refreshing.getFacts(budget.id)).toBeUndefined();
    expect((await refreshing.listFacts()).map((facts) => facts.title)).toEqual(["Reunião sobre roadmap"]);
  });

  test("a removal while an unchanged recording is checked is honoured too", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const index = new LibraryIndex(config());
    await index.refresh();
    let removing: Promise<void> | undefined;
    // The clients resolver runs on the unchanged path; remove the job from inside it.
    const checking = new LibraryIndex(config(), { clients: async () => { removing ??= new LibraryIndex(config()).removeJob(budget.id); await removing; return []; } });
    expect(await checking.refresh()).toMatchObject({ indexed: 0, removed: 1 });
    expect(await checking.listFacts()).toEqual([]);
  });

  test("vectors computed for a recording removed meanwhile are deleted", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const settings = config();
    settings.summary.ollamaUrl = "http://127.0.0.1:9";
    settings.assistant.embeddingModel = "fake-embed";
    let removed = false;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      if (!removed) { removed = true; await new LibraryIndex(config()).removeJob(budget.id); }
      return Response.json({ embeddings: body.input.map(() => [1, 0]) });
    }) as typeof fetch;
    const index = new LibraryIndex(settings, { fetch: fakeFetch });
    const report = await index.refresh();
    expect(report.embedded).toBe(0);
    expect(await new IndexStore().readEmbeddings(budget.id)).toBeUndefined();
  });

  test("tombstones expire after a day and are then pruned", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    let now = Date.now();
    const index = new LibraryIndex(config(), { now: () => now, revalidateMs: 0 });
    await index.refresh();
    await index.removeJob(budget.id);
    now += DAY - 60_000;
    expect((await index.refresh()).indexed).toBe(0);
    now += 2 * 60_000;
    expect((await index.refresh()).indexed).toBe(1);
    expect(await new IndexStore().listTombstones()).toEqual(new Map());
  });
});

describe("robustness", () => {
  test("one unreadable job file does not empty the index", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const index = new LibraryIndex(config());
    await index.refresh();
    const stray = join(fixture.stateDir, "recording-cli", "jobs", "9e3b529e-5c22-4802-97b8-f3e1a52c1919.json");
    await fs.writeFile(stray, "{broken");
    const store = new JobStore();
    await expect(store.list()).rejects.toThrow();
    expect((await listJobsTolerant(store)).map((job) => job.id)).toEqual([budget.id]);
    expect(await index.refresh()).toMatchObject({ indexed: 1, removed: 0 });
    expect(await listJobsTolerant({ stateDir: join(fixture.root, "missing"), get: store.get.bind(store) })).toEqual([]);
  });

  test("an unsafe index folder stops the refresh with a clear message", async () => {
    fixture = await makeRoot();
    await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const index = new LibraryIndex(config());
    await index.refresh();
    const store = new IndexStore();
    await fs.chmod(store.jobsDir, 0o755);
    await expect(index.refresh()).rejects.toThrow(INDEX_STORE_UNSAFE);
    await expect(new LibraryIndex(config()).listFacts()).rejects.toThrow(INDEX_STORE_UNSAFE);
    await fs.chmod(store.jobsDir, 0o700);
    expect((await index.refresh()).indexed).toBe(1);
  });

  test("local recordings still processing are skipped until they have a transcript", async () => {
    fixture = await makeRoot();
    const ready = await writeJob(fixture, { name: "pronta", state: "processing", target: "local", segments: filler("pronta", 3) });
    await writeTranscriptReceipt(ready);
    // A transcript without its receipt is not committed yet.
    const uncommitted = await writeJob(fixture, { name: "sem-recibo", state: "processing", target: "local", segments: filler("y", 2) });
    const waiting = await writeJob(fixture, { name: "aguardando", state: "processing", target: "local", segments: filler("x", 1) });
    await fs.rm(join(waiting.artifactDir, "transcript.json"));
    const index = new LibraryIndex(config());
    expect(await index.refresh()).toMatchObject({ indexed: 1, skipped: 2, failed: 0 });
    expect((await index.listFacts()).map((facts) => facts.jobId)).toEqual([ready.id]);
    await writeTranscriptReceipt(uncommitted);
    expect(await index.refresh()).toMatchObject({ indexed: 2, rebuilt: 1, unchanged: 1, skipped: 1 });
  });

  test("reads trust memory for a moment, then pick up other writers", async () => {
    fixture = await makeRoot();
    const budget = await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    let now = 1_000_000;
    const reader = new LibraryIndex(config(), { now: () => now });
    expect(await reader.listFacts()).toEqual([]);
    await new LibraryIndex(config()).refresh();
    expect(await reader.listFacts()).toEqual([]);
    now += 1_001;
    expect((await reader.listFacts()).map((facts) => facts.jobId)).toEqual([budget.id]);
  });

  test("a full refresh deletes vectors left without their index entry", async () => {
    fixture = await makeRoot();
    await meeting(fixture, "orcamento", "2026-10-01T13:00:00.000Z", "orçamento");
    const store = new IndexStore();
    const orphan = "7e3b529e-5c22-4802-97b8-f3e1a52c1919";
    await store.writeEmbeddings(orphan, { version: 1, model: "m", dims: 1, fingerprint: "2".repeat(64), vectors: [encodeVector(new Float32Array([1]))] });
    await new LibraryIndex(config()).refresh({ jobIds: [orphan] });
    expect(await store.readEmbeddings(orphan)).toBeDefined();
    await new LibraryIndex(config()).refresh();
    expect(await store.readEmbeddings(orphan)).toBeUndefined();
  });

  test("refuses malformed refresh targets", async () => {
    fixture = await makeRoot();
    const index = new LibraryIndex(config());
    await expect(index.refresh({ jobIds: "x" as unknown as string[] })).rejects.toThrow("Identificador de gravação inválido.");
    await expect(index.refresh({ jobIds: new Array(2_001).fill("3e3b529e-5c22-4802-97b8-f3e1a52c1919") })).rejects.toThrow("Identificador de gravação inválido.");
    expect(await index.search("orçamento", { jobIds: "x" as unknown as string[] })).toEqual([]);
  });
});
