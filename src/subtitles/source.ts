import type { AppConfig } from "../config/defaults";
import { ArchiveStore } from "../archive/store";
import { JobStore } from "../jobs/store";
import { inspectRemoteArchivedSource } from "../jobs/remote";
import { validateJobId } from "../jobs/types";
import type { AlignedSubtitleInput } from "./aligned";

export const resolveSubtitleSource = async (config: AppConfig, id: string): Promise<AlignedSubtitleInput> => {
  validateJobId(id);
  const archive = await new ArchiveStore().get(id);
  if (archive?.vaio.state === "completed" && archive.vaio.archiveRelative && archive.source.sha256) {
    return { id: archive.id, sourcePath: archive.sourcePath,
      source: { fileName: archive.source.fileName, size: archive.source.size, sha256: archive.source.sha256 },
      archiveRelative: archive.vaio.archiveRelative };
  }
  const job = await new JobStore().get(id).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
  });
  if (job?.target === "remote" && job.state === "completed") {
    const remote = await inspectRemoteArchivedSource(config, job, { verifyHash: true });
    return { id: job.id, sourcePath: job.sourcePath,
      source: { fileName: job.source.mediaFile, size: job.source.size, sha256: job.source.sha256 }, archiveRelative: remote.archiveRelative };
  }
  throw new Error("Aguarde a cópia do vídeo no VAIO antes de gerar as legendas precisas.");
};
