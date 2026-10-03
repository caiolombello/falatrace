import { promises as fs } from "node:fs";
import { withRevisionLease, RevisionConflictError } from "../revisions";
import { hasSavedRevision } from "../revisions/service";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "./command";
import type { JobRecord, JobStatus } from "./types";
import { validateJobId, validateJobStatus } from "./types";

const REMOTE_ROOT = ".local/share/recording-cli/server";
const ARTIFACT_NAMES = ["transcript.json", "transcript.md", "summary.json", "summary.md"];

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export const getSshDestination = (config: AppConfig): string =>
  config.remote.user ? `${config.remote.user}@${config.remote.host}` : config.remote.host;

export const buildSshArgs = (config: AppConfig): string[] => {
  const args = [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-p",
    String(config.remote.port)
  ];
  if (config.remote.identityFile) {
    args.push("-i", config.remote.identityFile);
  }
  return args;
};

const getRsyncEnvironment = (config: AppConfig): NodeJS.ProcessEnv => ({
  ...process.env,
  RSYNC_RSH: ["ssh", ...buildSshArgs(config)].map(shellQuote).join(" ")
});

const runSsh = async (config: AppConfig, remoteArgs: string[]): Promise<string> => {
  const result = await runCommand("ssh", [
    ...buildSshArgs(config),
    getSshDestination(config),
    ...remoteArgs
  ]);
  return result.stdout;
};

const remotePath = (suffix: string): string => `${REMOTE_ROOT}/${suffix}`;

export const resolveRemoteArchiveDir = async (config: AppConfig): Promise<string> => {
  if (!config.remote.archiveDir.startsWith("~/")) return config.remote.archiveDir;
  const home = (await runSsh(config, ["printenv", "HOME"])).trim();
  if (!home.startsWith("/") || /[\r\n\0]/.test(home)) {
    throw new Error("Remote HOME is invalid");
  }
  return `${home.replace(/\/$/, "")}/${config.remote.archiveDir.slice(2)}`;
};

const runQuotedSshCommand = async (
  config: AppConfig,
  command: string,
  args: string[]
): Promise<string> =>
  runSsh(config, [[command, ...args].map(shellQuote).join(" ")]);

export type RemoteArchivedSource = {
  archiveDir: string;
  archiveRelative: string;
  sourcePath: string;
  size: number;
  sha256?: string;
};

export const inspectRemoteArchivedSource = async (
  config: AppConfig,
  record: JobRecord,
  options: { verifyHash?: boolean } = {}
): Promise<RemoteArchivedSource> => {
  if (record.target !== "remote" || record.state !== "completed") {
    throw new Error("A gravação ainda não possui um arquivo concluído no vaio.");
  }
  const status = await readRemoteStatus(config, record.id);
  if (status?.state !== "completed" || !status.archiveRelative) {
    throw new Error("O arquivo concluído não foi localizado no catálogo remoto.");
  }
  const archiveDir = await resolveRemoteArchiveDir(config);
  const sourcePath =
    `${archiveDir.replace(/\/$/, "")}/${status.archiveRelative}/${record.source.mediaFile}`;
  const rawSize = (
    await runQuotedSshCommand(config, "stat", ["-c", "%s", "--", sourcePath])
  ).trim();
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("O vaio retornou um tamanho inválido para a gravação.");
  }
  if (size !== record.source.size) {
    throw new Error(
      `A gravação no vaio tem tamanho diferente do catálogo (${size} != ${record.source.size}).`
    );
  }

  let sha256: string | undefined;
  if (options.verifyHash) {
    const output = await runQuotedSshCommand(config, "sha256sum", ["--", sourcePath]);
    const match = output.match(/^([0-9a-f]{64})(?:\s|$)/i);
    if (!match) {
      throw new Error("O vaio retornou um SHA-256 inválido para a gravação.");
    }
    sha256 = match[1].toLowerCase();
    if (sha256 !== record.source.sha256) {
      throw new Error("O SHA-256 da gravação no vaio não confere com o catálogo local.");
    }
  }

  return {
    archiveDir,
    archiveRelative: status.archiveRelative,
    sourcePath,
    size,
    sha256
  };
};

