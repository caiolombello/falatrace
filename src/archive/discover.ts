import type { AppConfig } from "../config/defaults";
import { buildLibrary, isPathInside } from "../tui/library";
import { RecordingSessionStore } from "../recording/session";
import { ArchiveStore } from "./store";

export const registerLocalLibraryMedia = async (config: AppConfig, store = new ArchiveStore()): Promise<{ registered: number; missing: number; active: number; errors: string[] }> => {
  const activeSession = await new RecordingSessionStore().read();
  const results = { registered: 0, missing: 0, active: 0, errors: [] as string[] };
  for (const entry of await buildLibrary(config)) {
    if (!entry.sourceExists) { results.missing += 1; continue; }
    if (!isPathInside(config.recordingsDir, entry.sourcePath)) continue;
    if (entry.sourcePath === activeSession?.outputPath && activeSession.phase !== "stopped") { results.active += 1; continue; }
    try {
      const oldestJob = [...entry.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      await store.enqueue(entry.sourcePath, { id: oldestJob?.id, createdAt: oldestJob?.createdAt }); results.registered += 1;
    } catch (error) { results.errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return results;
};
