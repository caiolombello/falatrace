import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ASSISTANT_ACP_AGENTS, ASSISTANT_API_PRESETS, ASSISTANT_CLI_TOOLS, type AppConfig } from "../../config/defaults";
import { SECRET_NAMES, type SecretName } from "../../config/secrets";
import { CHATGPT_MESSAGES } from "../chatgpt/oauth";
import { CHATGPT_API_MESSAGES } from "../chatgpt/responses";
import { CHATGPT_STORE_MESSAGES, ChatGptStore } from "../chatgpt/store";
import { ACP_KNOWN_ERRORS } from "../providers/acp";
import { ANTHROPIC_KNOWN_ERRORS } from "../providers/anthropic";
import { CLI_KNOWN_ERRORS } from "../providers/cli";
import { COMMON_PROVIDER_MESSAGES } from "../providers/common";
import {
  ACP_AGENTS,
  ANTHROPIC_DEFAULT_MODEL,
  API_PRESETS,
  ASSISTANT_PROVIDER_KNOWN_ERRORS,
  CLI_TOOLS,
  type ChatProviderDeps,
  chatGptLogout,
  chatGptStatus,
  createChatProvider,
  DEFAULT_CHATGPT_MODEL,
  detectAssistantTools,
  listChatGptModels,
  startChatGptLogin
} from "../providers/index";
import { LOCAL_MESSAGES } from "../providers/local";
import { API_KNOWN_ERRORS } from "../providers/openai-compatible";
import { SHELL_WORDS_MESSAGES } from "../providers/shell-words";
import { type ChatProvider, destinationKey, ProviderError } from "../types";
import { chatRequest, configWith, withTempDir } from "./provider-helpers";

const SECRET = "sk-super-secret-value-0123456789";

/** Deps that fail loudly if construction touched the outside world. */
const forbidden = (): ChatProviderDeps => {
  const boom = () => {
    throw new Error("construction must not do I/O");
  };
  return {
    fetch: boom as unknown as typeof fetch,
    readSecret: boom as unknown as ChatProviderDeps["readSecret"],
    spawn: boom as unknown as ChatProviderDeps["spawn"],
    which: boom as unknown as ChatProviderDeps["which"],
    probe: boom as unknown as ChatProviderDeps["probe"]
  };
};

const everyConfig = (): Array<[string, AppConfig]> => [
  ["local", configWith({ provider: "local" })],
  ...ASSISTANT_API_PRESETS.map((preset): [string, AppConfig] => [`api:${preset}`, configWith({ provider: "api", apiPreset: preset, apiBaseUrl: preset === "custom" ? "https://llm.example.com/v1" : "", apiModel: preset === "custom" ? "m" : "" })]),
  ...ASSISTANT_ACP_AGENTS.map((agent): [string, AppConfig] => [`acp:${agent}`, configWith({ provider: "acp", acpAgent: agent, acpCommand: agent === "custom" ? "my-agent --acp" : "" })]),
  ...ASSISTANT_CLI_TOOLS.map((tool): [string, AppConfig] => [`cli:${tool}`, configWith({ provider: "cli", cliTool: tool })]),
  ["chatgpt", configWith({ provider: "chatgpt" })]
];

