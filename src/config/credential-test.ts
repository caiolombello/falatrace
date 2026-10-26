import { getSecretFiles, readSecretFiles, resolveSecretFrom, unitEnvironment, type SecretFiles, type SecretName, type SecretSource } from "./secrets";

/**
 * Explicit, user-initiated credential check. It contacts the provider once with a
 * read-only request (list models): no audio, transcript or prompt is sent and nothing
 * is billed by the providers for these calls. Only the outcome is returned.
 */

/** Assistant API presets whose key can be checked with a read-only call (models list or key info). */
export const ASSISTANT_KEY_TEST_PROVIDERS = ["openrouter", "anthropic", "xai", "groq", "mistral", "deepseek", "together", "custom"] as const;
export type AssistantKeyTestProvider = (typeof ASSISTANT_KEY_TEST_PROVIDERS)[number];
export const KEY_TEST_PROVIDERS = ["openai", "gemini", ...ASSISTANT_KEY_TEST_PROVIDERS] as const;
export type KeyTestProvider = (typeof KEY_TEST_PROVIDERS)[number];
export type KeyTestStatus = "ok" | "rejected" | "limited" | "unreachable" | "missing" | "unknown";
export type KeyTestResult = { provider: KeyTestProvider; status: KeyTestStatus; source: SecretSource; detail: string };

export type KeyTestDeps = {
  fetch: typeof fetch;
  managerEnv: () => Promise<NodeJS.ProcessEnv | null>;
  files: SecretFiles;
  configApiKey?: string;
  /** Assistant keys are read by the Studio's own process: its environment, then secrets.env. */
  env?: NodeJS.ProcessEnv;
  /** Base URL of the "custom" OpenAI-compatible API (assistant.apiBaseUrl). */
  customBaseUrl?: string;
};

/** Message when the custom API has no usable address to test against. */
export const CUSTOM_BASE_URL_MISSING = "Informe o endereço da API compatível antes de testar a chave.";
/** No assistant key reaches the Studio (its environment or secrets.env). */
export const ASSISTANT_KEY_MISSING = "Nenhuma chave deste provedor foi salva. Salve a chave nesta seção.";

