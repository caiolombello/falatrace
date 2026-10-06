import { basename, dirname } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "./command";
import { transientCommand } from "../runtime/systemd-units";
import type { JobRecord } from "./types";

let sequence = 0;

/**
 * Tell the desktop that a job finished or failed. Shows only the recording folder name,
 * never transcript or summary text. Delegated to the user manager like the call
 * notifications, so sandboxed units keep ProtectHome=read-only. Failures are ignored.
 */
export const notifyJobOutcome = async (config: AppConfig, job: JobRecord, run: typeof runCommand = runCommand): Promise<void> => {
  if (!config.processing.notifyOnCompletion || (job.state !== "completed" && job.state !== "failed")) return;
  const name = (basename(dirname(job.sourcePath)) || basename(job.sourcePath)).replace(/\p{Cc}/gu, " ").slice(0, 80);
  const [title, body] = job.state === "completed"
    ? ["Gravação processada", `${name}: transcrição e resumo prontos no FalaTrace Studio.`]
    : ["Processamento falhou", `${name}: abra o FalaTrace Studio para ver o motivo e tentar de novo.`];
  await run("systemd-run", [
    "--user", "--quiet", "--wait", "--collect", `--unit=recording-cli-notify-job-${process.pid}-${Date.now()}-${sequence++}`,
    "--", ...transientCommand(["notify-send", "--app-name", "FalaTrace", "--icon", "media-record", title, body])
  ], { timeoutMs: 5_000 }).catch(() => undefined);
};
