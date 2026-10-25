import { basename, dirname, join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { notifySendSupportsActions, type ReadyDetails, spawnDetachedNotify } from "../notify/actions";
import { runCommand } from "./command";
import { JobStore } from "./store";
import { readBoundedArtifact } from "./transcript-access";
import { transientCommand } from "../runtime/systemd-units";
import { validateJobId, type JobRecord } from "./types";

let sequence = 0;

const folderName = (job: Pick<JobRecord, "sourcePath">): string =>
  (basename(dirname(job.sourcePath)) || basename(job.sourcePath)).replace(/\p{Cc}/gu, " ").slice(0, 80);

/**
 * Tell the desktop that a job finished or failed. Shows only the recording folder name, never
 * transcript or summary text. Delegated to the user manager like the call notifications, so
 * sandboxed units keep ProtectHome=read-only. Failures are ignored.
 *
 * A finished job gets a clickable "notes ready" notification when notify-send can show buttons: a
 * detached helper unit (`notify ready --job <id>`) shows it and opens the recording in the Studio on
 * a click, so nothing here waits for the person. Without buttons (old libnotify), the plain
 * notification is shown as before.
 */
export const notifyJobOutcome = async (config: AppConfig, job: JobRecord, run?: typeof runCommand): Promise<void> => {
  if (!config.processing.notifyOnCompletion || (job.state !== "completed" && job.state !== "failed")) return;
  if (job.state === "completed") {
    const clickable = await notifySendSupportsActions(run ? { run } : {}).catch(() => false);
    if (clickable) {
      const started = await spawnDetachedNotify("ready", { job: job.id }, run ? { run } : {}).then(() => true, () => false);
      if (started) return;
    }
  }
  const name = folderName(job);
  const [title, body] = job.state === "completed"
    ? ["Gravação processada", `${name}: transcrição e resumo prontos no FalaTrace Studio.`]
    : ["Processamento falhou", `${name}: abra o FalaTrace Studio para ver o motivo e tentar de novo.`];
  await (run ?? runCommand)("systemd-run", [
    "--user", "--quiet", "--wait", "--collect", `--unit=recording-cli-notify-job-${process.pid}-${Date.now()}-${sequence++}`,
    "--", ...transientCommand(["notify-send", "--app-name", "FalaTrace", "--icon", "media-record", title, body])
  ], { timeoutMs: 5_000 }).catch(() => undefined);
};

const SUMMARY_MAX_BYTES = 20 * 1024 * 1024;
const MAX_COUNT = 999;

const count = (value: unknown): number | undefined => (Array.isArray(value) ? Math.min(value.length, MAX_COUNT) : undefined);

/**
 * What the "notes ready" notification shows for a job: the meeting's calendar title (else the
 * summary's title, else the recording folder) and how many actions and decisions the summary has.
 * Only counts and a title leave the summary; anything unreadable is simply left out.
 */
export const readyJobDetails = async (jobId: string, store: Pick<JobStore, "get"> = new JobStore()): Promise<ReadyDetails> => {
  const job = await store.get(validateJobId(jobId));
  let summary: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readBoundedArtifact(join(job.artifactDir, "summary.json"), SUMMARY_MAX_BYTES));
    summary = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    summary = undefined;
  }
  const meetingTitle = job.summary?.context?.meeting?.title;
  const summaryTitle = typeof summary?.title === "string" ? summary.title : undefined;
  const title = [meetingTitle, summaryTitle, folderName(job)].find((candidate) => typeof candidate === "string" && candidate.trim());
  const actions = count(summary?.actionItems);
  const decisions = count(summary?.decisions);
  return { ...(title ? { title } : {}), ...(actions !== undefined && decisions !== undefined ? { actions, decisions } : {}) };
};
