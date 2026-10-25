import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeVector } from "../embeddings";
import { IndexStore, INDEX_STORE_UNSAFE, type StoredJobIndex, validateJobFacts, validateStoredEmbeddings, validateStoredJobIndex } from "../store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const temp = async (): Promise<string> => { const root = await fs.mkdtemp(join(tmpdir(), "falatrace-store-")); roots.push(root); return root; };

const JOB = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
const entry = (): StoredJobIndex => ({
  version: 1,
  probe: "1".repeat(64),
  facts: {
    version: 1, jobId: JOB, mediaSha256: "a".repeat(64), sourcePath: "/m/meeting.mkv", title: "Planejamento", date: "2026-10-01T13:00:00.000Z",
    durationSeconds: 120, fingerprint: "2".repeat(64), transcriptArtifactSha256: "3".repeat(64), revision: 0,
    speakers: [{ speakerId: "S01", label: "Ana", confirmed: true }], attendees: [{ name: "Bruno", self: false }],
    calendar: { title: "Planejamento", recurring: true }, clients: [{ code: "CL001", name: "Acme", source: "manual", confidence: 1 }],
    overview: "Visão geral", topics: ["Escopo"], decisions: [{ index: 0, text: "Adiar", segmentIds: ["s000001"] }],
    actions: [{ index: 0, text: "Enviar proposta", owner: "Ana", dueDate: "sexta", segmentIds: [], origin: "model" }], noteCount: 0
  },
  chunks: [{ chunkId: `${JOB}:s000000-s000001`, jobId: JOB, kind: "segments", segmentIds: ["s000000", "s000001"], start: 0, end: 9, speakers: ["Ana"], text: "um\ndois" }],
  segments: [{ id: "s000000", start: 0, end: 4, speaker: "Ana" }, { id: "s000001", start: 5, end: 9 }]
});

describe("validators", () => {
  test("accept a well-formed entry and rebuild it field by field", () => {
    const value = validateStoredJobIndex(JSON.parse(JSON.stringify(entry())));
    expect(value).toEqual(entry());
  });

  test("reject unknown keys, wrong versions and malformed fields", () => {
    const cases: Array<(value: any) => void> = [
      (value) => { value.extra = 1; },
      (value) => { value.version = 2; },
      (value) => { value.facts.version = 2; },
      (value) => { value.facts.jobId = "not-a-uuid"; },
      (value) => { value.facts.mediaSha256 = "xyz"; },
      (value) => { value.facts.date = "yesterday"; },
      (value) => { value.facts.title = ""; },
      (value) => { value.facts.title = "a\u0007b"; },
      (value) => { value.facts.speakers = [{ speakerId: "S01", label: "Ana" }]; },
      (value) => { value.facts.clients = [{ code: "bad code!", name: "x", source: "manual", confidence: 1 }]; },
      (value) => { value.facts.clients = [{ code: "CL1", name: "x", source: "guess", confidence: 1 }]; },
      (value) => { value.facts.clients = [{ code: "CL1", name: "x", source: "manual", confidence: 2 }]; },
      (value) => { value.facts.decisions = [{ index: 0, text: "x", segmentIds: ["seg1"] }]; },
      (value) => { value.facts.actions[0].origin = "ai"; },
      (value) => { value.facts.topics = new Array(51).fill("t"); },
      (value) => { value.facts.secret = "x"; },
      (value) => { value.chunks[0].jobId = "4e3b529e-5c22-4802-97b8-f3e1a52c1919"; },
      (value) => { value.chunks[0].chunkId = "other:s000000"; },
      (value) => { value.chunks[0].kind = "video"; },
      (value) => { value.chunks[0].text = "x".repeat(4_001); },
      (value) => { value.chunks.push({ ...value.chunks[0] }); },
      (value) => { value.segments[0].start = -1; },
      (value) => { value.segments[0].id = "s1"; },
      (value) => { value.probe = "short"; }
    ];
    for (const mutate of cases) {
      const value = JSON.parse(JSON.stringify(entry()));
      mutate(value);
      expect(() => validateStoredJobIndex(value)).toThrow();
    }
  });

  test("a source path may hold any character but NUL", () => {
    expect(validateJobFacts({ ...entry().facts, sourcePath: "/m/reunião\n[1].mkv" }).sourcePath).toBe("/m/reunião\n[1].mkv");
    expect(() => validateJobFacts({ ...entry().facts, sourcePath: "/m/a\u0000b" })).toThrow();
    expect(() => validateJobFacts({ ...entry().facts, sourcePath: "" })).toThrow();
    expect(() => validateJobFacts({ ...entry().facts, sourcePath: "x".repeat(4_097) })).toThrow();
  });

  test("facts allow tabs and line breaks only where text is multi-line", () => {
    const value = JSON.parse(JSON.stringify(entry()));
    value.chunks[0].text = "linha 1\nlinha 2\tfim";
    expect(validateStoredJobIndex(value).chunks[0]!.text).toContain("\n");
    expect(() => validateJobFacts({ ...entry().facts, overview: "a\u0000b" })).toThrow();
  });

  test("embeddings need consistent base64 vectors", () => {
    const vector = encodeVector(new Float32Array([0.5, 0.25, 1]));
    expect(validateStoredEmbeddings({ version: 1, model: "m", dims: 3, fingerprint: "2".repeat(64), vectors: [vector] }).vectors).toEqual([vector]);
    expect(() => validateStoredEmbeddings({ version: 1, model: "m", dims: 4, fingerprint: "2".repeat(64), vectors: [vector] })).toThrow();
    expect(() => validateStoredEmbeddings({ version: 1, model: "m", dims: 0, fingerprint: "2".repeat(64), vectors: [] })).toThrow();
    expect(() => validateStoredEmbeddings({ version: 1, model: "", dims: 3, fingerprint: "2".repeat(64), vectors: [] })).toThrow();
    expect(() => validateStoredEmbeddings({ model: "m", dims: 3, fingerprint: "2".repeat(64), vectors: [] })).toThrow();
  });
});

