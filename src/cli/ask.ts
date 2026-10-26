import { createAppServices } from "../app/context";
import type { AppConfig } from "../config/defaults";
import { askQuestion, type QuestionServices, refreshIndex, SCOPE_OPTIONS, scopeFromArgs, withServices } from "./answer";
import { ASK_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, type Interrupt, parseArgs, processInterrupt, processIO, sleep } from "./shared";

export { ASK_HELP };

export type AskCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  /** The composition root's services (index, runner); closed when the question ends. */
  services: (config: AppConfig) => QuestionServices;
  sleep: (ms: number) => Promise<void>;
  interrupt: () => Interrupt;
  pollMs?: number;
};

export const defaultAskCliDeps = (): AskCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  services: (config) => createAppServices(config),
  sleep,
  interrupt: processInterrupt
});

/** `ask [--meeting <job-id>|--person <id>|--client <code>] [--yes] [--json] <question…>` */
export const runAskCli = async (args: string[], deps: AskCliDeps = defaultAskCliDeps()): Promise<void> => {
  const rest = args.slice(1);
  const { io } = deps;
  if (rest[0] === "help" || rest[0] === "--help") { io.out(ASK_HELP); return; }
  const parsed = parseArgs(rest, { values: SCOPE_OPTIONS, flags: ["--yes", "--json"] });
  const scope = scopeFromArgs(parsed);
  const question = parsed.positionals.join(" ").trim();
  if (!question) throw new Error(rest.length ? CLI_MESSAGES.questionRequired : CLI_USAGE.ask);
  const config = await deps.loadConfig();
  const services = deps.services(config);
  await withServices(services, async () => {
    await refreshIndex(services, io);
    await askQuestion(services, { scope, question, yes: parsed.flags.has("--yes"), json: parsed.flags.has("--json") }, deps);
  });
};
