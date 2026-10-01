import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "../types";
import { queueSelectedJob } from "../queue";

const job = (id: string, state: JobRecord["state"] = "pending"): JobRecord => ({
  version: 1,
  id,
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
  source: {
    originalName: "source.wav",
    mediaFile: "source.wav",
    size: 10,
    sha256: "a".repeat(64)
  },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
  summary: { provider: "ollama", model: "model" },
  sourcePath: "/tmp/source.wav",
  artifactDir: `/tmp/source.recording/${id}`,
  target: "local",
  state
});

test("queues only the selected job in a detached constrained systemd unit", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174101";
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await queueSelectedJob(id, {}, {
    store: {
      get: async () => job(id),
      update: async () => { throw new Error("unexpected update"); }
    },
    unitActive: async () => false,
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    }
  });

  expect(result).toEqual({
    id,
    status: "queued",
    unit: `recording-cli-job-${id}.service`
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command).toBe("systemd-run");
  expect(calls[0]!.args).toContain("--property=Type=exec");
  expect(calls[0]!.args).toContain("--property=UMask=0077");
  expect(calls[0]!.args).toContain("--property=Nice=10");
  expect(calls[0]!.args).toContain("--property=RuntimeMaxSec=5400");
  expect(calls[0]!.args).toContain("--property=MemoryMax=2G");
  expect(calls[0]!.args).toContain(
    `--property=EnvironmentFile=-${join(homedir(), ".config/recording-cli/worker.env")}`
  );
  expect(calls[0]!.args.slice(-3)).toEqual(["jobs", "process", id]);
});

test("restores a failed job when its retry unit cannot be launched", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174102";
  let current: JobRecord = { ...job(id, "failed"), error: "Falha anterior" };
  const transitions: Array<{ state: JobRecord["state"]; error: string | undefined }> = [];

  await expect(queueSelectedJob(id, { retry: true }, {
    store: {
      get: async () => current,
      update: async (_id, state, changes = {}) => {
        transitions.push({ state, error: changes.error });
        current = { ...current, state, error: changes.error };
        return current;
      }
    },
    unitActive: async () => false,
    run: async () => { throw new Error("systemd unavailable"); }
  })).rejects.toThrow("Não foi possível colocar o job selecionado na fila");

  expect(transitions).toEqual([
    { state: "pending", error: undefined },
    { state: "failed", error: "Falha anterior" }
  ]);
  expect(current.state).toBe("failed");
  expect(current.error).toBe("Falha anterior");
});

test("does not duplicate an orphaned processing state", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174103";
  let launched = false;
  const result = await queueSelectedJob(id, {}, {
    store: {
      get: async () => job(id, "processing"),
      update: async () => { throw new Error("unexpected update"); }
    },
    unitActive: async () => false,
    run: async () => { launched = true; return { stdout: "", stderr: "" }; }
  });

  expect(result.status).toBe("active");
  expect(result.warning).toContain("não pôde ser confirmada");
  expect(launched).toBe(false);
});

test("deduplicates concurrent requests for the same selected job", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174104";
  let launches = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const dependencies = {
    store: {
      get: async () => job(id),
      update: async () => { throw new Error("unexpected update"); }
    },
    unitActive: async () => false,
    run: async () => {
      launches += 1;
      entered();
      await gate;
      return { stdout: "", stderr: "" };
    }
  };

  const first = queueSelectedJob(id, {}, dependencies);
  await started;
  const duplicate = await queueSelectedJob(id, {}, dependencies);
  release();

  expect((await first).status).toBe("queued");
  expect(duplicate.status).toBe("active");
  expect(launches).toBe(1);
});
