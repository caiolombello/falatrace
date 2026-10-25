import { isAbsolute } from "node:path";
import { ASSISTANT_CLI_TOOLS, type AssistantAcpAgent, type AssistantCliTool } from "../config/defaults";
import { ACP_AGENTS } from "./providers/acp";
import { CLI_TOOLS, defaultProbeRunner, type ProbeRunner, probeCliSignIn } from "./providers/cli";
import { defaultWhich, type WhichFn } from "./providers/common";

// Which agents and CLIs are installed, from PATH alone, plus the CLIs' own cheap sign-in
// status commands. Nothing is downloaded or installed (no npx/bunx), and no meeting content
// is involved.

export type DetectedAcpAgent = { agent: Exclude<AssistantAcpAgent, "custom">; command: string; found: boolean };
export type DetectedCliTool = { tool: AssistantCliTool; command: string; found: boolean; signedIn: boolean | null };
export type AssistantToolsReport = { acp: DetectedAcpAgent[]; cli: DetectedCliTool[] };

export type DetectDeps = {
  which?: WhichFn;
  run?: ProbeRunner;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Per status command. */
  timeoutMs?: number;
};

const locate = (which: WhichFn, command: string): string | undefined => {
  try {
    const found = which(command);
    return found && isAbsolute(found) ? found : undefined;
  } catch {
    return undefined;
  }
};

export const detectAssistantTools = async (deps: DetectDeps = {}): Promise<AssistantToolsReport> => {
  const env = deps.env ?? process.env;
  const which = deps.which ?? defaultWhich(env);
  const run = deps.run ?? defaultProbeRunner({ env });
  const acp = (Object.keys(ACP_AGENTS) as Array<keyof typeof ACP_AGENTS>).map((agent) => {
    const command = ACP_AGENTS[agent].command;
    return { agent, command, found: locate(which, command) !== undefined };
  });
  const cli = await Promise.all(
    ASSISTANT_CLI_TOOLS.map(async (tool): Promise<DetectedCliTool> => {
      const command = CLI_TOOLS[tool].command;
      const executable = locate(which, command);
      if (!executable) return { tool, command, found: false, signedIn: null };
      const signedIn = deps.signal?.aborted ? null : await probeCliSignIn(tool, executable, run, { timeoutMs: deps.timeoutMs ?? 5_000, signal: deps.signal });
      return { tool, command, found: true, signedIn };
    })
  );
  return { acp, cli };
};
