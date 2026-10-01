import { promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import {
  getSshDestination,
  inspectRemoteArchivedSource
} from "../jobs/remote";
import { hashFile } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import type { Transcript } from "../jobs/types";
import { findAlignedSubtitles } from "../subtitles/aligned";
import { launchRecordingPlayer } from "../player/launcher";
import { inspectArchivedMedia } from "../archive/remote";
import { restoreProtonMedia } from "../archive/proton";
import { sealedArchiveMedia } from "../archive/sync";
import {
  assertExistingManagedPath,
  assertExistingJobArtifactPath,
  type LibraryEntry
} from "./library";

type CommandRunner = typeof runCommand;
export type PlaybackOptions = { startSeconds?: number };
export type TranscriptSearchResult = {
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  speaker?: string;
};

type PlayerLauncher = (path: string, options?: PlaybackOptions) => Promise<void>;

export type MediaDependencies = {
  run?: CommandRunner;
  launch?: PlayerLauncher;
  mountPoint?: string;
  inspectRemote?: typeof inspectRemoteArchivedSource;
  inspectArchive?: typeof inspectArchivedMedia;
  restoreProton?: typeof restoreProtonMedia;
};

export type PlaybackResult = {
  location: "local" | "vaio" | "proton";
  path: string;
};

export type LocalSourceRemovalResult = {
  bytesFreed: number;
  remotePath: string;
};

export const parseTimestamp = (value: string): number | undefined => {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    return undefined;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return numbers.slice(1).some((part) => part >= 60) || seconds < 0 ? undefined : seconds;
};

const resultFromSegment = (segment: { text: string; start?: number; end?: number; speaker?: string }): TranscriptSearchResult => ({
  text: segment.text,
  ...(typeof segment.start === "number" && Number.isFinite(segment.start) && segment.start >= 0
    ? { startSeconds: segment.start }
    : {}),
  ...(typeof segment.end === "number" && Number.isFinite(segment.end) && segment.end >= 0
    ? { endSeconds: segment.end }
    : {}),
  ...(segment.speaker ? { speaker: segment.speaker } : {})
});

const normalizePlaybackOptions = (options: PlaybackOptions = {}): PlaybackOptions => {
  if (
    options.startSeconds !== undefined &&
    (!Number.isFinite(options.startSeconds) || options.startSeconds < 0)
  ) {
    throw new Error("O início da reprodução deve ser um número finito não negativo.");
  }
  return options;
};

export const parseTranscriptJson = (value: unknown): TranscriptSearchResult[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") return [];
  const candidate = parsed as Partial<Transcript> & { segments?: unknown };
  if (Array.isArray(candidate.segments) && candidate.segments.length > 0) {
    return candidate.segments.flatMap((segment): TranscriptSearchResult[] => {
      if (!segment || typeof segment !== "object") return [];
      const item = segment as { text?: unknown; start?: unknown; end?: unknown; speaker?: unknown };
      if (typeof item.text !== "string") return [];
      const start = typeof item.start === "number" && Number.isFinite(item.start) && item.start >= 0
        ? item.start
        : undefined;
      const end = typeof item.end === "number" && Number.isFinite(item.end) && item.end >= 0
        ? item.end
        : undefined;
      return [resultFromSegment({
        text: item.text,
        start,
        end: start !== undefined && end !== undefined && end >= start ? end : undefined,
        speaker: typeof item.speaker === "string" ? item.speaker : undefined
      })];
    });
  }
  return typeof candidate.text === "string" && candidate.text ? [{ text: candidate.text }] : [];
};

export const parseTranscriptMarkdown = (text: string): TranscriptSearchResult[] => text
  .split(/\r?\n/)
  .map((line): TranscriptSearchResult | undefined => {
    if (/^\s*#/.test(line)) return undefined;
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:(.+?):\s*)?(.*?)\s*$/);
    if (match) {
      const startSeconds = parseTimestamp(match[1]);
      const result: TranscriptSearchResult = { text: match[3] };
      if (startSeconds !== undefined) result.startSeconds = startSeconds;
      if (match[2]) result.speaker = match[2];
      return result.text ? result : undefined;
    }
    const plain = line.trim();
    return plain ? { text: plain } : undefined;
  })
  .filter((item): item is TranscriptSearchResult => item !== undefined);

export const searchTranscript = (content: string, query: string): TranscriptSearchResult[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  let entries: TranscriptSearchResult[];
  try {
    entries = parseTranscriptJson(content);
  } catch {
    entries = parseTranscriptMarkdown(content);
  }
  return entries.filter((entry) => entry.text.toLocaleLowerCase().includes(needle));
};

