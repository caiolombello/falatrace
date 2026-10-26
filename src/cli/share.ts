import { listActions } from "../actions/list";
import { createLibraryIndex } from "../app/context";
import type { AppConfig } from "../config/defaults";
import {
  type DeliverShareInput, type DeliveryReceipt, type DestinationKind, type DestinationStatus, deliverShare, describeDestinations, EXTERNAL_DESTINATIONS,
  type ShareDestinationRequest
} from "../destinations";
import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { buildShareNoteWithLanguage } from "../share/job-note";
import { renderShare, type ShareInclude, type ShareLanguage, type ShareNote } from "../share/render";
import { SHARE_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, notice, parseArgs, printJson, processIO, readJob } from "./shared";

export { SHARE_HELP };

export const SHARE_TARGETS = ["clipboard", "obsidian", "notion", "slack", "ai-app"] as const;
export type ShareTarget = (typeof SHARE_TARGETS)[number];
const INCLUDES: readonly ShareInclude[] = ["summary", "summary+notes", "full"];

export type ShareCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  jobs: () => { get(id: string): Promise<JobRecord> };
  /** The recording's ShareNote and the language to render it in. */
  buildNote: (config: AppConfig, job: JobRecord) => Promise<{ note: ShareNote; language: ShareLanguage }>;
  describe: (config: AppConfig) => Promise<DestinationStatus[]>;
  deliver: (input: DeliverShareInput) => Promise<DeliveryReceipt>;
};

/** People, client and action states come from the library index (refreshed for this recording first). */
const defaultBuildNote = async (config: AppConfig, job: JobRecord): Promise<{ note: ShareNote; language: ShareLanguage }> => {
  const index = createLibraryIndex(config);
  await index.refresh({ jobIds: [job.id] }).catch(() => undefined);
  return buildShareNoteWithLanguage(job, {
    facts: (jobId) => index.getFacts(jobId),
    // Read-only listing: sharing never rewrites the saved action states.
    actions: (current) => listActions(index, { jobId: current.id }, { persist: false })
  });
};

export const defaultShareCliDeps = (): ShareCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  jobs: () => new JobStore(),
  buildNote: defaultBuildNote,
  describe: (config) => describeDestinations(config),
  deliver: (input) => deliverShare(input)
});

const requestFor = (target: ShareTarget): ShareDestinationRequest => {
  switch (target) {
    case "obsidian": return { destination: "obsidian", open: false };
    case "notion": return { destination: "notion" };
    case "slack": return { destination: "slack" };
    case "clipboard": return { destination: "clipboard", mode: "system" };
    case "ai-app": return { destination: "ai-app", clipboard: "system", open: true };
  }
};

export const isExternalShare = (target: ShareTarget): boolean => EXTERNAL_DESTINATIONS.includes(target as DestinationKind);

/** `share <job-id> --to <destination> [--include …] [--yes] [--dry-run]` */
export const runShareCli = async (args: string[], deps: ShareCliDeps = defaultShareCliDeps()): Promise<void> => {
  const rest = args.slice(1);
  const { io } = deps;
  if (rest[0] === "help" || rest[0] === "--help") { io.out(SHARE_HELP); return; }
  const parsed = parseArgs(rest, { values: ["--to", "--include"], flags: ["--yes", "--dry-run"] });
  const [jobId, ...extra] = parsed.positionals;
  if (!jobId || extra.length) throw new Error(CLI_USAGE.share);
  const to = parsed.values["--to"];
  if (!to || !(SHARE_TARGETS as readonly string[]).includes(to)) throw new Error(CLI_MESSAGES.shareDestinationRequired);
  const target = to as ShareTarget;
  const includeRaw = parsed.values["--include"] ?? "summary+notes";
  if (!(INCLUDES as readonly string[]).includes(includeRaw)) throw new Error(CLI_MESSAGES.shareIncludeInvalid);
  const include = includeRaw as ShareInclude;
  const config = await deps.loadConfig();
  const job = await readJob(deps.jobs(), jobId);
  const { note, language } = await deps.buildNote(config, job);
  // Obsidian keeps files, so its notes carry the frontmatter; chat-like destinations get the body.
  const share = renderShare(note, { frontmatter: target === "obsidian", language, include });
  if (parsed.flags.has("--dry-run")) {
    io.out(share.markdown.endsWith("\n") ? share.markdown : `${share.markdown}\n`);
    return;
  }
  const external = isExternalShare(target);
  const status = (await deps.describe(config)).find((item) => item.destination === target);
  notice(io, `Destino: ${target}${status?.target ? ` → ${status.target}` : ""} (${external ? "fora deste computador" : "neste computador"})`);
  if (status && !status.ready && status.problem) throw new Error(status.problem);
  if (external && !parsed.flags.has("--yes")) throw new Error(CLI_MESSAGES.consentRequired);
  const receipt = await deps.deliver({
    share, config, request: requestFor(target), expectedSnapshot: share.snapshot, ...(external ? { consent: true } : {})
  });
  const { content: _content, ...shown } = receipt;
  printJson(io, shown);
};
