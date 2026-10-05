import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CALL_APPLICATIONS, CALL_APPLICATION_IDENTITIES } from "../calls/apps";
import { DEFAULT_CONFIG, type AppConfig } from "./defaults";
import { getConfigPath, mergeConfig } from "./load";
import { commitConfigChange, readConfigRevision } from "./onboarding";

/**
 * Studio settings: an explicit allowlist of editable fields. Saving only touches the
 * fields present in the patch; every other key (including unknown ones and secrets)
 * is preserved byte-for-byte in meaning. Credentials are reported as present/absent only.
 */
type FieldRule = (value: unknown) => boolean;

const bool: FieldRule = (value) => typeof value === "boolean";
const oneOf = (...values: string[]): FieldRule => (value) => typeof value === "string" && values.includes(value);
const intBetween = (min: number, max: number): FieldRule => (value) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (max: number, pattern = /^[^\x00-\x1f\x7f]+$/): FieldRule => (value) =>
  typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value);
const absolutePath: FieldRule = (value) =>
  typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const deviceName: FieldRule = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 300 && /^[A-Za-z0-9_.:@+-]+$/.test(value);
const httpUrlWithoutCredentials: FieldRule = (value) => {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
};

export const SETTINGS_FIELDS: Record<string, FieldRule> = {
  "callDetection.enabled": bool,
  "callDetection.mode": oneOf("notify-only", "record", "obs"),
  "callDetection.enqueueOnStop": bool,
  "callDetection.entryDebounceSeconds": intBetween(1, 120),
  "callDetection.exitTimeoutSeconds": intBetween(1, 300),
  ...Object.fromEntries(CALL_APPLICATIONS.map((app) => [`callDetection.apps.${app}`, bool])),
  backend: oneOf("audio", "gpu-screen-recorder", "obs"),
  recordingsDir: absolutePath,
  "capture.audioSource": oneOf("none", "microphone", "desktop", "both"),
  "capture.microphone": deviceName,
  "capture.desktop": deviceName,
  "capture.profile": oneOf("standard", "call-light"),
  "capture.encoder": oneOf("gpu", "cpu"),
  "transcription.provider": oneOf("whisper-cpp", "openai", "gemini"),
  "transcription.language": text(12, /^(auto|[a-z]{2,3}(-[A-Z]{2})?)$/),
  "transcription.openaiModel": text(200),
  "transcription.geminiModel": text(200),
  "transcription.whisperCpp.command": text(4096),
  "transcription.whisperCpp.modelPath": absolutePath,
  "summary.provider": oneOf("ollama", "openai"),
  "summary.ollamaUrl": httpUrlWithoutCredentials,
  "summary.ollamaModel": text(200),
  "summary.openaiModel": text(200),
  "processing.defaultTarget": oneOf("local", "remote"),
  "processing.autoEnqueue": bool
};

export type SettingsPatch = Record<string, unknown>;

const getPath = (source: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, source);

const setPath = (target: Record<string, any>, path: string, value: unknown): void => {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    node[key] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
};

export const validateSettingsPatch = (patch: unknown): SettingsPatch => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Alterações inválidas.");
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0) throw new Error("Nenhuma alteração para salvar.");
  if (entries.length > Object.keys(SETTINGS_FIELDS).length) throw new Error("Alterações inválidas.");
  for (const [field, value] of entries) {
    const rule = SETTINGS_FIELDS[field];
    if (!rule) throw new Error(`Campo não editável: ${field.slice(0, 80)}`);
    if (!rule(value)) throw new Error(`Valor inválido para ${field}.`);
  }
  return patch as SettingsPatch;
};

const isLoopback = (url: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

const parseEnvKeys = (content: string): Set<string> => {
  const present = new Set<string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && match[2].replace(/^["']|["']$/g, "").trim()) present.add(match[1]);
  }
  return present;
};

/** Report whether each credential is defined, never its value. */
export const readCredentialStatus = async (
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
  envFile = join(homedir(), ".config", "recording-cli", "calls.env")
) => {
  const fileKeys = await fs.readFile(envFile, "utf8").then(parseEnvKeys, () => new Set<string>());
  const source = (name: string, inConfig = false) =>
    env[name] ? "environment" : fileKeys.has(name) ? "calls.env" : inConfig ? "config" : "missing";
  return {
    openai: source("OPENAI_API_KEY", !!config.openai.apiKey),
    gemini: source("GEMINI_API_KEY")
  };
};

const describeSettings = (value: Record<string, unknown>) => {
  const config = mergeConfig(DEFAULT_CONFIG, value as never);
  const values = Object.fromEntries(Object.keys(SETTINGS_FIELDS).map((field) => [field, getPath(config, field) ?? null]));
  // An absent capture profile behaves as the standard profile.
  if (values["capture.profile"] === null) values["capture.profile"] = "standard";
  return {
    values,
    apps: CALL_APPLICATIONS.map((id) => ({
      id,
      label: CALL_APPLICATION_IDENTITIES[id].label,
      kind: CALL_APPLICATION_IDENTITIES[id].kind,
      defaultEnabled: CALL_APPLICATION_IDENTITIES[id].defaultEnabled
    })),
    // Configured outside this screen; disclosed so the user knows what else may run.
    readOnly: {
      backendOutsideList: !["audio", "gpu-screen-recorder", "obs"].includes(config.backend) ? config.backend : null,
      obsEnabled: config.obs.enabled,
      remoteConfigured: !!config.remote.host,
      summaryLocal: config.summary.provider === "ollama" && isLoopback(config.summary.ollamaUrl)
    },
    config
  };
};

export async function readSettings(path = getConfigPath(), env: NodeJS.ProcessEnv = process.env) {
  const current = await readConfigRevision(path);
  const { config, ...described } = describeSettings(current.value);
  return { revision: current.revision, exists: current.exists, ...described, credentials: await readCredentialStatus(config, env) };
}

export async function saveSettings(revision: string, patch: unknown, path = getConfigPath(), beforeCommit?: () => Promise<void>) {
  const fields = validateSettingsPatch(patch);
  const result = await commitConfigChange(revision, path, (previous) => {
    const next = structuredClone(previous);
    for (const [field, value] of Object.entries(fields)) setPath(next, field, value);
    return next;
  }, beforeCommit);
  const receipt = { saved: true as const, changed: Object.keys(fields), backupCreated: result.backupCreated, cleanupPending: result.cleanupPending };
  // A failed re-read must not turn a published change into a reported failure.
  const after = await readSettings(result.path).catch(() => undefined);
  return after ? { ...after, ...receipt, needsReload: false } : { ...receipt, needsReload: true };
}
