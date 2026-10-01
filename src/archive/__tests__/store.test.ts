import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArchiveStore } from "../store";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp("/tmp/recording-archive-store-"); roots.push(root);
  const file = join(root, "meeting.mkv"); await fs.writeFile(file, "original video");
  return { root, file, store: new ArchiveStore(join(root, "catalog")) };
};

test("finalized media is durable without any processing job and repeated stop is idempotent", async () => {
  const { store, file } = await fixture();
  const id = randomUUID();
  const record = await store.enqueue(file, { id });
  expect(record.vaio.state).toBe("pending");
  expect(record.proton.state).toBe("pending");
  expect(record.source.sha256).toBeUndefined();
  await store.enqueue(file, { id });
  expect(await store.list()).toHaveLength(1);
  expect((await new ArchiveStore(store.stateDir).get(id))?.sourcePath).toBe(file);
});

test("a reused recording id cannot silently adopt changed media", async () => {
  const { store, file } = await fixture();
  const id = randomUUID(); await store.enqueue(file, { id });
  await fs.writeFile(file, "changed");
  await expect(store.enqueue(file, { id })).rejects.toThrow("changed");
  expect((await store.get(id))?.source.size).toBe(14);
});

test("catalog rejects symlinks and malformed identity before writing state", async () => {
  const { store, file, root } = await fixture();
  const link = join(root, "link.mkv"); await fs.symlink(file, link);
  await expect(store.enqueue(link)).rejects.toThrow("regular");
  await expect(store.enqueue(file, { id: "../../outside" })).rejects.toThrow();
  expect(await store.list()).toEqual([]);
});

test("sealing rejects changes after the stop event and retains pending state", async () => {
  const { store, file } = await fixture();
  const record = await store.enqueue(file);
  await fs.writeFile(file, "new recording content");
  await expect(store.seal(record.id)).rejects.toThrow("changed");
  expect((await store.get(record.id))?.source.sha256).toBeUndefined();
});

test("sealing persists checksum and uses one catalog entry across discovery retries", async () => {
  const { store, file } = await fixture();
  const first = await store.enqueue(file);
  const second = await store.enqueue(file);
  expect(first.id).toBe(second.id);
  const sealed = await store.seal(first.id);
  expect(sealed.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await fs.readFile(file, "utf8")).toBe("original video");
});

test("one damaged record does not prevent intact recordings from being backed up", async () => {
  const { store, file } = await fixture();
  const record = await store.enqueue(file);
  await fs.writeFile(join(store.stateDir, "unrelated.json"), "{}");
  const damagedPath = join(store.stateDir, `${randomUUID()}.json`);
  await fs.writeFile(damagedPath, "{");
  expect((await store.list()).map((item) => item.id)).toEqual([record.id]);
  expect(await fs.readFile(damagedPath, "utf8")).toBe("{");
});
