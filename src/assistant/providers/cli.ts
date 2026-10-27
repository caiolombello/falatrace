import { constants, promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AppConfig, AssistantCliTool } from "../../config/defaults";
import { type ChatProvider, type ChatRequest, type ChatResult, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import {
  agentToolsNotAccepted,
  childEnvironment,
  COMMON_PROVIDER_MESSAGES,
  createPrivateWorkspace,
  defaultSpawn,
  defaultWhich,
  defaultWorkspaceRoot,
  flattenConversation,
  GEMINI_NO_EXTENSIONS,
  isRecord,
  MAX_ANSWER_CHARACTERS,
  opencodeLockdown,
  type ProviderTimeouts,
  runCaptured,
  type SpawnFn,
  throwIfCancelled,
  validateChatRequest,
  type WhichFn
} from "./common";

// One-shot runs of the user's own subscription CLIs. The prompt goes on stdin, the working
// directory is a fresh empty folder, tools/MCP/session history are switched off where the
// CLI allows it, and the answer is read from its JSON output. No streaming: the whole answer
// is delivered once.

export type CliToolPreset = { label: string; command: string; subscription: string; loginHint: string; /** Replaces the usual "not found" message. */ notFound?: string };

export const CLI_TOOLS: Record<AssistantCliTool, CliToolPreset> = {
  claude: { label: "Claude Code", command: "claude", subscription: "plano do Claude via Claude Code", loginHint: "rode `claude` no terminal e entre com sua conta" },
  codex: { label: "Codex", command: "codex", subscription: "plano do ChatGPT via Codex", loginHint: "rode `codex login` no terminal" },
  gemini: {
    label: "Gemini CLI", command: "gemini", subscription: "conta Google via Gemini CLI", loginHint: "rode `gemini` no terminal e entre com sua conta",
    notFound: "Nem o Antigravity CLI (agy) nem o Gemini CLI foram encontrados. Instale o Antigravity CLI ou escolha outro provedor."
  },
  opencode: { label: "OpenCode", command: "opencode", subscription: "provedor configurado no OpenCode", loginHint: "rode `opencode auth login` no terminal" }
};

/** Google's successor to the Gemini CLI for personal accounts; the "gemini" choice runs it when installed. */
export const ANTIGRAVITY_CLI: CliToolPreset = { label: "Antigravity CLI", command: "agy", subscription: "conta Google via Antigravity CLI", loginHint: "rode `agy` no terminal e entre com sua conta" };

/** How a question is run: the chosen tool, or agy behind the "gemini" choice. */
export type CliVariant = AssistantCliTool | "antigravity";

export type ResolvedCliTool = { variant: CliVariant; preset: CliToolPreset; executable?: string };

/**
 * The program behind a choice. "gemini" runs the Antigravity CLI (agy) when it is installed and
 * the legacy `gemini` only where agy is not; the other choices run their own command.
 */
export const resolveCliTool = (tool: AssistantCliTool, which: WhichFn): ResolvedCliTool => {
  const find = (command: string): string | undefined => {
    try {
      const found = which(command);
      return found && isAbsolute(found) ? found : undefined;
    } catch {
      return undefined;
    }
  };
  if (tool === "gemini") {
    const agy = find(ANTIGRAVITY_CLI.command);
    if (agy) return { variant: "antigravity", preset: ANTIGRAVITY_CLI, executable: agy };
  }
  const preset = CLI_TOOLS[tool];
  const executable = find(preset.command);
  return { variant: tool, preset, ...(executable ? { executable } : {}) };
};

export const CLI_MESSAGES = {
  invalidModel: "O modelo informado para a ferramenta de linha de comando é inválido. Use só letras, números e . _ : / @ + -."
} as const;

export const cliNotFoundMessage = (preset: CliToolPreset): string => preset.notFound ?? `O ${preset.label} não foi encontrado (comando ${preset.command}). Instale-o ou escolha outro provedor.`;
export const cliSignedOutMessage = (preset: CliToolPreset): string => `O ${preset.label} não está conectado: ${preset.loginHint}, e tente de novo.`;
export const cliFailedMessage = (preset: CliToolPreset): string => `O ${preset.label} não conseguiu responder. Tente de novo.`;
export const cliEmptyMessage = (preset: CliToolPreset): string => `O ${preset.label} não devolveu uma resposta.`;

export const CLI_KNOWN_ERRORS: string[] = [
  ...Object.values(CLI_MESSAGES),
  ...[...Object.values(CLI_TOOLS), ANTIGRAVITY_CLI].flatMap((preset) => [cliNotFoundMessage(preset), cliSignedOutMessage(preset), cliFailedMessage(preset), cliEmptyMessage(preset)])
];

/** Instruction passed with gemini -p; the conversation itself arrives on stdin. */
export const GEMINI_STDIN_INSTRUCTION = "Read the conversation given on standard input and answer its last User message, following the instructions it contains.";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const MAX_OUTPUT_FILE_BYTES = 4 * 1024 * 1024;

/** `lockdown`: the tool's own settings that refuse its tools, added to its environment. */
export type CliInvocation = { argv: string[]; outputFile?: string; lockdown?: Record<string, string> };

/**
 * agy reads the prompt from stdin only as stream-json: one {"event":"user"} line per turn. The
 * conversation travels as a single turn, so the CLI answers once and exits when stdin closes.
 */
export const antigravityStdin = (conversation: string): string => `${JSON.stringify({ event: "user", message: { content: conversation } })}\n`;

/** argv for one question. `model` is already validated; the prompt itself never goes in argv. */
export const buildCliInvocation = (tool: CliVariant, executable: string, model: string, paths: { cwd: string; outputFile: string }): CliInvocation => {
  switch (tool) {
    case "claude":
      return {
        argv: [executable, "-p", "--output-format", "json", "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--permission-mode", "dontAsk",
          "--max-turns", "1", "--no-session-persistence", ...(model ? ["--model", model] : [])]
      };
    case "codex":
      return {
        argv: [executable, "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", paths.cwd, "--color", "never",
          ...(model ? ["-m", model] : []), "-o", paths.outputFile, "-"],
        outputFile: paths.outputFile
      };
    case "gemini":
      return { argv: [executable, "-p", GEMINI_STDIN_INSTRUCTION, "-o", "json", ...GEMINI_NO_EXTENSIONS, ...(model ? ["-m", model] : [])] };
    case "opencode":
      // OpenCode has no flag to turn tools off and allows most of them without asking by default.
      return { argv: [executable, "run", "--format", "json", ...(model ? ["-m", model] : [])], lockdown: opencodeLockdown("deny") };
    case "antigravity":
      // agy has no flag to turn its tools off and follows the user's own permission setting
      // (often "always-proceed"); --sandbox at least confines its terminal commands. "-p=" turns
      // on print mode with an empty prompt: the question comes on stdin.
      return {
        argv: [executable, "--input-format", "stream-json", "--output-format", "stream-json", "--sandbox", "--disable-slash-commands",
          ...(model ? ["--model", model] : []), "-p="]
      };
  }
};

const parseJsonOutput = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some versions print a warning line before the JSON document.
    const lines = trimmed.split("\n").filter((line) => line.trim());
    try {
      return JSON.parse(lines[lines.length - 1] as string);
    } catch {
      return undefined;
    }
  }
};

