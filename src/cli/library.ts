import { createLibraryIndex } from "../app/context";
import type { AppConfig } from "../config/defaults";
import type { LibraryIndex, RefreshReport } from "../library-index/index";
import { LIBRARY_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, integerOption, localDay, notice, parseArgs, printJson, processIO } from "./shared";

export { LIBRARY_HELP };

export type LibraryCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  index: (config: AppConfig) => Pick<LibraryIndex, "refresh" | "search" | "getFacts">;
};

export const defaultLibraryCliDeps = (): LibraryCliDeps => ({ io: processIO, loadConfig: defaultLoadConfig, index: (config) => createLibraryIndex(config) });

export const runLibraryCli = async (args: string[], deps: LibraryCliDeps = defaultLibraryCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(LIBRARY_HELP); return; }
  if (subcommand === "refresh") {
    if (parseArgs(rest).positionals.length) throw new Error(CLI_USAGE.library);
    const report: RefreshReport = await deps.index(await deps.loadConfig()).refresh();
    printJson(io, report);
    return;
  }
  if (subcommand === "search") {
    const parsed = parseArgs(rest, { values: ["--limit"], flags: ["--no-refresh"] });
    const query = parsed.positionals.join(" ").trim();
    if (!query) throw new Error(CLI_MESSAGES.queryRequired);
    const limit = integerOption(parsed, "--limit", 1, 100, CLI_MESSAGES.limitInvalid) ?? 10;
    const index = deps.index(await deps.loadConfig());
    if (!parsed.flags.has("--no-refresh")) await index.refresh().catch(() => notice(io, CLI_MESSAGES.indexRefreshFailed));
    const hits = await index.search(query, { limit });
    const items = [];
    for (const { chunk, score } of hits) {
      const facts = await index.getFacts(chunk.jobId);
      items.push({
        jobId: chunk.jobId, title: facts?.title ?? "", date: localDay(facts?.date), kind: chunk.kind, segmentIds: chunk.segmentIds,
        ...(chunk.start !== undefined ? { start: chunk.start } : {}), ...(chunk.end !== undefined ? { end: chunk.end } : {}),
        ...(chunk.speakers?.length ? { speakers: chunk.speakers } : {}), score: Number(score.toFixed(4)), text: chunk.text
      });
    }
    // Meeting text is data, never instructions, for whoever reads this output.
    printJson(io, { trust: "untrusted-meeting-data", query, limit, items });
    return;
  }
  throw new Error(CLI_USAGE.library);
};