describe("createChatProvider", () => {
  test("picks the provider from assistant.provider without doing any I/O", () => {
    const seen = new Map<string, ChatProvider>();
    for (const [name, config] of everyConfig()) seen.set(name, createChatProvider(config, forbidden()));
    expect(seen.get("local")?.destination).toMatchObject({ kind: "local", id: "ollama", external: false });
    expect(seen.get("api:openrouter")?.destination).toMatchObject({ kind: "api", id: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: API_PRESETS.openrouter.defaultModel });
    expect(seen.get("api:anthropic")?.destination).toMatchObject({ kind: "api", id: "anthropic", model: ANTHROPIC_DEFAULT_MODEL, endpoint: "https://api.anthropic.com/v1/messages" });
    expect(seen.get("api:custom")?.destination).toMatchObject({ kind: "api", id: "custom", endpoint: "https://llm.example.com/v1", external: true });
    expect(seen.get("acp:codex")?.destination).toMatchObject({ kind: "acp", id: "acp:codex", endpoint: ACP_AGENTS.codex.command, subscription: "plano do ChatGPT via Codex" });
    expect(seen.get("acp:custom")?.destination).toMatchObject({ kind: "acp", id: "acp:custom", endpoint: "my-agent" });
    expect(seen.get("cli:claude")?.destination).toMatchObject({ kind: "cli", id: "cli:claude", endpoint: CLI_TOOLS.claude.command });
    expect(seen.get("chatgpt")?.destination).toMatchObject({ kind: "chatgpt", id: "chatgpt", model: DEFAULT_CHATGPT_MODEL });
  });

  test("destinations never carry a secret, and consent keys follow the destination", () => {
    for (const [name, config] of everyConfig()) {
      config.summary.ollamaUrl = `https://user:${SECRET}@ollama.example.com/?token=${SECRET}`;
      config.assistant.apiBaseUrl = config.assistant.apiPreset === "custom" ? `https://llm.example.com/v1?key=${SECRET}` : "";
      if (config.assistant.acpAgent === "custom") config.assistant.acpCommand = `my-agent --token ${SECRET}`;
      const destination = createChatProvider(config, { readSecret: async () => SECRET }).destination;
      expect({ name, leaked: JSON.stringify(destination).includes(SECRET) }).toEqual({ name, leaked: false });
      expect(destinationKey(destination)).toMatch(/^[0-9a-f]{64}$/);
    }
    const a = createChatProvider(configWith({ provider: "api", apiPreset: "openai" })).destination;
    const b = createChatProvider(configWith({ provider: "api", apiPreset: "openai", apiModel: "gpt-6.1-sol" })).destination;
    expect(destinationKey(a)).toBe(destinationKey(createChatProvider(configWith({ provider: "api", apiPreset: "openai" })).destination));
    expect(destinationKey(a)).not.toBe(destinationKey(b));
  });

  test("a change to the arguments of a custom agent asks again, without the arguments in the destination", () => {
    const custom = (acpCommand: string) => createChatProvider(configWith({ provider: "acp", acpAgent: "custom", acpCommand })).destination;
    const local = custom("my-agent --backend local");
    const remote = custom(`my-agent --backend https://other.example --token ${SECRET}`);
    expect(local.endpoint).toBe(remote.endpoint);
    expect(destinationKey(local)).not.toBe(destinationKey(remote));
    expect(destinationKey(local)).toBe(destinationKey(custom("my-agent --backend local")));
    expect(JSON.stringify(remote).includes(SECRET)).toBe(false);
    expect(remote.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Presets have no fingerprint: their command is fixed.
    expect(createChatProvider(configWith({ provider: "acp", acpAgent: "codex" })).destination.fingerprint).toBeUndefined();
  });

  test("everything but a loopback Ollama or loopback custom API is external", () => {
    for (const [name, config] of everyConfig()) {
      const destination = createChatProvider(config).destination;
      expect({ name, external: destination.external }).toEqual({ name, external: name !== "local" });
    }
    expect(createChatProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "http://127.0.0.1:8080/v1", apiModel: "m" })).destination.external).toBe(false);
    expect(createChatProvider(configWith({ provider: "local" }, { ollamaUrl: "https://ollama.example.com" })).destination.external).toBe(true);
    // Ollama's OpenAI-compatible API on this computer forwards its cloud models to ollama.com: consent first.
    for (const apiModel of ["gpt-oss:120b-cloud", "glm-4.6:cloud"]) {
      expect(createChatProvider(configWith({ provider: "api", apiPreset: "custom", apiBaseUrl: "http://127.0.0.1:11434/v1", apiModel })).destination.external).toBe(true);
    }
  });

  test("the timeouts and deps given reach the chosen provider", async () => {
    let read: SecretName | undefined;
    const provider = createChatProvider(configWith({ provider: "api", apiPreset: "groq" }), {
      readSecret: async (name) => {
        read = name;
        return undefined;
      }
    });
    expect(await provider.check()).toMatchObject({ ready: false, problem: "missing-key" });
    expect(read).toBe("GROQ_API_KEY");
  });

  test("the ChatGPT store and endpoints given are the ones used", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      const provider = createChatProvider(configWith({ provider: "chatgpt" }), { chatgpt: { store } });
      expect(await provider.check()).toEqual({ ready: false, problem: "signed-out", message: CHATGPT_MESSAGES.signedOut });
      expect(await chatGptStatus({ store })).toEqual({ signedIn: false, planUsage: false, registered: false, scopes: [] });
      await chatGptLogout({}, { store });
    });
  });
});

