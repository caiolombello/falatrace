import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../store";
import { syncJob, syncJobs } from "../sync";
import { writeCallStatus } from "../../calls/status";

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

test("sync queue bounds paused local admission and preserves pending state without processing or losing media", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "sync-paused-"));
  const previous = { pause: process.env.FALATRACE_HEAVY_PAUSE, state: process.env.XDG_STATE_HOME };
  try {
    // Declare the activity this fixture depends on; never inherit a fresh IDLE
    // status from an unrelated runtime/controller test in the same QA process.
    process.env.XDG_STATE_HOME = join(root, "activity-state");
    await writeCallStatus({ version: 1, state: "IN_CALL", confidence: 1,
      reasons: ["synthetic-active-call-fixture"], updatedAt: new Date().toISOString(),
      dryRun: false, recordingOwned: false });
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.enabled = false;
    config.processing.defaultTarget = "local";
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const media = join(root, "synthetic.mkv");
    await fs.writeFile(media, "synthetic-kept");
    const record = await store.enqueue(config, media);
    process.env.FALATRACE_HEAVY_PAUSE = "capture-and-call";
    const before = Date.now();
    const results = await syncJobs(config, store);
    expect(Date.now() - before).toBeLessThan(3000);
    expect(results.find(result => result.id === record.id)?.state).toBe("pending");
    expect(await store.get(record.id)).toEqual(record);
    expect(await fs.readFile(media, "utf8")).toBe("synthetic-kept");
  } finally {
    if (previous.pause === undefined) delete process.env.FALATRACE_HEAVY_PAUSE; else process.env.FALATRACE_HEAVY_PAUSE = previous.pause;
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
    await fs.rm(root, { recursive: true, force: true });
  }
});
