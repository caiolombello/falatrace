import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { acquireSingleton } from "../runtime/singleton";
import { DownloadInProgressError, fileIdentity, sha256File, whisperModelsDir, type VerifiedFile } from "./downloads";

/**
 * Local voice recognition, installed only on request: the sherpa-onnx native runtime
 * (from its npm package, not a project dependency) and one speaker-embedding model
 * (from the sherpa-onnx release). The archive, each runtime file and the model are
 * checked against the sizes and SHA-256 pinned here before anything is published, and
 * the runtime is later loaded only from files whose identity that check recorded.
 */
export type PinnedFile = { name: string; bytes: number; sha256: string };

/** Pins read on 2026-10-20: npm integrity (sha512) of the archive verified, SHA-256 computed;
 * the model SHA-256 is the one in the release's checksum.txt. Both Apache-2.0. */
export const VOICE_PACKAGE = {
  id: "eres2net-base",
  runtime: {
    version: "1.13.8",
    url: "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz",
    bytes: 11_089_653,
    sha256: "13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c",
    files: [
      { name: "sherpa-onnx.node", bytes: 974_496, sha256: "d8f1181559e7aecaa99493e8c441c16a4d51a18a1f3fcdf48fd7884e510f3767" },
      { name: "libsherpa-onnx-c-api.so", bytes: 5_116_576, sha256: "b1019f8c9583e3e576c2ba6032b580677fcf6e2230c241a8b423c65aceded021" },
      { name: "libonnxruntime.so", bytes: 27_026_609, sha256: "4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e" }
    ] as PinnedFile[]
  },
  model: {
    name: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    bytes: 39_593_761,
    sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"
  }
};

export const voiceDownloadBytes = (): number => VOICE_PACKAGE.runtime.bytes + VOICE_PACKAGE.model.bytes;
export const voiceDir = (): string => join(whisperModelsDir(), "voice");
export const voiceRuntimeDir = (directory = voiceDir()): string => join(directory, `runtime-${VOICE_PACKAGE.runtime.version}`);
export const voiceModelPath = (directory = voiceDir()): string => join(directory, VOICE_PACKAGE.model.name);
const receiptPath = (directory: string): string => join(directory, "installed.json");

export const VOICE_UNSUPPORTED = "O reconhecimento de voz está disponível só em Linux x86-64 nesta versão.";
export const voicePlatformSupported = (): boolean => process.platform === "linux" && process.arch === "x64";

export type VoiceInstallation = { runtimeDir: string; modelPath: string; modelSha256: string };
type Receipt = { version: 1; runtime: string; model: string; files: Record<string, VerifiedFile> };

/** Regular-file members of a ustar archive by exact name; nothing is written from archive names. */
export const readTarMembers = (archive: Buffer, wanted: ReadonlySet<string>): Map<string, Buffer> => {
  const found = new Map<string, Buffer>();
  const text = (header: Buffer, start: number, length: number): string => {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
  };
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 257, 6).startsWith("ustar") ? text(header, 345, 155) : "";
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error("O pacote de voz está corrompido.");
    const type = header[156];
    const path = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    // "0" or NUL: a regular file. Links, directories and extended headers are never extracted.
    if ((type === 0x30 || type === 0) && wanted.has(path)) {
      if (found.has(path)) throw new Error("O pacote de voz repete um arquivo esperado.");
      found.set(path, Buffer.from(archive.subarray(offset, offset + size)));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return found;
};

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const verifiedOnDisk = async (path: string, pinned: PinnedFile): Promise<boolean> => {
  const stat = await fs.lstat(path).catch(() => null);
  return !!stat?.isFile() && !stat.isSymbolicLink() && stat.size === pinned.bytes && await sha256File(path) === pinned.sha256;
};

export type VoiceDownloadDeps = {
  fetch: typeof fetch;
  directory?: string;
  onProgress: (receivedBytes: number) => Promise<void> | void;
  signal?: AbortSignal;
};

/** Streams one pinned file into memory or a handle, refusing anything larger or different. */
const fetchPinned = async (
  url: string, pinned: { bytes: number; sha256: string }, deps: VoiceDownloadDeps, base: number,
  write: (chunk: Uint8Array) => Promise<void>
): Promise<void> => {
  const response = await deps.fetch(url, { redirect: "follow", signal: deps.signal });
  if (!response.ok || !response.body) throw new Error(`O servidor respondeu ${response.status}.`);
  if (!response.url.startsWith("https://")) throw new Error("O download foi redirecionado para um endereço sem HTTPS.");
  const hash = createHash("sha256");
  let received = 0, lastReport = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > pinned.bytes) throw new Error("O arquivo recebido é maior que o esperado.");
    hash.update(value);
    await write(value);
    if (received - lastReport >= 4 * 1024 * 1024) { lastReport = received; await deps.onProgress(base + received); }
  }
  if (received !== pinned.bytes || hash.digest("hex") !== pinned.sha256) throw new Error("O arquivo baixado não confere com o tamanho e o SHA-256 fixados; ele foi descartado.");
  await deps.onProgress(base + received);
};

const CONFLICT = "Já existe um arquivo diferente na pasta do reconhecimento de voz; ele foi preservado. Mova ou apague essa pasta para instalar de novo.";

