import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THREAD_ERRORS, type ThreadMessage, ThreadStore } from "../threads";

/** Deleting a meeting removes its conversations even when this version cannot validate them; bad ids are "not found". */

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
const message = (role: "user" | "assistant", text: string): ThreadMessage =>
  ({ role, text, citations: [], createdAt: "2026-10-25T12:00:00.000Z", destination: { label: "Ollama local", model: "qwen" } });

describe("removeThreadsForJob", () => {
  test("removes a thread of the deleted meeting that this version cannot validate", async () => {
    const threads = await store();
    const own = await threads.create({ scope: { kind: "meeting", jobId: A }, title: "Da reunião", destinationKey: KEY, messages: [message("user", "Quem decidiu?")] });
    const other = await threads.create({ scope: { kind: "meeting", jobId: B }, title: "Outra", destinationKey: KEY, messages: [message("user", "E aqui?")] });
    // Written by a newer version (unknown field) or damaged: it still quotes the meeting being deleted.
    for (const thread of [own, other]) {
      const path = join(threads.root, `${thread.id}.json`);
      const raw = JSON.parse(await fs.readFile(path, "utf8"));
      await fs.writeFile(path, JSON.stringify({ ...raw, version: 2, extra: { future: true } }), { mode: 0o600 });
      await expect(threads.read(thread.id)).rejects.toThrow(THREAD_ERRORS.invalid);
    }
    expect(await threads.removeThreadsForJob(A.toUpperCase())).toEqual({ removed: 1, scrubbed: 0 });
    await expect(fs.lstat(join(threads.root, `${own.id}.json`))).rejects.toThrow();
    // Another meeting's file and files that cannot be parsed at all are left as they are.
    expect((await fs.lstat(join(threads.root, `${other.id}.json`))).isFile()).toBe(true);
    const garbage = "7e3b529e-5c22-4802-97b8-f3e1a52c1919";
    await fs.writeFile(join(threads.root, `${garbage}.json`), "{oops", { mode: 0o600 });
    expect(await threads.removeThreadsForJob(B)).toEqual({ removed: 1, scrubbed: 0 });
    expect((await fs.lstat(join(threads.root, `${garbage}.json`))).isFile()).toBe(true);
  });

  test("never touches a shared-permission thread file, even of the deleted meeting", async () => {
    const threads = await store();
    const own = await threads.create({ scope: { kind: "meeting", jobId: A }, title: "Da reunião", destinationKey: KEY });
    const path = join(threads.root, `${own.id}.json`);
    await fs.chmod(path, 0o644);
    expect(await threads.removeThreadsForJob(A)).toEqual({ removed: 0, scrubbed: 0 });
    expect((await fs.lstat(path)).isFile()).toBe(true);
  });
});

describe("thread ids", () => {
  test("append and rename refuse a malformed id as not found", async () => {
    const threads = await store();
    for (const id of [undefined, 42, "../../etc", ""] as unknown as string[]) {
      await expect(threads.append(id, [message("user", "oi")])).rejects.toThrow(THREAD_ERRORS.notFound);
      await expect(threads.rename(id, "Nome")).rejects.toThrow(THREAD_ERRORS.notFound);
    }
  });
});
