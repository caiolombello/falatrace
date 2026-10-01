import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { buildSshArgs, getSshDestination } from "../jobs/remote";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { validateJobId, validateMediaExtension } from "../jobs/types";
import { ArchiveStore, type ArchiveRecord } from "./store";

export type RemoteOriginalRecoveryReport = {
  recovered: number;
  missing: number;
  errors: Array<{ id: string; error: string }>;
};

export type RemoteOriginalRecoveryDependencies = {
  run?: typeof runCommand;
  now?: () => Date;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REMOTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;

const isInside = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith("../") && !isAbsolute(child);
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000);

const RECOVERY_SCRIPT = `# RECOVER_REMOTE_ORIGINAL
set -eu
archive_setting=$1
year=$2
month=$3
job_id=$4
file_name=$5
expected_size=$6
expected_digest=$7

home_canonical=$(realpath -e -- "$HOME")
if [ "$home_canonical" != "$HOME" ]; then printf 'unsafe\\t-\\n'; exit 0; fi
case "$archive_setting" in
  "~/"*) archive_root="$HOME/\${archive_setting#??}" ;;
  /*) archive_root=$archive_setting ;;
  *) printf 'unsafe\\t-\\n'; exit 0 ;;
esac
while [ "$archive_root" != "/" ] && [ "\${archive_root%/}" != "$archive_root" ]; do
  archive_root=\${archive_root%/}
done
if [ -L "$archive_root" ] || [ ! -d "$archive_root" ]; then printf 'unsafe\\t-\\n'; exit 0; fi
archive_canonical=$(realpath -e -- "$archive_root")
if [ "$archive_canonical" != "$archive_root" ]; then printf 'unsafe\\t-\\n'; exit 0; fi

server_root="$HOME/.local/share/recording-cli/server"
source_path=
divergent=0
for bucket in failed processing queue incoming; do
  for suffix in "$job_id" "$job_id.partial"; do
    candidate="$server_root/$bucket/$suffix/$file_name"
    if [ -L "$candidate" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
    if [ -e "$candidate" ]; then
      if [ ! -f "$candidate" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
      candidate_canonical=$(realpath -e -- "$candidate")
      if [ "$candidate_canonical" != "$candidate" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
      candidate_size=$(stat -c '%s' -- "$candidate")
      candidate_digest=$(sha256sum -- "$candidate")
      candidate_digest=\${candidate_digest%% *}
      if [ "$candidate_size" = "$expected_size" ] && [ "$candidate_digest" = "$expected_digest" ]; then
        if [ -z "$source_path" ]; then source_path=$candidate; fi
      else
        divergent=1
      fi
    fi
  done
done
if [ "$divergent" = 1 ]; then printf 'divergent\\t%s\\n' "$archive_root"; exit 0; fi
if [ -z "$source_path" ]; then printf 'missing\\t%s\\n' "$archive_root"; exit 0; fi

media_dir="$archive_root/media"
year_dir="$media_dir/$year"
month_dir="$year_dir/$month"
locks_dir="$media_dir/.recovery-locks"
for directory in "$media_dir" "$year_dir" "$month_dir" "$locks_dir"; do
  if [ -L "$directory" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
  if [ ! -e "$directory" ]; then mkdir -- "$directory"; chmod 700 -- "$directory"; fi
done
lock_dir="$locks_dir/$job_id.lock"
if ! mkdir -- "$lock_dir" 2>/dev/null; then printf 'busy\\t%s\\n' "$archive_root"; exit 0; fi
chmod 700 -- "$lock_dir"
trap 'rmdir -- "$lock_dir" 2>/dev/null || true' EXIT INT TERM

if [ -L "$source_path" ] || [ ! -f "$source_path" ]; then printf 'changed\\t%s\\n' "$archive_root"; exit 0; fi
locked_canonical=$(realpath -e -- "$source_path")
if [ "$locked_canonical" != "$source_path" ]; then printf 'changed\\t%s\\n' "$archive_root"; exit 0; fi
before_identity=$(stat -c '%d:%i:%s:%Y' -- "$source_path")
before_size=$(stat -c '%s' -- "$source_path")
before_digest=$(sha256sum -- "$source_path")
before_digest=\${before_digest%% *}
if [ "$before_size" != "$expected_size" ] || [ "$before_digest" != "$expected_digest" ]; then
  printf 'changed\\t%s\\n' "$archive_root"; exit 0
fi

final_dir="$month_dir/$job_id"
final_file="$final_dir/$file_name"
if [ -L "$final_dir" ] || [ -L "$final_file" ]; then printf 'unsafe\\t%s\\n' "$archive_root"; exit 0; fi
if [ -e "$final_dir" ]; then
  if [ ! -d "$final_dir" ] || [ ! -f "$final_file" ]; then printf 'conflict\\t%s\\n' "$archive_root"; exit 0; fi
  final_canonical=$(realpath -e -- "$final_file")
  final_size=$(stat -c '%s' -- "$final_file")
  final_digest=$(sha256sum -- "$final_file")
  final_digest=\${final_digest%% *}
  if [ "$final_canonical" = "$final_file" ] && [ "$final_size" = "$expected_size" ] && [ "$final_digest" = "$expected_digest" ]; then
    printf 'existing\\t%s\\n' "$archive_root"; exit 0
  fi
  printf 'conflict\\t%s\\n' "$archive_root"; exit 0
fi

staging_dir="$month_dir/$job_id.recovery.partial"
staging_file="$staging_dir/$file_name"
if [ -L "$staging_dir" ] || { [ -e "$staging_dir" ] && [ ! -d "$staging_dir" ]; }; then
  printf 'unsafe\\t%s\\n' "$archive_root"; exit 0
fi
if [ ! -e "$staging_dir" ]; then mkdir -- "$staging_dir"; fi
chmod 700 -- "$staging_dir"
if [ -L "$staging_file" ] || { [ -e "$staging_file" ] && [ ! -f "$staging_file" ]; }; then
  printf 'unsafe\\t%s\\n' "$archive_root"; exit 0
fi
rsync --partial --append-verify --protect-args --chmod=F600,D700 -- "$source_path" "$staging_file"
staging_size=$(stat -c '%s' -- "$staging_file")
staging_digest=$(sha256sum -- "$staging_file")
staging_digest=\${staging_digest%% *}
if [ -L "$source_path" ] || [ ! -f "$source_path" ]; then printf 'changed\\t%s\\n' "$archive_root"; exit 0; fi
after_canonical=$(realpath -e -- "$source_path")
if [ "$after_canonical" != "$source_path" ]; then printf 'changed\\t%s\\n' "$archive_root"; exit 0; fi
after_identity=$(stat -c '%d:%i:%s:%Y' -- "$source_path")
after_digest=$(sha256sum -- "$source_path")
after_digest=\${after_digest%% *}
if [ "$before_identity" != "$after_identity" ] || [ "$before_digest" != "$after_digest" ]; then
  printf 'changed\\t%s\\n' "$archive_root"; exit 0
fi
if [ "$staging_size" != "$expected_size" ] || [ "$staging_digest" != "$expected_digest" ]; then
  printf 'divergent\\t%s\\n' "$archive_root"; exit 0
fi

if [ -e "$final_dir" ] || [ -L "$final_dir" ]; then printf 'conflict\\t%s\\n' "$archive_root"; exit 0; fi
mv -T -n -- "$staging_dir" "$final_dir"
if [ ! -d "$final_dir" ] || [ -L "$final_dir" ] || [ ! -f "$final_file" ] || [ -L "$final_file" ]; then
  printf 'conflict\\t%s\\n' "$archive_root"; exit 0
fi
published_canonical=$(realpath -e -- "$final_file")
published_size=$(stat -c '%s' -- "$final_file")
published_digest=$(sha256sum -- "$final_file")
published_digest=\${published_digest%% *}
if [ "$published_canonical" != "$final_file" ] || [ "$published_size" != "$expected_size" ] || [ "$published_digest" != "$expected_digest" ]; then
  printf 'conflict\\t%s\\n' "$archive_root"; exit 0
fi
printf 'recovered\\t%s\\n' "$archive_root"`;

