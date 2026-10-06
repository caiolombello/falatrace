import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults";

/**
 * Explicit model downloads. Nothing here runs unless the user starts it: the Studio
 * shows the source, size and destination first, and the CLI requires the model name.
 * Whisper files are verified against the size and SHA-256 published for the pinned
 * whisper.cpp repository before they replace anything; Ollama pulls go only to a
 * loopback Ollama server, which performs its own verification.
 */
export type WhisperModel = {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  quality: string;
  recommended?: boolean;
};

/** Sizes and SHA-256 from the Hugging Face LFS metadata of ggerganov/whisper.cpp, read 2026-10-05. */
export const WHISPER_MODELS: WhisperModel[] = [
  { id: "tiny", file: "ggml-tiny.bin", bytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", quality: "Muito rápido, menos preciso. Bom para testar." },
  { id: "base", file: "ggml-base.bin", bytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", quality: "Rápido, precisão básica." },
  { id: "small", file: "ggml-small.bin", bytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", quality: "Equilibrado para CPUs modestas." },
  { id: "medium-q5_0", file: "ggml-medium-q5_0.bin", bytes: 539_212_467, sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f", quality: "Preciso, quantizado." },
  { id: "large-v3-turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", bytes: 574_041_195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", quality: "Padrão do FalaTrace: rápido e preciso.", recommended: true },
  { id: "large-v3-turbo-q8_0", file: "ggml-large-v3-turbo-q8_0.bin", bytes: 874_188_075, sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", quality: "Turbo com um pouco mais de precisão." },
  { id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", bytes: 1_624_555_275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", quality: "Turbo sem quantização; mais memória." },
  { id: "large-v3", file: "ggml-large-v3.bin", bytes: 3_095_033_483, sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2", quality: "Máxima precisão; lento sem GPU." }
];

export const WHISPER_SOURCE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

export const whisperModelsDir = (): string => dirname(DEFAULT_CONFIG.transcription.whisperCpp.modelPath);

export const findWhisperModel = (id: unknown): WhisperModel => {
  const model = WHISPER_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error("Modelo desconhecido.");
  return model;
};

export const modelStateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "recording-cli", "models");

export type DownloadKind = "whisper" | "ollama";
/** The file a SHA-256 check accepted; a file with another identity has to be checked again. */
export type VerifiedFile = { size: number; mtimeMs: number; ino: number };
export type DownloadState = {
  kind: DownloadKind;
  id: string;
  state: "running" | "completed" | "failed";
  receivedBytes: number;
  totalBytes: number | null;
  path?: string;
  verified?: VerifiedFile;
  error?: string;
  updatedAt: string;
};

// A digest of the whole id: two long Ollama names that share a prefix never share a state file.
const stateFile = (kind: DownloadKind, id: string): string =>
  join(modelStateDir(), `${kind}-${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);

export const writeDownloadState = async (state: Omit<DownloadState, "updatedAt">): Promise<void> => {
  await fs.mkdir(modelStateDir(), { recursive: true, mode: 0o700 });
  const target = stateFile(state.kind, state.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.rename(temporary, target);
};

export const readDownloadState = async (kind: DownloadKind, id: string): Promise<DownloadState | null> => {
  const raw = await fs.readFile(stateFile(kind, id), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DownloadState;
    return value && value.kind === kind && value.id === id ? value : null;
  } catch {
    return null;
  }
};

export const fileIdentity = async (path: string): Promise<VerifiedFile> => {
  const stat = await fs.lstat(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
};

/**
 * A Whisper model counts as installed only when its file is the one a download or an
 * existing-file check accepted by SHA-256. The right size alone is not trusted.
 */
export const isVerifiedWhisperModel = async (model: WhisperModel, path: string): Promise<boolean> => {
  const [stat, state] = await Promise.all([fs.lstat(path).catch(() => null), readDownloadState("whisper", model.id)]);
  const receipt = state?.state === "completed" && state.path === path ? state.verified : undefined;
  return !!stat?.isFile() && !!receipt && stat.size === model.bytes &&
    receipt.size === stat.size && receipt.mtimeMs === stat.mtimeMs && receipt.ino === stat.ino;
};

export type WhisperDownloadDeps = {
  fetch: typeof fetch;
  directory: string;
  onProgress: (receivedBytes: number) => Promise<void> | void;
  signal?: AbortSignal;
  /** Opens the partial file; tests swap in a device that fails writes. */
  open?: (path: string) => Promise<FileHandle>;
};

/** Download, verify and publish one Whisper model. An existing verified file is reused. */
export const downloadWhisperModel = async (id: string, deps: WhisperDownloadDeps): Promise<string> => {
  const model = findWhisperModel(id);
  await fs.mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const destination = join(deps.directory, model.file);
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("O destino do modelo não é um arquivo comum.");
    if (existing.size === model.bytes && await sha256File(destination) === model.sha256) return destination;
    throw new Error("Já existe um arquivo diferente com o nome deste modelo; ele foi preservado.");
  }
  // One unit per model: partial files left by a cancelled or killed attempt are stale now.
  for (const name of await fs.readdir(deps.directory).catch(() => [] as string[])) {
    if (name.startsWith(`.${model.file}.partial-`)) await fs.rm(join(deps.directory, name), { force: true }).catch(() => undefined);
  }
  const partial = join(deps.directory, `.${model.file}.partial-${randomUUID()}`);
  const response = await deps.fetch(WHISPER_SOURCE + model.file, { redirect: "follow", signal: deps.signal });
  if (!response.ok || !response.body) throw new Error(`O servidor respondeu ${response.status}.`);
  if (!response.url.startsWith("https://")) throw new Error("O download foi redirecionado para um endereço sem HTTPS.");
  const hash = createHash("sha256");
  let received = 0;
  let lastReport = 0;
  try {
    // Awaited writes on a file handle: a full or failing disk rejects here instead of
    // emitting an unhandled stream error that would end the downloader without a state.
    const output = await (deps.open ?? ((path: string) => fs.open(path, "wx", 0o600)))(partial);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > model.bytes) throw new Error("O arquivo recebido é maior que o esperado.");
        hash.update(value);
        for (let offset = 0; offset < value.byteLength;) offset += (await output.write(value, offset)).bytesWritten;
        if (received - lastReport >= 8 * 1024 * 1024) {
          lastReport = received;
          await deps.onProgress(received);
        }
      }
    } finally {
      await output.close();
    }
    if (received !== model.bytes || hash.digest("hex") !== model.sha256) {
      throw new Error("O arquivo baixado não confere com o tamanho e o SHA-256 publicados; ele foi descartado.");
    }
    await fs.chmod(partial, 0o644);
    await fs.link(partial, destination);
    await deps.onProgress(received);
    return destination;
  } finally {
    await fs.rm(partial, { force: true }).catch(() => undefined);
  }
};

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
};

export const isLoopbackOllama = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

export const validateOllamaModelName = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?(?::[A-Za-z0-9._-]+)?$/.test(value) || value.length > 120) {
    throw new Error("Nome de modelo do Ollama inválido.");
  }
  return value;
};

/** Ask a loopback Ollama server to pull a model, streaming its progress lines. */
export const pullOllamaModel = async (
  baseUrl: string,
  model: string,
  deps: { fetch: typeof fetch; onProgress: (completed: number, total: number | null, status: string) => Promise<void> | void; signal?: AbortSignal }
): Promise<void> => {
  if (!isLoopbackOllama(baseUrl)) throw new Error("O download pelo Ollama só é feito para um Ollama neste computador.");
  const name = validateOllamaModelName(model);
  const response = await deps.fetch(new URL("/api/pull", baseUrl), {
    method: "POST", redirect: "error", signal: deps.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: true })
  });
  if (!response.ok || !response.body) throw new Error(`O Ollama respondeu ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 1024 * 1024) throw new Error("Resposta do Ollama grande demais.");
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
      if (typeof event.error === "string") throw new Error(`Ollama: ${event.error.slice(0, 200)}`);
      const completed = typeof event.completed === "number" ? event.completed : 0;
      const total = typeof event.total === "number" ? event.total : null;
      const status = typeof event.status === "string" ? event.status.slice(0, 120) : "";
      if (status === "success" || Date.now() - last > 1000) {
        last = Date.now();
        await deps.onProgress(completed, total, status);
      }
    }
  }
};