const validateRuntimePath = (path: string): string => {
  if (!path.startsWith("/") || /[\r\n\0]/.test(path)) {
    throw new Error("O diretório de montagem SSHFS é inválido.");
  }
  return resolve(path);
};

export const getRemoteArchiveMountPoint = (): string =>
  validateRuntimePath(
    join(
      process.env.XDG_RUNTIME_DIR || join(homedir(), ".local", "share"),
      "recording-cli",
      "vaio-archive"
    )
  );

export const findCompletedRemoteJob = (
  entry: Pick<LibraryEntry, "jobs">,
  selected?: JobRecord
): JobRecord | undefined => {
  if (selected?.target === "remote" && selected.state === "completed") {
    return selected;
  }
  return entry.jobs.find(
    (job) => job.target === "remote" && job.state === "completed"
  );
};

const ensureSafeMountPoint = async (mountPoint: string): Promise<void> => {
  await fs.mkdir(mountPoint, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(mountPoint);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("O ponto de montagem SSHFS não é um diretório seguro.");
  }
};

const expectedSshfsSource = (
  config: AppConfig,
  archiveDir: string
): string => `${getSshDestination(config)}:${archiveDir}`;

const findMount = async (
  run: CommandRunner,
  mountPoint: string
): Promise<{ fileSystem: string; source: string } | null> => {
  try {
    const result = await run("findmnt", [
      "--noheadings",
      "--raw",
      "--output",
      "FSTYPE,SOURCE",
      "--mountpoint",
      mountPoint
    ]);
    const [fileSystem, ...sourceParts] = result.stdout.trim().split(/\s+/);
    return fileSystem && sourceParts.length > 0
      ? { fileSystem, source: sourceParts.join(" ") }
      : null;
  } catch {
    return null;
  }
};

export const ensureRemoteArchiveMounted = async (
  config: AppConfig,
  archiveDir: string,
  dependencies: MediaDependencies = {}
): Promise<string> => {
  const run = dependencies.run || runCommand;
  const mountPoint = validateRuntimePath(
    dependencies.mountPoint || getRemoteArchiveMountPoint()
  );
  await ensureSafeMountPoint(mountPoint);
  const expectedSource = expectedSshfsSource(config, archiveDir);
  const mounted = await findMount(run, mountPoint);
  if (mounted) {
    if (
      mounted.fileSystem !== "fuse.sshfs" ||
      mounted.source !== expectedSource
    ) {
      throw new Error("O ponto de montagem já está ocupado por outra origem.");
    }
    return mountPoint;
  }

  const options = [
    "ro",
    "nodev",
    "nosuid",
    "reconnect",
    "BatchMode=yes",
    "ConnectTimeout=5",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
    "IdentitiesOnly=yes",
    "PreferredAuthentications=publickey",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "StrictHostKeyChecking=yes"
  ];
  if (config.remote.identityFile) {
    options.push(`IdentityFile=${config.remote.identityFile}`);
  }
  await run(
    "sshfs",
    [
      expectedSource,
      mountPoint,
      "-F",
      "/dev/null",
      "-p",
      String(config.remote.port),
      ...options.flatMap((option) => ["-o", option])
    ],
    { timeoutMs: 20_000 }
  );
  const verified = await findMount(run, mountPoint);
  if (
    !verified ||
    verified.fileSystem !== "fuse.sshfs" ||
    verified.source !== expectedSource
  ) {
    throw new Error("O arquivo do vaio foi montado, mas a origem não pôde ser confirmada.");
  }
  return mountPoint;
};

const assertLocalSource = async (
  config: AppConfig,
  entry: Pick<LibraryEntry, "sourcePath">
): Promise<Stats> => {
  await assertExistingManagedPath(config, entry.sourcePath);
  const stat = await fs.lstat(entry.sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("A origem local não é um arquivo regular.");
  }
  return stat;
};

const localSourceExists = async (path: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error("A origem local não pode ser um link simbólico.");
    }
    return stat.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};

