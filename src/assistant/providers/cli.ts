import { constants, promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AppConfig, AssistantCliTool } from "../../config/defaults";
import { type ChatProvider, type ChatRequest, type ChatResult, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import {
  childEnvironment,
  COMMON_PROVIDER_MESSAGES,
  createPrivateWorkspace,
  defaultSpawn,
  defaultWhich,
  defaultWorkspaceRoot,
  flattenConversation,
  isRecord,
  MAX_ANSWER_CHARACTERS,
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

export type CliToolPreset = { label: string; command: string; subscription: string; loginHint: string };

export const CLI_TOOLS: Record<AssistantCliTool, CliToolPreset> = {
  claude: { label: "Claude Code", command: "claude", subscription: "plano do Claude via Claude Code", loginHint: "rode `claude` no terminal e entre com sua conta" },
  codex: { label: "Codex", command: "codex", subscription: "plano do ChatGPT via Codex", loginHint: "rode `codex login` no terminal" },
  gemini: { label: "Gemini CLI", command: "gemini", subscription: "conta Google via Gemini CLI", loginHint: "rode `gemini` no terminal e entre com sua conta" },
  opencode: { label: "OpenCode", command: "opencode", subscription: "provedor configurado no OpenCode", loginHint: "rode `opencode auth login` no terminal" }
};

export const CLI_MESSAGES = {
  invalidModel: "O modelo informado para a ferramenta de linha de comando é inválido. Use só letras, números e . _ : / @ + -."
} as const;

export const cliNotFoundMessage = (preset: CliToolPreset): string => `O ${preset.label} não foi encontrado (comando ${preset.command}). Instale-o ou escolha outro provedor.`;
export const cliSignedOutMessage = (preset: CliToolPreset): string => `O ${preset.label} não está conectado: ${preset.loginHint}, e tente de novo.`;
export const cliFailedMessage = (preset: CliToolPreset): string => `O ${preset.label} não conseguiu responder. Tente de novo.`;
export const cliEmptyMessage = (preset: CliToolPreset): string => `O ${preset.label} não devolveu uma resposta.`;

export const CLI_KNOWN_ERRORS: string[] = [
  ...Object.values(CLI_MESSAGES),
  ...Object.values(CLI_TOOLS).flatMap((preset) => [cliNotFoundMessage(preset), cliSignedOutMessage(preset), cliFailedMessage(preset), cliEmptyMessage(preset)])
];

/** Instruction passed with gemini -p; the conversation itself arrives on stdin. */
export const GEMINI_STDIN_INSTRUCTION = "Read the conversation given on standard input and answer its last User message, following the instructions it contains.";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const MAX_OUTPUT_FILE_BYTES = 4 * 1024 * 1024;

export type CliInvocation = { argv: string[]; outputFile?: string };

/** argv for one question. `model` is already validated; the prompt itself never goes in argv. */
export const buildCliInvocation = (tool: AssistantCliTool, executable: string, model: string, paths: { cwd: string; outputFile: string }): CliInvocation => {
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
      return { argv: [executable, "-p", GEMINI_STDIN_INSTRUCTION, "-o", "json", ...(model ? ["-m", model] : [])] };
    case "opencode":
      return { argv: [executable, "run", "--format", "json", ...(model ? ["-m", model] : [])] };
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
export const probeCliSignIn = async (tool: AssistantCliTool, executable: string, run: ProbeRunner, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean | null> => {
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
  const preset = CLI_TOOLS[tool];
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
  const locate = (): string | undefined => {
    const found = which(preset.command);
    return found && isAbsolute(found) ? found : undefined;
  };
  const modelValid = !model || MODEL_PATTERN.test(model);

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    if (!modelValid) return { ready: false, problem: "misconfigured", message: CLI_MESSAGES.invalidModel };
    const executable = locate();
    if (!executable) return { ready: false, problem: "missing-binary", message: cliNotFoundMessage(preset) };
    const signedIn = await probeCliSignIn(tool, executable, probe, { timeoutMs: timeouts.checkMs, signal });
    throwIfCancelled(signal);
    if (signedIn === false) return { ready: false, problem: "signed-out", message: cliSignedOutMessage(preset) };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    if (!modelValid) throw new ProviderError(CLI_MESSAGES.invalidModel, "bad-request");
    const executable = locate();
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
      const invocation = buildCliInvocation(tool, executable, model, { cwd, outputFile: join(outputDir, "last.txt") });
      const result = await runCaptured(launch, invocation.argv, {
        cwd,
        env: childEnvironment(env),
        input,
        timeoutMs: timeouts.totalMs,
        signal: request.signal,
        stopSignals: ["SIGINT", "SIGTERM"],
        graceMs: timeouts.stopGraceMs
      });
      if (result.cancelled || request.signal.aborted) throw new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      if (result.timedOut) throw new ProviderError(COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      let parsed: Parsed;
      if (result.exitCode !== 0) {
        parsed = { failed: true, auth: tool === "gemini" && result.exitCode === 41 };
      } else if (tool === "claude") {
        parsed = parseClaude(result.stdout);
      } else if (tool === "codex") {
        const text = invocation.outputFile ? await readOutputFile(invocation.outputFile) : undefined;
        parsed = text === undefined ? { failed: true } : { text: text.trim() };
      } else if (tool === "gemini") {
        parsed = parseGemini(result.stdout);
      } else {
        parsed = parseOpenCode(result.stdout);
      }
      if ("failed" in parsed) {
        // Gemini reports sign-in failures with exit 41; the others are asked through their status command.
        const signedIn = parsed.auth ? false : await probeCliSignIn(tool, executable, probe, { timeoutMs: timeouts.checkMs });
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