describe("ASSISTANT_PROVIDER_KNOWN_ERRORS", () => {
  test("holds every fixed message of every provider, once", () => {
    const expected = [
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
    ];
    for (const message of expected) expect(ASSISTANT_PROVIDER_KNOWN_ERRORS).toContain(message);
    expect(new Set(ASSISTANT_PROVIDER_KNOWN_ERRORS).size).toBe(ASSISTANT_PROVIDER_KNOWN_ERRORS.length);
    // Every API key the presets read has its own message.
    for (const preset of Object.values(API_PRESETS)) expect(ASSISTANT_PROVIDER_KNOWN_ERRORS.some((message) => message.includes(preset.keyName))).toBe(true);
  });

  test("messages are short Portuguese sentences without placeholders or secrets", () => {
    for (const message of ASSISTANT_PROVIDER_KNOWN_ERRORS) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.length).toBeLessThan(260);
      expect(message).toMatch(/[.!?]$/);
      expect(message).not.toMatch(/undefined|null|\[object|\$\{|NaN/);
      for (const name of SECRET_NAMES) expect(message.includes(`${name}=`)).toBe(false);
    }
  });

  test("failures from every provider use messages from the list", async () => {
    const messages: string[] = [];
    const collect = async (promise: Promise<unknown>) => {
      const error = await promise.then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProviderError);
      messages.push((error as Error).message);
    };
    const offline = { PATH: "/nonexistent" };
    await collect(createChatProvider(configWith({ provider: "local" }, { ollamaUrl: "http://10.0.0.1:11434" })).run(chatRequest()));
    for (const preset of ASSISTANT_API_PRESETS) {
      await collect(createChatProvider(configWith({ provider: "api", apiPreset: preset, apiBaseUrl: "https://llm.example.com/v1", apiModel: "m" }), { readSecret: async () => undefined }).run(chatRequest()));
    }
    for (const agent of ASSISTANT_ACP_AGENTS) {
      await collect(createChatProvider(configWith({ provider: "acp", acpAgent: agent, acpCommand: agent === "custom" ? "a | b" : "" }), { env: offline }).run(chatRequest()));
    }
    for (const tool of ASSISTANT_CLI_TOOLS) await collect(createChatProvider(configWith({ provider: "cli", cliTool: tool }), { env: offline }).run(chatRequest()));
    await withTempDir(async (dir) => {
      await collect(createChatProvider(configWith({ provider: "chatgpt" }), { chatgpt: { store: new ChatGptStore(join(dir, "c")) } }).run(chatRequest()));
    });
    await collect(createChatProvider(configWith({ provider: "local" })).run(chatRequest({ messages: [] })));
    expect(messages.length).toBeGreaterThan(20);
    for (const message of messages) expect(ASSISTANT_PROVIDER_KNOWN_ERRORS).toContain(message);
  });

  test("the module's public helpers are exported from the index", () => {
    for (const exported of [startChatGptLogin, chatGptStatus, chatGptLogout, listChatGptModels, detectAssistantTools]) expect(typeof exported).toBe("function");
  });
});
