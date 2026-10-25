import type { AppConfig } from "../config/defaults";
import { LIBRARY_INDEX_LIMITS } from "./store";

/**
 * Optional semantic search through a local Ollama embedding model (`assistant.embeddingModel`).
 * Only a loopback Ollama is used: building the index must never send meeting text off this computer.
 */

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const MAX_INPUT_CHARACTERS = 2_000;
const MAX_BATCH = 16;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
/** A question waits less than indexing: search falls back to keywords instead. */
export const QUERY_TIMEOUT_MS = 15_000;

export type EmbeddingDeps = { fetch?: typeof fetch };

/** Embedding settings, or undefined when semantic search is off or Ollama is not on this computer. */
export const embeddingTarget = (config: AppConfig): { url: URL; model: string } | undefined => {
  const model = config.assistant.embeddingModel.trim();
  if (!model) return undefined;
  let base: URL;
  try { base = new URL(config.summary.ollamaUrl); } catch { return undefined; }
  if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;
  if (!LOOPBACK.includes(base.hostname) || base.username || base.password) return undefined;
  return { url: new URL("/api/embed", base), model };
};

const readBounded = async (response: Response, maximum: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel().catch(() => undefined); throw new Error("Resposta de embeddings grande demais"); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
};

/** Vectors for `texts`, in order, from `POST /api/embed`. Throws on any malformed answer. */
export const embedTexts = async (
  target: { url: URL; model: string },
  texts: ReadonlyArray<string>,
  options: { signal?: AbortSignal; deps?: EmbeddingDeps; timeoutMs?: number } = {}
): Promise<Float32Array[]> => {
  const request = options.deps?.fetch ?? fetch;
  const vectors: Float32Array[] = [];
  let dims = 0;
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
    options.signal?.throwIfAborted();
    const input = texts.slice(offset, offset + MAX_BATCH).map((text) => text.slice(0, MAX_INPUT_CHARACTERS));
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const response = await request(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ model: target.model, input, truncate: true }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`Ollama embeddings HTTP ${response.status}`); }
    let body: unknown;
    try { body = JSON.parse(await readBounded(response, MAX_RESPONSE_BYTES)); } catch { throw new Error("Resposta de embeddings inválida"); }
    const embeddings = body && typeof body === "object" ? (body as { embeddings?: unknown }).embeddings : undefined;
    if (!Array.isArray(embeddings) || embeddings.length !== input.length) throw new Error("Resposta de embeddings inválida");
    for (const raw of embeddings) {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIBRARY_INDEX_LIMITS.embeddingDimensions) throw new Error("Resposta de embeddings inválida");
      if (dims && raw.length !== dims) throw new Error("Resposta de embeddings inválida");
      dims = raw.length;
      const vector = new Float32Array(raw.length);
      raw.forEach((value, index) => {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Resposta de embeddings inválida");
        vector[index] = value;
      });
      vectors.push(normalizeVector(vector));
    }
  }
  return vectors;
};

/** Unit length, so cosine similarity is a dot product. A zero vector stays zero. */
export const normalizeVector = (vector: Float32Array): Float32Array => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!norm) return vector;
  for (let index = 0; index < vector.length; index++) vector[index] = vector[index]! / norm;
  return vector;
};

export const dot = (left: Float32Array, right: Float32Array): number => {
  if (left.length !== right.length) return 0;
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!;
  return sum;
};

export const encodeVector = (vector: Float32Array): string =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");

export const decodeVector = (encoded: string, dims: number): Float32Array => {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== dims * 4) throw new Error("Vetor de embeddings inválido");
  // Copy into an aligned buffer; a Buffer view may start at any byte offset.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
};

/** Reciprocal-rank fusion of several rankings (ids best first). */
export const reciprocalRankFusion = (rankings: ReadonlyArray<ReadonlyArray<string>>, k = 60): Map<string, number> => {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [rank, id] of ranking.entries()) scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
  }
  return scores;
};