const recoverOne = async (
  config: AppConfig,
  job: JobRecord,
  dependencies: RemoteOriginalRecoveryDependencies
): Promise<{ status: string; archiveDir: string }> => {
  const created = new Date(job.createdAt);
  const year = String(created.getUTCFullYear()).padStart(4, "0");
  const month = String(created.getUTCMonth() + 1).padStart(2, "0");
  const remoteCommand = [
    "sh",
    "-c",
    RECOVERY_SCRIPT,
    "recover-remote-original",
    config.remote.archiveDir,
    year,
    month,
    job.id,
    job.source.mediaFile,
    String(job.source.size),
    job.source.sha256.toLowerCase()
  ].map(shellQuote).join(" ");
  const run = dependencies.run || runCommand;
  const result = await run(
    "ssh",
    [...buildSshArgs(config), getSshDestination(config), remoteCommand],
    { timeoutMs: REMOTE_TIMEOUT_MS }
  );
  const match = result.stdout.trim().match(/^([a-z-]+)\t([^\t\r\n]+)$/);
  if (!match) throw new Error("Resposta inválida da recuperação remota.");
  return { status: match[1], archiveDir: match[2] };
};

const validateFailedJob = (job: JobRecord): void => {
  validateJobId(job.id);
  validateMediaExtension(job.source.mediaFile);
  if (!/^source\.[a-z0-9]+$/.test(job.source.mediaFile)) throw new Error("Nome de mídia inválido.");
  if (!SHA256_PATTERN.test(job.source.sha256)) throw new Error("SHA-256 inválido no job.");
  if (!Number.isSafeInteger(job.source.size) || job.source.size <= 0) throw new Error("Tamanho inválido no job.");
  if (!Number.isFinite(Date.parse(job.createdAt))) throw new Error("createdAt inválido no job.");
};

