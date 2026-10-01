import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { ArchiveStore } from "../store";
import { sealedArchiveMedia, syncMediaArchive } from "../sync";
import { archiveMediaToProton, restoreProtonMedia, type MediaBackupClient } from "../proton";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp("/tmp/recording-archive-proton-"); roots.push(root);
  const file = join(root, "meeting.mkv"); await fs.writeFile(file, "original video");
  const store = new ArchiveStore(join(root, "catalog"));
  const record = await store.enqueue(file); const media = sealedArchiveMedia(await store.seal(record.id));
  const config = mergeConfig(DEFAULT_CONFIG, { archive: { enabled: true }, proton: { targetFolder: "/my-files/RecordingArchive" } });
  const remote = new Map<string, Buffer>(); let uploads = 0; let downloads = 0;
  const client: MediaBackupClient = {
    async ensureFolder() {},
    async list(path) { return [...remote].filter(([name]) => name.startsWith(`${path}/`)).map(([name, bytes]) => ({ type: "file", name: basename(name), activeRevision: { claimedSize: bytes.length } })); },
    async uploadImmutable(paths, parent) {
      for (const path of paths) { const key = `${parent}/${basename(path)}`; if (!remote.has(key)) { remote.set(key, await fs.readFile(path)); uploads += 1; } }
    },
    async download(paths, destination) {
      for (const path of paths) { const bytes = remote.get(path); if (!bytes) throw new Error("missing object"); await fs.writeFile(join(destination, basename(path)), bytes, { flag: "wx" }); downloads += 1; }
    }
  };
  return { root, file, store, media, config, client, remote, counts: () => ({ uploads, downloads }) };
};

test("a backup is completed only after restoring both original and manifest", async () => {
  const { root, file, media, config, client, counts } = await fixture();
  const result = await archiveMediaToProton(config, media, client, join(root, "data"));
  expect(result.verifiedAt).toBeTruthy(); expect(counts()).toEqual({ uploads: 2, downloads: 2 });
  await archiveMediaToProton(config, media, client, join(root, "data"));
  expect(counts().uploads).toBe(2);
  const restored = await restoreProtonMedia(config, media, client, join(root, "data"));
  expect(await fs.readFile(restored)).toEqual(await fs.readFile(file));
  const before = counts().downloads;
  await restoreProtonMedia(config, media, client, join(root, "data"));
  expect(counts().downloads).toBe(before);
  await fs.writeFile(restored, "damaged cache");
  expect(await restoreProtonMedia(config, media, client, join(root, "data"))).toBe(restored);
  expect(await fs.readFile(restored)).toEqual(await fs.readFile(file));
  expect(counts().downloads).toBe(before + 1);
});

test("equal remote size with a wrong checksum never counts as a successful backup", async () => {
  const { root, media, config, client, remote } = await fixture();
  await archiveMediaToProton(config, media, client, join(root, "data"));
  const key = [...remote.keys()].find((name) => name.endsWith("source.mkv"))!;
  remote.set(key, Buffer.from("corrupted data"));
  await expect(archiveMediaToProton(config, media, client, join(root, "data"))).rejects.toThrow("SHA-256");
  expect(remote.get(key)?.toString()).toBe("corrupted data");
});

test("cloud copies succeed when VAIO is offline and a retry only sends the failed destination", async () => {
  const { store, config, media } = await fixture();
  let vaioCalls = 0; let protonCalls = 0;
  const dependencies = {
    vaio: async () => { vaioCalls += 1; if (vaioCalls === 1) throw new Error("offline"); return { archiveDir: "/archive", archiveRelative: `media/2026/09/${media.id}`, sourcePath: "/archive/source.mkv", size: media.source.size, sha256: media.source.sha256, verifiedAt: new Date().toISOString() }; },
    proton: async () => { protonCalls += 1; return { path: "/my-files/source.mkv", verifiedAt: new Date().toISOString() }; }
  };
  const [first] = await syncMediaArchive(config, {}, store, dependencies);
  expect(first.vaio.state).toBe("failed"); expect(first.proton.state).toBe("completed");
  const [second] = await syncMediaArchive(config, {}, store, dependencies);
  expect(second.vaio.state).toBe("completed"); expect(protonCalls).toBe(1); expect(vaioCalls).toBe(2);
  expect(await syncMediaArchive(config, {}, store, dependencies)).toEqual([]);
});

test("a VAIO-only original is materialized for Proton and the temporary download is removed", async () => {
  const { root, file, store, config, media } = await fixture();
  const record = (await store.get(media.id))!;
  record.vaio = { state: "completed", path: "/archive/source.mkv", archiveRelative: `2026/09/${media.id}`, verifiedAt: new Date().toISOString() };
  await store.save(record);
  const bytes = await fs.readFile(file); await fs.rm(file);
  let scratchPath = "";
  const [result] = await syncMediaArchive(config, {}, store, {
    dataDir: join(root, "data"),
    downloadVaio: async (_config, _reference, path) => { scratchPath = path; await fs.writeFile(path, bytes); return { ..._reference, archiveDir: "/archive", sourcePath: "/archive/source.mkv", verifiedAt: new Date().toISOString(), destinationPath: path }; },
    proton: async (_config, source) => {
      expect(await fs.readFile(source.sourcePath)).toEqual(bytes);
      expect(source.source.sha256).toBe(media.source.sha256);
      return { path: "/my-files/source.mkv", verifiedAt: new Date().toISOString() };
    }
  });
  expect(result.proton.state).toBe("completed");
  expect(await fs.exists(scratchPath)).toBe(false);
  expect(await fs.exists(file)).toBe(false);
});

test("bounded batches progress past recent failures and rotate later retries", async () => {
  const { root, store, config, media } = await fixture();
  config.archive.vaio = false;
  const olderFile = join(root, "older.mkv"); await fs.writeFile(olderFile, "older video");
  const older = await store.enqueue(olderFile, { createdAt: "2025-01-01T00:00:00.000Z" });
  const attempted: string[] = [];
  const dependencies = { proton: async (_config: typeof config, input: typeof media): Promise<{path:string;verifiedAt:string}> => { attempted.push(input.id); throw new Error("offline"); } };
  await syncMediaArchive(config, { limit: 1 }, store, dependencies);
  await syncMediaArchive(config, { limit: 1 }, store, dependencies);
  await syncMediaArchive(config, { limit: 1 }, store, dependencies);
  expect(attempted).toEqual([media.id, older.id, media.id]);
});

test("concurrent syncs of the same catalog cannot upload the same original twice", async () => {
  const { store, config } = await fixture(); config.archive.vaio = false;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const dependencies = { proton: async () => {
    entered(); await held; return { path: "/my-files/source.mkv", verifiedAt: new Date().toISOString() };
  } };
  const first = syncMediaArchive(config, {}, store, dependencies);
  await started;
  try { await expect(syncMediaArchive(config, {}, store, dependencies)).rejects.toThrow("already running"); }
  finally { release(); await first; }
});
