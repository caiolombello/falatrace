import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { validateJobId } from "../jobs/types";

// The tombstone lives at the recording level, next to the job artifact folders:
//   <dirname(sourcePath)>/<name>.recording/media-retention.json
// It never changes a job record, so job identities, removal plans and retention
// ages stay valid, and deleting the recording moves it to Trash with the rest.

export const MEDIA_RETENTION_FILE = "media-retention.json";
export const RETAINED_AUDIO_FILE = "retained-audio.mka";
export const MEDIA_RETENTION_LIMITS = Object.freeze({
  tombstoneBytes: 64 * 1024,
  jobs: 64,
  audioStreams: 32,
  titleCharacters: 200
});

/** Every fixed message this module can show; the bridge whitelists them and i18n translates them. */
export const MEDIA_RETENTION_MESSAGES = Object.freeze({
  modeKeep: "A política de mídia está em manter; nada será removido.",
  noJobs: "Esta gravação ainda não foi processada; a mídia foi mantida.",
  jobsUnreadable: "Não foi possível ler os processamentos desta gravação; a mídia foi mantida.",
  jobNotSettled: "Há um processamento em andamento para esta gravação; a mídia foi mantida.",
  mediaIdentityConflict: "Os processamentos desta gravação não concordam sobre a mídia; ela foi mantida.",
  captureActive: "Esta gravação ainda está sendo capturada; a mídia foi mantida.",
  captureUnreadable: "Não foi possível conferir a captura em andamento; a mídia foi mantida.",
  diarizationRunning: "A identificação de falantes está em andamento; a mídia foi mantida.",
  speakersRunning: "A sugestão de nomes de falantes está em andamento; a mídia foi mantida.",
  summaryRunning: "Um resumo revisado está sendo gerado; a mídia foi mantida.",
  summaryStateUnreadable: "Não foi possível conferir os resumos revisados; a mídia foi mantida.",
  visualRunning: "A análise de quadros está em andamento; a mídia foi mantida.",
  transcriptMissing: "Não há uma transcrição concluída e verificada; a mídia foi mantida.",
  transcriptLegacy: "A transcrição não tem recibo de verificação; a remoção automática não se aplica. Remova manualmente, se quiser.",
  summaryInvalid: "O resumo não confere com a transcrição; a mídia foi mantida.",
  stepsPending: "Aguardando o prazo para identificar falantes e aprender vozes; a mídia será removida depois.",
  backupPending: "Os backups da mídia ainda não terminaram; a mídia foi mantida.",
  backupMismatch: "O backup registrado não corresponde a esta mídia; ela foi mantida.",
  protonBackupPending: "O backup completo no Proton ainda não terminou; a mídia foi mantida.",
  mediaMissing: "A mídia original não está neste computador.",
  mediaUnsafe: "A mídia não é um arquivo comum dentro da pasta de gravações; ela foi mantida.",
  mediaSizeMismatch: "O tamanho da mídia mudou; ela foi mantida.",
  mediaHashMismatch: "O conteúdo da mídia mudou (SHA-256 diferente); ela foi mantida.",
  mediaChanged: "A mídia mudou durante a verificação; ela foi mantida.",
  recordingRootUnsafe: "A pasta da gravação é insegura ou não confere; a mídia foi mantida.",
  alreadyRemoved: "A mídia desta gravação já foi removida.",
  noVideo: "A gravação já é só áudio; não há vídeo para remover.",
  noAudio: "A gravação não tem trilhas de áudio para manter; a mídia foi mantida.",
  probeFailed: "Não foi possível examinar as trilhas da mídia; ela foi mantida.",
  planChanged: "A situação da gravação mudou; revise a remoção da mídia de novo.",
  busy: "Outra remoção de mídia desta gravação está em andamento.",
  workStarted: "Um processamento começou nesta gravação; a mídia foi mantida.",
  audioFailed: "Não foi possível manter só o áudio; a mídia original foi preservada.",
  audioMismatch: "O áudio extraído não preservou todas as trilhas; a mídia original foi preservada.",
  retainedAudioInvalid: "O áudio mantido desta gravação está ausente ou foi alterado.",
  removeFailed: "Não foi possível apagar a mídia original; ela foi mantida.",
  purgeFailed: "A mídia foi removida, mas cópias derivadas não puderam ser apagadas; tente de novo.",
  tombstoneInvalid: "O registro de retenção da mídia é inválido; ele foi preservado.",
  tombstoneChanged: "O registro de retenção da mídia mudou em outro processo; tente de novo.",
  evidenceRemoved: "A mídia desta gravação foi removida pela política de retenção.",
  evidenceVideoRemoved: "O vídeo desta gravação foi removido pela política de retenção; só o áudio continua disponível.",
  evidenceChanged: "A mídia mudou e não corresponde mais à transcrição.",
  reprocessRefused: "Mídia removida pela política de retenção; não é possível reprocessar.",
  modeInvalid: "Escolha o que manter: só a transcrição ou só o áudio.",
  consentRequired: "Confirme a remoção da mídia antes de continuar.",
  passFailed: "Não foi possível conferir a retenção de mídia nesta execução; nada foi removido."
} as const);

