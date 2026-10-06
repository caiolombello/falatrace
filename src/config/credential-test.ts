import OpenAI from "openai";
import { getSecretFiles, readSecretFiles, resolveSecretFrom, type SecretFiles, type SecretSource } from "./secrets";

/**
 * Explicit, user-initiated credential check. It contacts the provider once with a
 * read-only request (list models): no audio, transcript or prompt is sent and nothing
 * is billed by the providers for these calls. Only the outcome is returned.
 */
export type KeyTestProvider = "openai" | "gemini";
export type KeyTestStatus = "ok" | "rejected" | "limited" | "unreachable" | "missing";
export type KeyTestResult = { provider: KeyTestProvider; status: KeyTestStatus; source: SecretSource; detail: string };

export type KeyTestDeps = {
  fetch: typeof fetch;
  managerEnv: () => Promise<NodeJS.ProcessEnv | null>;
  files: SecretFiles;
  configApiKey?: string;
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
  const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  const states = await readSecretFiles(deps.files);
  const managerEnv = await deps.managerEnv().catch(() => null);
  const resolved = resolveSecretFrom(name, managerEnv || {}, states);
  const key = resolved.value || (provider === "openai" ? deps.configApiKey : undefined);
  const source: SecretSource = resolved.value ? resolved.source : key ? "config" : "missing";
  if (!key) {
    return { provider, source, status: "missing", detail: "Nenhuma chave alcança o processamento em segundo plano. Salve a chave nesta seção." };
  }
  if (provider === "openai") {
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

export const defaultKeyTestDeps = (managerEnv: () => Promise<NodeJS.ProcessEnv | null>, configApiKey?: string): KeyTestDeps => ({
  fetch,
  managerEnv,
  files: getSecretFiles(),
  configApiKey
});
