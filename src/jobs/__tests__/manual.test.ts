import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { planRecordingProcessing, runRecordingProcessing, type ManualProcessDeps } from "../manual";
import type { JobRecord } from "../types";

const job = (state: JobRecord["state"], overrides: Partial<JobRecord> = {}): JobRecord => ({
  version: 1 as never, id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-01T00:00:00Z",
  source: { originalName: "recording.mka", mediaFile: "source.mka", size: 3, sha256: "a".repeat(64) },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
  summary: { provider: "ollama", model: "qwen3.5:9b" },
  sourcePath: "/x", artifactDir: "/y", target: "local", state, updatedAt: "2026-10-01T00:00:00Z", ...overrides
} as JobRecord);

const withRecording = async (run: (path: string) => Promise<void>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-manual-"));
  const path = join(root, "recording.mka");
  await fs.writeFile(path, "abc");
  try { await run(path); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

const fakeDeps = (stored?: JobRecord) => {
  const calls: string[] = [];
  const deps: ManualProcessDeps = {
    store: {
      get: async () => { if (!stored) throw new Error("missing"); return stored; },
      enqueue: async () => { calls.push("enqueue"); return job("pending", { id: "223e4567-e89b-42d3-a456-426614174000" }); }
    } as never,
    duration: async () => 61,
    queue: async (id, options) => { calls.push(`queue:${id}:${options?.retry ? "retry" : "run"}`); return { id, status: "queued" }; }
  };
  return { deps, calls };
};

test("an unprocessed recording is planned with its destinations disclosed", async () => {
  await withRecording(async (path) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.transcription.provider = "openai";
    const plan = await planRecordingProcessing(config, { sourcePath: path, sourceExists: true, jobs: [] }, fakeDeps().deps);
    expect(plan).toMatchObject({ action: "create", durationSeconds: 61, target: "local" });
    expect(plan.transcription).toMatchObject({ provider: "openai", where: "OpenAI, serviço externo", external: true });
    expect(plan.summary).toMatchObject({ provider: "ollama", where: "Ollama neste computador", external: false });
    expect(plan.consentKey).toMatch(/^[a-f0-9]{64}$/);
  });
});

test("existing jobs are queued, retried or left alone and keep their recorded providers", async () => {
  await withRecording(async (path) => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [state, action] of [["pending", "queue"], ["failed", "retry"], ["completed", "none"], ["processing", "none"]] as const) {
      const stored = job(state, { sourcePath: path });
      const plan = await planRecordingProcessing(config, { sourcePath: path, sourceExists: true, jobs: [stored] }, fakeDeps(stored).deps);
      expect(plan.action).toBe(action);
      expect(plan.transcription.provider).toBe("openai");
    }
    const missing = await planRecordingProcessing(config, { sourcePath: `${path}.gone`, sourceExists: false, jobs: [] }, fakeDeps().deps);
    expect(missing.action).toBe("none");
    config.processing.defaultTarget = "remote";
    expect((await planRecordingProcessing(config, { sourcePath: path, sourceExists: true, jobs: [] }, fakeDeps().deps)).action).toBe("none");
  });
});

