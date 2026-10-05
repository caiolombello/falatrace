import { dirname, join } from "node:path";
import { writePrivateArtifact } from "../jobs/artifacts";
import { getDefaultJobStateDir } from "../jobs/store";
import { readBoundedArtifact } from "../jobs/transcript-access";

/** Presentation-only copy of the last complete library list. It lets the Studio show the
 * library immediately at startup; the fresh list always replaces it. Never a source of truth:
 * detail, playback and every write path keep reading the real library. */
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export const defaultLibrarySnapshotPath = (): string =>
  join(dirname(getDefaultJobStateDir()), "studio-library-snapshot.json");

export const writeLibrarySnapshot = async (items: unknown[], path = defaultLibrarySnapshotPath()): Promise<void> => {
  const raw = JSON.stringify({ version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), items });
  if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES) return;
  await writePrivateArtifact(path, raw);
};

export const readLibrarySnapshot = async (path = defaultLibrarySnapshotPath()): Promise<{ items: unknown[]; savedAt: string } | undefined> => {
  try {
    const value = JSON.parse(await readBoundedArtifact(path, MAX_SNAPSHOT_BYTES));
    if (value?.version !== SNAPSHOT_VERSION || typeof value.savedAt !== "string" || !Array.isArray(value.items)) return undefined;
    if (!value.items.every((item: unknown) => item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string")) return undefined;
    return { items: value.items, savedAt: value.savedAt };
  } catch { return undefined; }
};
