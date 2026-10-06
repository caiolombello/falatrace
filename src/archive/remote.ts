import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { hashFile as hashStoredFile } from "../jobs/store";
import {
  buildSshArgs,
  getRemotePathSpec,
  getSshDestination,
  resolveRemoteArchiveDir
} from "../jobs/remote";
import { validateJobId, validateMediaExtension } from "../jobs/types";

export type ArchiveMediaInput = {
  id: string;
  createdAt: string;
  sourcePath: string;
  source: {
    fileName: string;
    size: number;
    sha256: string;
  };
};

export type ArchivedMedia = {
  archiveDir: string;
  archiveRelative: string;
  sourcePath: string;
  size: number;
  sha256: string;
  verifiedAt: string;
};

export type ArchivedMediaInspection = {
  archiveRelative: string;
  fileName: string;
  size: number;
  sha256: string;
};

export type DownloadedArchivedMedia = ArchivedMedia & {
  destinationPath: string;
};

type CommandRunner = typeof runCommand;

export type ArchiveDependencies = {
  run?: CommandRunner;
  hashFile?: (path: string) => Promise<string>;
  now?: () => Date;
  resolveArchiveDir?: (config: AppConfig) => Promise<string>;
};

const TRANSFER_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const REMOTE_TIMEOUT_MS = 60_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ARCHIVE_RELATIVE_PATTERN =
  /^(?:media\/)?(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const normalizeArchiveRoot = (path: string): string =>
  path === "/" ? path : path.replace(/\/+$/, "");

const validateArchiveRoot = (path: string): string => {
  const normalized = normalizeArchiveRoot(path);
  if (
    !isAbsolute(normalized) ||
    resolve(normalized) !== normalized ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error("O diretório remoto de archive é inválido.");
  }
  return normalized;
};

const remoteJoin = (root: string, suffix: string): string =>
  root === "/" ? `/${suffix}` : `${root}/${suffix}`;

const validateDigest = (value: string): string => {
  if (!SHA256_PATTERN.test(value)) throw new Error("SHA-256 inválido para a mídia.");
  return value.toLowerCase();
};

const validateSize = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("O tamanho da mídia deve ser um inteiro positivo.");
  }
  return value;
};

const validateSafeMediaName = (fileName: string): string => {
  if (
    !fileName ||
    fileName.length > 255 ||
    basename(fileName) !== fileName ||
    /[\/\\\0\r\n]/.test(fileName)
  ) {
    throw new Error("source.fileName deve ser um basename seguro.");
  }
  validateMediaExtension(fileName);
  return fileName;
};

const validateArchiveRelative = (archiveRelative: string): string => {
  const match = archiveRelative.match(ARCHIVE_RELATIVE_PATTERN);
  if (!match) throw new Error("archiveRelative inválido.");
  validateJobId(match[3]);
  return archiveRelative;
};

const getRsyncEnvironment = (config: AppConfig): NodeJS.ProcessEnv => ({
  ...process.env,
  RSYNC_RSH: ["ssh", ...buildSshArgs(config)].map(shellQuote).join(" ")
});

const runRemote = async (
  config: AppConfig,
  run: CommandRunner,
  command: string,
  args: string[]
): Promise<string> => {
  const quotedCommand = [command, ...args].map(shellQuote).join(" ");
  const result = await run(
    "ssh",
    [...buildSshArgs(config), getSshDestination(config), quotedCommand],
    { timeoutMs: REMOTE_TIMEOUT_MS }
  );
  return result.stdout.trim();
};

const resolveArchiveRoot = async (
  config: AppConfig,
  dependencies: ArchiveDependencies
): Promise<string> => {
  if (dependencies.resolveArchiveDir) {
    return validateArchiveRoot(await dependencies.resolveArchiveDir(config));
  }
  if (dependencies.run && config.remote.archiveDir.startsWith("~/")) {
    const home = await runRemote(config, dependencies.run, "printenv", ["HOME"]);
    if (!isAbsolute(home) || resolve(home) !== home || /[\0\r\n]/.test(home)) {
      throw new Error("Remote HOME is invalid");
    }
    return validateArchiveRoot(remoteJoin(home, config.remote.archiveDir.slice(2)));
  }
  return validateArchiveRoot(await resolveRemoteArchiveDir(config));
};