export const recoverRemoteOriginals = async (
  config: AppConfig,
  archiveStore = new ArchiveStore(),
  jobStore = new JobStore(),
  dependencies: RemoteOriginalRecoveryDependencies = {}
): Promise<RemoteOriginalRecoveryReport> => {
  if (!/^\/(?:[^\0-\x1f]*)$/.test(config.remote.archiveDir) && !/^~\/(?:[^\0-\x1f]*)$/.test(config.remote.archiveDir)) {
    throw new Error("remote.archiveDir inválido para recuperação.");
  }
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  const report: RemoteOriginalRecoveryReport = { recovered: 0, missing: 0, errors: [] };
  const catalog = await archiveStore.list();

  for (const job of await jobStore.list()) {
    if (job.target !== "remote" || job.state !== "failed") continue;
    try {
      validateFailedJob(job);
      if (resolve(job.sourcePath) !== job.sourcePath || !isInside(recordingsDir, job.sourcePath)) {
        throw new Error("sourcePath está fora de recordingsDir.");
      }
      try {
        await fs.lstat(job.sourcePath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const existing = catalog.find(
        (record) => record.sourcePath === job.sourcePath || record.id === job.id
      );
      if (existing) {
        if (
          existing.source.fileName === job.source.mediaFile &&
          existing.source.size === job.source.size &&
          existing.source.sha256?.toLowerCase() === job.source.sha256.toLowerCase() &&
          existing.vaio.state === "completed"
        ) {
          continue;
        }
        throw new Error("Identidade divergente já existe no catálogo de backup.");
      }

      const remote = await recoverOne(config, job, dependencies);
      if (remote.status === "missing") {
        report.missing += 1;
        throw new Error("O original não foi localizado nos caminhos remotos permitidos.");
      }
      if (remote.status === "divergent") throw new Error("O SHA-256 do original remoto diverge do job.");
      if (remote.status === "unsafe") throw new Error("O caminho remoto contém link simbólico ou tipo inseguro.");
      if (remote.status === "changed") throw new Error("O original remoto mudou durante a recuperação.");
      if (remote.status === "conflict") throw new Error("O destino final remoto já existe e diverge.");
      if (remote.status === "busy") throw new Error("Outra recuperação mantém o lock remoto.");
      if (remote.status !== "recovered" && remote.status !== "existing") {
        throw new Error(`Estado remoto de recuperação desconhecido: ${remote.status}`);
      }
      if (!isAbsolute(remote.archiveDir) || resolve(remote.archiveDir) !== remote.archiveDir) {
        throw new Error("O VAIO retornou archiveDir inválido.");
      }
      const checkedAt = dependencies.now ? dependencies.now() : new Date();
      if (Number.isNaN(checkedAt.getTime())) throw new Error("Relógio inválido durante recuperação.");
      const year = new Date(job.createdAt).toISOString().slice(0, 4);
      const month = new Date(job.createdAt).toISOString().slice(5, 7);
      const archiveRelative = `media/${year}/${month}/${job.id}`;
      const sourcePath = `${remote.archiveDir.replace(/\/+$/, "")}/${archiveRelative}/${job.source.mediaFile}`;
      const record: ArchiveRecord = {
        version: 1,
        id: job.id,
        createdAt: job.createdAt,
        sourcePath: job.sourcePath,
        source: {
          fileName: job.source.mediaFile,
          size: job.source.size,
          sha256: job.source.sha256.toLowerCase(),
          mtimeMs: Date.parse(job.createdAt)
        },
        vaio: {
          state: "completed",
          path: sourcePath,
          archiveDir: remote.archiveDir,
          archiveRelative,
          verifiedAt: checkedAt.toISOString()
        },
        proton: { state: "pending" }
      };
      await archiveStore.save(record);
      catalog.push(record);
      report.recovered += 1;
    } catch (error) {
      report.errors.push({ id: job.id, error: errorText(error) });
    }
  }
  return report;
};
