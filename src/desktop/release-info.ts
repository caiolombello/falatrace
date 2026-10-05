import { basename, dirname, join } from "node:path";
import { readBoundedArtifact } from "../jobs/transcript-access";

export type ReleaseInfo = { name: string; commit: string };

/** Installed releases keep manifest.json beside the executable. Source runs (bun) have none.
 * Display only: identifies which build is running; never used for trust decisions. */
export const readReleaseInfo = async (executable = process.execPath): Promise<ReleaseInfo | undefined> => {
  try {
    const directory = dirname(executable);
    const manifest = JSON.parse(await readBoundedArtifact(join(directory, "manifest.json"), 64 * 1024));
    const name = basename(directory);
    if (typeof manifest?.commit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.commit) || !/^[\w.+-]{1,120}$/.test(name)) return undefined;
    return { name, commit: manifest.commit.slice(0, 7) };
  } catch { return undefined; }
};