describe("IndexStore", () => {
  test("round trip with private directories and files", async () => {
    const root = join(await temp(), "knowledge-index");
    const store = new IndexStore(root);
    expect(await store.listJobIds()).toEqual([]);
    expect(await store.readJob(JOB)).toBeUndefined();
    await store.writeJob(entry());
    expect(await store.listJobIds()).toEqual([JOB]);
    const read = await store.readJob(JOB);
    expect(read?.entry).toEqual(entry());
    for (const path of [root, store.jobsDir, store.embeddingsDir]) expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(store.jobsDir, `${JOB}.json`))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(store.jobsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const signature = await store.signature(JOB);
    expect(signature?.size).toBe(read?.signature.size);
    await store.removeJob(JOB);
    expect(await store.readJob(JOB)).toBeUndefined();
    await store.removeJob(JOB);
  });

  test("ignores stray files and refuses invalid job ids", async () => {
    const store = new IndexStore(join(await temp(), "idx"));
    await store.ensure();
    await fs.writeFile(join(store.jobsDir, "notes.txt"), "x");
    await fs.writeFile(join(store.jobsDir, "abc.json"), "{}");
    expect(await store.listJobIds()).toEqual([]);
    await expect(store.readJob("../../etc/passwd")).rejects.toThrow("Identificador de gravação inválido.");
    await expect(store.removeJob("x")).rejects.toThrow();
  });

  test("refuses symbolic links, shared permissions and oversized or corrupt files", async () => {
    const base = await temp();
    const store = new IndexStore(join(base, "idx"));
    await store.writeJob(entry());
    const path = join(store.jobsDir, `${JOB}.json`);
    await fs.chmod(path, 0o644);
    await expect(store.readJob(JOB)).rejects.toThrow(INDEX_STORE_UNSAFE);
    await fs.chmod(path, 0o600);
    const outside = join(base, "outside.json");
    await fs.writeFile(outside, JSON.stringify(entry()), { mode: 0o600 });
    await fs.rm(path);
    await fs.symlink(outside, path);
    await expect(store.readJob(JOB)).rejects.toThrow(INDEX_STORE_UNSAFE);
    await fs.rm(path);
    await fs.writeFile(path, "{not json", { mode: 0o600 });
    await expect(store.readJob(JOB)).rejects.toThrow("inválido");
    const other = JSON.parse(JSON.stringify(entry()));
    other.facts.jobId = "4e3b529e-5c22-4802-97b8-f3e1a52c1919";
    other.chunks = [];
    await fs.writeFile(path, JSON.stringify(other), { mode: 0o600 });
    await expect(store.readJob(JOB)).rejects.toThrow("inválido");
  });

  test("refuses a shared or linked index directory", async () => {
    const base = await temp();
    const store = new IndexStore(join(base, "idx"));
    await store.ensure();
    await fs.chmod(store.root, 0o755);
    await expect(store.listJobIds()).rejects.toThrow(INDEX_STORE_UNSAFE);
    await expect(store.writeJob(entry())).rejects.toThrow(INDEX_STORE_UNSAFE);
    const real = join(base, "real");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, join(base, "linked"));
    await expect(new IndexStore(join(base, "linked")).listJobIds()).rejects.toThrow(INDEX_STORE_UNSAFE);
  });

  test("never writes an invalid entry", async () => {
    const store = new IndexStore(join(await temp(), "idx"));
    const bad = entry() as any;
    bad.facts.title = "";
    await expect(store.writeJob(bad)).rejects.toThrow();
    expect(await store.listJobIds()).toEqual([]);
  });

  test("tombstones are private markers listed by job id", async () => {
    const base = await temp();
    const store = new IndexStore(join(base, "idx"));
    expect(await store.listTombstones()).toEqual(new Map());
    expect(await store.tombstone(JOB)).toBeUndefined();
    await store.writeTombstone(JOB.toUpperCase());
    const path = join(store.tombstonesDir, JOB);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(store.tombstonesDir)).mode & 0o777).toBe(0o700);
    expect(await store.tombstone(JOB)).toBeGreaterThan(0);
    await fs.writeFile(join(store.tombstonesDir, "not-a-job"), "");
    await fs.symlink(path, join(store.tombstonesDir, "4e3b529e-5c22-4802-97b8-f3e1a52c1919"));
    expect([...(await store.listTombstones()).keys()]).toEqual([JOB]);
    await store.removeTombstone(JOB);
    expect(await store.tombstone(JOB)).toBeUndefined();
    await expect(store.writeTombstone("../x")).rejects.toThrow("Identificador de gravação inválido.");
    await fs.chmod(store.tombstonesDir, 0o777);
    await expect(store.listTombstones()).rejects.toThrow(INDEX_STORE_UNSAFE);
  });

  test("lists embeddings files by job id", async () => {
    const store = new IndexStore(join(await temp(), "idx"));
    expect(await store.listEmbeddingIds()).toEqual([]);
    await store.writeEmbeddings(JOB, { version: 1, model: "m", dims: 1, fingerprint: "2".repeat(64), vectors: [encodeVector(new Float32Array([1]))] });
    await fs.writeFile(join(store.embeddingsDir, "stray.json"), "{}");
    expect(await store.listEmbeddingIds()).toEqual([JOB]);
  });

  test("embeddings round trip", async () => {
    const store = new IndexStore(join(await temp(), "idx"));
    const value = { version: 1 as const, model: "m", dims: 2, fingerprint: "2".repeat(64), vectors: [encodeVector(new Float32Array([1, 0]))] };
    expect(await store.readEmbeddings(JOB)).toBeUndefined();
    await store.writeEmbeddings(JOB, value);
    expect((await store.readEmbeddings(JOB))?.value).toEqual(value);
    expect(await store.embeddingsSignature(JOB)).toBeDefined();
    await store.removeEmbeddings(JOB);
    expect(await store.readEmbeddings(JOB)).toBeUndefined();
  });
});
