import type { AppConfig } from "../../config/defaults";
import { CHATGPT_MESSAGES, type ChatGptOAuthDeps } from "../chatgpt/oauth";
import { CHATGPT_API_MESSAGES, createChatGptProvider } from "../chatgpt/responses";
import { CHATGPT_STORE_MESSAGES } from "../chatgpt/store";
import type { ChatProvider } from "../types";
import { ACP_KNOWN_ERRORS, type AcpDeps, createAcpProvider } from "./acp";
import { ANTHROPIC_KNOWN_ERRORS, type AnthropicEffort, createAnthropicProvider } from "./anthropic";
import { CLI_KNOWN_ERRORS, createCliProvider, type ProbeRunner } from "./cli";
import { COMMON_PROVIDER_MESSAGES, type ProviderTimeouts, type ReadSecretFn, type SpawnFn, type WhichFn } from "./common";
import { createLocalProvider, LOCAL_MESSAGES } from "./local";
import { API_KNOWN_ERRORS, createOpenAiCompatibleProvider } from "./openai-compatible";
import { SHELL_WORDS_MESSAGES } from "./shell-words";

/**
 * Everything a provider touches outside the process, injectable for tests. Each provider
 * picks what it needs; the defaults are the real network, secrets, PATH and processes.
 */
export type ChatProviderDeps = {
  fetch?: typeof fetch;
  readSecret?: ReadSecretFn;
  spawn?: SpawnFn;
  which?: WhichFn;
  env?: NodeJS.ProcessEnv;
  /** Parent of the empty working directories given to agents and CLIs. */
  workspaceRoot?: string;
  /** CLI sign-in status commands. */
  probe?: ProbeRunner;
  /** Sign in with ChatGPT: credential store, endpoints, clock. */
  chatgpt?: ChatGptOAuthDeps & { apiBase?: string };
  /** Thinking depth for the Anthropic API ("low" for chat). */
  anthropicEffort?: AnthropicEffort;
  timeouts?: ProviderTimeouts & AcpDeps["timeouts"] & { stopGraceMs?: number };
};

/** The provider for config.assistant.provider. Construction never does I/O; check() and run() do. */
export const createChatProvider = (config: AppConfig, deps: ChatProviderDeps = {}): ChatProvider => {
  switch (config.assistant.provider) {
    case "local":
      return createLocalProvider(config, { fetch: deps.fetch, timeouts: deps.timeouts });
    case "api":
      return config.assistant.apiPreset === "anthropic"
        ? createAnthropicProvider(config, { fetch: deps.fetch, readSecret: deps.readSecret, timeouts: deps.timeouts, effort: deps.anthropicEffort })
        : createOpenAiCompatibleProvider(config, { fetch: deps.fetch, readSecret: deps.readSecret, timeouts: deps.timeouts });
    case "acp":
      return createAcpProvider(config, { spawn: deps.spawn, which: deps.which, env: deps.env, workspaceRoot: deps.workspaceRoot, timeouts: deps.timeouts });
    case "cli":
      return createCliProvider(config, { spawn: deps.spawn, which: deps.which, env: deps.env, workspaceRoot: deps.workspaceRoot, probe: deps.probe, timeouts: deps.timeouts });
    case "chatgpt": {
      const { apiBase, ...oauth } = deps.chatgpt ?? {};
      return createChatGptProvider(config, { fetch: deps.fetch, oauth: { fetch: deps.fetch, ...oauth }, apiBase, timeouts: deps.timeouts });
    }
  }
};

/** Every fixed Portuguese message these providers can throw or report, for the bridge allowlist and i18n. */
export const ASSISTANT_PROVIDER_KNOWN_ERRORS: readonly string[] = [
  ...new Set<string>([
    ...Object.values(COMMON_PROVIDER_MESSAGES),
    ...Object.values(SHELL_WORDS_MESSAGES),
    ...Object.values(LOCAL_MESSAGES),
    ...API_KNOWN_ERRORS,
    ...ANTHROPIC_KNOWN_ERRORS,
    ...ACP_KNOWN_ERRORS,
    ...CLI_KNOWN_ERRORS,
    ...Object.values(CHATGPT_MESSAGES),
    ...Object.values(CHATGPT_API_MESSAGES),
    ...Object.values(CHATGPT_STORE_MESSAGES)
  ])
];

export { type ChatGptLogin, type ChatGptStatus, chatGptLogout, chatGptStatus, startChatGptLogin } from "../chatgpt/oauth";
export { type ChatGptModel, DEFAULT_CHATGPT_MODEL, listChatGptModels } from "../chatgpt/responses";
export { type AssistantToolsReport, detectAssistantTools } from "../detect";
export { ACP_AGENTS } from "./acp";
export { ANTHROPIC_DEFAULT_MODEL } from "./anthropic";
export { CLI_TOOLS } from "./cli";
export { API_PRESETS } from "./openai-compatible";
