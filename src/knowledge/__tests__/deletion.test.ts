import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import { buildLibrary, deleteRecording } from "../../tui/library";
import { assertFreshAiContext, clearContextInvalidation, invalidateAiContext, readContextInvalidation, aiContextRoot } from "../invalidation";

test("local deletion reports preserved remote scope and blocks stale compact context without deleting external copies", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-delete-scope-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const config = structuredClone(DEFAULT_CONFIG); config.recordingsDir = join(root, "recordings");
    await fs.mkdir(config.recordingsDir); const media = join(config.recordingsDir, "synthetic.mkv"); await fs.writeFile(media, "synthetic original");
    const store = new JobStore(join(root, "jobs"), join(root, "data")); await store.enqueue(config, media);
    const memory = aiContextRoot(); await fs.mkdir(join(memory, "clients"), { recursive: true });
    await fs.writeFile(join(memory, "clients/CL001.md"), "old derived context");
    const remoteFixture = join(root, "external-copy.mkv"); await fs.writeFile(remoteFixture, "preserve remote simulation");
    const [entry] = await buildLibrary(config, store); const result = await deleteRecording(config, entry, store, join(root, "trash"));
    expect(result.scope.remoteCopies).toBe("preserved-not-contacted");
    expect(result.scope.archiveCatalog).toBe("preserved");
    expect(result.scope.externalExports).toBe("not-controlled");
    expect(result.scope.aiContext).toBe("invalidated");
    await expect(assertFreshAiContext(memory)).rejects.toThrow("invalidado");
    expect(await fs.readFile(remoteFixture, "utf8")).toBe("preserve remote simulation");
    expect(await fs.readFile(result.trashedPaths[0], "utf8")).toBe("synthetic original");
    const before = await readContextInvalidation(memory);
    await invalidateAiContext(memory);
    await clearContextInvalidation(memory, before);
    await expect(assertFreshAiContext(memory)).rejects.toThrow("invalidado");
    const current = await readContextInvalidation(memory);
    await clearContextInvalidation(memory, current);
    await expect(assertFreshAiContext(memory)).resolves.toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing context does not create state and symlink context is reported as failed without following it", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-context-link-"));
  try {
    expect(await invalidateAiContext(join(root, "missing"))).toBe("not-found");
    const target = join(root, "target"); await fs.mkdir(target); await fs.symlink(target, join(root, "link"));
    expect(await invalidateAiContext(join(root, "link"))).toBe("failed");
    await expect(assertFreshAiContext(join(root, "link"))).rejects.toThrow("Unsafe AI context directory");
    expect(await fs.readdir(target)).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed memory invalidation blocks deletion before media or job changes", async () => {
 const root=await fs.mkdtemp(join(tmpdir(),"delete-invalidation-failure-"));const previous=process.env.XDG_STATE_HOME;process.env.XDG_STATE_HOME=join(root,"state");
 try {
  const config=structuredClone(DEFAULT_CONFIG);config.recordingsDir=join(root,"recordings");await fs.mkdir(config.recordingsDir);const media=join(config.recordingsDir,"synthetic.mkv");await fs.writeFile(media,"preserve source");
  const store=new JobStore(join(root,"jobs"),join(root,"data"));await store.enqueue(config,media);const [entry]=await buildLibrary(config,store);
  const memory=aiContextRoot();await fs.mkdir(join(memory,".."),{recursive:true});const target=join(root,"external-memory");await fs.mkdir(target);await fs.symlink(target,memory);
  await expect(deleteRecording(config,entry,store,join(root,"trash"))).rejects.toThrow("deletion cancelled");
  expect(await fs.readFile(media,"utf8")).toBe("preserve source");expect((await store.list()).length).toBe(1);expect(await fs.readdir(target)).toEqual([]);
 }finally {if(previous===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=previous;await fs.rm(root,{recursive:true,force:true});}
});
