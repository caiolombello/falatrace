// Whether an Ollama model really runs on this computer. A loopback address is not enough: once
// the user signs in, the local server also lists Ollama's cloud models ("gpt-oss:120b-cloud",
// "glm-4.6:cloud"…) and forwards their requests to ollama.com. Every place that tells the user
// "nothing leaves this computer", or skips a consent because of it, asks here.

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

/** The names Ollama gives its cloud models: a "cloud" tag or a "-cloud" suffix in the tag. */
export const OLLAMA_CLOUD_MODEL = /(?:[:-]cloud)(?:$|[:-])/i;

export const isOllamaCloudModel = (model: string): boolean => OLLAMA_CLOUD_MODEL.test(model);

/** Where a cloud model goes, in the words of the processing plans ("Ollama neste computador"…). */
export const OLLAMA_CLOUD_WHERE = "Nuvem do Ollama (ollama.com), serviço externo";

export const isLoopbackUrl = (value: string | URL): boolean => {
  try {
    return LOOPBACK_HOSTS.includes(new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * What the settings alone say, for checks that cannot wait for the server (saving settings, the
 * fast path, labels): a loopback address and a model that is not one of Ollama's cloud models.
 */
export const ollamaLocalByName = (url: string | URL, model: string): boolean => isLoopbackUrl(url) && !isOllamaCloudModel(model);

/**
 * What the server says about one model. "local": it runs it here (model details, no remote host);
 * "cloud": it forwards it elsewhere, or does not describe it; "missing": not installed;
 * "unreachable": no answer that could be read.
 */
export type OllamaLocality = "local" | "cloud" | "missing" | "unreachable";

export type OllamaLocalityOptions = { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };

const MAX_SHOW_BYTES = 8 * 1024 * 1024;

/** Asks the Ollama at `url` (/api/show) whether `model` runs there; a model with a cloud name never does. */
export const probeOllamaLocality = async (url: string | URL, model: string, options: OllamaLocalityOptions = {}): Promise<OllamaLocality> => {
  if (!ollamaLocalByName(url, model)) return "cloud";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL("/api/show", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ model }),
      signal
    });
  } catch {
    options.signal?.throwIfAborted();
    return "unreachable";
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return "missing";
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return "unreachable";
  }
  let details: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_SHOW_BYTES) return "unreachable";
    details = JSON.parse(text);
  } catch {
    options.signal?.throwIfAborted();
    return "unreachable";
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) return "unreachable";
  const record = details as Record<string, unknown>;
  const info = record.model_info;
  if (record.remote_host || record.remote_model) return "cloud";
  // A model this server runs itself always has its details; without them, nothing says it is here.
  if (!info || typeof info !== "object" || Array.isArray(info) || !Object.keys(info).length) return "cloud";
  return "local";
};
