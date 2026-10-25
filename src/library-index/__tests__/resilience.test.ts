import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobRecord } from "../../jobs/types";
import { buildJobIndex, readMeetingSource, readNotesInput } from "../build";
import { LibraryIndex } from "../index";
import { IndexStore, validateStoredJobIndex } from "../store";
import { fakeArtifacts, type FixtureRoot, filler, makeRoot, writeJob } from "./fixtures";

/** Injected readers that fail, notes that do not fit the store, and refreshes that must not re-read everything. */

let fixture: FixtureRoot | undefined;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await fixture?.restore();
  fixture = undefined;
});

const JOB = {
  id: "3e3b529e-5c22-4802-97b8-f3e1a52c1919", createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-01T13:00:00.000Z",
  source: { originalName: "reuniao.mkv", sha256: "a".repeat(64) }, summary: { provider: "openai", model: "m" }, sourcePath: "/m/reuniao.mkv",
  artifactDir: "/m/reuniao.recording", state: "completed", target: "local"
} as unknown as JobRecord;

const meeting = (root: FixtureRoot, name: string) => writeJob(root, {
  name, segments: filler(name, 12),
  summary: { title: `Reunião ${name}`, overview: `Assuntos de ${name}.`, topics: [], decisions: [], actionItems: [] }
});

describe("injected readers never take recordings out of the index", () => {
  test("a clients resolver that throws (invalid catalog) leaves every recording indexed, without clients", async () => {
    fixture = await makeRoot();
    const first = await meeting(fixture, "alfa");
    const second = await meeting(fixture, "beta");
    let broken = false;
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), {
      clients: async () => {
        if (broken) throw new Error("O catálogo de clientes é inválido; corrija o arquivo antes de editar.");
        return [{ code: "CL001", name: "Acme", source: "manual", confidence: 1 }];
      }
    });
    expect(await index.refresh()).toMatchObject({ indexed: 2, failed: 0 });
    expect((await index.getFacts(first.id))?.clients.map((client) => client.code)).toEqual(["CL001"]);
    broken = true;
    const report = await index.refresh();
    expect(report).toMatchObject({ indexed: 2, failed: 0, removed: 0 });
    expect((await index.listFacts()).map((facts) => facts.jobId).sort()).toEqual([first.id, second.id].sort());
    expect((await index.getFacts(first.id))?.clients).toEqual([]);
    expect((await index.search("alfa")).some((hit) => hit.chunk.jobId === first.id)).toBe(true);
  });

  test("a notes or calendar reader that throws leaves the recording indexed, without them", async () => {
    fixture = await makeRoot();
    const job = await meeting(fixture, "gama");
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), {
      notes: async () => { throw new Error("notes file unreadable"); },
      calendarLink: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }
    });
    expect(await index.refresh()).toMatchObject({ indexed: 1, failed: 0, skipped: 0 });
    expect(await index.getFacts(job.id)).toMatchObject({ noteCount: 0, title: "Reunião gama" });
  });

  test("the meeting source used by questions survives a failing notes or calendar reader", async () => {
    const source = await readMeetingSource(JOB, {
      readArtifacts: async () => fakeArtifacts({ segments: filler("delta", 3) }),
      notes: async () => { throw new Error("boom"); },
      calendarLink: async () => { throw new Error("boom"); }
    });
    expect(source.notes).toEqual([]);
    expect(source.calendar).toBeUndefined();
    expect(source.segments).toHaveLength(3);
  });
});

