import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../store";
import { enqueueRecording } from "../enqueue";

test("finalizing a recording queues one durable job without processing other pending jobs", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-enqueue-"));
  try {
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const source = join(root, "meeting.wav");
    await fs.writeFile(source, "fixture media");
    const config = structuredClone(DEFAULT_CONFIG);
    config.processing.defaultTarget = "local";
    config.processing.autoEnqueue = true;
    const unrelated = await store.enqueue(config, source);
    const options = { recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const first = await enqueueRecording(config, source, options, store);
    const repeated = await enqueueRecording(config, source, options, store);
    expect(first?.state).toBe("pending");
    expect(repeated?.id).toBe(first?.id);
    expect((await store.get(unrelated.id)).state).toBe("pending");
    expect(await store.list()).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(join(store.getWorkDir(first!.id), "manifest.json"), "utf8")).id).toBe(first!.id);
    await fs.writeFile(source, "different media");
    await expect(store.enqueue(config, source, options)).rejects.toThrow("different media");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
