import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { cleanupRemoteServer } from "../retention";

test("retention preserves failed media, unknown files, nested files and links while removing disposable empty failures", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-retention-safe-"));
  const ids = [0,1,2,3,4].map((n) => `123e4567-e89b-42d3-a456-42661417400${n}`);
  const now = Date.now(); const old = new Date(now - 40 * 86400000);
  try {
    for (const id of ids) await fs.mkdir(join(root, "failed", id), { recursive: true });
    await fs.writeFile(join(root, "failed", ids[0], "source.mkv"), "synthetic original");
    await fs.writeFile(join(root, "failed", ids[1], "unrecognized.bin"), "preserve");
    await fs.mkdir(join(root, "failed", ids[2], "nested"));
    await fs.writeFile(join(root, "failed", ids[2], "nested", "source.wav"), "original");
    await fs.symlink(join(root, "failed", ids[0], "source.mkv"), join(root, "failed", ids[3], "summary.json"));
    for (const id of ids) await fs.utimes(join(root, "failed", id), old, old);
    const config = structuredClone(DEFAULT_CONFIG); config.retention.remoteFailuresDays = 30;
    const dry = await cleanupRemoteServer(config, { serverRoot: root, now, dryRun: true });
    expect(dry.remoteFailures).toBe(1);
    expect(await fs.readdir(join(root, "failed"))).toHaveLength(5);
    const report = await cleanupRemoteServer(config, { serverRoot: root, now });
    expect(report.remoteFailures).toBe(1);
    expect(await fs.readFile(join(root, "failed", ids[0], "source.mkv"), "utf8")).toBe("synthetic original");
    for (const id of ids.slice(0,4)) expect((await fs.stat(join(root, "failed", id))).isDirectory()).toBe(true);
    expect(await fs.stat(join(root, "failed", ids[4])).catch(() => null)).toBeNull();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