const installRuntime = async (directory: string, deps: VoiceDownloadDeps): Promise<void> => {
  const runtime = VOICE_PACKAGE.runtime;
  const target = voiceRuntimeDir(directory);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(CONFLICT);
    for (const file of runtime.files) if (!await verifiedOnDisk(join(target, file.name), file)) throw new Error(CONFLICT);
    await deps.onProgress(runtime.bytes);
    return;
  }
  const chunks: Uint8Array[] = [];
  await fetchPinned(runtime.url, runtime, deps, 0, async (chunk) => { chunks.push(chunk); });
  const members = readTarMembers(gunzipSync(Buffer.concat(chunks)), new Set(runtime.files.map((file) => `package/${file.name}`)));
  const staging = join(directory, `.runtime-${runtime.version}.partial-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of runtime.files) {
      const data = members.get(`package/${file.name}`);
      if (!data || data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error("O pacote de voz não contém os arquivos esperados; nada foi instalado.");
      await fs.writeFile(join(staging, file.name), data, { mode: 0o600, flag: "wx" });
    }
    await fs.chmod(staging, 0o700);
    // A directory that appeared meanwhile is kept, as for any model file.
    await fs.rename(staging, target).catch((error: NodeJS.ErrnoException) => {
      throw ["EEXIST", "ENOTEMPTY"].includes(error.code || "") ? new Error(CONFLICT) : error;
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
};

const installModel = async (directory: string, deps: VoiceDownloadDeps): Promise<void> => {
  const model = VOICE_PACKAGE.model;
  const destination = voiceModelPath(directory);
  const base = VOICE_PACKAGE.runtime.bytes;
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing) {
    if (!await verifiedOnDisk(destination, model)) throw new Error(CONFLICT);
    await deps.onProgress(base + model.bytes);
    return;
  }
  for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
    if (name.startsWith(`.${model.name}.partial-`)) await fs.rm(join(directory, name), { force: true }).catch(() => undefined);
  }
  const partial = join(directory, `.${model.name}.partial-${randomUUID()}`);
  try {
    const output = await fs.open(partial, "wx", 0o600);
    try {
      await fetchPinned(model.url, model, deps, base, async (chunk) => {
        for (let offset = 0; offset < chunk.byteLength;) offset += (await output.write(chunk, offset)).bytesWritten;
      });
    } finally { await output.close(); }
    await fs.link(partial, destination).catch((error: NodeJS.ErrnoException) => { throw error.code === "EEXIST" ? new Error(CONFLICT) : error; });
  } finally {
    await fs.rm(partial, { force: true }).catch(() => undefined);
  }
};

/** Downloads, verifies and publishes the runtime and the model, then records their identities. */
export const downloadVoicePackage = async (deps: VoiceDownloadDeps): Promise<VoiceInstallation> => {
  if (!voicePlatformSupported()) throw new Error(VOICE_UNSUPPORTED);
  const lease = await acquireSingleton("voice-download").catch(() => {
    throw new DownloadInProgressError("O reconhecimento de voz já está sendo baixado. Aguarde o download em andamento terminar.");
  });
  try {
    const directory = deps.directory || voiceDir();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await installRuntime(directory, deps);
    await installModel(directory, deps);
    const files: Record<string, VerifiedFile> = {};
    for (const file of VOICE_PACKAGE.runtime.files) files[`runtime/${file.name}`] = await fileIdentity(join(voiceRuntimeDir(directory), file.name));
    files.model = await fileIdentity(voiceModelPath(directory));
    const receipt: Receipt = { version: 1, runtime: VOICE_PACKAGE.runtime.sha256, model: VOICE_PACKAGE.model.sha256, files };
    const temporary = `${receiptPath(directory)}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await fs.rename(temporary, receiptPath(directory));
    return { runtimeDir: voiceRuntimeDir(directory), modelPath: voiceModelPath(directory), modelSha256: VOICE_PACKAGE.model.sha256 };
  } finally {
    await lease.release();
  }
};

/** Installed only when every file is the one the download verified: a changed file needs a new download. */
export const readVoiceInstallation = async (directory = voiceDir()): Promise<VoiceInstallation | undefined> => {
  if (!voicePlatformSupported()) return undefined;
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath(directory), "utf8")) as Receipt;
    if (receipt?.version !== 1 || receipt.runtime !== VOICE_PACKAGE.runtime.sha256 || receipt.model !== VOICE_PACKAGE.model.sha256) return undefined;
    const expected: Array<[string, string]> = [
      ...VOICE_PACKAGE.runtime.files.map((file): [string, string] => [`runtime/${file.name}`, join(voiceRuntimeDir(directory), file.name)]),
      ["model", voiceModelPath(directory)]
    ];
    for (const [key, path] of expected) {
      const stat = await fs.lstat(path);
      const seen = receipt.files?.[key];
      if (!stat.isFile() || stat.isSymbolicLink() || !seen || seen.size !== stat.size || seen.mtimeMs !== stat.mtimeMs || seen.ctimeMs !== stat.ctimeMs || seen.ino !== stat.ino) return undefined;
    }
    return { runtimeDir: voiceRuntimeDir(directory), modelPath: voiceModelPath(directory), modelSha256: VOICE_PACKAGE.model.sha256 };
  } catch { return undefined; }
};
