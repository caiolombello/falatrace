import { basename } from "node:path";
import { createLibraryIndex } from "../app/context";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import {
  type MediaRemovalDeps, type MediaRemovalPlan, type MediaRetentionEntry, type MediaRetentionPassItem, type MediaRetentionPassOptions,
  type MediaRetentionPlan, type MediaRetentionResult, type MediaState, mediaStateOf, type PlanMediaRetentionOptions, planMediaRemoval,
  planMediaRetention, type RetainedMode, removeMediaNow, runMediaRetentionPass
} from "../media-retention";
import { buildLibrary, type LibraryEntry } from "../tui/library";
import { MEDIA_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, integerOption, notice, oneLine, parseArgs, printJson, printLine, processIO, readJob } from "./shared";

export { MEDIA_HELP };

export type MediaCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  jobs: () => { get(id: string): Promise<JobRecord> };
  library: (config: AppConfig) => Promise<LibraryEntry[]>;
  plan: (config: AppConfig, entry: MediaRetentionEntry, options: PlanMediaRetentionOptions) => Promise<MediaRetentionPlan>;
  pass: (config: AppConfig, options: MediaRetentionPassOptions) => Promise<MediaRetentionPassItem[]>;
  planRemoval: (entry: MediaRetentionEntry, deps: MediaRemovalDeps) => Promise<MediaRemovalPlan>;
  remove: (entry: MediaRetentionEntry, mode: RetainedMode, consentKey: string, deps: MediaRemovalDeps) => Promise<MediaRetentionResult>;
  state: (entry: MediaRetentionEntry) => Promise<MediaState>;
  /** Brings the library index up to date for a recording whose media changed. */
  refreshIndex: (config: AppConfig, jobId: string) => Promise<unknown>;
};

export const defaultMediaCliDeps = (): MediaCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  jobs: () => new JobStore(),
  library: (config) => buildLibrary(config),
  plan: planMediaRetention,
  pass: runMediaRetentionPass,
  planRemoval: planMediaRemoval,
  remove: removeMediaNow,
  state: (entry) => mediaStateOf(entry),
  refreshIndex: (config, jobId) => createLibraryIndex(config).refresh({ jobIds: [jobId] })
});

const mebibytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
/** The recording's file name as one terminal line. */
const fileName = (path: string): string => oneLine(basename(path), 200);

/** The library entry of a job; a recording outside the library still has its own job. */
const entryOf = async (deps: MediaCliDeps, config: AppConfig, job: JobRecord): Promise<LibraryEntry | MediaRetentionEntry> =>
  (await deps.library(config)).find((entry) => entry.jobs.some((candidate) => candidate.id === job.id)) ?? { sourcePath: job.sourcePath, jobs: [job] };

