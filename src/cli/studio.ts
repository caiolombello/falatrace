import { OPEN_REQUEST_ERRORS, openInStudio, parseFalatraceUri } from "../desktop/open-request";
import { STUDIO_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, parseArgs, printJson, processIO } from "./shared";

export { STUDIO_HELP };

export type StudioCliDeps = {
  io: CliIO;
  /** Queues the link for a running Studio, else starts the Studio with it. */
  open: (uri: string) => Promise<"queued" | "launched">;
};

export const defaultStudioCliDeps = (): StudioCliDeps => ({ io: processIO, open: (uri) => openInStudio(uri) });

/** `studio open <falatrace-uri>`: navigation only; the link is validated before anything starts. */
export const runStudioCli = async (args: string[], deps: StudioCliDeps = defaultStudioCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(STUDIO_HELP); return; }
  if (subcommand !== "open") throw new Error(CLI_USAGE.studio);
  const parsed = parseArgs(rest);
  const [uri, ...extra] = parsed.positionals;
  if (!uri || extra.length) throw new Error(CLI_MESSAGES.uriRequired);
  const target = parseFalatraceUri(uri);
  if (!target) throw new Error(OPEN_REQUEST_ERRORS.invalidUri);
  printJson(io, { uri, target, result: await deps.open(uri) });
};
