import { createReadStream, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import OpenAI, { APIError } from "openai";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { probeMedia } from "../jobs/media";
import { readSecret } from "../config/secrets";

export const DIARIZATION_MODEL = "gpt-4o-transcribe-diarize";
export const DIARIZATION_UPLOAD_MAX_BYTES = 24_000_000;
export type DiarizationTurn = { start: number; end: number; text: string; speaker: string };

export const providerErrorDiagnostic = (error: APIError, apiKey: string): Record<string, unknown> => ({
  status: error.status,
  code: typeof error.code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(error.code) ? error.code : null,
  // Do not retain headers, request bodies, or credentials in diagnostics.
  message: String(error.error && typeof error.error === "object" && "message" in error.error ? error.error.message : error.message)
    .split(apiKey).join("[redacted]").replace(/sk-[a-zA-Z0-9_*-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1500)
});

// One upload retains a recording-wide speaker namespace. Never stitch labels from
// independent API calls: "A" in the second call is not evidence of the same voice.
export const normalizeDiarizationResponse = (value: unknown, duration: number): { turns: DiarizationTurn[]; ignoredZeroDurationTurns: number; ignoredEmptyTextTurns: number } => {
  const segments = value && typeof value === "object" ? (value as { segments?: unknown }).segments : undefined;
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(segments) || !segments.length || segments.length > 100_000) {
    throw new Error("O diarizador não retornou falas válidas");
  }
  const identities = new Map<string, string>();
  const turns = segments.map((value): DiarizationTurn => {
    const item = value as Record<string, unknown> | null;
    if (!item || typeof item !== "object" ||
      typeof item.start !== "number" || !Number.isFinite(item.start) || item.start < 0 ||
      typeof item.end !== "number" || !Number.isFinite(item.end) || item.end < item.start || item.end > duration + 1 ||
      typeof item.text !== "string" || item.text.length > 10_000 ||
      typeof item.speaker !== "string" || !item.speaker.trim() || item.speaker.length > 200 || /[\x00-\x1f\x7f]/.test(item.speaker)) {
      const reason = !item || typeof item !== "object" ? "formato" :
        typeof item.start !== "number" || typeof item.end !== "number" || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start || item.end > duration + 1 ? "intervalo de tempo" :
        typeof item.text !== "string" || item.text.length > 10_000 ? "texto" : "falante";
      throw new Error(`O diarizador retornou uma fala inválida (${reason})`);
    }
    return { start: item.start, end: item.end, text: item.text, speaker: item.speaker };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  // A point has no audible interval. Keep the canonical transcript untouched and
  // exclude only these points from the acoustic timeline, without inventing time.
  const audible = turns.filter((turn) => turn.end > turn.start && turn.text.trim());
  if (!audible.length) throw new Error("O diarizador não retornou falas válidas");
  return { ignoredZeroDurationTurns: turns.filter((turn) => turn.end === turn.start).length, ignoredEmptyTextTurns: turns.filter((turn) => turn.end > turn.start && !turn.text.trim()).length, turns: audible.map((turn) => {
    if (!identities.has(turn.speaker)) identities.set(turn.speaker, `S${String(identities.size + 1).padStart(2, "0")}`);
    return { ...turn, speaker: identities.get(turn.speaker)! };
  }) };
};

export const parseDiarizationResponse = (value: unknown, duration: number): DiarizationTurn[] => normalizeDiarizationResponse(value, duration).turns;

export const DIARIZATION_AUDIO_ENCODING = { codec: "opus", sampleRate: 24000, channels: 1, targetBitrate: 40000, rateControl: "vbr" } as const;
export const prepareDiarizationAudio = async (sourcePath: string, workDir: string): Promise<{ path: string; duration: number }> => {
  const duration = await probeMedia(sourcePath);
  const path = join(workDir, "diarization.webm");
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", sourcePath,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libopus", "-b:a", String(DIARIZATION_AUDIO_ENCODING.targetBitrate), "-vbr", "on", "-threads", "1", path], { timeoutMs: 30 * 60 * 1000 });
  await assertDiarizationUpload(path);
  return { path, duration };
};

export const assertDiarizationUpload = async (path: string): Promise<void> => {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error("O áudio da diarização é inválido");
  if (stat.size > DIARIZATION_UPLOAD_MAX_BYTES) {
    throw new Error(`O áudio excede 24 MB (${(stat.size / 1_000_000).toFixed(1)} MB). A diarização integral precisa de outro método para manter os mesmos falantes; o texto original foi preservado.`);
  }
};

export const diarizeAudioWithOpenAI = async (
  config: AppConfig, audioPath: string, duration: number, language: string
): Promise<DiarizationTurn[]> => {
  await assertDiarizationUpload(audioPath);
  const apiKey = (await readSecret("OPENAI_API_KEY")) || config.openai.apiKey;
  if (!apiKey) throw new Error("A chave OpenAI não está configurada");
  const client = new OpenAI({
    apiKey, maxRetries: 0, timeout: 60 * 60 * 1000,
    fetch: (input, init) => {
      // Bun's independent 5-minute socket idle timer can abort long diarization.
      // Disable only that timer; preserve the SDK's one-hour AbortSignal deadline.
      const request = { ...init, timeout: false };
      return fetch(input, request);
    }
  });
  let response: unknown;
  try {
    // Official contract: diarized_json, server VAD for >30 s, no prompt/logprobs/word timestamps.
    // https://developers.openai.com/api/docs/guides/speech-to-text#speaker-diarization
    response = await client.audio.transcriptions.create({
      file: createReadStream(audioPath), model: DIARIZATION_MODEL,
      response_format: "diarized_json", chunking_strategy: "auto",
      ...(language !== "auto" ? { language } : {})
    });
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      await fs.writeFile(join(dirname(audioPath), "provider-response.json"), JSON.stringify({ error: providerErrorDiagnostic(error, apiKey) }), { mode: 0o600 }).catch(() => undefined);
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new Error("A OpenAI não concluiu a diarização: tempo de espera excedido. Tente novamente. O texto original foi preservado.");
      if (error.status === 401 || error.status === 403) throw new Error("A conta OpenAI não autorizou a diarização");
      if (error.status === 429) throw new Error("O limite da conta OpenAI foi atingido; tente novamente mais tarde");
      if (error.status === 400 && error.message.includes("Audio file might be corrupted or unsupported")) throw new Error("O diarizador não conseguiu ler o áudio integral desta gravação. É necessário outro método de processamento; a transcrição original foi preservada.");
      throw new Error(`A OpenAI não concluiu a diarização${error.status ? ` (HTTP ${error.status})` : ""}. O texto original foi preservado.`);
    }
    throw new Error("Não foi possível concluir a diarização; verifique a conexão e tente novamente");
  }
  const raw = JSON.stringify(response);
  if (Buffer.byteLength(raw) > 20 * 1024 * 1024) throw new Error("O diarizador retornou uma resposta muito grande");
  try { await fs.writeFile(join(dirname(audioPath), "provider-response.json"), raw, { mode: 0o600 }); }
  catch { throw new Error("Não foi possível salvar a resposta de diarização; verifique o espaço em disco e as permissões"); }
  return parseDiarizationResponse(response, duration);
};