export type MediaRetentionMessage = (typeof MEDIA_RETENTION_MESSAGES)[keyof typeof MEDIA_RETENTION_MESSAGES];

export class MediaRetentionError extends Error {
  constructor(message: MediaRetentionMessage, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaRetentionError";
  }
}

export type RetainedMode = "transcript-only" | "audio-only";
export type PurgeKind = "proton-restore-cache" | "visual-frames" | "work-temp-audio";
export const PURGE_KINDS: readonly PurgeKind[] = Object.freeze(["proton-restore-cache", "visual-frames", "work-temp-audio"]);

export type RetainedAudioStream = { index: number; title?: string; channels: number; codec: string };
export type RetainedAudio = {
  fileName: typeof RETAINED_AUDIO_FILE;
  size: number;
  sha256: string;
  streams: RetainedAudioStream[];
  durationSeconds: number;
};

export type MediaRetentionVerified = {
  jobId: string;
  receipt: "verified" | "legacy-unverified";
  transcriptArtifactSha256: string;
  receiptSha256?: string;
  summarySha256?: string;
  diarizationSha256?: string;
  microphone: "ready" | "failed" | "skipped";
  voices: "ready" | "skipped";
  backups: { vaio?: string; proton?: string; protonJobBackup?: string };
};

export type MediaRetentionTombstone = {
  version: 1;
  sourcePath: string;
  source: { fileName: string; size: number; sha256: string; mtimeMs: number };
  jobs: string[];
  mode: RetainedMode;
  reason: "policy" | "manual";
  state: "removing" | "removed";
  /** When this removal began; `removedAt` is set only once the state is "removed". */
  startedAt: string;
  removedAt?: string;
  verified: MediaRetentionVerified;
  audio?: RetainedAudio;
  purged: PurgeKind[];
};

export type StoredTombstone = { tombstone: MediaRetentionTombstone; raw: string; sha256: string };

const SHA256 = /^[a-f0-9]{64}$/;
// C0/C1 controls and line/paragraph separators never belong in a path or a title.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
export const hasControlCharacters = (text: string): boolean => CONTROL.test(text);

export const digestText = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

export const recordingRootOf = (sourcePath: string): string => {
  const absolute = resolve(sourcePath);
  return join(dirname(absolute), `${parse(absolute).name}.recording`);
};
export const tombstonePathOf = (sourcePath: string): string => join(recordingRootOf(sourcePath), MEDIA_RETENTION_FILE);
export const retainedAudioPathOf = (sourcePath: string): string => join(recordingRootOf(sourcePath), RETAINED_AUDIO_FILE);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isoDate = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const sha = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const safeInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const safeTitle = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MEDIA_RETENTION_LIMITS.titleCharacters && !CONTROL.test(value);

const invalid = (): never => { throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid); };

/** Rebuilds a stream description field by field; shared with the executor's ffprobe check. */
export const validateRetainedStreams = (value: unknown): RetainedAudioStream[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MEDIA_RETENTION_LIMITS.audioStreams) return invalid();
  return value.map((item, position) => {
    if (!isRecord(item) || !exactKeys(item, ["index", "channels", "codec"], ["title"]) || item.index !== position ||
      !safeInteger(item.channels, 1, 64) || typeof item.codec !== "string" || !/^[a-z0-9_]{1,40}$/.test(item.codec) ||
      (item.title !== undefined && !safeTitle(item.title))) return invalid();
    return { index: item.index, ...(item.title !== undefined ? { title: item.title } : {}), channels: item.channels, codec: item.codec };
  });
};