type Parsed = { text: string; stopReason?: "end" | "length"; usage?: ChatResult["usage"] } | { failed: true; auth?: boolean };

const parseClaude = (stdout: string): Parsed => {
  const value = parseJsonOutput(stdout);
  if (!isRecord(value) || value.is_error === true || (value.subtype !== undefined && value.subtype !== "success") || typeof value.result !== "string") return { failed: true };
  const usage = isRecord(value.usage) ? value.usage : undefined;
  return {
    text: value.result,
    stopReason: value.stop_reason === "max_tokens" ? "length" : "end",
    ...(usage ? { usage: { inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined, outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined } } : {})
  };
};

const parseGemini = (stdout: string): Parsed => {
  const value = parseJsonOutput(stdout);
  if (!isRecord(value) || (value.error !== undefined && value.error !== null) || typeof value.response !== "string") return { failed: true };
  return { text: value.response };
};

/** Best effort: OpenCode's JSON events are not documented; text parts are joined in order. */
const parseOpenCode = (stdout: string): Parsed => {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "error") return { failed: true };
    if (event.type !== "text") continue;
    const text = isRecord(event.part) && typeof event.part.text === "string" ? event.part.text : typeof event.text === "string" ? event.text : undefined;
    if (text) parts.push(text);
  }
  return { text: parts.join("\n\n") };
};

