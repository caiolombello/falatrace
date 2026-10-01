import { describe, expect, test } from "bun:test";
import { buildTranscriptBoundary, parseRequest, type DiarizationView } from "./bridge";
import { parsePlayerTranscript } from "../../src/player/transcript";
import type { Transcript } from "../../src/jobs/types";

describe("desktop transcript boundary", () => {
  test.each(["idle", "running", "review"] as const)("keeps canonical text and caption timeline separate (%s)", (state) => {
    const canonical: Transcript = {
      version: 1, provider: "openai", model: "gpt-transcribe", language: "pt",
      text: "  Texto canônico preservado.\n", segments: [{ start: 0, end: 60, text: "Texto canônico preservado." }]
    };
    const captionTranscript = parsePlayerTranscript({ model: "whisper", text: "Texto alinhado", segments: [{ start: 1, end: 3, text: "Texto alinhado", speaker: "Falante 1" }] });
    const diarization: DiarizationView = { state, message: "Identificação automática; revise as trocas de voz.", turns: [{ start: 1, end: 3, speaker: "S01", label: "Falante 1" }] };
    const result = buildTranscriptBoundary(canonical, captionTranscript, diarization);
    expect(result.transcript.text).toBe(canonical.text);
    expect(result.transcript.segments).toEqual(canonical.segments);
    expect(result.captionTranscript).toEqual(captionTranscript);
    expect(result.diarization).toEqual(diarization);
  });
});

describe("desktop operation boundary", () => {
  test("accepts scoped operations and rejects arbitrary arguments", () => {
    expect(parseRequest({ id: 8, op: "automation-pause" }).op).toBe("automation-pause");
    expect(parseRequest({ id: 9, op: "automation-resume" }).op).toBe("automation-resume");
    expect(() => parseRequest({ id: 10, op: "automation-resume", payload: { command: "arbitrary" } })).toThrow();
    expect(parseRequest({ id: 1, op: "capture-start", payload: { title: "Reunião" } }).payload?.title).toBe("Reunião");
    expect(parseRequest({ id: 2, op: "context-meeting", key: "meeting", payload: { maxCharacters: 4096, offset: 100 } }).payload?.offset).toBe(100);
    for (const request of [
      { id: 1, op: "shell", payload: { command: "anything" } },
      { id: 1, op: "capture-start", payload: { microphone: "other-device" } },
      { id: 1, op: "audio-defaults", payload: { config: "private" } },
      { id: 1, op: "diarization-name", payload: { label: "bad\nname" } },
      { id: 1, op: "context-meeting", payload: { offset: NaN } },
      { id: 1, op: "context-meeting", payload: { maxCharacters: 24001 } },
      { id: 1, op: "job-process", key: "bad\0path" }
    ]) expect(() => parseRequest(request)).toThrow();
  });

  test("discards oversized streaming input and returns sanitized errors without echoing data", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/bridge.ts`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write("private-sentinel".repeat(80000) + "\n");
    child.stdin.write(JSON.stringify({ id: 7, op: "unknown-private-sentinel" }) + "\n");
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const lines = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { id: 0, ok: false, error: "linha JSON excede 1 MiB" },
      { id: 7, ok: false, error: "Request inválido" }
    ]);
    expect(output).not.toContain("private-sentinel");
  });
});
