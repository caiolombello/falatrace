import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WHISPER_MODELS, downloadWhisperModel, findWhisperModel, pullOllamaModel, readDownloadState, validateOllamaModelName, writeDownloadState
} from "../downloads";

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-models-"));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

/** Swap the pinned catalog entry for a tiny synthetic payload with its real hash. */
const withSyntheticModel = async (payload: Buffer, run: () => Promise<void>) => {
  const model = findWhisperModel("tiny");
  const original = { ...model };
  Object.assign(model, { bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
  try { await run(); } finally { Object.assign(model, original); }
};

const serve = (body: Buffer, seen: string[] = []) => (async (input: RequestInfo | URL) => {
  seen.push(String(input));
  const response = new Response(new Uint8Array(body), { status: 200 });
  Object.defineProperty(response, "url", { value: String(input) });
  return response;
}) as typeof fetch;

test("the catalog pins unique ids, files, sizes and SHA-256 values", () => {
  expect(new Set(WHISPER_MODELS.map((model) => model.id)).size).toBe(WHISPER_MODELS.length);
  for (const model of WHISPER_MODELS) {
    expect(model.file).toMatch(/^ggml-[a-z0-9._-]+\.bin$/);
    expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(model.bytes).toBeGreaterThan(10_000_000);
  }
  expect(WHISPER_MODELS.filter((model) => model.recommended).map((model) => model.id)).toEqual(["large-v3-turbo-q5_0"]);
  expect(() => findWhisperModel("../etc/passwd")).toThrow("Modelo desconhecido");
});

test("a verified download is published atomically and reused afterwards", async () => {
  await withDir(async (dir) => {
    const payload = Buffer.from("synthetic ggml payload ".repeat(1000));
    await withSyntheticModel(payload, async () => {
      const seen: string[] = [];
      const progress: number[] = [];
      const path = await downloadWhisperModel("tiny", { fetch: serve(payload, seen), directory: dir, onProgress: (bytes) => { progress.push(bytes); } });
      expect(path).toBe(join(dir, "ggml-tiny.bin"));
      expect(await fs.readFile(path)).toEqual(payload);
      expect(seen).toEqual(["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"]);
      expect(progress[progress.length - 1]).toBe(payload.length);
      expect((await fs.readdir(dir)).filter((name) => name.includes("partial"))).toEqual([]);
      const again: string[] = [];
      expect(await downloadWhisperModel("tiny", { fetch: serve(payload, again), directory: dir, onProgress: () => undefined })).toBe(path);
      expect(again).toEqual([]);
    });
  });
});

test("a corrupted or oversized download is discarded and an unrelated file is preserved", async () => {
  await withDir(async (dir) => {
    const payload = Buffer.from("expected payload");
    await withSyntheticModel(payload, async () => {
      await expect(downloadWhisperModel("tiny", { fetch: serve(Buffer.from("tampered payload")), directory: dir, onProgress: () => undefined }))
        .rejects.toThrow("SHA-256");
      await expect(downloadWhisperModel("tiny", { fetch: serve(Buffer.concat([payload, payload])), directory: dir, onProgress: () => undefined }))
        .rejects.toThrow("maior");
      expect(await fs.readdir(dir)).toEqual([]);
      await fs.writeFile(join(dir, "ggml-tiny.bin"), "someone else's file");
      await expect(downloadWhisperModel("tiny", { fetch: serve(payload), directory: dir, onProgress: () => undefined }))
        .rejects.toThrow("preservado");
      expect(await fs.readFile(join(dir, "ggml-tiny.bin"), "utf8")).toBe("someone else's file");
    });
  });
});

test("Ollama pulls only go to loopback servers and report progress and errors", async () => {
  expect(validateOllamaModelName("qwen3.5:9b")).toBe("qwen3.5:9b");
  expect(validateOllamaModelName("library/llama3:8b-instruct")).toBe("library/llama3:8b-instruct");
  for (const bad of ["", "UPPER", "a b", "../x", "x".repeat(200)]) expect(() => validateOllamaModelName(bad)).toThrow();
  await expect(pullOllamaModel("https://ollama.example.com", "qwen3.5:9b", { fetch, onProgress: () => undefined })).rejects.toThrow("neste computador");
  const lines = [{ status: "pulling manifest" }, { status: "downloading", completed: 5, total: 10 }, { status: "success" }].map((line) => `${JSON.stringify(line)}\n`).join("");
  const seen: Array<{ url: string; body: string }> = [];
  const progress: string[] = [];
  await pullOllamaModel("http://127.0.0.1:11434", "qwen3.5:9b", {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push({ url: String(input), body: String(init?.body) }); return new Response(lines); }) as typeof fetch,
    onProgress: (_completed, _total, status) => { progress.push(status); }
  });
  expect(seen).toEqual([{ url: "http://127.0.0.1:11434/api/pull", body: JSON.stringify({ model: "qwen3.5:9b", stream: true }) }]);
  expect(progress).toContain("success");
  await expect(pullOllamaModel("http://localhost:11434", "qwen3.5:9b", {
    fetch: (async () => new Response(`${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`)) as unknown as typeof fetch,
    onProgress: () => undefined
  })).rejects.toThrow("Ollama: pull model manifest");
});