/** agy's stream-json output: the last "result" event carries the status and the whole answer. */
const parseAntigravity = (stdout: string): Parsed => {
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(event) && event.event === "result" && isRecord(event.result)) result = event.result;
  }
  if (!result) return { failed: true };
  if (result.status !== "SUCCESS" || typeof result.response !== "string") {
    // Print mode reports a missing or expired sign-in as an auth error of the run.
    return { failed: true, auth: typeof result.error === "string" && /\bauth/i.test(result.error) };
  }
  const usage = isRecord(result.usage) ? result.usage : undefined;
  return {
    text: result.response.trim(),
    ...(usage ? { usage: { inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined, outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined } } : {})
  };
};

/** Reads codex's final-message file without following a link someone could have put there. */
const readOutputFile = async (path: string): Promise<string | undefined> => {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_OUTPUT_FILE_BYTES) return undefined;
    return await handle.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
};

export type ProbeRunner = (argv: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; stdout: string }>;

/** Default probe runner: no stdin, private empty working directory, bounded output. */
export const defaultProbeRunner = (options: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv; workspaceRoot?: string } = {}): ProbeRunner => async (argv, probe) => {
  const env = options.env ?? process.env;
  const workspace = await createPrivateWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot(env));
  try {
    const result = await runCaptured(options.spawn ?? defaultSpawn, argv, { cwd: workspace.path, env: childEnvironment(env), timeoutMs: probe.timeoutMs, signal: probe.signal, maxOutputBytes: 64 * 1024 });
    return { exitCode: result.exitCode, stdout: result.stdout };
  } finally {
    await workspace.remove();
  }
};

/**
 * Whether the CLI is signed in, from its own cheap status command: `claude auth status` (JSON
 * authMethod) or `codex login status` (exit 0). null when the tool has no such command or the
 * answer is unclear.
 */
export const probeCliSignIn = async (tool: CliVariant, executable: string, run: ProbeRunner, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean | null> => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    if (tool === "claude") {
      const result = await run([executable, "auth", "status"], { timeoutMs, signal: options.signal });
      if (result.exitCode === 1) return false;
      if (result.exitCode !== 0) return null;
      const status = parseJsonOutput(result.stdout);
      if (!isRecord(status)) return null;
      if (status.loggedIn === false || status.authMethod === "none") return false;
      return typeof status.authMethod === "string" || status.loggedIn === true ? true : null;
    }
    if (tool === "codex") {
      const result = await run([executable, "login", "status"], { timeoutMs, signal: options.signal });
      if (result.exitCode === null) return null;
      return result.exitCode === 0;
    }
  } catch {
    return null;
  }
  return null;
};

export type CliDeps = {
  spawn?: SpawnFn;
  which?: WhichFn;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  /** Status commands; defaults to running them with `spawn`. */
  probe?: ProbeRunner;
  timeouts?: ProviderTimeouts & { stopGraceMs?: number };
};

const DEFAULT_TIMEOUTS = { totalMs: 10 * 60_000, checkMs: 5_000, stopGraceMs: 3_000 };
/** Claude Code caps piped stdin at 10 MB; the same bound keeps every CLI safe. */
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

