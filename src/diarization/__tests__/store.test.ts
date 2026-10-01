import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiarizationStore, transcriptChecksum } from "../store";

test("only reuses speaker annotations for the exact media and canonical text", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-diarization-store-"));
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const text = "Olá.\n";
  try {
    const store = new DiarizationStore(root);
    const result = {
      version: 1 as const, jobId, mediaSha256: "a".repeat(64), transcriptSha256: transcriptChecksum(text),
      provider: "openai" as const, model: "gpt-4o-transcribe-diarize", generatedAt: new Date().toISOString(), duration: 3,
      labels: { S01: "Falante 1" }, acousticValidation: "pending" as const,
      turns: [{ start: 0, end: 3, text: "Olá.", speaker: "S01" }],
      alignment: { text, matchedTokenRatio: 1, unassignedTokenCount: 0, segments: [{ start: 0, end: 3, text, speaker: "S01", charStart: 0, charEnd: text.length }] }
    };
    await store.save(result);
    expect((await store.read(jobId, "a".repeat(64), text))?.alignment.text).toBe(text);
    expect(await store.read(jobId, "b".repeat(64), text)).toBeUndefined();
    expect(await store.read(jobId, "a".repeat(64), "Olá!\n")).toBeUndefined();
    expect((await fs.stat(join(root, `${jobId}.json`))).mode & 0o777).toBe(0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
