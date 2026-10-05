import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "./bridge";
import { readLibrarySnapshot, writeLibrarySnapshot } from "./library-snapshot";

test("library snapshot round-trips privately and rejects malformed or foreign content", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "library-snapshot-"));
  const path = join(root, "snapshot.json");
  try {
    expect(await readLibrarySnapshot(path)).toBeUndefined();
    await writeLibrarySnapshot([{ key: "/synthetic/a.mkv", title: "Gravação" }], path);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await readLibrarySnapshot(path))?.items).toEqual([{ key: "/synthetic/a.mkv", title: "Gravação" }]);
    for (const value of [{ version: 2, savedAt: "x", items: [] }, { version: 1, savedAt: "x", items: [{ title: "no key" }] }, "not json"]) {
      await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
      expect(await readLibrarySnapshot(path)).toBeUndefined();
    }
    await fs.rm(path);
    await fs.symlink(join(root, "elsewhere"), path);
    expect(await readLibrarySnapshot(path)).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("list-cached is a payload-free operation", () => {
  expect(parseRequest({ id: 1, op: "list-cached" }).op).toBe("list-cached");
  expect(() => parseRequest({ id: 1, op: "list-cached", payload: { query: "x" } })).toThrow("payload inválido");
});
