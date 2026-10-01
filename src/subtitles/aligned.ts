import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { buildSshArgs, getSshDestination } from "../jobs/remote";
import { runCommand } from "../jobs/command";
import {
  JOB_VERSION,
  validateJobId,
  validateMediaExtension,
  validateTranscript,
  type Transcript,
  type TranscriptSegment
} from "../jobs/types";
import { acquireSingleton } from "../runtime/singleton";

const MAX_SEGMENTS = 100_000;
const MAX_TEXT = 10_000_000;
const REMOTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export type AlignedSubtitleInput = {
  id: string;
  sourcePath: string;
  source: { size: number; sha256: string; fileName: string };
  archiveRelative: string;
};

export type AlignedSubtitle = Transcript & {
  mediaSha256: string;
  source: { archiveRelative: string; fileName: string; size: number };
  modelSource: { command: string; path: string; hash: string; threads: number; variant: string };
  generatedAt: string;
};

export type SubtitleDependencies = {
  run?: typeof runCommand;
  now?: () => Date;
  resolveArchiveDir?: (config: AppConfig) => Promise<string>;
  readRemoteWhisperConfig?: (config: AppConfig, run: typeof runCommand) => Promise<RemoteWhisperConfig>;
};

export type RemoteWhisperConfig = {
  home: string;
  command: string;
  modelPath: string;
  modelSha256: string;
  threads: number;
  variant: "cpu" | "vulkan";
  language: string;
};

const cacheRoot = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "subtitles");

