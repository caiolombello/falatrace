import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMarkers, THREAD_ERRORS, THREAD_LIMITS, type ThreadMessage, ThreadStore, validateThread } from "../threads";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const store = async (): Promise<ThreadStore> => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-threads-"));
  roots.push(root);
  return new ThreadStore(join(root, "assistant", "threads"));
};

const A = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
const B = "4e3b529e-5c22-4802-97b8-f3e1a52c1919";
const KEY = "d".repeat(64);
const at = new Date("2026-10-25T12:00:00.000Z");
const message = (role: "user" | "assistant", text: string, citations: ThreadMessage["citations"] = []): ThreadMessage =>
  ({ role, text, citations, createdAt: at.toISOString(), destination: { label: "Ollama local · qwen", model: "qwen3.5:9b" } });

describe("ThreadStore", () => {
  test("creates, reads, appends and lists threads privately", async () => {
    const threads = await store();
    expect(await threads.list()).toEqual([]);
    const created = await threads.create({ scope: { kind: "meeting", jobId: A }, title: "Decisões", destinationKey: KEY, now: at });
    expect((await fs.stat(threads.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(threads.root, `${created.id}.json`))).mode & 0o777).toBe(0o600);
    const updated = await threads.append(created.id, [message("user", "Quem decidiu?"),
      message("assistant", "A Ana [[s000001]].", [{ ref: "s000001", jobId: A, segmentId: "s000001", start: 3, end: 5, title: "Planejamento" }])],
    { destinationKey: "e".repeat(64), now: new Date("2026-10-25T12:05:00.000Z") });
    expect(updated.messages).toHaveLength(2);
    expect(updated.destinationKey).toBe("e".repeat(64));
    expect(await threads.read(created.id)).toEqual(updated);
    const library = await threads.create({ scope: { kind: "library" }, title: "Biblioteca", destinationKey: KEY, messages: [message("user", "oi"), message("assistant", "olá")], now: at });
    const all = await threads.list();
    expect(all.map((thread) => thread.id)).toEqual([created.id, library.id]);
    expect(all[0]).toMatchObject({ title: "Decisões", messageCount: 2, updatedAt: "2026-10-25T12:05:00.000Z" });
    expect((await threads.list({ scope: { kind: "library" } })).map((thread) => thread.id)).toEqual([library.id]);
    expect((await threads.list({ scope: { kind: "meeting", jobId: B } }))).toEqual([]);
    expect((await threads.rename(library.id, "  Novo\tnome ")).title).toBe("Novo nome");
    await expect(threads.rename(library.id, "   ")).rejects.toThrow(THREAD_ERRORS.title);
    await expect(threads.rename(library.id, "x".repeat(121))).rejects.toThrow(THREAD_ERRORS.title);
    await expect(threads.rename("6e3b529e-5c22-4802-97b8-f3e1a52c1919", "Nome")).rejects.toThrow(THREAD_ERRORS.notFound);
  });

  test("refuses to pass the message limit instead of trimming", async () => {
    const threads = await store();
    const full = Array.from({ length: THREAD_LIMITS.messages }, (_value, index) => message(index % 2 ? "assistant" : "user", `m${index}`));
    const thread = await threads.create({ scope: { kind: "library" }, title: "Cheia", destinationKey: KEY, messages: full });
    await expect(threads.append(thread.id, [message("user", "mais uma")])).rejects.toThrow(THREAD_ERRORS.full);
    expect((await threads.read(thread.id)).messages).toHaveLength(THREAD_LIMITS.messages);
  });

  test("concurrent appends are all kept", async () => {
    const threads = await store();
    const thread = await threads.create({ scope: { kind: "library" }, title: "Paralelo", destinationKey: KEY });
    await Promise.all(Array.from({ length: 6 }, (_value, index) => threads.append(thread.id, [message("user", `pergunta ${index}`)])));
    expect((await threads.read(thread.id)).messages.map((item) => item.text).sort()).toEqual(Array.from({ length: 6 }, (_value, index) => `pergunta ${index}`));
  });

  test("removes one thread, and every thread of a deleted meeting", async () => {
    const threads = await store();
    const own = await threads.create({ scope: { kind: "meeting", jobId: A }, title: "Da reunião", destinationKey: KEY });
    const other = await threads.create({ scope: { kind: "meeting", jobId: B }, title: "Outra", destinationKey: KEY });
    const library = await threads.create({ scope: { kind: "library" }, title: "Biblioteca", destinationKey: KEY, messages: [
      message("user", "Resumo?"),
      message("assistant", "Kickoff [[m1:s000001]] e retro [[m2:s000002]].", [
        { ref: "m1:s000001", jobId: A, segmentId: "s000001", title: "Kickoff" }, { ref: "m2:s000002", jobId: B, segmentId: "s000002", title: "Retro" }])
    ] });
    expect(await threads.removeThreadsForJob(A)).toEqual({ removed: 1, scrubbed: 1 });
    await expect(threads.read(own.id)).rejects.toThrow(THREAD_ERRORS.notFound);
    expect((await threads.read(other.id)).title).toBe("Outra");
    const scrubbed = await threads.read(library.id);
    expect(scrubbed.messages[1]!.citations.map((citation) => citation.jobId)).toEqual([B]);
    expect(scrubbed.messages[1]!.text).toBe("Kickoff e retro [[m2:s000002]].");
    expect(await threads.removeThreadsForJob(A)).toEqual({ removed: 0, scrubbed: 0 });
    expect(await threads.remove(other.id)).toBe(true);
    expect(await threads.remove(other.id)).toBe(false);
    await expect(threads.removeThreadsForJob("x")).rejects.toThrow();
  });

  test("validates every stored field and refuses unsafe files", async () => {
    const threads = await store();
    const thread = await threads.create({ scope: { kind: "library" }, title: "Ok", destinationKey: KEY, messages: [message("user", "oi")] });
    const path = join(threads.root, `${thread.id}.json`);
    const raw = JSON.parse(await fs.readFile(path, "utf8"));
    for (const mutate of [
      (value: any) => { value.version = 2; },
      (value: any) => { value.extra = true; },
      (value: any) => { value.scope = { kind: "meeting", jobId: "x" }; },
      (value: any) => { value.destinationKey = "short"; },
      (value: any) => { value.messages[0].role = "system"; },
      (value: any) => { value.messages[0].text = ""; },
      (value: any) => { value.messages[0].text = "a\u0000b"; },
      (value: any) => { value.messages[0].citations = [{ ref: "x", jobId: A, segmentId: "s000001", title: "" }]; },
      (value: any) => { value.messages[0].recipeId = "Bad Id"; },
      (value: any) => { value.messages = new Array(201).fill(raw.messages[0]); }
    ]) {
      const value = structuredClone(raw);
      mutate(value);
      expect(() => validateThread(value)).toThrow(THREAD_ERRORS.invalid);
    }
    await fs.writeFile(path, "{oops", { mode: 0o600 });
    await expect(threads.read(thread.id)).rejects.toThrow(THREAD_ERRORS.invalid);
    expect(await threads.list()).toEqual([]);
    await fs.writeFile(path, JSON.stringify({ ...raw, id: B }), { mode: 0o600 });
    await expect(threads.read(thread.id)).rejects.toThrow(THREAD_ERRORS.invalid);
    await fs.rm(path);
    const outside = join(threads.root, "..", "outside.json");
    await fs.writeFile(outside, JSON.stringify(raw), { mode: 0o600 });
    await fs.symlink(outside, path);
    await expect(threads.read(thread.id)).rejects.toThrow(THREAD_ERRORS.unsafe);
    await fs.rm(path);
    await fs.writeFile(path, JSON.stringify(raw), { mode: 0o644 });
    await expect(threads.read(thread.id)).rejects.toThrow(THREAD_ERRORS.unsafe);
    await fs.chmod(threads.root, 0o755);
    await expect(threads.list()).rejects.toThrow(THREAD_ERRORS.unsafe);
    await expect(threads.read("../../etc")).rejects.toThrow(THREAD_ERRORS.notFound);
  });

  test("appendOrCreate creates a new conversation once and appends after", async () => {
    const threads = await store();
    const id = "6e3b529e-5c22-4802-97b8-f3e1a52c1919";
    // Two answers of a brand-new conversation finishing together.
    await Promise.all([
      threads.appendOrCreate({ id, scope: { kind: "meeting", jobId: A }, title: "Primeira", destinationKey: KEY, messages: [message("user", "p1"), message("assistant", "r1")], now: at }),
      threads.appendOrCreate({ id, scope: { kind: "meeting", jobId: A }, title: "Segunda", destinationKey: "e".repeat(64), messages: [message("user", "p2"), message("assistant", "r2")], now: at })
    ]);
    const thread = await threads.read(id.toUpperCase());
    expect(thread.messages.map((item) => item.text).sort()).toEqual(["p1", "p2", "r1", "r2"]);
    expect(["Primeira", "Segunda"]).toContain(thread.title);
    await expect(threads.appendOrCreate({ id, scope: { kind: "library" }, title: "x", destinationKey: KEY, messages: [message("user", "p3")] }))
      .rejects.toThrow(THREAD_ERRORS.otherScope);
    await expect(threads.appendOrCreate({ id, scope: { kind: "meeting", jobId: A }, title: "x", destinationKey: KEY,
      messages: Array.from({ length: THREAD_LIMITS.messages }, () => message("user", "x")) })).rejects.toThrow(THREAD_ERRORS.full);
    await expect(threads.appendOrCreate({ id: "../x", scope: { kind: "library" }, title: "x", destinationKey: KEY, messages: [] })).rejects.toThrow(THREAD_ERRORS.notFound);
    const blank = await threads.appendOrCreate({ id: "7e3b529e-5c22-4802-97b8-f3e1a52c1919", scope: { kind: "library" }, title: "   ", destinationKey: KEY, messages: [message("user", "oi")] });
    expect(blank.title).toBe("Conversa");
    await expect(threads.create({ id, scope: { kind: "meeting", jobId: A }, title: "dup", destinationKey: KEY })).rejects.toThrow(THREAD_ERRORS.exists);
  });

  test("removeMarkers keeps the sentence readable", () => {
    const gone = new Set(["m1:s000001"]);
    expect(removeMarkers("Kickoff [[m1:s000001]] e retro.", gone)).toBe("Kickoff e retro.");
    expect(removeMarkers("Kickoff [[m1:s000001]].", gone)).toBe("Kickoff.");
    expect(removeMarkers("Kickoff [[m1:s000001]][[m2:s000002]].", gone)).toBe("Kickoff [[m2:s000002]].");
    expect(removeMarkers("Kickoff [[m1:s000001]]depois", gone)).toBe("Kickoff depois");
    expect(removeMarkers("a[[m1:s000001]] b", gone)).toBe("a b");
    expect(removeMarkers("fica [[m2:s000001]] e [[s000001]]", gone)).toBe("fica [[m2:s000001]] e [[s000001]]");
  });

  test("a busy lock is reported, not waited on forever", async () => {
    const threads = new ThreadStore(join(await fs.mkdtemp(join(tmpdir(), "falatrace-threads-")), "t"), {
      lockWaitMs: 30, acquireLock: async (name) => { throw new Error(`${name} is already running`); }
    });
    roots.push(join(threads.root, ".."));
    await expect(threads.create({ scope: { kind: "library" }, title: "x", destinationKey: KEY })).rejects.toThrow(THREAD_ERRORS.busy);
  });
});