export const transferJob = async (
  config: AppConfig,
  record: JobRecord,
  manifestPath: string
): Promise<void> => {
  const partialDir = remotePath(`incoming/${record.id}.partial`);
  const queueDir = remotePath(`queue/${record.id}`);
  await runSsh(config, [
    "mkdir",
    "-p",
    remotePath("incoming"),
    remotePath("queue"),
    remotePath("status"),
    partialDir
  ]);
  const destination = `${getSshDestination(config)}:${partialDir}/`;
  const commonArgs = ["--partial", "--append-verify", "--protect-args", "--chmod=F600,D700"];
  await runCommand(
    "rsync",
    [...commonArgs, manifestPath, `${destination}manifest.json`],
    { env: getRsyncEnvironment(config), timeoutMs: 12 * 60 * 60 * 1000 }
  );
  await runCommand(
    "rsync",
    [...commonArgs, record.sourcePath, `${destination}${record.source.mediaFile}`],
    { env: getRsyncEnvironment(config), timeoutMs: 12 * 60 * 60 * 1000 }
  );
  await runSsh(config, ["mv", partialDir, queueDir]);
};

export const remoteJobIsQueued = async (config: AppConfig, jobId: string): Promise<boolean> => {
  try {
    await runSsh(config, ["test", "-d", remotePath(`queue/${jobId}`)]);
    return true;
  } catch {
    return false;
  }
};

export const requeueRemoteFailedJob = async (
  config: AppConfig,
  jobId: string
): Promise<boolean> => {
  validateJobId(jobId);
  try {
    await runSsh(config, ["mkdir", "-p", remotePath("queue")]);
    await runSsh(config, [
      "mv",
      remotePath(`failed/${jobId}`),
      remotePath(`queue/${jobId}`)
    ]);
    return true;
  } catch {
    return false;
  }
};

export const readRemoteStatus = async (
  config: AppConfig,
  jobId: string
): Promise<JobStatus | null> => {
  try {
    const output = await runSsh(config, ["cat", remotePath(`status/${jobId}.json`)]);
    const status = validateJobStatus(JSON.parse(output));
    if (status.id !== jobId) {
      throw new Error("Remote status job id mismatch");
    }
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("No such file")) {
      return null;
    }
    throw err;
  }
};

export const pullRemoteArtifacts = async (
  config: AppConfig,
  record: JobRecord,
  archiveRelative?: string
): Promise<void> => withRevisionLease(record.id, async () => {
  if (await hasSavedRevision(record.id)) throw new RevisionConflictError("Human review exists; remote original artifacts were preserved without contacting the remote.");
  await fs.mkdir(record.artifactDir, { recursive: true, mode: 0o700 });
  const archiveDir = archiveRelative ? await resolveRemoteArchiveDir(config) : undefined;
  const sourceRoot = archiveRelative
    ? `${archiveDir!.replace(/\/$/, "")}/${archiveRelative}`
    : remotePath(`results/${record.id}`);
  for (const name of ARTIFACT_NAMES) {
    await runCommand(
      "rsync",
      [
        "--protect-args",
        `${getSshDestination(config)}:${sourceRoot}/${name}`,
        join(record.artifactDir, name)
      ],
      { env: getRsyncEnvironment(config), timeoutMs: 10 * 60 * 1000 }
    );
  }
});

export const checkRemote = async (config: AppConfig): Promise<string> =>
  runSsh(config, [
    'printf "host=%s\\n" "$(hostname)"; for command in recording-cli ffmpeg ffprobe whisper-cli ollama; do if command -v "$command" >/dev/null 2>&1; then printf "%s=ok\\n" "$command"; else printf "%s=missing\\n" "$command"; fi; done; df -h "$HOME" | tail -1'
  ]);