const cachePath = (sha256: string): string => join(cacheRoot(), `${sha256.toLowerCase()}.json`);

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const shellDoubleQuote = (value: string): string => `"${value.replace(/[\\`\"]/g, "\\$&")}"`;

const validateInput = (input: AlignedSubtitleInput): AlignedSubtitleInput => {
  validateJobId(input.id);
  if (!isAbsoluteNormalized(input.sourcePath)) throw new Error("A origem local deve ser um caminho absoluto normalizado");
  if (!SHA256.test(input.source.sha256) || !Number.isSafeInteger(input.source.size) || input.source.size <= 0) {
    throw new Error("A fonte da legenda possui tamanho ou SHA-256 inválido");
  }
  if (!/^source\.[a-z0-9]+$/.test(input.source.fileName) || extname(input.source.fileName).toLowerCase() !== extname(input.sourcePath).toLowerCase()) {
    throw new Error("O nome da mídia arquivada não corresponde à origem");
  }
  validateMediaExtension(input.source.fileName);
  if (input.archiveRelative.startsWith("/")) throw new Error("archiveRelative inválido para a mídia arquivada");
  const relative = input.archiveRelative;
  const match = relative.match(/^(?:media\/)?(\d{4})\/(0[1-9]|1[0-2])\/([^/]+)$/i);
  if (!match || !UUID.test(match[3])) throw new Error("archiveRelative inválido para a mídia arquivada");
  return { ...input, source: { ...input.source, sha256: input.source.sha256.toLowerCase() }, archiveRelative: relative };
};

const isAbsoluteNormalized = (value: string): boolean =>
  typeof value === "string" && value.startsWith("/") && !/[\0\r\n]/.test(value) && resolve(value) === value;

const remoteArchiveRoot = (config: AppConfig, resolved?: string): string => {
  const value = resolved || config.remote.archiveDir;
  if (!value || /[\0\r\n]/.test(value) || (!value.startsWith("/") && !value.startsWith("~/"))) {
    throw new Error("O diretório remoto do archive é inválido");
  }
  if (value.split("/").some((part) => part === "..")) throw new Error("O diretório remoto do archive é inválido");
  if (value.startsWith("~/")) throw new Error("O diretório remoto do archive não foi resolvido");
  return value.replace(/\/+$/, "");
};

const readCached = async (path: string, sha256: string): Promise<AlignedSubtitle | undefined> => {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) return undefined;
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as AlignedSubtitle;
    const transcript = validateTranscript(parsed);
    if (parsed.mediaSha256?.toLowerCase() !== sha256.toLowerCase() || transcript.provider !== "whisper-cpp" || transcript.text.trim().length === 0 || transcript.segments.length === 0) return undefined;
    return { ...parsed, ...transcript };
  } catch { return undefined; }
};

export const findAlignedSubtitles = async (sha256: string): Promise<string | undefined> => {
  if (!SHA256.test(sha256)) return undefined;
  const path = cachePath(sha256);
  return (await readCached(path, sha256)) ? path : undefined;
};

const safeRemotePath = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.startsWith("/") || /[\0\r\n]/.test(value) || resolve(value) !== value) {
    throw new Error(`A configuração remota do Whisper possui ${field} inválido`);
  }
  return value;
};

export const readRemoteWhisperConfig = async (
  config: AppConfig,
  run: typeof runCommand = runCommand
): Promise<RemoteWhisperConfig> => {
  const script = "import hashlib,json,os,sys; c=json.load(open(sys.argv[1])); w=c.get('transcription',{}).get('whisperCpp',{}); m=w.get('modelPath'); print(json.dumps({'home':os.environ.get('HOME',''),'command':w.get('command'),'modelPath':m,'modelSha256':hashlib.file_digest(open(m,'rb'),'sha256').hexdigest() if isinstance(m,str) else None,'threads':w.get('threads'),'variant':w.get('variant'),'language':c.get('transcription',{}).get('language')}))";
  try {
    const result = await run("ssh", [
      ...buildSshArgs(config), getSshDestination(config),
      `python3 -c ${shellQuote(script)} "$HOME/.config/recording-cli/config.json"`
    ], { timeoutMs: 20_000 });
    const value = JSON.parse(result.stdout.trim()) as Partial<RemoteWhisperConfig>;
    const home = safeRemotePath(value.home, "HOME");
    const modelPath = safeRemotePath(value.modelPath, "modelPath");
    const command = value.command;
    const modelSha256 = value.modelSha256;
    const threads = value.threads;
    const variant = value.variant;
    const language = value.language;
    if (typeof command !== "string" || !command || /[\0\r\n]/.test(command) || typeof modelSha256 !== "string" || !SHA256.test(modelSha256) || typeof threads !== "number" || !Number.isInteger(threads) || threads < 1 || threads > 128 || (variant !== "cpu" && variant !== "vulkan") || typeof language !== "string") {
      throw new Error("invalid fields");
    }
    if (!/^(?:auto|[a-z]{2,3}(?:-[a-z]{2})?)$/i.test(language)) throw new Error("invalid language");
    return { home, command, modelPath, modelSha256: modelSha256.toLowerCase(), threads, variant, language };
  } catch { throw new Error("Não foi possível ler a configuração remota do Whisper"); }
};

export const parseAlignedWhisperJson = (raw: string, input: AlignedSubtitleInput, config: AppConfig, now: () => Date = () => new Date(), whisperOverride?: RemoteWhisperConfig): AlignedSubtitle => {
  let parsed: { result?: { language?: unknown }; transcription?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new Error("O Whisper remoto retornou JSON inválido"); }
  if (!Array.isArray(parsed.transcription) || parsed.transcription.length === 0 || parsed.transcription.length > MAX_SEGMENTS) {
    throw new Error("O Whisper remoto não produziu segmentos de legenda");
  }
  const segments: TranscriptSegment[] = [];
  for (const value of parsed.transcription) {
    if (!value || typeof value !== "object") throw new Error("O Whisper remoto retornou um segmento inválido");
    const item = value as Record<string, unknown>;
    const offsets = item.offsets as Record<string, unknown> | undefined;
    const start = offsets?.from;
    const end = offsets?.to;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof end !== "number" || !Number.isFinite(end) || end <= start || typeof item.text !== "string" || item.text.length > 10_000) {
      throw new Error("O Whisper remoto retornou offsets inválidos");
    }
    const text = item.text.trim();
    if (text) segments.push({ start: start / 1000, end: end / 1000, text });
  }
  if (!segments.length) throw new Error("O Whisper remoto retornou uma legenda vazia");
  segments.sort((left, right) => left.start - right.start || left.end - right.end);
  const generated = now();
  if (Number.isNaN(generated.getTime())) throw new Error("Relógio inválido ao gerar legenda");
  const whisper = whisperOverride || { ...config.transcription.whisperCpp, modelSha256: "" };
  const transcript: Transcript = {
    version: JOB_VERSION,
    provider: "whisper-cpp",
    model: whisper.modelPath,
    language: typeof parsed.result?.language === "string" ? parsed.result.language : config.transcription.language,
    text: segments.map((segment) => segment.text).join(" "),
    segments
  };
  return {
    ...transcript,
    mediaSha256: input.source.sha256,
    source: { archiveRelative: input.archiveRelative, fileName: input.source.fileName, size: input.source.size },
    modelSource: { command: whisper.command, path: whisper.modelPath, threads: whisper.threads, variant: whisper.variant, hash: whisper.modelSha256 },
    generatedAt: generated.toISOString()
  };
};

const remoteCommand = (config: AppConfig, input: AlignedSubtitleInput, stage: string, resolvedArchiveDir: string, whisper: RemoteWhisperConfig): string => {
  const archiveRoot = remoteArchiveRoot(config, resolvedArchiveDir);
  const source = `${archiveRoot}/${input.archiveRelative}/${input.source.fileName}`;
  const sourceAssignment = `source=${shellQuote(source)}`;
  const stageAssignment = stage.startsWith("$HOME/")
    ? `stage=${shellDoubleQuote(stage)}`
    : `stage=${shellQuote(stage)}`;
  const audio = `${stage}/audio.wav`;
  const output = `${stage}/whisper`;
  return [
    "set -eu",
    sourceAssignment,
    stageAssignment,
    `audio=\"$stage/audio.wav\"`,
    `output=\"$stage/whisper\"`,
    "umask 077; mkdir -p -- \"$stage\"; chmod 700 -- \"$stage\"",
    "test -f \"$source\" && test ! -L \"$source\"",
    "source_real=$(realpath -e -- \"$source\"); test \"$source_real\" = \"$source\"",
    `test "$(stat -c '%s' -- \"$source\")" = ${shellQuote(String(input.source.size))}`,
    `test "$(sha256sum -- \"$source\" | cut -d ' ' -f1)" = ${shellQuote(input.source.sha256)}`,
    `ffmpeg -hide_banner -loglevel error -y -i \"$source\" -map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le \"$audio\" >\"$stage/ffmpeg.log\" 2>&1`,
    `${shellQuote(whisper.command)} -m ${shellQuote(whisper.modelPath)} -f \"$audio\" -l ${shellQuote(whisper.language)} -t ${shellQuote(String(whisper.threads))} -oj -of \"$output\" -np -ml 80 -sow >\"$stage/whisper.log\" 2>&1`,
    "test -s \"$output.json\""
  ].join("; ");
};