/** Where each assistant preset answers a cheap authenticated read; the custom one uses its base URL. */
const ASSISTANT_KEY_TESTS: Record<Exclude<AssistantKeyTestProvider, "anthropic" | "custom">, { name: SecretName; url: string }> = {
  // OpenRouter lists models without a key; the key information endpoint needs one.
  openrouter: { name: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1/key" },
  xai: { name: "XAI_API_KEY", url: "https://api.x.ai/v1/models" },
  groq: { name: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/models" },
  mistral: { name: "MISTRAL_API_KEY", url: "https://api.mistral.ai/v1/models" },
  deepseek: { name: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/models" },
  together: { name: "TOGETHER_API_KEY", url: "https://api.together.ai/v1/models" }
};

const isLoopbackHost = (host: string): boolean => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);

/** The custom API's models URL: HTTPS, or HTTP on this computer only, without credentials or parameters. */
const customModelsUrl = (base: string | undefined): string | undefined => {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return undefined;
    return `${url.href.replace(/\/+$/, "")}/models`;
  } catch {
    return undefined;
  }
};

const assistantKeyName = (provider: AssistantKeyTestProvider): SecretName =>
  provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "custom" ? "CUSTOM_API_KEY" : ASSISTANT_KEY_TESTS[provider].name;

/**
 * An assistant key, as the Studio's assistant would use it (its environment, then secrets.env).
 * One read-only request; no meeting content is sent.
 */
const testAssistantKey = async (provider: AssistantKeyTestProvider, deps: KeyTestDeps): Promise<KeyTestResult> => {
  const resolved = resolveSecretFrom(assistantKeyName(provider), deps.env ?? process.env, await readSecretFiles(deps.files));
  const source: SecretSource = resolved.value ? resolved.source : "missing";
  if (!resolved.value) return { provider, source, status: "missing", detail: ASSISTANT_KEY_MISSING };
  const key = resolved.value;
  if (provider === "anthropic") {
    // Same client settings as the assistant provider (src/assistant/providers/anthropic.ts).
    // The SDK loads only for this explicit test, so opening the Studio or the CLI does not pay for it.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: 10_000, logLevel: "off", fetch: deps.fetch });
    try {
      await client.models.list({ limit: 1 });
      return outcome(provider, source, 200);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      return outcome(provider, source, typeof status === "number" ? status : undefined);
    }
  }
  const url = provider === "custom" ? customModelsUrl(deps.customBaseUrl) : ASSISTANT_KEY_TESTS[provider].url;
  if (!url) return { provider, source, status: "unknown", detail: CUSTOM_BASE_URL_MISSING };
  try {
    const response = await deps.fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel().catch(() => undefined);
    return outcome(provider, source, response.status);
  } catch {
    return outcome(provider, source, undefined);
  }
};

const GEMINI_MODELS = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

const outcome = (provider: KeyTestProvider, source: SecretSource, httpStatus: number | undefined): KeyTestResult => {
  if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
    return { provider, source, status: "ok", detail: "Chave aceita pelo provedor. O teste não envia áudio nem texto." };
  }
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 400) {
    return { provider, source, status: "rejected", detail: "O provedor recusou a chave. Confira se ela está ativa e se foi copiada inteira." };
  }
  if (httpStatus === 429) {
    return { provider, source, status: "limited", detail: "A chave existe, mas a conta está sem créditos ou no limite de uso. Confira o faturamento da API." };
  }
  return { provider, source, status: "unreachable", detail: "Não foi possível falar com o provedor agora. Confira a rede e tente de novo." };
};

export const testProviderKey = async (provider: KeyTestProvider, deps: KeyTestDeps): Promise<KeyTestResult> => {
  if ((ASSISTANT_KEY_TEST_PROVIDERS as readonly string[]).includes(provider)) return testAssistantKey(provider as AssistantKeyTestProvider, deps);
  const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  const states = await readSecretFiles(deps.files);
  const managerEnv = await deps.managerEnv().catch(() => null);
  const resolved = resolveSecretFrom(name, unitEnvironment(managerEnv || {}, states), states);
  const key = resolved.value || (provider === "openai" ? deps.configApiKey : undefined);
  const source: SecretSource = resolved.value ? resolved.source : key ? "config" : "missing";
  // A key in the user manager's environment wins over the Studio's: without that environment the key
  // background processing will use is unknown, so nothing is tested rather than possibly the wrong key.
  if (!managerEnv) {
    return { provider, source, status: "unknown", detail: "Não foi possível ler o ambiente dos serviços do usuário, então não dá para saber qual chave o processamento usa. Tente de novo." };
  }
  if (!key) {
    return { provider, source, status: "missing", detail: "Nenhuma chave alcança o processamento em segundo plano. Salve a chave nesta seção." };
  }
  if (provider === "openai") {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 10_000, fetch: deps.fetch });
    try {
      await client.models.list();
      return outcome(provider, source, 200);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      return outcome(provider, source, typeof status === "number" ? status : undefined);
    }
  }
  try {
    const response = await deps.fetch(GEMINI_MODELS, {
      headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000)
    });
    await response.body?.cancel().catch(() => undefined);
    return outcome(provider, source, response.status);
  } catch {
    return outcome(provider, source, undefined);
  }
};

export const defaultKeyTestDeps = (managerEnv: () => Promise<NodeJS.ProcessEnv | null>, configApiKey?: string, customBaseUrl?: string): KeyTestDeps => ({
  fetch,
  managerEnv,
  files: getSecretFiles(),
  configApiKey,
  ...(customBaseUrl ? { customBaseUrl } : {})
});
