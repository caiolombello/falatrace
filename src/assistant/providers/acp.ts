import { isAbsolute } from "node:path";
import { version as productVersion } from "../../../package.json";
import type { AppConfig, AssistantAcpAgent } from "../../config/defaults";
import { type ChatProvider, type ChatRequest, type ChatResult, type ChatStopReason, ProviderError, type ProviderDestination, type ProviderReadiness } from "../types";
import {
  abortPromise,
  type ChildProcess,
  childEnvironment,
  COMMON_PROVIDER_MESSAGES,
  createPrivateWorkspace,
  Deadline,
  defaultSpawn,
  defaultWhich,
  defaultWorkspaceRoot,
  flattenConversation,
  isRecord,
  MAX_ANSWER_CHARACTERS,
  type ProviderTimeouts,
  readBounded,
  readLines,
  type SpawnFn,
  stopProcessTree,
  throwIfCancelled,
  validateChatRequest,
  type WhichFn
} from "./common";
import { ShellWordsError, splitShellWords } from "./shell-words";

// Minimal client of the Agent Client Protocol (JSON-RPC 2.0, one JSON object per line over
// the agent's stdio). FalaTrace advertises no file system or terminal, starts every question
// in a fresh empty directory, and turns down every tool permission the agent asks for: the
// agent only reads the text it is given and answers.

export const ACP_PROTOCOL_VERSION = 1;
/** JSON-RPC code ACP agents use for "authentication required". */
export const ACP_AUTH_REQUIRED = -32000;
const METHOD_NOT_FOUND = -32601;

export type AcpAgentPreset = {
  label: string;
  command: string;
  args: string[];
  /** How the user signs in, named when the agent answers "authentication required". */
  loginHint: string;
  /** Plan whose limits the agent uses, shown with the destination. */
  subscription?: string;
};

export const ACP_AGENTS: Record<Exclude<AssistantAcpAgent, "custom">, AcpAgentPreset> = {
  // API key or Console login only: Anthropic does not allow third-party apps to route Claude.ai plan credentials.
  claude: { label: "Claude Agent", command: "claude-agent-acp", args: ["--hide-claude-auth"], loginHint: "rode `claude auth login --console` (conta do Console) ou defina ANTHROPIC_API_KEY no terminal" },
  codex: { label: "Codex", command: "codex-acp", args: [], loginHint: "rode `codex login` no terminal", subscription: "plano do ChatGPT via Codex" },
  gemini: { label: "Gemini CLI", command: "gemini", args: ["--acp"], loginHint: "rode `gemini` no terminal e entre com sua conta", subscription: "conta Google via Gemini CLI" },
  opencode: { label: "OpenCode", command: "opencode", args: ["acp"], loginHint: "rode `opencode auth login` no terminal", subscription: "provedor configurado no OpenCode" },
  kiro: { label: "Kiro CLI", command: "kiro-cli", args: ["acp"], loginHint: "rode `kiro-cli login` no terminal", subscription: "plano do Kiro" },
  copilot: { label: "GitHub Copilot CLI", command: "copilot", args: ["--acp"], loginHint: "rode `copilot` no terminal e use /login", subscription: "plano do GitHub Copilot" },
  cursor: { label: "Cursor Agent", command: "cursor-agent", args: ["acp"], loginHint: "rode `cursor-agent login` no terminal", subscription: "plano do Cursor" },
  goose: { label: "goose", command: "goose", args: ["acp"], loginHint: "rode `goose configure` no terminal", subscription: "provedor configurado no goose" },
  qwen: { label: "Qwen Code", command: "qwen", args: ["--acp"], loginHint: "rode `qwen` no terminal e entre com sua conta", subscription: "plano do Qwen Code" },
  grok: { label: "Grok Build", command: "grok", args: ["agent", "stdio"], loginHint: "rode `grok login` no terminal", subscription: "plano do Grok via Grok Build" }
};

const CUSTOM_LABEL = "ACP personalizado";

