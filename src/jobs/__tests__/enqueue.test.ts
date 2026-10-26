import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../store";
import { enqueueRecording, fastPathActive } from "../enqueue";

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
    // A consented hash that no longer matches the bytes creates nothing.
    const before = (await store.list()).length;
    await expect(store.enqueue(config, source, { expectedSha256: "0".repeat(64) })).rejects.toThrow("mudaram");
    expect(await store.list()).toHaveLength(before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the fast path queues a local job on stop even without automatic queueing; never for external providers", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-fast-path-"));
  try {
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const source = join(root, "meeting.wav");
    await fs.writeFile(source, "fixture media");
    const config = structuredClone(DEFAULT_CONFIG);
    config.processing.autoEnqueue = false;
    config.processing.defaultTarget = "remote";
    config.transcription.provider = "whisper-cpp";
    config.summary.provider = "ollama";
    config.summary.ollamaUrl = "http://127.0.0.1:11434";
    const asked: string[] = [];
    const local = { ollamaLocality: async (_url: string, model: string) => { asked.push(model); return "local" as const; } };
    expect(fastPathActive(config)).toBe(false);
    expect(await enqueueRecording(config, source, {}, store, local)).toBeNull();
    config.processing.fastPath = true;
    expect(fastPathActive(config)).toBe(true);
    // The Ollama does not run the model itself (a cloud model under another name): nothing is queued.
    for (const locality of ["cloud", "missing", "unreachable"] as const) {
      expect(await enqueueRecording(config, source, {}, store, { ollamaLocality: async () => locality })).toBeNull();
    }
    expect(await store.list()).toHaveLength(0);
    const job = await enqueueRecording(config, source, { recordingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, store, local);
    expect(asked).toEqual([config.summary.ollamaModel]);
    expect(job?.id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(job?.target).toBe("local");
    expect(job?.state).toBe("pending");
    // External providers are never on the fast path, nor is a cloud model of the Ollama on this computer.
    const external = [structuredClone(config), structuredClone(config), structuredClone(config), structuredClone(config)];
    external[0].summary.provider = "openai";
    external[1].summary.ollamaUrl = "https://ollama.example.test";
    external[2].transcription.provider = "openai";
    external[3].summary.ollamaModel = "gpt-oss:120b-cloud";
    for (const candidate of external) {
      expect(fastPathActive(candidate)).toBe(false);
      expect(await enqueueRecording(candidate, source, {}, store, local)).toBeNull();
    }
    expect(await store.list()).toHaveLength(1);
    // With automatic queueing on, the configured target is kept.
    config.processing.autoEnqueue = true;
    expect((await enqueueRecording(config, source, {}, store))?.target).toBe("remote");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
