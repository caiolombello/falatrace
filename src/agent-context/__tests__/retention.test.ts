import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAccess } from "../access";
import { AgentRetrieval } from "../retrieval";
import { RecordingCatalog } from "../source";
import { VisualAppBudget } from "../../visual/app-budget";
import { writeRemovedTombstone } from "../../media-retention/__tests__/fixture";

const policy = { maxPreviews: 3, maxInferences: 1, period: "lifetime" as const };

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agent-context-retention-"));
  const path = join(root, "recordings", "synthetic.mp4"), id = randomUUID(), bytes = Buffer.from("synthetic media bytes");
  await fs.mkdir(join(root, "recordings"), { recursive: true });
  await fs.writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const job = { id, sourcePath: path, source: { sha256, size: bytes.length, originalName: "Synthetic" } };
  const jobs = { get: async (key: string) => { if (key !== id) throw Object.assign(Error("missing"), { code: "ENOENT" }); return job; } };
  const catalog = new RecordingCatalog(jobs as never, { get: async () => null } as never);
  const access = new ContextAccess(join(root, "access"));
  const recipient = { kind: "agent" as const, id: "synthetic-agent" };
  let decodes = 0;
  const retrieval = new AgentRetrieval(access, catalog, new VisualAppBudget(join(root, "visual-review"), async () => policy),
    async () => { decodes += 1; throw new Error("decode must not run"); });
  return { root, path, id, job, catalog, access, recipient, retrieval, decodes: () => decodes };
};

test("media removed by retention keeps the recording's context binding and omits frames with a reason", async () => {
  const f = await fixture();
  try {
    const grant = await f.access.authorize({ consent: true, recipient: f.recipient, scope: { kind: "recordings", sources: await f.catalog.snapshot([f.id]) }, data: ["context", "frames"], limits: { cacheTtlMs: 1000 } });
    await writeRemovedTombstone(f.job);
    await fs.rm(f.path);
    const current = await f.catalog.get(f.id);
    expect(current).toMatchObject({ id: f.id, path: f.path, sha256: f.job.source.sha256, mediaRemoved: true });
    // The binding is validated against the tombstone, not by hashing a file that is gone.
    expect((await f.catalog.validate({ id: f.id, path: f.path, sha256: f.job.source.sha256 })).mediaRemoved).toBe(true);
    const frames = await f.retrieval.getFrames({ grantId: grant.id, recipient: f.recipient, recordingId: f.id, timestamps: [0.5], supportsImages: true },
      { policy, admission: { policy: { pause: "off", unknown: "wait" } } });
    expect(frames.frames).toEqual([]);
    expect(frames.omissions).toEqual([{ recordingId: f.id, reason: "media-removed-by-retention" }]);
    expect(f.decodes()).toBe(0);
    const search = await f.retrieval.search({ grantId: grant.id, recipient: f.recipient, query: "synthetic" }, { admission: { policy: { pause: "off", unknown: "wait" } } });
    expect(search.items).toEqual([{ recordingId: f.id, title: "Synthetic", mediaHash: f.job.source.sha256 }]);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("missing media without a tombstone, or with one for other media, is still refused", async () => {
  const f = await fixture();
  try {
    await fs.rm(f.path);
    await expect(f.catalog.get(f.id)).rejects.toThrow();
    await writeRemovedTombstone({ ...f.job, source: { ...f.job.source, sha256: "0".repeat(64) } });
    await expect(f.catalog.get(f.id)).rejects.toThrow();
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("present media keeps its binding unchanged", async () => {
  const f = await fixture();
  try {
    expect(await f.catalog.get(f.id)).toEqual({ id: f.id, path: f.path, sha256: f.job.source.sha256, title: "Synthetic", job: true });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
