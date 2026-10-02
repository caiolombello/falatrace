import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { ArchiveStore } from "../store";
import { syncMediaArchive } from "../sync";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await fs.mkdtemp("/tmp/falatrace-archive-readiness-");
  roots.push(root);
  const sourcePath = join(root, "synthetic.mka");
  await fs.writeFile(sourcePath, "synthetic original bytes");
  const store = new ArchiveStore(join(root, "catalog"));
  const record = await store.enqueue(sourcePath);
  const config = mergeConfig(DEFAULT_CONFIG, { archive: { enabled: true } });
  return { root, sourcePath, store, record, config };
};

test("missing original remains failed with its identity retained and no destination call", async () => {
  const { sourcePath, store, record, config } = await fixture();
  await fs.rm(sourcePath);
  let destinationCalls = 0;
  const unexpected = async (): Promise<never> => { destinationCalls += 1; throw new Error("unexpected transfer"); };
  const [result] = await syncMediaArchive(config, {}, store, { vaio: unexpected, proton: unexpected });
  expect(destinationCalls).toBe(0);
  expect(result.vaio.state).toBe("failed");
  expect(result.proton.state).toBe("failed");
  expect(result.vaio.state === "failed" && result.vaio.error).toContain("ENOENT");
  expect(result.proton.state === "failed" && result.proton.error).toContain("ENOENT");
  const retained = (await store.get(record.id))!;
  expect(retained.id).toBe(record.id);
  expect(retained.sourcePath).toBe(sourcePath);
  expect(retained.source).toEqual(record.source);
  expect(await fs.exists(sourcePath)).toBe(false);
  expect((await store.list()).length).toBe(1);
});

test("a missing local source never invalidates a previously completed copy", async () => {
  const { sourcePath, store, record, config } = await fixture();
  const sealed = await store.seal(record.id);
  const completed = { state: "completed" as const, path: "/synthetic-archive/source.mka", verifiedAt: "2026-10-01T00:00:00.000Z" };
  sealed.proton = completed;
  await store.save(sealed);
  await fs.rm(sourcePath);
  let destinationCalls = 0;
  const unexpected = async (): Promise<never> => { destinationCalls += 1; throw new Error("unexpected transfer"); };
  const [result] = await syncMediaArchive(config, {}, store, { vaio: unexpected, proton: unexpected });
  expect(destinationCalls).toBe(0);
  expect(result.vaio.state).toBe("failed");
  expect(result.proton).toEqual(completed);
  const retained = (await store.get(record.id))!;
  expect(retained.source.sha256).toBe(sealed.source.sha256);
  expect(retained.proton).toEqual(completed);
});

test("missing original cannot stop a later available item in the same batch", async () => {
  const { root, sourcePath, store, record, config } = await fixture();
  config.archive.vaio = false;
  await fs.rm(sourcePath);
  const availablePath = join(root, "available.mka");
  const bytes = Buffer.from("other synthetic original");
  await fs.writeFile(availablePath, bytes);
  const available = await store.enqueue(availablePath);
  const calls: string[] = [];
  const results = await syncMediaArchive(config, { limit: 3 }, store, {
    proton: async (_config, media) => {
      calls.push(media.id);
      return { path: "/synthetic-archive/available.mka", verifiedAt: "2026-10-01T00:00:00.000Z" };
    }
  });
  expect(results.find((item) => item.id === record.id)?.proton.state).toBe("failed");
  expect(results.find((item) => item.id === available.id)?.proton.state).toBe("completed");
  expect(calls).toEqual([available.id]);
  expect(await fs.readFile(availablePath)).toEqual(bytes);
  expect((await store.list()).length).toBe(2);
});