const PROBE_SCRIPT = `# ARCHIVE_PROBE
set -eu
root=$1
path=$2
verify_hash=$3
shift 3
if [ -L "$root" ] || [ ! -d "$root" ]; then printf 'invalid-root\\n'; exit 0; fi
canonical=$(realpath -e -- "$root")
if [ "$canonical" != "$root" ]; then printf 'invalid-root\\n'; exit 0; fi
for directory in "$@"; do
  if [ -L "$directory" ]; then printf 'symlink\\n'; exit 0; fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then printf 'not-directory\\n'; exit 0; fi
done
if [ -L "$path" ]; then printf 'symlink\\n'; exit 0; fi
if [ ! -e "$path" ]; then printf 'missing\\n'; exit 0; fi
if [ ! -f "$path" ]; then printf 'not-regular\\n'; exit 0; fi
size=$(stat -c '%s' -- "$path")
if [ "$verify_hash" = 1 ]; then
  digest=$(sha256sum -- "$path")
  digest=\${digest%% *}
else
  digest=-
fi
printf 'ok\\t%s\\t%s\\n' "$size" "$digest"`;

type RemoteProbe =
  | { state: "missing" }
  | { state: "symlink" }
  | { state: "not-regular" }
  | { state: "ok"; size: number; sha256?: string };

const probeRemote = async (
  config: AppConfig,
  archiveDir: string,
  path: string,
  directories: string[],
  verifyHash: boolean,
  run: CommandRunner
): Promise<RemoteProbe> => {
  const output = await runRemote(config, run, "sh", [
    "-c",
    PROBE_SCRIPT,
    "archive-probe",
    archiveDir,
    path,
    verifyHash ? "1" : "0",
    ...directories
  ]);
  if (output === "invalid-root") {
    throw new Error("O archive root remoto não existe ou atravessa link simbólico.");
  }
  if (output === "not-directory") {
    throw new Error("Um componente do archive remoto não é diretório.");
  }
  if (output === "missing") return { state: "missing" };
  if (output === "symlink" || output === "not-regular") return { state: output };
  const match = output.match(/^ok\t(\d+)\t([^\s]+)$/);
  if (!match) throw new Error("Resposta inválida ao inspecionar a mídia no VAIO.");
  const size = Number(match[1]);
  validateSize(size);
  const sha256 = match[2] === "-" ? undefined : validateDigest(match[2]);
  if (verifyHash && !sha256) throw new Error("O VAIO não retornou o SHA-256 da mídia.");
  return { state: "ok", size, sha256 };
};

const assertMatchingRemote = (
  probe: RemoteProbe,
  expected: { size: number; sha256: string },
  label: string
): void => {
  if (probe.state === "symlink") throw new Error(`${label} é um link simbólico no VAIO.`);
  if (probe.state === "not-regular") throw new Error(`${label} não é um arquivo regular no VAIO.`);
  if (probe.state === "missing") throw new Error(`${label} não existe no VAIO.`);
  if (probe.size !== expected.size) {
    throw new Error(`${label} diverge no tamanho (${probe.size} != ${expected.size}).`);
  }
  if (probe.sha256 && probe.sha256 !== expected.sha256) {
    throw new Error(`O SHA-256 remoto de ${label} diverge do catálogo local.`);
  }
};

const PREPARE_SCRIPT = `# ARCHIVE_PREPARE
set -eu
umask 077
root=$1
shift
if [ -L "$root" ] || [ ! -d "$root" ]; then printf 'invalid-root\\n'; exit 0; fi
canonical=$(realpath -e -- "$root")
if [ "$canonical" != "$root" ]; then printf 'invalid-root\\n'; exit 0; fi
for directory in "$1" "$2" "$3"; do
  if [ -L "$directory" ]; then printf 'symlink\\n'; exit 0; fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then printf 'not-directory\\n'; exit 0; fi
  if [ ! -e "$directory" ]; then mkdir -- "$directory"; chmod 700 -- "$directory"; fi
done
staging=$4
if [ -L "$staging" ]; then printf 'symlink\\n'; exit 0; fi
if [ -e "$staging" ] && [ ! -d "$staging" ]; then printf 'not-directory\\n'; exit 0; fi
mkdir -p -- "$staging"
chmod 700 -- "$staging"
printf 'ready\\n'`;

