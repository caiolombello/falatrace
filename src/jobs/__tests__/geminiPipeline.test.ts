import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { transcribeWithGemini } from "../../transcription/gemini";
import { JOB_VERSION, type JobManifest } from "../types";
import { hashFile } from "../store";
import { processJob } from "../pipeline";

const originalPath = process.env.PATH;
const originalGeminiKey = process.env.GEMINI_API_KEY;

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await fs.writeFile(path, content, { mode: 0o700 });
};

const geminiResponse = (label: string, speaker: string, end = 0.8) => ({
  status: "completed",
  steps: [{
    type: "model_output",
    content: [{
      type: "text",
      text: label,
      annotations: [
        { type: "word_info", text: label, start_offset: "0s", end_offset: `${end}s`, speaker }
      ]
    }]
  }]
});

const manifest = (model = "gemini-3.5-transcribe"): JobManifest => ({
  version: JOB_VERSION,
  id: "123e4567-e89b-42d3-a456-426614174000",
  createdAt: "2026-09-08T12:00:00.000Z",
  source: {
    originalName: "meeting.mkv",
    mediaFile: "source.mkv",
    size: 12,
    sha256: "a".repeat(64)
  },
  transcription: { provider: "gemini", model, language: "pt" },
  summary: { provider: "ollama", model: "fake-summary" }
});

test("processes a Gemini job with Ollama summary and removes temporary MP3", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-gemini-pipeline-"));
  const binDir = join(root, "bin");
  const outputDir = join(root, "artifacts");
  const sourcePath = join(root, "meeting.mkv");
  const originalFetch = globalThis.fetch;
  await fs.mkdir(binDir);
  await fs.writeFile(sourcePath, "fake media");
  await writeExecutable(join(binDir, "ffprobe"), "#!/usr/bin/env bash\nprintf '2.5\\n'\n");
  await writeExecutable(
    join(binDir, "ffmpeg"),
    "#!/usr/bin/env bash\noutput=\"${!#}\"\nprintf 'fake mp3' > \"$output\"\n"
  );

  let geminiRequests = 0;
  let summaryRequests = 0;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.GEMINI_API_KEY = "test-only-key";
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiRequests += 1;
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.input[0].mime_type).toBe("audio/mp3");
      return Response.json(geminiResponse("Olá", "spk_1"));
    }
    expect(url).toContain("/api/chat");
    summaryRequests += 1;
    return Response.json({
      message: {
        content: JSON.stringify({
          title: "Reunião Gemini",
          overview: "Resumo gerado localmente.",
          topics: ["Transcrição"],
          decisions: [],
          actionItems: []
        })
      }
    });
  }) as unknown as typeof fetch;

  try {
    const config = mergeConfig(DEFAULT_CONFIG, {
      transcription: { provider: "gemini", geminiModel: "gemini-3.5-transcribe" },
      summary: { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }
    });
    const selected=manifest(); selected.source.sha256=await hashFile(sourcePath);
    await processJob(config, selected, sourcePath, outputDir);

    const transcript = JSON.parse(await fs.readFile(join(outputDir, "transcript.json"), "utf-8"));
    const summary = JSON.parse(await fs.readFile(join(outputDir, "summary.json"), "utf-8"));
    expect(geminiRequests).toBe(1);
    expect(summaryRequests).toBe(1);
    expect(transcript.text).toBe("Olá");
    expect(transcript.segments).toEqual([{ start: 0, end: 0.8, text: "Olá", speaker: "spk_1" }]);
    expect(transcript.words).toEqual([{ start: 0, end: 0.8, text: "Olá", speaker: "spk_1" }]);
    expect(summary.title).toBe("Reunião Gemini");
    expect(summary.overview).toBe("Resumo gerado localmente.");
    expect(await fs.stat(join(outputDir, "transcript.md"))).toBeTruthy();
    expect(await fs.stat(join(outputDir, "summary.md"))).toBeTruthy();
    expect(await fs.stat(join(outputDir, "audio.mp3")).catch(() => null)).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a recording longer than 30 minutes before extracting or sending audio", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-gemini-chunks-"));
  const binDir = join(root, "bin");
  const workDir = join(root, "work");
  const sourcePath = join(root, "meeting.mkv");
  const ffmpegLog = join(root, "ffmpeg.log");
  const originalFetch = globalThis.fetch;
  await fs.mkdir(binDir);
  await fs.mkdir(workDir);
  await fs.writeFile(sourcePath, "fake media");
  await writeExecutable(join(binDir, "ffprobe"), "#!/usr/bin/env bash\nprintf '1801\\n'\n");
  await writeExecutable(
    join(binDir, "ffmpeg"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${ffmpegLog}'
output="${"${!#}"}"
printf 'fake mp3' > "$output"
`
  );

  const requests: Array<{ duration: number; body: Record<string, unknown> }> = [];
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.GEMINI_API_KEY = "test-only-key";
  globalThis.fetch = (async () => {
    requests.push({ duration: 1801, body: {} });
    return Response.json(geminiResponse("não deve ser enviado", "spk_1"));
  }) as unknown as typeof fetch;

  try {
    await expect(
      transcribeWithGemini(sourcePath, workDir, "gemini-3.5-transcribe", "pt")
    ).rejects.toThrow("30 minutos");
    expect(requests).toHaveLength(0);
    expect(await fs.stat(ffmpegLog).catch(() => null)).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});