export const runMediaCli = async (args: string[], deps: MediaCliDeps = defaultMediaCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(MEDIA_HELP); return; }
  if (subcommand === "status") {
    const parsed = parseArgs(rest);
    if (parsed.positionals.length !== 1) throw new Error(CLI_USAGE.media);
    const config = await deps.loadConfig();
    const job = await readJob(deps.jobs(), parsed.positionals[0]);
    const entry = await entryOf(deps, config, job);
    const state = ("media" in entry && entry.media) || await deps.state(entry);
    printJson(io, { jobId: job.id, file: entry.sourcePath, ...state });
    return;
  }
  if (subcommand === "retention") {
    const parsed = parseArgs(rest, { values: ["--limit"], flags: ["--dry-run", "--apply"] });
    if (parsed.positionals.length) throw new Error(CLI_USAGE.media);
    if (parsed.flags.has("--dry-run") && parsed.flags.has("--apply")) throw new Error(CLI_MESSAGES.mediaModeConflict);
    const limit = integerOption(parsed, "--limit", 1, 100, CLI_MESSAGES.limitInvalid);
    const config = await deps.loadConfig();
    if (parsed.flags.has("--apply")) {
      // Also finishes removals interrupted earlier ("removing"), even with the "keep" policy.
      const items = await deps.pass(config, limit ? { limit } : {});
      const counts: Record<MediaRetentionPassItem["outcome"], number> = { removed: 0, finalized: 0, waiting: 0, blocked: 0, deferred: 0, failed: 0 };
      for (const item of items) counts[item.outcome] += 1;
      printJson(io, {
        policy: config.media.retention,
        items: items.map((item) => ({
          file: item.sourcePath, outcome: item.outcome,
          ...(item.blockers ? { blockers: item.blockers } : {}), ...(item.waitUntil ? { waitUntil: item.waitUntil } : {}),
          ...(item.result ? { mode: item.result.mode, bytesFreed: item.result.bytesFreed } : {}), ...(item.error ? { error: item.error } : {})
        })),
        counts
      });
      if (counts.failed) throw new Error(CLI_MESSAGES.mediaPassFailed);
      return;
    }
    // Dry run: every condition except the media hash, which only an actual removal computes.
    const items = [];
    for (const entry of await deps.library(config)) {
      const plan = await deps.plan(config, entry, { reason: "policy", verifyMedia: "never" });
      // The planner stops early (no jobs) when nothing will be removed; the library entry knows them.
      const jobs = plan.jobs.length ? plan.jobs : entry.jobs ?? [];
      items.push({
        file: plan.sourcePath, jobs: jobs.map((job) => job.id), action: plan.action, mode: plan.mode,
        ready: (plan.action === "remove" || plan.action === "finalize") && plan.blockers.length === 0,
        blockers: plan.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
        ...(plan.waitUntil ? { waitUntil: plan.waitUntil } : {}), ...(plan.media.size !== undefined ? { size: plan.media.size } : {})
      });
    }
    printJson(io, { policy: config.media.retention, graceDays: config.media.graceDays, items });
    return;
  }
  if (subcommand === "remove") {
    const parsed = parseArgs(rest, { flags: ["--keep-audio", "--yes", "--json"] });
    if (parsed.positionals.length !== 1) throw new Error(CLI_USAGE.media);
    const mode: RetainedMode = parsed.flags.has("--keep-audio") ? "audio-only" : "transcript-only";
    const config = await deps.loadConfig();
    const job = await readJob(deps.jobs(), parsed.positionals[0]);
    const entry = await entryOf(deps, config, job);
    const plan = await deps.planRemoval(entry, { config });
    // An interrupted removal has one way forward (finishing it), whatever was asked.
    const option = plan.options.find((item) => item.mode === mode) ?? (plan.options.length === 1 ? plan.options[0] : undefined);
    const freed = option?.bytesFreed === null || option?.bytesFreed === undefined ? CLI_MESSAGES.mediaUnknownSize : mebibytes(option.bytesFreed);
    // Finishing an interrupted removal keeps what that removal chose, which may differ from --keep-audio.
    const kept = option?.mode ?? mode;
    notice(io, `Remover a mídia de ${fileName(entry.sourcePath)}: mantém ${kept === "audio-only" ? "a transcrição e o áudio" : "a transcrição"}; ` +
      `espaço liberado: ${freed}; ${plan.scope === "total" ? "não há cópia verificada em outro lugar" : "as cópias do backup continuam"}.`);
    if (!option?.eligible) throw new Error(option?.reasons[0] ?? plan.reasons[0] ?? CLI_MESSAGES.mediaNoOption);
    if (!parsed.flags.has("--yes")) throw new Error(CLI_MESSAGES.confirmRequired);
    const result = await deps.remove(entry, mode, plan.consentKey, { config });
    // Pages read the index; the media state of this recording just changed.
    await deps.refreshIndex(config, job.id).catch(() => undefined);
    if (parsed.flags.has("--json")) {
      printJson(io, {
        jobId: job.id, file: result.sourcePath, status: result.status, mode: result.mode, bytesFreed: result.bytesFreed,
        ...(result.retainedAudio ? { retainedAudioBytes: result.retainedAudio.size } : {}), scope: result.scope
      });
      return;
    }
    const shown = result.mode === "audio-only" ? CLI_MESSAGES.mediaUnknownSize : mebibytes(result.bytesFreed);
    printLine(io, `Mídia removida: ${fileName(result.sourcePath)}. Espaço liberado: ${shown}.`);
    return;
  }
  throw new Error(CLI_USAGE.media);
};