const prepareStaging = async (
  config: AppConfig,
  archiveDir: string,
  year: string,
  month: string,
  stagingDir: string,
  run: CommandRunner
): Promise<void> => {
  const mediaDir = `${archiveDir}/media`;
  const yearDir = `${mediaDir}/${year}`;
  const monthDir = `${yearDir}/${month}`;
  const output = await runRemote(config, run, "sh", [
    "-c",
    PREPARE_SCRIPT,
    "archive-prepare",
    archiveDir,
    mediaDir,
    yearDir,
    monthDir,
    stagingDir
  ]);
  if (output === "invalid-root") {
    throw new Error("O archive root remoto não existe ou atravessa link simbólico.");
  }
  if (output === "symlink") throw new Error("O destino de archive contém link simbólico.");
  if (output === "not-directory") throw new Error("O destino de archive contém item não diretório.");
  if (output !== "ready") throw new Error("O VAIO não confirmou o staging do archive.");
};

const PUBLISH_SCRIPT = `# ARCHIVE_PUBLISH
set -eu
staging=$1
staging_file=$2
final=$3
expected_size=$4
expected_digest=$5
if [ -L "$staging" ] || [ -L "$staging_file" ] || [ -L "$final" ]; then
  printf 'symlink\\n'; exit 0
fi
if [ ! -d "$staging" ] || [ ! -f "$staging_file" ]; then
  printf 'invalid-staging\\n'; exit 0
fi
actual_size=$(stat -c '%s' -- "$staging_file")
actual_digest=$(sha256sum -- "$staging_file")
actual_digest=\${actual_digest%% *}
if [ "$actual_size" != "$expected_size" ] || [ "$actual_digest" != "$expected_digest" ]; then
  printf 'invalid-staging\\n'; exit 0
fi
if [ -e "$final" ]; then printf 'exists\\n'; exit 0; fi
mv -T -n -- "$staging" "$final"
if [ -d "$final" ] && [ ! -L "$final" ]; then printf 'published\\n'; else printf 'exists\\n'; fi`;

const publishStaging = async (
  config: AppConfig,
  stagingDir: string,
  stagingPath: string,
  finalDir: string,
  expected: { size: number; sha256: string },
  run: CommandRunner
): Promise<void> => {
  const output = await runRemote(config, run, "sh", [
    "-c",
    PUBLISH_SCRIPT,
    "archive-publish",
    stagingDir,
    stagingPath,
    finalDir,
    String(expected.size),
    expected.sha256
  ]);
  if (output === "symlink") throw new Error("O staging ou destino final é um link simbólico.");
  if (output === "invalid-staging") throw new Error("O staging remoto deixou de ser válido.");
  if (output !== "published" && output !== "exists") {
    throw new Error("O VAIO não confirmou a publicação atômica.");
  }
};

const verifiedAt = (now: () => Date): string => {
  const value = now();
  if (Number.isNaN(value.getTime())) throw new Error("Relógio inválido ao verificar o archive.");
  return value.toISOString();
};

export const inspectArchivedMedia = async (
  config: AppConfig,
  input: ArchivedMediaInspection,
  options: { verifyHash?: boolean } = {},
  dependencies: ArchiveDependencies = {}
): Promise<ArchivedMedia> => {
  const archiveRelative = validateArchiveRelative(input.archiveRelative);
  const fileName = validateSafeMediaName(input.fileName);
  if (!fileName.startsWith("source.")) {
    throw new Error("fileName do archive deve seguir source.ext.");
  }
  const size = validateSize(input.size);
  const sha256 = validateDigest(input.sha256);
  const archiveDir = await resolveArchiveRoot(config, dependencies);
  const sourceDir = remoteJoin(archiveDir, archiveRelative);
  const sourcePath = `${sourceDir}/${fileName}`;
  const relativeParts = archiveRelative.split("/");
  const probe = await probeRemote(
    config,
    archiveDir,
    sourcePath,
    relativeParts.map((_, index) =>
      remoteJoin(archiveDir, relativeParts.slice(0, index + 1).join("/"))
    ),
    options.verifyHash === true,
    dependencies.run || runCommand
  );
  assertMatchingRemote(probe, { size, sha256 }, "A mídia arquivada");
  return {
    archiveDir,
    archiveRelative,
    sourcePath,
    size,
    sha256,
    verifiedAt: verifiedAt(dependencies.now || (() => new Date()))
  };
};