const validateAudio = (value: unknown): RetainedAudio => {
  if (!isRecord(value) || !exactKeys(value, ["fileName", "size", "sha256", "streams", "durationSeconds"]) || value.fileName !== RETAINED_AUDIO_FILE ||
    !safeInteger(value.size, 1, Number.MAX_SAFE_INTEGER) || !sha(value.sha256) ||
    typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 7 * 86_400) return invalid();
  return { fileName: RETAINED_AUDIO_FILE, size: value.size, sha256: value.sha256, streams: validateRetainedStreams(value.streams), durationSeconds: value.durationSeconds };
};

const validateVerified = (value: unknown, jobs: string[]): MediaRetentionVerified => {
  if (!isRecord(value) || !exactKeys(value, ["jobId", "receipt", "transcriptArtifactSha256", "microphone", "voices", "backups"],
    ["receiptSha256", "summarySha256", "diarizationSha256"])) return invalid();
  if (typeof value.jobId !== "string" || !jobs.includes(value.jobId) || !["verified", "legacy-unverified"].includes(value.receipt as string) ||
    !sha(value.transcriptArtifactSha256) || (value.receipt === "verified") !== sha(value.receiptSha256) ||
    (value.receipt !== "verified" && value.receiptSha256 !== undefined) ||
    (value.summarySha256 !== undefined && !sha(value.summarySha256)) || (value.diarizationSha256 !== undefined && !sha(value.diarizationSha256)) ||
    !["ready", "failed", "skipped"].includes(value.microphone as string) || !["ready", "skipped"].includes(value.voices as string)) return invalid();
  const backups = value.backups;
  if (!isRecord(backups) || !exactKeys(backups, [], ["vaio", "proton", "protonJobBackup"]) ||
    Object.values(backups).some((at) => !isoDate(at))) return invalid();
  return {
    jobId: value.jobId,
    receipt: value.receipt as MediaRetentionVerified["receipt"],
    transcriptArtifactSha256: value.transcriptArtifactSha256,
    ...(value.receiptSha256 !== undefined ? { receiptSha256: value.receiptSha256 as string } : {}),
    ...(value.summarySha256 !== undefined ? { summarySha256: value.summarySha256 } : {}),
    ...(value.diarizationSha256 !== undefined ? { diarizationSha256: value.diarizationSha256 } : {}),
    microphone: value.microphone as MediaRetentionVerified["microphone"],
    voices: value.voices as MediaRetentionVerified["voices"],
    backups: {
      ...(backups.vaio !== undefined ? { vaio: backups.vaio as string } : {}),
      ...(backups.proton !== undefined ? { proton: backups.proton as string } : {}),
      ...(backups.protonJobBackup !== undefined ? { protonJobBackup: backups.protonJobBackup as string } : {})
    }
  };
};

/** Strict validation: unknown keys, wrong types or inconsistent states are refused, never repaired. */
export const validateTombstone = (value: unknown): MediaRetentionTombstone => {
  if (!isRecord(value) || !exactKeys(value, ["version", "sourcePath", "source", "jobs", "mode", "reason", "state", "startedAt", "verified", "purged"],
    ["removedAt", "audio"])) return invalid();
  if (value.version !== 1 || typeof value.sourcePath !== "string" || value.sourcePath.length > 4096 || !isAbsolute(value.sourcePath) ||
    resolve(value.sourcePath) !== value.sourcePath || CONTROL.test(value.sourcePath)) return invalid();
  const source = value.source;
  if (!isRecord(source) || !exactKeys(source, ["fileName", "size", "sha256", "mtimeMs"]) || source.fileName !== basename(value.sourcePath as string) ||
    !safeInteger(source.size, 1, Number.MAX_SAFE_INTEGER) || !sha(source.sha256) ||
    typeof source.mtimeMs !== "number" || !Number.isFinite(source.mtimeMs) || source.mtimeMs < 0) return invalid();
  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > MEDIA_RETENTION_LIMITS.jobs ||
    new Set(value.jobs).size !== value.jobs.length) return invalid();
  const jobs = value.jobs.map((id) => {
    if (typeof id !== "string") return invalid();
    try { return validateJobId(id); } catch { return invalid(); }
  });
  if (!["transcript-only", "audio-only"].includes(value.mode as string) || !["policy", "manual"].includes(value.reason as string) ||
    !["removing", "removed"].includes(value.state as string) || !isoDate(value.startedAt) ||
    (value.state === "removed") !== isoDate(value.removedAt) || (value.state !== "removed" && value.removedAt !== undefined)) return invalid();
  // Audio is recorded only for audio-only, and a finished audio-only removal must have it.
  if ((value.audio !== undefined && value.mode !== "audio-only") || (value.mode === "audio-only" && value.state === "removed" && value.audio === undefined)) return invalid();
  if (!Array.isArray(value.purged) || value.purged.length > PURGE_KINDS.length || new Set(value.purged).size !== value.purged.length ||
    value.purged.some((kind) => !PURGE_KINDS.includes(kind as PurgeKind))) return invalid();
  return {
    version: 1,
    sourcePath: value.sourcePath as string,
    source: { fileName: source.fileName as string, size: source.size, sha256: source.sha256, mtimeMs: source.mtimeMs },
    jobs,
    mode: value.mode as RetainedMode,
    reason: value.reason as MediaRetentionTombstone["reason"],
    state: value.state as MediaRetentionTombstone["state"],
    startedAt: value.startedAt,
    ...(value.removedAt !== undefined ? { removedAt: value.removedAt as string } : {}),
    verified: validateVerified(value.verified, jobs),
    ...(value.audio !== undefined ? { audio: validateAudio(value.audio) } : {}),
    purged: PURGE_KINDS.filter((kind) => (value.purged as string[]).includes(kind))
  };
};

