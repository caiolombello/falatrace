import { afterEach, expect, test } from "bun:test";
import { transcribeGeminiAudio } from "../gemini";

const originalKey = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
});

test("does not expose request credentials when the network client throws", async () => {
  process.env.GEMINI_API_KEY = "test-only-secret";
  const request = (async () => {
    throw new Error("connection failed with test-only-secret");
  }) as unknown as typeof fetch;
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "auto", duration: 2
  }, request)).rejects.toThrow("Não foi possível conectar ao Gemini");
});

test("rejects a partial response instead of publishing an incomplete transcript", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  const request = (async () => Response.json({ ...completedResponse(), status: "in_progress" })) as unknown as typeof fetch;
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "auto", duration: 2
  }, request)).rejects.toThrow("não concluiu");
});

test("rejects missing word timings and reversed intervals rather than inventing caption timing", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  for (const annotations of [[], [{ type: "word_info", text: "Oi", speaker: "spk:0", start_offset: "1.5s", end_offset: "0.5s" }]]) {
    const response = completedResponse();
    response.steps[0].content[0].annotations = annotations;
    const request = (async () => Response.json(response)) as unknown as typeof fetch;
    await expect(transcribeGeminiAudio(Buffer.from("audio"), {
      model: "gemini-3.5-transcribe", language: "auto", duration: 2
    }, request)).rejects.toThrow();
  }
});

test("keeps HTTP errors free of provider response bodies and never retries billable requests", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  let requests = 0;
  const request = (async () => {
    requests += 1;
    return Response.json({ error: { message: "test-only-key sensitive detail" } }, { status: 429 });
  }) as unknown as typeof fetch;
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "auto", duration: 2
  }, request)).rejects.toThrow("Gemini recusou a transcrição (HTTP 429)");
  expect(requests).toBe(1);
});

test("blocks missing credentials and oversized duration before sending audio", async () => {
  let requests = 0;
  const request = (async () => { requests += 1; return Response.json(completedResponse()); }) as unknown as typeof fetch;
  delete process.env.GEMINI_API_KEY;
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "auto", duration: 2
  }, request)).rejects.toThrow("GEMINI_API_KEY");
  process.env.GEMINI_API_KEY = "test-only-key";
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "auto", duration: 1_801
  }, request)).rejects.toThrow("30 minutos");
  expect(requests).toBe(0);
});

test("separates words across speaker turns even when the provider text joins them", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  const response = completedResponse();
  response.steps[0].content[0].text = "Bom dia.Olá!";
  const request = (async () => Response.json(response)) as unknown as typeof fetch;
  const transcript = await transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "pt-BR", duration: 2
  }, request);
  expect(transcript.text).toBe("Bom dia. Olá!");
});

test("rejects missing annotated words instead of silently dropping spoken text", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  const response = completedResponse();
  response.steps[0].content[0].annotations.pop();
  const request = (async () => Response.json(response)) as unknown as typeof fetch;
  await expect(transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "pt-BR", duration: 2
  }, request)).rejects.toThrow("não cobrem todo o texto");
});

test("preserves an overlapping speaker reply returned after the preceding turn", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  const response = completedResponse();
  response.steps[0].content[0].annotations[1].start_offset = "1.100s";
  response.steps[0].content[0].annotations[1].end_offset = "1.400s";
  const request = (async () => Response.json(response)) as unknown as typeof fetch;
  const transcript = await transcribeGeminiAudio(Buffer.from("audio"), {
    model: "gemini-3.5-transcribe", language: "pt-BR", duration: 2
  }, request);
  expect(transcript.text).toBe("Bom dia. Olá!");
  expect(transcript.words?.map((word) => word.start)).toEqual([0.1, 1, 1.1]);
  expect(transcript.words?.map((word) => word.speaker)).toEqual(["spk_1", "spk_2", "spk_1"]);
  expect(transcript.segments.map((segment) => segment.text)).toEqual(["Bom", "Olá!", "dia."]);
  expect(transcript.segments.map((segment) => segment.start)).toEqual([0.1, 1, 1.1]);
});

const completedResponse = () => ({
  status: "completed",
  steps: [{
    type: "model_output",
    content: [{
      type: "text",
      text: "Bom dia. Olá!",
      annotations: [
        { type: "word_info", text: "Bom", start_offset: "0.100s", end_offset: "0.300s", speaker: "spk_1" },
        { type: "word_info", text: "dia.", start_offset: "0.350s", end_offset: "0.700s", speaker: "spk_1" },
        { type: "word_info", text: "Olá!", start_offset: "1.000s", end_offset: "1.500s", speaker: "spk_2" }
      ]
    }]
  }]
});

test("transcribes audio with speaker labels and readable captions while retaining word timings", async () => {
  process.env.GEMINI_API_KEY = "test-only-key";
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! });
    return Response.json(completedResponse());
  }) as typeof fetch;

  const result = await transcribeGeminiAudio(Buffer.from("test audio"), {
    model: "gemini-3.5-transcribe", language: "pt", duration: 2
  }, request);

  expect(result.provider).toBe("gemini");
  expect(result.text).toBe("Bom dia. Olá!");
  expect(result.segments).toEqual([
    { start: 0.1, end: 0.7, text: "Bom dia.", speaker: "spk_1" },
    { start: 1, end: 1.5, text: "Olá!", speaker: "spk_2" }
  ]);
  expect(result.words).toHaveLength(3);
  expect(result.words?.[1]).toEqual({ start: 0.35, end: 0.7, text: "dia.", speaker: "spk_1" });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  const body = JSON.parse(String(requests[0].init.body));
  expect(body.store).toBe(false);
  expect(body.input).toEqual([{ type: "audio", data: Buffer.from("test audio").toString("base64"), mime_type: "audio/mp3" }]);
  expect(body.generation_config.transcription_config).toEqual({
    language_codes: ["pt-BR"],
    mode: { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] }
  });
  expect(body).not.toHaveProperty("prompt");
  expect(body.generation_config.transcription_config).not.toHaveProperty("custom_vocabulary");
});