test("running needs the consent of the exact plan, then creates and queues the job", async () => {
  await withRecording(async (path) => {
    const config = structuredClone(DEFAULT_CONFIG);
    const entry = { sourcePath: path, sourceExists: true, jobs: [] };
    const { deps, calls } = fakeDeps();
    const plan = await planRecordingProcessing(config, entry, deps);
    await expect(runRecordingProcessing(config, entry, { consent: false, consentKey: plan.consentKey }, deps)).rejects.toThrow("Confirme");
    await expect(runRecordingProcessing(config, entry, { consent: true, consentKey: "b".repeat(64) }, deps)).rejects.toThrow("mudaram");
    config.summary.provider = "openai";
    await expect(runRecordingProcessing(config, entry, { consent: true, consentKey: plan.consentKey }, deps)).rejects.toThrow("mudaram");
    config.summary.provider = "ollama";
    // Same size and mtime, different bytes: the consent no longer matches.
    const pinned = new Date(1700000000000);
    await fs.utimes(path, pinned, pinned);
    const pinnedPlan = await planRecordingProcessing(config, entry, deps);
    await fs.writeFile(path, "xyz");
    await fs.utimes(path, pinned, pinned);
    await expect(runRecordingProcessing(config, entry, { consent: true, consentKey: pinnedPlan.consentKey }, deps)).rejects.toThrow("mudaram");
    const fresh = await planRecordingProcessing(config, entry, deps);
    expect(await runRecordingProcessing(config, entry, { consent: true, consentKey: fresh.consentKey }, deps)).toEqual({ jobId: "223e4567-e89b-42d3-a456-426614174000", status: "queued", created: true });
    expect(calls).toEqual(["enqueue", "queue:223e4567-e89b-42d3-a456-426614174000:run"]);
    const failed = job("failed", { sourcePath: path });
    const retry = fakeDeps(failed);
    const retryPlan = await planRecordingProcessing(config, { ...entry, jobs: [failed] }, retry.deps);
    await runRecordingProcessing(config, { ...entry, jobs: [failed] }, { consent: true, consentKey: retryPlan.consentKey }, retry.deps);
    expect(retry.calls).toEqual([`queue:${failed.id}:retry`]);
  });
});

test("remote processing names the worker and asks again when the worker changes", async () => {
  await withRecording(async (path) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.processing.defaultTarget = "remote";
    config.remote = { ...config.remote, host: "gpu.lan", user: "ana", port: 2222 };
    const entry = { sourcePath: path, sourceExists: true, jobs: [] };
    const { deps, calls } = fakeDeps();
    const plan = await planRecordingProcessing(config, entry, deps);
    expect(plan).toMatchObject({ action: "create", target: "remote", remote: { destination: "ana@gpu.lan", port: 2222 } });
    expect(plan.transcription).toMatchObject({ where: "Whisper.cpp no worker remoto", external: true });
    // The worker summarizes with its own configuration: its Ollama address is disclosed as unchecked.
    expect(plan.summary).toMatchObject({ where: "Ollama configurado no worker remoto, em endereço não verificado daqui", external: true });
    for (const change of [{ host: "other.lan" }, { user: "bia" }, { port: 22 }, { identityFile: "/home/u/.ssh/other" }]) {
      const changed = structuredClone(config);
      changed.remote = { ...changed.remote, ...change };
      await expect(runRecordingProcessing(changed, entry, { consent: true, consentKey: plan.consentKey }, deps)).rejects.toThrow("mudaram");
    }
    expect(calls).toEqual([]);
    expect((await planRecordingProcessing({ ...config, processing: { ...config.processing, defaultTarget: "local" } }, entry, deps)).remote).toBeUndefined();
  });
});

test("a local job whose original is gone is not offered again; a remote one keeps its options", async () => {
  await withRecording(async (path) => {
    const config = structuredClone(DEFAULT_CONFIG);
    const gone = `${path}.gone`;
    for (const state of ["pending", "failed"] as const) {
      const stored = job(state, { sourcePath: gone });
      const plan = await planRecordingProcessing(config, { sourcePath: gone, sourceExists: false, jobs: [stored] }, fakeDeps(stored).deps);
      expect(plan).toMatchObject({ action: "none", reason: "O arquivo original não está neste computador." });
      await expect(runRecordingProcessing(config, { sourcePath: gone, sourceExists: false, jobs: [stored] }, { consent: true, consentKey: plan.consentKey }, fakeDeps(stored).deps)).rejects.toThrow("original");
    }
    const remote = job("failed", { sourcePath: gone, target: "remote" });
    expect((await planRecordingProcessing(config, { sourcePath: gone, sourceExists: false, jobs: [remote] }, fakeDeps(remote).deps)).action).toBe("retry");
  });
});