export const createAlignedSubtitles = async (
  config: AppConfig,
  input: AlignedSubtitleInput,
  dependencies: SubtitleDependencies = {}
): Promise<{ path: string; segments: number }> => {
  const validated = validateInput(input);
  const path = cachePath(validated.source.sha256);
  const existing = await findAlignedSubtitles(validated.source.sha256);
  if (existing) {
    const parsed = await readCached(existing, validated.source.sha256);
    if (!parsed) throw new Error("O cache de legendas existente diverge da origem");
    return { path: existing, segments: parsed.segments.length };
  }
  const lease = await acquireSingleton(`subtitles-${validated.source.sha256.slice(0, 16)}`);
  try {
    const inside = await findAlignedSubtitles(validated.source.sha256);
    if (inside) {
      const parsed = await readCached(inside, validated.source.sha256);
      if (!parsed) throw new Error("O cache de legendas existente diverge da origem");
      return { path: inside, segments: parsed.segments.length };
    }
    await fs.mkdir(cacheRoot(), { recursive: true, mode: 0o700 });
    const run = dependencies.run || runCommand;
    const remoteWhisper = dependencies.readRemoteWhisperConfig
      ? await dependencies.readRemoteWhisperConfig(config, run)
      : await readRemoteWhisperConfig(config, run);
    const configuredArchiveDir = dependencies.resolveArchiveDir
      ? await dependencies.resolveArchiveDir(config)
      : config.remote.archiveDir;
    const archiveDir = configuredArchiveDir.startsWith("~/")
      ? `${remoteWhisper.home}/${configuredArchiveDir.slice(2).replace(/\/+$/, "")}`
      : configuredArchiveDir;
    const stage = `${remoteWhisper.home}/.local/share/recording-cli/subtitles/${validated.source.sha256}.partial-${randomUUID()}`;
    const command = [
      "ssh",
      ...buildSshArgs(config),
      getSshDestination(config),
      remoteCommand(config, validated, stage, archiveDir, remoteWhisper)
    ];
    const localRaw = join(cacheRoot(), `.${validated.source.sha256}.${randomUUID()}.json`);
    try {
      try {
        await run(command[0], command.slice(1), { timeoutMs: REMOTE_TIMEOUT_MS });
      } catch {
        throw new Error("A geração de legendas no VAIO falhou");
      }
      const env = { ...process.env, RSYNC_RSH: ["ssh", ...buildSshArgs(config)].map(shellQuote).join(" ") };
      try {
        await run("rsync", ["--protect-args", `${getSshDestination(config)}:${stage}/whisper.json`, localRaw], { env, timeoutMs: REMOTE_TIMEOUT_MS });
      } catch {
        throw new Error("Não foi possível transferir a legenda gerada pelo VAIO");
      }
      const subtitle = parseAlignedWhisperJson(await fs.readFile(localRaw, "utf8"), validated, config, dependencies.now || (() => new Date()), remoteWhisper);
      const serialized = JSON.stringify(subtitle, null, 2);
      if (Buffer.byteLength(serialized) > MAX_TEXT) throw new Error("A legenda alinhada excede o limite permitido");
      await fs.writeFile(`${localRaw}.validated`, serialized, { mode: 0o600 });
      try { await fs.link(`${localRaw}.validated`, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const concurrent = await findAlignedSubtitles(validated.source.sha256);
        if (!concurrent) throw new Error("O cache de legendas existente diverge da origem");
      }
      const final = await readCached(path, validated.source.sha256);
      if (!final) throw new Error("O cache de legendas publicado não pôde ser validado");
      return { path, segments: final.segments.length };
    } finally {
      await fs.rm(localRaw, { force: true });
      await fs.rm(`${localRaw}.validated`, { force: true });
      await run("ssh", [...buildSshArgs(config), getSshDestination(config), `rm -rf -- ${shellQuote(stage)}`], { timeoutMs: 20_000 }).catch(() => undefined);
    }
  } finally { await lease.release(); }
};