describe("notes always fit the stored index", () => {
  test("repeated ids are kept once and out-of-range offsets lose their moment", async () => {
    const notes = await readNotesInput(JOB, async () => ({ entries: [
      { id: "n000001", text: "primeira", offsetSeconds: 12 },
      { id: "n000001", text: "repetida", offsetSeconds: 13 },
      { id: "n000002", text: "muito tarde", offsetSeconds: 2e7 },
      { id: "n000003", text: "   ", offsetSeconds: 1 },
      { id: "n000003", text: "depois de uma vazia", offsetSeconds: 1 }
    ] }));
    expect(notes).toEqual([
      { id: "n000001", text: "primeira", offsetSeconds: 12 },
      { id: "n000002", text: "muito tarde", offsetSeconds: null },
      { id: "n000003", text: "depois de uma vazia", offsetSeconds: 1 }
    ]);
  });

  test("an entry built from such notes passes the store validator", async () => {
    const source = await readMeetingSource(JOB, {
      readArtifacts: async () => fakeArtifacts({ segments: filler("epsilon", 4) }),
      notes: async () => ({ entries: [
        { id: "n000001", text: "[ ] ligar", offsetSeconds: 5 },
        { id: "n000001", text: "[ ] ligar de novo", offsetSeconds: 6 },
        { id: "n000002", text: "nota", offsetSeconds: 1e9 }
      ] })
    });
    const entry = buildJobIndex(source, [], "f".repeat(64));
    expect(() => validateStoredJobIndex(JSON.parse(JSON.stringify(entry)))).not.toThrow();
    expect(entry.chunks.filter((chunk) => chunk.kind === "note").map((chunk) => chunk.chunkId))
      .toEqual([`${JOB.id}:note:n000001`, `${JOB.id}:note:n000002`]);
  });

  test("a library with such notes is indexed instead of failing", async () => {
    fixture = await makeRoot();
    const job = await meeting(fixture, "zeta");
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), {
      notes: async () => ({ entries: [{ id: "n1", text: "a", offsetSeconds: 1 }, { id: "n1", text: "b", offsetSeconds: 2e7 }] })
    });
    expect(await index.refresh()).toMatchObject({ indexed: 1, failed: 0 });
    expect((await index.getFacts(job.id))?.noteCount).toBe(1);
  });
});

describe("an unchanged library is not re-read", () => {
  const counted = (store: IndexStore) => {
    const counts = { jobs: 0, embeddings: 0 };
    const readJob = store.readJob.bind(store);
    const readEmbeddings = store.readEmbeddings.bind(store);
    store.readJob = async (jobId) => { counts.jobs++; return readJob(jobId); };
    store.readEmbeddings = async (jobId) => { counts.embeddings++; return readEmbeddings(jobId); };
    return counts;
  };

  test("a second refresh in the same process reuses the loaded entries", async () => {
    fixture = await makeRoot();
    await meeting(fixture, "eta");
    await meeting(fixture, "teta");
    const store = new IndexStore();
    const counts = counted(store);
    const index = new LibraryIndex(structuredClone(DEFAULT_CONFIG), { store });
    await index.refresh();
    const after = counts.jobs;
    expect(await index.refresh()).toMatchObject({ unchanged: 2, rebuilt: 0 });
    expect(counts.jobs).toBe(after);
    // Another writer changed the file: it is read again.
    const other = new LibraryIndex(structuredClone(DEFAULT_CONFIG));
    const facts = await other.listFacts();
    await new IndexStore().writeJob({ ...(await new IndexStore().readJob(facts[0]!.jobId))!.entry, probe: "e".repeat(64) });
    await index.refresh();
    expect(counts.jobs).toBe(after + 1);
  });

  test("stored vectors are checked once per file version, not re-read on every refresh", async () => {
    fixture = await makeRoot();
    await meeting(fixture, "iota");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
      const body = await request.json() as { input: string[] };
      return Response.json({ embeddings: body.input.map((_text, index) => [1, index % 2, 0.5]) });
    } });
    servers.push(server);
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.ollamaUrl = `http://127.0.0.1:${server.port}`;
    config.assistant.embeddingModel = "fake-embed";
    const store = new IndexStore();
    const counts = counted(store);
    const index = new LibraryIndex(config, { store });
    expect(await index.refresh()).toMatchObject({ embedded: 1, embeddings: "ready" });
    const reads = counts.embeddings;
    expect(await index.refresh()).toMatchObject({ embedded: 0, embeddings: "ready" });
    expect(await index.refresh()).toMatchObject({ embedded: 0 });
    expect(counts.embeddings).toBe(reads);
    // A fresh process reads each vectors file once, then trusts its signature.
    const freshStore = new IndexStore();
    const freshCounts = counted(freshStore);
    const fresh = new LibraryIndex(config, { store: freshStore });
    expect(await fresh.refresh()).toMatchObject({ embedded: 0 });
    expect(freshCounts.embeddings).toBe(1);
    expect(await fresh.refresh()).toMatchObject({ embedded: 0 });
    expect(freshCounts.embeddings).toBe(1);
  });
});