test("download state files round-trip and are private", async () => {
  await writeDownloadState({ kind: "whisper", id: "tiny", state: "running", receivedBytes: 1, totalBytes: 2 });
  expect(await readDownloadState("whisper", "tiny")).toMatchObject({ state: "running", receivedBytes: 1, totalBytes: 2 });
  expect(await readDownloadState("ollama", "tiny")).toBeNull();
});

test("a failing disk ends the download with an error and leaves no partial file", async () => {
  await withDir(async (dir) => {
    const payload = Buffer.from("synthetic ggml payload ".repeat(1000));
    await withSyntheticModel(payload, async () => {
      const full = () => fs.open("/dev/full", "w");
      await expect(downloadWhisperModel("tiny", { fetch: serve(payload), directory: dir, onProgress: () => undefined, open: full }))
        .rejects.toThrow(/ENOSPC|no space/i);
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });
});

test("long model names that share a prefix keep separate download states", async () => {
  const prefix = `registry.example.com/team/${"a".repeat(60)}`;
  await writeDownloadState({ kind: "ollama", id: `${prefix}:one`, state: "running", receivedBytes: 1, totalBytes: 10 });
  await writeDownloadState({ kind: "ollama", id: `${prefix}:two`, state: "running", receivedBytes: 2, totalBytes: 10 });
  expect((await readDownloadState("ollama", `${prefix}:one`))?.receivedBytes).toBe(1);
  expect((await readDownloadState("ollama", `${prefix}:two`))?.receivedBytes).toBe(2);
});

test("a cancelled download leaves no partial file, and a new one clears stale partials", async () => {
  await withDir(async (dir) => {
    const payload = Buffer.from("synthetic ggml payload ".repeat(1000));
    await withSyntheticModel(payload, async () => {
      const controller = new AbortController();
      // Like fetch: aborting the signal errors the body stream mid-transfer.
      const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(payload.subarray(0, 100)));
            init?.signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
          }
        });
        const response = new Response(body, { status: 200 });
        Object.defineProperty(response, "url", { value: "https://huggingface.co/x" });
        return response;
      }) as typeof fetch;
      const running = downloadWhisperModel("tiny", { fetch: stalled, directory: dir, signal: controller.signal, onProgress: () => undefined });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(running).rejects.toThrow();
      expect(await fs.readdir(dir)).toEqual([]);

      await fs.writeFile(join(dir, ".ggml-tiny.bin.partial-left-by-a-killed-unit"), "x");
      await downloadWhisperModel("tiny", { fetch: serve(payload), directory: dir, onProgress: () => undefined });
      expect(await fs.readdir(dir)).toEqual(["ggml-tiny.bin"]);
    });
  });
});