export const playLibraryEntry = async (
  config: AppConfig,
  entry: LibraryEntry,
  selectedJob?: JobRecord,
  dependenciesOrOptions: MediaDependencies | PlaybackOptions = {},
  options?: PlaybackOptions
): Promise<PlaybackResult> => {
  const isPlaybackOptions = "startSeconds" in dependenciesOrOptions;
  const dependencies: MediaDependencies = isPlaybackOptions
    ? {}
    : dependenciesOrOptions as MediaDependencies;
  const playbackOptions = normalizePlaybackOptions(
    options || (isPlaybackOptions ? dependenciesOrOptions : {})
  );
  const launch: PlayerLauncher = dependencies.launch || (async (path, options) => {
    const mediaHash = entry.archive?.source.sha256 || selectedJob?.source.sha256 || entry.jobs[0]?.source.sha256;
    let transcriptPath = mediaHash ? await findAlignedSubtitles(mediaHash) : undefined;
    for (const job of [selectedJob, ...entry.jobs].filter((job): job is JobRecord => !!job)) {
      if (transcriptPath) break;
      const candidate = join(job.artifactDir, "transcript.json");
      try {
        const stat = await assertExistingJobArtifactPath(job, candidate);
        if (stat.isFile() && stat.size <= 10 * 1024 * 1024) { transcriptPath = candidate; break; }
      } catch { /* Playback remains available while transcript artifacts are missing. */ }
    }
    await launchRecordingPlayer(path, { ...options, transcriptPath, title: entry.meetingTitle || entry.relativePath });
  });
  if (await localSourceExists(entry.sourcePath)) {
    await assertExistingManagedPath(config, entry.sourcePath);
    await launch(entry.sourcePath, playbackOptions);
    return { location: "local", path: entry.sourcePath };
  }

  const archive = entry.archive;
  let sourceError: unknown;
  let resolved: PlaybackResult | undefined;
  if (archive?.vaio.state === "completed" && archive.vaio.archiveRelative && archive.source.sha256) {
    try {
      const remote = await (dependencies.inspectArchive || inspectArchivedMedia)(config, {
        archiveRelative: archive.vaio.archiveRelative, fileName: archive.source.fileName, size: archive.source.size, sha256: archive.source.sha256
      }, { verifyHash: true });
      const mountPoint = await ensureRemoteArchiveMounted(config, remote.archiveDir, dependencies);
      const path = join(mountPoint, remote.archiveRelative, archive.source.fileName);
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== archive.source.size) throw new Error("A mídia montada não corresponde ao catálogo de backup");
      resolved = { location: "vaio", path };
    } catch (error) { sourceError = error; }
  }
  const job = findCompletedRemoteJob(entry, selectedJob);
  if (!resolved && job) {
    try {
      const remote = await (dependencies.inspectRemote || inspectRemoteArchivedSource)(config, job, { verifyHash: true });
      const mountPoint = await ensureRemoteArchiveMounted(config, remote.archiveDir, dependencies);
      const path = join(mountPoint, remote.archiveRelative, job.source.mediaFile);
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.source.size) {
        throw new Error("A gravação montada do vaio não corresponde ao catálogo.");
      }
      resolved = { location: "vaio", path };
    } catch (error) { sourceError = error; }
  }
  if (!resolved && archive?.proton.state === "completed") {
    const path = await (dependencies.restoreProton || restoreProtonMedia)(config, sealedArchiveMedia(archive));
    resolved = { location: "proton", path };
  }
  if (!resolved) throw sourceError || new Error("Esta gravação não possui uma cópia concluída no vaio.");
  // A player startup failure is unrelated to storage and must not trigger another download.
  await launch(resolved.path, playbackOptions);
  return resolved;
};

export const removeVerifiedLocalSource = async (
  config: AppConfig,
  entry: LibraryEntry,
  selectedJob?: JobRecord,
  dependencies: MediaDependencies = {}
): Promise<LocalSourceRemovalResult> => {
  const job = findCompletedRemoteJob(entry, selectedJob);
  if (!job) {
    throw new Error("Não há uma cópia concluída no vaio; o vídeo local foi preservado.");
  }
  const remote = await (
    dependencies.inspectRemote || inspectRemoteArchivedSource
  )(config, job, { verifyHash: true });
  const beforeHash = await assertLocalSource(config, entry);
  if (beforeHash.size !== job.source.size) {
    throw new Error("O vídeo local mudou de tamanho; ele foi preservado.");
  }
  const localSha256 = await hashFile(entry.sourcePath);
  if (localSha256 !== job.source.sha256) {
    throw new Error("O SHA-256 do vídeo local mudou; ele foi preservado.");
  }
  const afterHash = await assertLocalSource(config, entry);
  if (
    afterHash.size !== beforeHash.size ||
    afterHash.dev !== beforeHash.dev ||
    afterHash.ino !== beforeHash.ino ||
    afterHash.mtimeMs !== beforeHash.mtimeMs
  ) {
    throw new Error("O vídeo local mudou durante a verificação; ele foi preservado.");
  }
  await fs.rm(entry.sourcePath, { force: false });
  return {
    bytesFreed: beforeHash.size,
    remotePath: remote.sourcePath
  };
};
