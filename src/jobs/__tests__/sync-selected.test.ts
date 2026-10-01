import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../store";
import { syncJob, syncJobs } from "../sync";

test("processing a selected job leaves every unrelated pending job unchanged", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "selected-job-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.enabled = false;
    config.processing.defaultTarget = "local";
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const paths = [join(root, "selected.mkv"), join(root, "unrelated.mkv")];
    for (const path of paths) await fs.writeFile(path, "original");
    const selected = await store.enqueue(config, paths[0]);
    const unrelated = await store.enqueue(config, paths[1]);
    // Both jobs must stop at source verification if selected, before any external processor.
    for (const path of paths) await fs.writeFile(path, "modified");
    const result = await syncJob(config, store, selected.id);
    expect(result.id).toBe(selected.id);
    expect(result.state).toBe("failed");
    expect(result.error).toContain("checksum");
    expect(await store.get(unrelated.id)).toEqual(unrelated);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("overlapping selected and queue processing acquire one job lease", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "selected-job-concurrent-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.enabled = false;
    config.processing.defaultTarget = "local";
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const media = join(root, "meeting.mkv");
    await fs.writeFile(media, "original");
    const selected = await store.enqueue(config, media);
    await fs.writeFile(media, "modified");
    const update = store.update.bind(store);
    let processingTransitions = 0;
    store.update = async (...args) => {
      if (args[1] === "processing") processingTransitions += 1;
      return update(...args);
    };
    await Promise.all([syncJob(config, store, selected.id), syncJobs(config, store)]);
    expect(processingTransitions).toBe(1);
    expect((await store.get(selected.id)).state).toBe("failed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
