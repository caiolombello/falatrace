import { join } from "node:path";
import type { VoiceInstallation } from "../models/voice";

// Thin binding to the sherpa-onnx speaker-embedding extractor. The native addon is
// loaded from the verified installation directory (never from node_modules), so the
// source checkout and the compiled CLI use the same files.

export const VOICE_SAMPLE_RATE = 16_000;

export type VoiceEmbedder = { dim: number; modelSha256: string; embed: (samples: Float32Array) => Float32Array };

type Addon = {
  createSpeakerEmbeddingExtractor: (config: object) => unknown;
  speakerEmbeddingExtractorDim: (handle: unknown) => number;
  speakerEmbeddingExtractorCreateStream: (handle: unknown) => unknown;
  acceptWaveformOnline: (stream: unknown, wave: { sampleRate: number; samples: Float32Array }) => void;
  inputFinished: (stream: unknown) => void;
  speakerEmbeddingExtractorIsReady: (handle: unknown, stream: unknown) => boolean;
  speakerEmbeddingExtractorComputeEmbedding: (handle: unknown, stream: unknown, enableExternalBuffer: boolean) => Float32Array;
};
const REQUIRED: Array<keyof Addon> = [
  "createSpeakerEmbeddingExtractor", "speakerEmbeddingExtractorDim", "speakerEmbeddingExtractorCreateStream",
  "acceptWaveformOnline", "inputFinished", "speakerEmbeddingExtractorIsReady", "speakerEmbeddingExtractorComputeEmbedding"
];

let cached: { key: string; embedder: VoiceEmbedder } | undefined;

export const loadVoiceEmbedder = (installation: VoiceInstallation): VoiceEmbedder => {
  const key = `${installation.runtimeDir}\0${installation.modelPath}\0${installation.modelSha256}`;
  if (cached?.key === key) return cached.embedder;
  const module = { exports: {} as Partial<Addon> };
  try { process.dlopen(module, join(installation.runtimeDir, "sherpa-onnx.node")); }
  catch { throw new Error("Não foi possível carregar o reconhecimento de voz instalado. Baixe-o de novo em Configurações › Modelos."); }
  const addon = module.exports;
  if (REQUIRED.some((name) => typeof addon[name] !== "function")) throw new Error("O runtime de voz instalado não é compatível com esta versão do FalaTrace.");
  const native = addon as Addon;
  const handle = native.createSpeakerEmbeddingExtractor({ model: installation.modelPath, numThreads: 2, debug: 0, provider: "cpu" });
  const dim = native.speakerEmbeddingExtractorDim(handle);
  if (!Number.isSafeInteger(dim) || dim < 16 || dim > 4096) throw new Error("O modelo de voz instalado não é compatível com esta versão do FalaTrace.");
  const embedder: VoiceEmbedder = {
    dim, modelSha256: installation.modelSha256,
    embed: (samples) => {
      const stream = native.speakerEmbeddingExtractorCreateStream(handle);
      native.acceptWaveformOnline(stream, { sampleRate: VOICE_SAMPLE_RATE, samples });
      native.inputFinished(stream);
      if (!native.speakerEmbeddingExtractorIsReady(handle, stream)) throw new Error("Áudio insuficiente para calcular a voz.");
      const embedding = Float32Array.from(native.speakerEmbeddingExtractorComputeEmbedding(handle, stream, false));
      if (embedding.length !== dim || embedding.some((value) => !Number.isFinite(value))) throw new Error("O modelo de voz retornou um resultado inválido.");
      return embedding;
    }
  };
  cached = { key, embedder };
  return embedder;
};