export const createCliProvider = (config: AppConfig, deps: CliDeps = {}): ChatProvider => {
  const env = deps.env ?? process.env;
  const which = deps.which ?? defaultWhich(env);
  const spawn = deps.spawn ?? defaultSpawn;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const tool = config.assistant.cliTool;
  // The destination names the program found now; each question looks again.
  const { preset } = resolveCliTool(tool, which);
  const model = config.assistant.cliModel;
  const workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot(env);
  const probe = deps.probe ?? defaultProbeRunner({ spawn, env, workspaceRoot });
  const destination: ProviderDestination = {
    kind: "cli",
    id: `cli:${tool}`,
    label: model ? `${preset.label} · ${model}` : preset.label,
    endpoint: preset.command,
    model,
    external: true,
    subscription: preset.subscription
  };
  const modelValid = !model || MODEL_PATTERN.test(model);
  // A tool that can run tools FalaTrace cannot switch off answers only once the user accepted that.
  const toolsNotAccepted = agentToolsNotAccepted(config, destination.id);

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    if (!modelValid) return { ready: false, problem: "misconfigured", message: CLI_MESSAGES.invalidModel };
    if (toolsNotAccepted) return { ready: false, problem: "misconfigured", message: COMMON_PROVIDER_MESSAGES.toolsNotAccepted };
    const { variant, preset, executable } = resolveCliTool(tool, which);
    if (!executable) return { ready: false, problem: "missing-binary", message: cliNotFoundMessage(preset) };
    const signedIn = await probeCliSignIn(variant, executable, probe, { timeoutMs: timeouts.checkMs, signal });
    throwIfCancelled(signal);
    if (signedIn === false) return { ready: false, problem: "signed-out", message: cliSignedOutMessage(preset) };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    if (!modelValid) throw new ProviderError(CLI_MESSAGES.invalidModel, "bad-request");
    if (toolsNotAccepted) throw new ProviderError(COMMON_PROVIDER_MESSAGES.toolsNotAccepted, "bad-request");
    const { variant, preset, executable } = resolveCliTool(tool, which);
    if (!executable) throw new ProviderError(cliNotFoundMessage(preset), "unavailable");
    const input = flattenConversation(request.system, request.messages);
    if (Buffer.byteLength(input) > MAX_STDIN_BYTES) throw new ProviderError(COMMON_PROVIDER_MESSAGES.requestTooLarge, "bad-request");
    throwIfCancelled(request.signal);
    const workspace = await createPrivateWorkspace(workspaceRoot).catch(() => {
      throw new ProviderError(cliFailedMessage(preset), "unavailable");
    });
    const launch: SpawnFn = (argv, options) => {
      try {
        return spawn(argv, options);
      } catch {
        // On PATH but not startable: removed meanwhile, or a script whose interpreter is gone.
        throw new ProviderError(cliNotFoundMessage(preset), "unavailable");
      }
    };
    try {
      // The tool works in an empty folder; codex writes its final message to a sibling folder.
      const cwd = join(workspace.path, "workspace");
      const outputDir = join(workspace.path, "output");
      await fs.mkdir(cwd, { mode: 0o700 });
      await fs.mkdir(outputDir, { mode: 0o700 });
      const invocation = buildCliInvocation(variant, executable, model, { cwd, outputFile: join(outputDir, "last.txt") });
      const result = await runCaptured(launch, invocation.argv, {
        cwd,
        env: childEnvironment(env, invocation.lockdown),
        input: variant === "antigravity" ? antigravityStdin(input) : input,
        timeoutMs: timeouts.totalMs,
        signal: request.signal,
        stopSignals: ["SIGINT", "SIGTERM"],
        graceMs: timeouts.stopGraceMs
      });
      if (result.cancelled || request.signal.aborted) throw new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      if (result.timedOut) throw new ProviderError(COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      let parsed: Parsed;
      if (result.exitCode !== 0) {
        const antigravityAuth = variant === "antigravity" && (() => { const outcome = parseAntigravity(result.stdout); return "failed" in outcome && outcome.auth === true; })();
        parsed = { failed: true, auth: (variant === "gemini" && result.exitCode === 41) || antigravityAuth };
      } else if (variant === "antigravity") {
        parsed = parseAntigravity(result.stdout);
      } else if (variant === "claude") {
        parsed = parseClaude(result.stdout);
      } else if (variant === "codex") {
        const text = invocation.outputFile ? await readOutputFile(invocation.outputFile) : undefined;
        parsed = text === undefined ? { failed: true } : { text: text.trim() };
      } else if (variant === "gemini") {
        parsed = parseGemini(result.stdout);
      } else {
        parsed = parseOpenCode(result.stdout);
      }
      if ("failed" in parsed) {
        // Gemini reports sign-in failures with exit 41 and agy in its result event; the others are asked through their status command.
        const signedIn = parsed.auth ? false : await probeCliSignIn(variant, executable, probe, { timeoutMs: timeouts.checkMs });
        if (signedIn === false) throw new ProviderError(cliSignedOutMessage(preset), "auth");
        throw new ProviderError(cliFailedMessage(preset), "unavailable");
      }
      if (!parsed.text.trim()) throw new ProviderError(cliEmptyMessage(preset), "protocol");
      const text = parsed.text.length > MAX_ANSWER_CHARACTERS ? parsed.text.slice(0, MAX_ANSWER_CHARACTERS) : parsed.text;
      request.onDelta?.(text);
      return {
        text,
        stopReason: text.length < parsed.text.length ? "length" : (parsed.stopReason ?? "end"),
        ...(parsed.usage ? { usage: parsed.usage } : {})
      };
    } catch (error) {
      // Only fixed Portuguese messages leave a provider; a raw error could name local paths.
      throw error instanceof ProviderError ? error : new ProviderError(cliFailedMessage(preset), "unavailable");
    } finally {
      await workspace.remove();
    }
  };

  return { destination, check, run };
};