export const ACP_MESSAGES = {
  customMissing: "Informe o comando do agente ACP em Configurações › Perguntar e receitas.",
  customNotFound: "O programa do agente ACP personalizado não foi encontrado. Confira o comando em Configurações › Perguntar e receitas.",
  customAuth: "O agente ACP personalizado pede login. Entre pelo terminal do próprio agente e tente de novo."
} as const;

export const acpNotFoundMessage = (preset: AcpAgentPreset): string =>
  `O agente ${preset.label} não foi encontrado (comando ${preset.command}). Instale-o ou escolha outro agente.`;
export const acpAuthMessage = (preset: AcpAgentPreset): string => `O agente ${preset.label} pede login: ${preset.loginHint}, e tente de novo.`;
export const acpExitedMessage = (label: string): string => `O agente ${label} encerrou antes de responder.`;
export const acpProtocolMessage = (label: string): string => `O agente ${label} respondeu fora do protocolo ACP.`;
export const acpVersionMessage = (label: string): string => `O agente ${label} usa uma versão do protocolo ACP que o FalaTrace não suporta.`;
export const acpFailedMessage = (label: string): string => `O agente ${label} não conseguiu responder. Tente de novo.`;

export const ACP_KNOWN_ERRORS: string[] = [
  ...Object.values(ACP_MESSAGES),
  ...Object.values(ACP_AGENTS).flatMap((preset) => [acpNotFoundMessage(preset), acpAuthMessage(preset)]),
  ...[...Object.values(ACP_AGENTS).map((preset) => preset.label), CUSTOM_LABEL].flatMap((label) => [
    acpExitedMessage(label),
    acpProtocolMessage(label),
    acpVersionMessage(label),
    acpFailedMessage(label)
  ])
];

export type AcpDeps = {
  spawn?: SpawnFn;
  which?: WhichFn;
  env?: NodeJS.ProcessEnv;
  /** Parent of the per-question empty working directories. */
  workspaceRoot?: string;
  timeouts?: ProviderTimeouts & {
    /** initialize + session/new. */
    startMs?: number;
    /** How long a cancelled turn may take to wrap up before the agent is stopped. */
    cancelGraceMs?: number;
    /** Between SIGTERM and SIGKILL. */
    killGraceMs?: number;
  };
};

const DEFAULT_TIMEOUTS = { totalMs: 10 * 60_000, idleMs: 3 * 60_000, checkMs: 5_000, startMs: 60_000, cancelGraceMs: 5_000, killGraceMs: 2_000 };
const MAX_LINE_BYTES = 8 * 1024 * 1024;

type ResolvedAgent = { argv: string[]; label: string; preset?: AcpAgentPreset };

/** argv of the configured agent, or a Portuguese reason it cannot be used. */
export const resolveAcpAgent = (config: AppConfig, home?: string): ResolvedAgent | { error: string } => {
  const agent = config.assistant.acpAgent;
  if (agent !== "custom") {
    const preset = ACP_AGENTS[agent];
    return { argv: [preset.command, ...preset.args], label: preset.label, preset };
  }
  if (!config.assistant.acpCommand.trim()) return { error: ACP_MESSAGES.customMissing };
  try {
    return { argv: splitShellWords(config.assistant.acpCommand, { home }), label: CUSTOM_LABEL };
  } catch (error) {
    return { error: error instanceof ShellWordsError ? error.message : ACP_MESSAGES.customMissing };
  }
};

/** The option that turns a tool down: reject_once, else reject_always, else a cancelled outcome. */
export const choosePermissionOutcome = (params: unknown, cancelled: boolean): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } => {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  const options = isRecord(params) && Array.isArray(params.options) ? params.options.slice(0, 100) : [];
  for (const kind of ["reject_once", "reject_always"]) {
    const option = options.find((entry) => isRecord(entry) && entry.kind === kind && typeof entry.optionId === "string" && entry.optionId.length > 0 && entry.optionId.length <= 500);
    if (isRecord(option)) return { outcome: { outcome: "selected", optionId: option.optionId as string } };
  }
  return { outcome: { outcome: "cancelled" } };
};

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

