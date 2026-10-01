import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { hashFile } from "../store";
import { processJob } from "../pipeline";
import type { JobManifest, Transcript } from "../types";

test("summarizes segment-only transcripts without sending an empty conversation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "summary-input-"));
  const originalFetch = globalThis.fetch;
  const manifest: JobManifest = {
    version: 1, id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-09-30T00:00:00Z",
    source: { originalName: "synthetic.wav", mediaFile: "source.wav", size: 1, sha256: "a".repeat(64) },
    transcription: { provider: "whisper-cpp", model: "fixture", language: "pt" },
    summary: { provider: "ollama", model: "fixture" }
  };
  const transcript: Transcript = {
    version: 1, provider: "whisper-cpp", model: "fixture", language: "pt",
    text: " \n", segments: [
      { start: 1, end: 2, text: " Revisar o protótipo. " },
      { start: 3, end: 4, text: "Publicar após revisão." }
    ]
  };
  let input = "";
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    input = JSON.parse(request.messages[1].content).transcript;
    return Response.json({ message: { content: JSON.stringify({
      title: "Revisão do protótipo", overview: "Planejamento sintético.",
      topics: [], decisions: [], actionItems: []
    }) } });
  }) as typeof fetch;
  try {
    await fs.writeFile(join(root, "transcript.json"), JSON.stringify(transcript));
    const source=join(root,"synthetic.wav"); await fs.writeFile(source,"synthetic offline fixture"); manifest.source.sha256=await hashFile(source);
    await processJob(DEFAULT_CONFIG, manifest, source, root);
    expect(input).toBe("Revisar o protótipo.\nPublicar após revisão.");
    expect(JSON.parse(await fs.readFile(join(root, "transcript.json"), "utf8"))).toEqual(transcript);
    expect(await fs.readFile(join(root, "summary.md"), "utf8")).toContain("Planejamento sintético.");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
