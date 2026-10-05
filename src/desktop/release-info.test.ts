import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReleaseInfo } from "./release-info";

test("release info comes from the manifest beside the executable and rejects malformed content", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "release-info-"));
  const release = join(root, "v0.2.0-alpha.11-pr1-7b36444");
  try {
    await fs.mkdir(release);
    expect(await readReleaseInfo(join(release, "falatrace"))).toBeUndefined();
    await fs.writeFile(join(release, "manifest.json"), JSON.stringify({ version: "0.2.0-alpha.11", commit: "7b36444".padEnd(40, "0") }));
    expect(await readReleaseInfo(join(release, "falatrace"))).toEqual({ name: "v0.2.0-alpha.11-pr1-7b36444", commit: "7b36444" });
    await fs.writeFile(join(release, "manifest.json"), JSON.stringify({ commit: "not-a-commit" }));
    expect(await readReleaseInfo(join(release, "falatrace"))).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