export const archiveMediaToVaio = async (
  config: AppConfig,
  media: ArchiveMediaInput,
  dependencies: ArchiveDependencies = {}
): Promise<ArchivedMedia> => {
  const id = validateJobId(media.id).toLowerCase();
  const created = new Date(media.createdAt);
  if (Number.isNaN(created.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(media.createdAt)) {
    throw new Error("createdAt deve ser uma data ISO válida.");
  }
  if (
    !isAbsolute(media.sourcePath) ||
    resolve(media.sourcePath) !== media.sourcePath ||
    /[\0\r\n]/.test(media.sourcePath)
  ) {
    throw new Error("sourcePath deve ser um caminho local absoluto e normalizado.");
  }
  const suppliedName = validateSafeMediaName(media.source.fileName);
  const extension = extname(suppliedName).toLowerCase();
  if (extname(media.sourcePath).toLowerCase() !== extension) {
    throw new Error("A extensão de source.fileName não confere com sourcePath.");
  }
  const size = validateSize(media.source.size);
  const sha256 = validateDigest(media.source.sha256);
  const sourceStat = await fs.lstat(media.sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error("A origem não pode ser um link simbólico.");
  if (await fs.realpath(media.sourcePath) !== media.sourcePath) {
    throw new Error("O caminho da origem não pode atravessar link simbólico.");
  }
  if (!sourceStat.isFile() || sourceStat.size !== size) {
    throw new Error("A origem não é arquivo regular ou diverge no tamanho.");
  }
  const hashFile = dependencies.hashFile || hashStoredFile;
  if ((await hashFile(media.sourcePath)).toLowerCase() !== sha256) {
    throw new Error("O SHA-256 da origem diverge do catálogo.");
  }

  const year = String(created.getUTCFullYear()).padStart(4, "0");
  const month = String(created.getUTCMonth() + 1).padStart(2, "0");
  const archiveRelative = `media/${year}/${month}/${id}`;
  const fileName = `source${extension}`;
  const archiveDir = await resolveArchiveRoot(config, dependencies);
  const mediaDir = remoteJoin(archiveDir, "media");
  const yearDir = `${mediaDir}/${year}`;
  const monthDir = `${yearDir}/${month}`;
  const finalDir = `${monthDir}/${id}`;
  const finalPath = `${finalDir}/${fileName}`;
  const run = dependencies.run || runCommand;
  const expected = { size, sha256 };
  const existing = await probeRemote(
    config,
    archiveDir,
    finalPath,
    [mediaDir, yearDir, monthDir, finalDir],
    true,
    run
  );
  if (existing.state !== "missing") {
    assertMatchingRemote(existing, expected, "A mídia final existente");
    const verifiedStat = await fs.lstat(media.sourcePath);
    if (
      verifiedStat.isSymbolicLink() ||
      !verifiedStat.isFile() ||
      verifiedStat.size !== size ||
      (await hashFile(media.sourcePath)).toLowerCase() !== sha256
    ) {
      throw new Error("A origem mudou durante a verificação do archive.");
    }
    return {
      archiveDir,
      archiveRelative,
      sourcePath: finalPath,
      size,
      sha256,
      verifiedAt: verifiedAt(dependencies.now || (() => new Date()))
    };
  }

  const stagingDir = `${monthDir}/${id}.partial`;
  const stagingPath = `${stagingDir}/${fileName}`;
  await prepareStaging(config, archiveDir, year, month, stagingDir, run);
  const existingStaging = await probeRemote(
    config,
    archiveDir,
    stagingPath,
    [mediaDir, yearDir, monthDir, stagingDir],
    false,
    run
  );
  if (existingStaging.state === "symlink") {
    throw new Error("O arquivo de staging remoto é um link simbólico.");
  }
  if (existingStaging.state === "not-regular") {
    throw new Error("O arquivo de staging remoto existente não é regular.");
  }
  await run(
    "rsync",
    [
      "--partial",
      "--append-verify",
      "--protect-args",
      "--chmod=F600,D700",
      media.sourcePath,
      getRemotePathSpec(config, stagingPath)
    ],
    { env: getRsyncEnvironment(config), timeoutMs: TRANSFER_TIMEOUT_MS }
  );
  const staging = await probeRemote(
    config,
    archiveDir,
    stagingPath,
    [mediaDir, yearDir, monthDir, stagingDir],
    true,
    run
  );
  assertMatchingRemote(staging, expected, "O staging remoto");

  const verifiedStat = await fs.lstat(media.sourcePath);
  if (
    verifiedStat.isSymbolicLink() ||
    !verifiedStat.isFile() ||
    verifiedStat.size !== size ||
    (await hashFile(media.sourcePath)).toLowerCase() !== sha256
  ) {
    throw new Error("A origem mudou durante a transferência.");
  }

  await publishStaging(config, stagingDir, stagingPath, finalDir, expected, run);
  return inspectArchivedMedia(
    config,
    { archiveRelative, fileName, size, sha256 },
    { verifyHash: true },
    { ...dependencies, run, resolveArchiveDir: async () => archiveDir }
  );
};

export const downloadArchivedMedia = async (
  config: AppConfig,
  input: ArchivedMediaInspection,
  destinationPath: string,
  dependencies: ArchiveDependencies = {}
): Promise<DownloadedArchivedMedia> => {
  if (
    !isAbsolute(destinationPath) ||
    resolve(destinationPath) !== destinationPath ||
    /[\0\r\n]/.test(destinationPath)
  ) {
    throw new Error("destinationPath deve ser absoluto e normalizado.");
  }
  try {
    await fs.lstat(destinationPath);
    throw new Error("O destino local do cache já existe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parent = dirname(destinationPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink()) {
    throw new Error("O diretório do cache não pode ser um link simbólico.");
  }
  if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) {
    throw new Error("O diretório do cache deve ser privado para o usuário.");
  }
  if (await fs.realpath(parent) !== parent) {
    throw new Error("O diretório do cache não pode atravessar link simbólico.");
  }

  const run = dependencies.run || runCommand;
  const archived = await inspectArchivedMedia(
    config,
    input,
    { verifyHash: true },
    { ...dependencies, run }
  );
  const temporaryPath = `${destinationPath}.${randomUUID()}.partial`;
  const expectedSha256 = validateDigest(input.sha256);
  const expectedSize = validateSize(input.size);
  const hashFile = dependencies.hashFile || hashStoredFile;
  try {
    await run(
      "rsync",
      [
        "--partial",
        "--protect-args",
        "--chmod=F600",
        getRemotePathSpec(config, archived.sourcePath),
        temporaryPath
      ],
      { env: getRsyncEnvironment(config), timeoutMs: TRANSFER_TIMEOUT_MS }
    );
    const stat = await fs.lstat(temporaryPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedSize) {
      throw new Error("O download do archive diverge no tipo ou tamanho.");
    }
    await fs.chmod(temporaryPath, 0o600);
    if ((await hashFile(temporaryPath)).toLowerCase() !== expectedSha256) {
      throw new Error("O SHA-256 do download do archive diverge do catálogo.");
    }

    const reverified = await inspectArchivedMedia(
      config,
      input,
      { verifyHash: true },
      { ...dependencies, run, resolveArchiveDir: async () => archived.archiveDir }
    );
    try {
      await fs.link(temporaryPath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("O destino local do cache já existe.");
      }
      throw error;
    }
    await fs.rm(temporaryPath);
    return { ...reverified, destinationPath };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};
