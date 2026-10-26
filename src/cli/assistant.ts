import {
  ACP_AGENTS, ANTHROPIC_DEFAULT_MODEL, API_PRESETS, type AssistantToolsReport, CLI_TOOLS, type ChatGptLogin, type ChatGptModel, type ChatGptStatus,
  chatGptLogout, chatGptStatus, createChatProvider, DEFAULT_CHATGPT_MODEL, detectAssistantTools, listChatGptModels, startChatGptLogin
} from "../assistant/providers";
import type { ChatProvider } from "../assistant/types";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { ASSISTANT_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, type Interrupt, parseArgs, printJson, printLine, processInterrupt, processIO } from "./shared";

export { ASSISTANT_HELP };

export type AssistantCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  provider: (config: AppConfig) => ChatProvider;
  detect: () => Promise<AssistantToolsReport>;
  chatgptStatus: () => Promise<ChatGptStatus>;
  login: (openUrl: (url: string) => unknown) => Promise<ChatGptLogin>;
  logout: () => Promise<void>;
  chatgptModels: () => Promise<ChatGptModel[]>;
  ollamaModels: (baseUrl: string) => Promise<string[]>;
  openUrl: (url: string) => Promise<unknown>;
  interrupt: () => Interrupt;
};

const ollamaTags = async (baseUrl: string): Promise<string[]> => {
  const { validateOllamaUrl } = await import("../summary/ollama");
  const response = await fetch(new URL("/api/tags", validateOllamaUrl(baseUrl)), { redirect: "error", signal: AbortSignal.timeout(5_000) })
    .catch(() => { throw new Error(CLI_MESSAGES.assistantModelsUnavailable); });
  if (!response.ok) throw new Error(CLI_MESSAGES.assistantModelsUnavailable);
  const body = await response.json() as { models?: Array<{ name?: unknown }> };
  return (body.models || []).map((model) => model.name).filter((name): name is string => typeof name === "string").slice(0, 500);
};

export const defaultAssistantCliDeps = (): AssistantCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  provider: (config) => createChatProvider(config),
  detect: () => detectAssistantTools(),
  chatgptStatus: () => chatGptStatus(),
  login: (openUrl) => startChatGptLogin({ openUrl }),
  logout: () => chatGptLogout(),
  chatgptModels: () => listChatGptModels(),
  ollamaModels: ollamaTags,
  openUrl: (url) => runCommand("xdg-open", [url], { timeoutMs: 10_000 }).catch(() => undefined),
  interrupt: processInterrupt
});

/** What `assistant models` can say for each provider without sending meeting content. */
const modelsFor = async (config: AppConfig, deps: AssistantCliDeps) => {
  const assistant = config.assistant;
  switch (assistant.provider) {
    case "local":
      return { provider: "local", current: assistant.localModel, models: await deps.ollamaModels(config.summary.ollamaUrl) };
    case "chatgpt":
      return { provider: "chatgpt", current: assistant.chatgptModel || DEFAULT_CHATGPT_MODEL, models: await deps.chatgptModels() };
    case "api": {
      const defaultModel = assistant.apiPreset === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : API_PRESETS[assistant.apiPreset].defaultModel;
      // Listing a paid API's catalogue needs the key and the network; the presets' defaults are known.
      return {
        provider: "api", preset: assistant.apiPreset, current: assistant.apiModel || defaultModel, defaultModel,
        models: [...new Set([ANTHROPIC_DEFAULT_MODEL, ...Object.values(API_PRESETS).map((preset) => preset.defaultModel)].filter(Boolean))]
      };
    }
    case "acp":
      return { provider: "acp", agent: assistant.acpAgent, command: assistant.acpAgent === "custom" ? assistant.acpCommand : ACP_AGENTS[assistant.acpAgent].command, current: "", models: [] };
    case "cli":
      return { provider: "cli", tool: assistant.cliTool, command: CLI_TOOLS[assistant.cliTool].command, current: assistant.cliModel, models: [] };
  }
};

const ASSISTANT_SUBCOMMANDS: readonly string[] = ["status", "detect", "models", "login-chatgpt", "logout-chatgpt"];

export const runAssistantCli = async (args: string[], deps: AssistantCliDeps = defaultAssistantCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(ASSISTANT_HELP); return; }
  // A missing or unknown subcommand is a usage error, whatever the state of the configuration.
  if (!subcommand || !ASSISTANT_SUBCOMMANDS.includes(subcommand)) throw new Error(CLI_USAGE.assistant);
  parseArgs(rest);
  if (subcommand === "detect") { printJson(io, await deps.detect()); return; }
  if (subcommand === "logout-chatgpt") {
    await deps.logout();
    printJson(io, await deps.chatgptStatus());
    return;
  }
  if (subcommand === "login-chatgpt") {
    const login = await deps.login(deps.openUrl);
    printLine(io, `${CLI_MESSAGES.chatgptOpenLogin}\n${login.url}`);
    const interrupt = deps.interrupt();
    const cancel = (): void => { void login.cancel(); };
    if (interrupt.signal.aborted) cancel();
    else interrupt.signal.addEventListener("abort", cancel, { once: true });
    try {
      printJson(io, await login.done);
    } finally {
      interrupt.signal.removeEventListener("abort", cancel);
      interrupt.dispose();
    }
    return;
  }
  const config = await deps.loadConfig();
  if (subcommand === "status") {
    const provider = deps.provider(config);
    const readiness = await provider.check(AbortSignal.timeout(15_000));
    printJson(io, {
      provider: config.assistant.provider,
      destination: provider.destination,
      readiness,
      ...(config.assistant.provider === "chatgpt" ? { chatgpt: await deps.chatgptStatus() } : {})
    });
    return;
  }
  if (subcommand === "models") { printJson(io, await modelsFor(config, deps)); return; }
  throw new Error(CLI_USAGE.assistant);
};