/** Serialized form; keys are emitted in a stable order so CAS compares bytes. */
export const serializeTombstone = (tombstone: MediaRetentionTombstone): string => `${JSON.stringify(validateTombstone(tombstone), null, 2)}\n`;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** The recording folder must be a real directory directly beside the media. */
export const assertRecordingRoot = async (sourcePath: string): Promise<string> => {
  const root = recordingRootOf(sourcePath);
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("unsafe");
    const [realParent, realRoot] = await Promise.all([fs.realpath(dirname(root)), fs.realpath(root)]);
    if (realRoot !== join(realParent, basename(root))) throw new Error("unsafe");
  } catch (error) {
    throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.recordingRootUnsafe, { cause: error });
  }
  return root;
};

/** Bounded, no-follow read of a small private file; undefined when absent. */
const readSmall = async (path: string, maximum: number): Promise<string | undefined> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    return buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
};

/** Reads, validates, and atomically replaces tombstones with compare-and-swap on the stored bytes. */
export class MediaRetentionStore {
  async read(sourcePath: string): Promise<StoredTombstone | null> {
    const expected = resolve(sourcePath);
    const root = await fs.lstat(recordingRootOf(expected)).catch((error) => {
      if (missing(error)) return undefined;
      throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid, { cause: error });
    });
    if (!root) return null;
    if (!root.isDirectory() || root.isSymbolicLink()) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.recordingRootUnsafe);
    const raw = await readSmall(tombstonePathOf(expected), MEDIA_RETENTION_LIMITS.tombstoneBytes);
    if (raw === undefined) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid, { cause: error }); }
    const tombstone = validateTombstone(parsed);
    if (tombstone.sourcePath !== expected) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    return { tombstone, raw, sha256: digestText(raw) };
  }

  /** `expectedRaw` is the current file content, or null when the file must not exist yet. */
  async write(tombstone: MediaRetentionTombstone, expectedRaw: string | null): Promise<StoredTombstone> {
    const raw = serializeTombstone(tombstone);
    if (Buffer.byteLength(raw) > MEDIA_RETENTION_LIMITS.tombstoneBytes) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneInvalid);
    const root = await assertRecordingRoot(tombstone.sourcePath);
    const path = join(root, MEDIA_RETENTION_FILE);
    const temporary = join(root, `.${MEDIA_RETENTION_FILE}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(raw, "utf8"); await handle.sync(); } finally { await handle.close(); }
      // An unreadable current file is never replaced: the read throws and the attempt stops.
      const current = await readSmall(path, MEDIA_RETENTION_LIMITS.tombstoneBytes);
      if ((current ?? null) !== expectedRaw) throw new MediaRetentionError(MEDIA_RETENTION_MESSAGES.tombstoneChanged);
      await fs.rename(temporary, path);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return { tombstone: validateTombstone(JSON.parse(raw)), raw, sha256: digestText(raw) };
  }
}