class ConnectionClosed extends Error {}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** JSON-RPC over the agent's stdin/stdout, one object per line. */
class AcpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private writing: Promise<unknown> = Promise.resolve();
  private closedError: Error | undefined;
  private readonly stopReading = new AbortController();
  readonly done: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: {
      onNotification: (method: string, params: unknown) => void;
      onRequest: (method: string, params: unknown) => unknown;
      onActivity: () => void;
      onProtocolError: () => void;
    }
  ) {
    this.done = this.listen();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async endInput(): Promise<void> {
    this.writing = this.writing.then(() => this.child.stdin.end()).catch(() => undefined);
    await this.writing;
  }

  /** Stops waiting for answers, e.g. when the agent exited but left its stdout open. */
  close(error: Error): void {
    this.closedError ??= error;
    this.stopReading.abort();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(this.closedError);
    }
  }

  private send(message: object): void {
    // JSON.stringify never emits a raw newline, so one message is always one line.
    const line = `${JSON.stringify(message)}\n`;
    this.writing = this.writing.then(() => this.child.stdin.write(line)).catch(() => undefined);
  }

  private reply(id: unknown, outcome: { result: unknown } | { error: { code: number; message: string } }): void {
    this.send({ jsonrpc: "2.0", id, ...outcome });
  }

  private async listen(): Promise<void> {
    try {
      for await (const line of readLines(this.child.stdout, { maxLineBytes: MAX_LINE_BYTES, signal: this.stopReading.signal })) {
        this.handlers.onActivity();
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          // Agents must keep stdout for ACP; a stray log line is skipped, not fatal.
          continue;
        }
        if (!isRecord(message) || message.jsonrpc !== "2.0") continue;
        this.dispatch(message);
      }
      this.close(new ConnectionClosed("agent closed its output"));
    } catch {
      this.handlers.onProtocolError();
      this.close(new ConnectionClosed("agent output was not ACP"));
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const hasId = message.id !== undefined && message.id !== null;
      if (!hasId) {
        this.handlers.onNotification(message.method, message.params);
        return;
      }
      if (typeof message.id !== "string" && typeof message.id !== "number") return;
      try {
        this.reply(message.id, { result: this.handlers.onRequest(message.method, message.params) });
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32603;
        this.reply(message.id, { error: { code, message: error instanceof RpcError ? error.message : "Internal error" } });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -32603;
      pending.reject(new RpcError(code, "agent error"));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new RpcError(-32603, "malformed response"));
    }
  }
}

/** Resolves when the promise settles or after ms, whichever is first; the timer never outlives it. */
const settleWithin = async (promise: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    })
  ]);
  if (timer) clearTimeout(timer);
};

/** A delay that does not keep the process alive on its own. */
const unrefDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

const stopReasonOf = (value: unknown): ChatStopReason | undefined => {
  switch (value) {
    case "end_turn":
      return "end";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
};

export const createAcpProvider = (config: AppConfig, deps: AcpDeps = {}): ChatProvider => {
  const env = deps.env ?? process.env;
  const which = deps.which ?? defaultWhich(env);
  const spawn = deps.spawn ?? defaultSpawn;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const resolved = resolveAcpAgent(config, env.HOME);
  const agentId = config.assistant.acpAgent;
  const preset = "error" in resolved ? undefined : resolved.preset;
  const label = "error" in resolved ? CUSTOM_LABEL : resolved.label;
  const destination: ProviderDestination = {
    kind: "acp",
    id: `acp:${agentId}`,
    label: `${label} (ACP)`,
    // The program only: arguments of a custom command could hold tokens.
    endpoint: "error" in resolved ? "" : (resolved.argv[0] as string),
    model: "",
    external: true,
    ...(preset?.subscription ? { subscription: preset.subscription } : {})
  };

  const notFound = (): string => (preset ? acpNotFoundMessage(preset) : ACP_MESSAGES.customNotFound);
  const locate = (): string | undefined => {
    if ("error" in resolved) return undefined;
    const found = which(resolved.argv[0] as string);
    return found && isAbsolute(found) ? found : undefined;
  };

  const check = async (signal?: AbortSignal): Promise<ProviderReadiness> => {
    throwIfCancelled(signal);
    if ("error" in resolved) return { ready: false, problem: "misconfigured", message: resolved.error };
    if (!locate()) return { ready: false, problem: "missing-binary", message: notFound() };
    return { ready: true };
  };

  const run = async (request: ChatRequest): Promise<ChatResult> => {
    validateChatRequest(request);
    if ("error" in resolved) throw new ProviderError(resolved.error, "bad-request");
    throwIfCancelled(request.signal);
    const executable = locate();
    if (!executable) throw new ProviderError(notFound(), "unavailable");
    const deadline = new Deadline(request.signal, { totalMs: timeouts.totalMs, idleMs: timeouts.idleMs });
    const workspace = await createPrivateWorkspace(deps.workspaceRoot ?? defaultWorkspaceRoot(env)).catch(() => {
      deadline.dispose();
      throw new ProviderError(acpFailedMessage(label), "unavailable");
    });
    // Cancelled while the folder was being made: nothing was started yet.
    if (deadline.fired) {
      const failure = deadline.failure() as ProviderError;
      deadline.dispose();
      await workspace.remove();
      throw failure;
    }
    let child: ChildProcess | undefined;
    let connection: AcpConnection | undefined;
    let sessionId: string | undefined;
    let cancelSent = false;
    let protocolBroken = false;
    let text = "";
    let lastMessageId: string | undefined;
    let overflow = false;
    let markOverflow = () => {};
    const overflowed = new Promise<void>((resolve) => {
      markOverflow = resolve;
    });
    const authError = () => new ProviderError(preset ? acpAuthMessage(preset) : ACP_MESSAGES.customAuth, "auth");
    const sendCancel = () => {
      if (cancelSent || !sessionId || !connection) return;
      cancelSent = true;
      connection.notify("session/cancel", { sessionId });
    };
    const rpcFailure = (error: unknown): ProviderError => {
      if (error instanceof ProviderError) return error;
      if (error instanceof RpcError && error.code === ACP_AUTH_REQUIRED) return authError();
      if (error instanceof RpcError) return new ProviderError(acpFailedMessage(label), "unavailable");
      if (protocolBroken) return new ProviderError(acpProtocolMessage(label), "protocol");
      return new ProviderError(acpExitedMessage(label), "unavailable");
    };
    try {
      try {
        child = spawn([executable, ...resolved.argv.slice(1)], { cwd: workspace.path, env: childEnvironment(env) });
      } catch {
        throw new ProviderError(notFound(), "unavailable");
      }
      const spawned = child;
      // stderr is drained (a full pipe would block the agent) and never shown: it may hold anything.
      void readBounded(spawned.stderr, 16 * 1024, "tail").catch(() => undefined);
      connection = new AcpConnection(spawned, {
        onActivity: () => deadline.touch(),
        onProtocolError: () => { protocolBroken = true; },
        onRequest: (method, params) => {
          if (method === "session/request_permission") return choosePermissionOutcome(params, cancelSent);
          // No fs/terminal/elicitation capability was advertised; anything else is unknown.
          throw new RpcError(METHOD_NOT_FOUND, "Method not found");
        },
        onNotification: (method, params) => {
          if (method !== "session/update" || !isRecord(params) || params.sessionId !== sessionId || !sessionId || !isRecord(params.update)) return;
          const update = params.update;
          // Unknown update kinds (plans, tool calls, thoughts, future variants) are ignored on purpose.
          if (update.sessionUpdate !== "agent_message_chunk" || !isRecord(update.content) || update.content.type !== "text") return;
          const chunk = update.content.text;
          if (typeof chunk !== "string" || !chunk || overflow) return;
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          const piece = messageId && lastMessageId && messageId !== lastMessageId && text ? `\n\n${chunk}` : chunk;
          if (messageId) lastMessageId = messageId;
          if (text.length + piece.length > MAX_ANSWER_CHARACTERS) {
            overflow = true;
            sendCancel();
            markOverflow();
            return;
          }
          text += piece;
          request.onDelta?.(piece);
        }
      });
      const activeConnection = connection;
      // An agent that exits but leaves stdout open (a helper holds it) must not hang the request.
      void spawned.exited.then(() => unrefDelay(1_000)).then(() => activeConnection.close(new ConnectionClosed("agent exited")));

      // Setup has its own, shorter limit; the overall deadline still applies.
      const setup = new Deadline(deadline.signal, { totalMs: timeouts.startMs });
      try {
        const raceSetup = async <T>(promise: Promise<T>): Promise<T> => {
          const result = await Promise.race([promise, abortPromise(setup.signal).then(() => undefined)]);
          if (setup.fired) throw deadline.failure() ?? new ProviderError(COMMON_PROVIDER_MESSAGES.timeout, "timeout");
          return result as T;
        };
        const initialized = await raceSetup(activeConnection.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "falatrace", title: "FalaTrace", version: productVersion }
        }).catch((error) => { throw rpcFailure(error); }));
        if (!isRecord(initialized) || initialized.protocolVersion !== ACP_PROTOCOL_VERSION) throw new ProviderError(acpVersionMessage(label), "protocol");
        const session = await raceSetup(activeConnection.request("session/new", { cwd: workspace.path, mcpServers: [] }).catch((error) => { throw rpcFailure(error); }));
        if (!isRecord(session) || typeof session.sessionId !== "string" || !session.sessionId || session.sessionId.length > 512) throw new ProviderError(acpProtocolMessage(label), "protocol");
        sessionId = session.sessionId;
      } finally {
        setup.dispose();
      }

      const prompt = activeConnection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: flattenConversation(request.system, request.messages) }]
      });
      prompt.catch(() => undefined);
      const first = await Promise.race([
        prompt.then((value) => ({ value }), (error: unknown) => ({ error })),
        abortPromise(deadline.signal).then(() => ({ stopped: true as const })),
        overflowed.then(() => ({ overflow: true as const }))
      ]);
      if ("stopped" in first) {
        // Cancelled or timed out: ask the agent to stop and give it a moment to close the turn.
        sendCancel();
        await settleWithin(prompt, timeouts.cancelGraceMs);
        throw deadline.failure() ?? new ProviderError(COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      }
      if ("overflow" in first || overflow) {
        // The cancel was sent with the chunk that overflowed; an agent that ignores it is stopped below.
        await settleWithin(prompt, timeouts.cancelGraceMs);
        return { text, stopReason: "length" };
      }
      if ("error" in first) throw rpcFailure(first.error);
      const stopReason = isRecord(first.value) ? stopReasonOf(first.value.stopReason) : undefined;
      if (!stopReason) {
        if (text) return { text, stopReason: "end" };
        throw new ProviderError(acpProtocolMessage(label), "protocol");
      }
      return { text, stopReason };
    } catch (error) {
      throw deadline.failure() ?? rpcFailure(error);
    } finally {
      deadline.dispose();
      // Closing stdin waits for every queued write; an agent that stopped reading would hold
      // that back forever, so give it a moment and stop it anyway (the pending write then fails).
      if (connection) await settleWithin(connection.endInput(), timeouts.killGraceMs);
      if (child) await stopProcessTree(child, { waitMs: 300, signals: ["SIGTERM"], graceMs: timeouts.killGraceMs });
      connection?.close(new ConnectionClosed("finished"));
      await workspace.remove();
    }
  };

  return { destination, check, run };
};
