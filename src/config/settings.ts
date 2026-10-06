import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CALL_APPLICATIONS, CALL_APPLICATION_IDENTITIES } from "../calls/apps";
import { DEFAULT_CONFIG, TRANSCRIPTION_PROMPT_MAX_LENGTH, type AppConfig } from "./defaults";
import { getConfigPath, mergeConfig, validateConfig } from "./load";
import { commitConfigChange, configBackupPattern, readConfigRevision } from "./onboarding";
import { describeCredentials, type SecretFiles } from "./secrets";

/**
 * Studio settings: an explicit allowlist of editable fields. Saving only touches the
 * fields present in the patch; every other key (including unknown ones and secrets)
 * is preserved. Credentials never pass through these fields: they live in secrets.env
 * and are reported as present/absent with their source only.
 */
type FieldRule = (value: unknown) => boolean;

const CONTROL = /[\x00-\x1f\x7f]/;
const has = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);
const bool: FieldRule = (value) => typeof value === "boolean";
const oneOf = (...values: string[]): FieldRule => (value) => typeof value === "string" && values.includes(value);
const intBetween = (min: number, max: number): FieldRule => (value) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const numberBetween = (min: number, max: number): FieldRule => (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const text = (max: number, pattern = /^[^\x00-\x1f\x7f]+$/): FieldRule => (value) =>
  typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value);
const textOrEmpty = (max: number): FieldRule => (value) =>
  typeof value === "string" && value.length <= max && !CONTROL.test(value);
/** Free text such as a vocabulary hint: line breaks and tabs allowed, other control characters not. */
const multiline = (max: number): FieldRule => (value) =>
  typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const absolutePath: FieldRule = (value) =>
  typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !CONTROL.test(value);
const absoluteOrHomePath: FieldRule = (value) =>
  typeof value === "string" && (value.startsWith("/") || value.startsWith("~/")) && value.length <= 4096 && !CONTROL.test(value);
const deviceName: FieldRule = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 300 && /^[A-Za-z0-9_.:@+-]+$/.test(value);
const hostName: FieldRule = (value) =>
  typeof value === "string" && value.length <= 253 && !value.startsWith("-") && /^[A-Za-z0-9._:-]+$/.test(value);
const accountName: FieldRule = (value) =>
  typeof value === "string" && value.length <= 64 && !value.startsWith("-") && /^[A-Za-z0-9._-]+$/.test(value);
const optional = (rule: FieldRule): FieldRule => (value) => value === null || rule(value);
const httpUrlWithoutCredentials: FieldRule = (value) => {
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
};
const languageList: FieldRule = (value) =>
  Array.isArray(value) && value.length <= 10 && new Set(value).size === value.length &&
  value.every((item) => typeof item === "string" && /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(item));
const protonFolder: FieldRule = (value) =>
  typeof value === "string" && /^\/my-files(?:\/[A-Za-z0-9._ -]+)*$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");
const s3Bucket: FieldRule = (value) =>
  typeof value === "string" && (value === "" || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value));
const s3Prefix: FieldRule = (value) =>
  typeof value === "string" && value.length <= 1024 && !CONTROL.test(value) && !value.startsWith("/");
/** Recording folder names: tokens plus safe characters, never a path. */
const namingTemplate: FieldRule = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 120 && /^[A-Za-z0-9_\-[\]. ]+$/.test(value) && !/^\.+$/.test(value);

export const CAPTURE_BACKENDS = ["audio", "gpu-screen-recorder", "obs"] as const;

export const SETTINGS_FIELDS: Record<string, FieldRule> = {
  // Automatic recording
  "callDetection.enabled": bool,
  "callDetection.mode": oneOf("notify-only", "record", "obs"),
  "callDetection.enqueueOnStop": bool,
  "callDetection.dryRun": bool,
  "callDetection.entryDebounceSeconds": intBetween(1, 120),
  "callDetection.exitTimeoutSeconds": intBetween(1, 300),
  "callDetection.networkSampleSeconds": intBetween(1, 60),
  ...Object.fromEntries(CALL_APPLICATIONS.map((app) => [`callDetection.apps.${app}`, bool])),
  // Capture and audio
  backend: oneOf(...CAPTURE_BACKENDS),
  recordingsDir: absolutePath,
  "features.namingTemplate": namingTemplate,
  "capture.audioSource": oneOf("none", "microphone", "desktop", "both"),
  "capture.microphone": deviceName,
  "capture.desktop": deviceName,
  "capture.profile": oneOf("standard", "call-light"),
  "capture.encoder": oneOf("gpu", "cpu"),
  "capture.framerate": intBetween(1, 60),
  "capture.startupTimeoutSeconds": intBetween(5, 300),
  "gnome.framerate": intBetween(1, 60),
  "gnome.drawCursor": bool,
  "gnome.audioSource": oneOf("none", "microphone", "desktop", "both"),
  // OBS (the WebSocket password is a secret, never a field)
  "obs.enabled": bool,
  "obs.autoLaunch": bool,
  "obs.host": oneOf("127.0.0.1", "localhost", "::1"),
  "obs.port": intBetween(1, 65535),
  // Transcription
  "transcription.provider": oneOf("whisper-cpp", "openai", "gemini"),
  "transcription.language": text(12, /^(auto|[a-z]{2,3}(-[A-Z]{2})?)$/),
  "transcription.expectedLanguages": languageList,
  "transcription.openaiPrompt": multiline(TRANSCRIPTION_PROMPT_MAX_LENGTH),
  "transcription.openaiModel": text(200),
  "transcription.geminiModel": text(200),
  "transcription.whisperCpp.command": text(4096),
  "transcription.whisperCpp.modelPath": absolutePath,
  "transcription.whisperCpp.threads": intBetween(1, 256),
  "transcription.whisperCpp.variant": oneOf("cpu", "vulkan"),
  // Summary
  "summary.provider": oneOf("ollama", "openai"),
  "summary.ollamaUrl": httpUrlWithoutCredentials,
  "summary.ollamaModel": text(200),
  "summary.openaiModel": text(200),
  "summary.maxInputCharacters": intBetween(4096, 200_000),
  // Processing and retention
  "processing.defaultTarget": oneOf("local", "remote"),
  "processing.autoEnqueue": bool,
  "processing.syncIntervalMinutes": intBetween(1, 1440),
  "processing.notifyOnCompletion": bool,
  "retention.localCompletedWorkDays": intBetween(0, 3650),
  "retention.remoteIncomingDays": intBetween(0, 3650),
  "retention.remoteResultsDays": intBetween(0, 3650),
  "retention.remoteFailuresDays": intBetween(0, 3650),
  // Remote worker (SSH key path only; no password is stored)
  "remote.host": hostName,
  "remote.user": optional(accountName),
  "remote.port": intBetween(1, 65535),
  "remote.identityFile": optional(absolutePath),
  "remote.archiveDir": absoluteOrHomePath,
  // Original media archive and backups
  "archive.enabled": bool,
  "archive.vaio": bool,
  "archive.proton": bool,
  "archive.syncIntervalMinutes": intBetween(1, 1440),
  "proton.enabled": bool,
  "proton.targetFolder": protonFolder,
  "proton.policy": oneOf("artifacts", "full"),
  "s3.enabled": bool,
  "s3.bucket": s3Bucket,
  "s3.region": text(32, /^[a-z0-9-]+$/),
  "s3.prefix": s3Prefix,
  "s3.profile": optional(accountName),
  // Optional modules
  "timesheet.enabled": bool,
  "timesheet.automaticFromCalls": bool,
  "timesheet.aiClassification": bool,
  "timesheet.aiModel": text(200),
  "timesheet.readyConfidence": numberBetween(0.5, 1),
  "timesheet.contextPath": absolutePath,
  "aiContext.enabled": bool,
  "aiContext.autoBuild": bool,
  "aiContext.maxMeetingsPerClient": intBetween(1, 100),
  "aiContext.maxCharactersPerClient": intBetween(8_000, 200_000),
  "calendar.enabled": bool,
  // Lifetime visual review limits (always written together with period "lifetime")
  "visualReview.maxInferences": intBetween(1, 1000),
  "visualReview.maxPreviews": intBetween(1, 1000)
};

/** Fields whose value may be null to remove an optional key from the file. */
export const NULLABLE_FIELDS = new Set(["remote.user", "remote.identityFile", "s3.profile"]);

/** Temporary alpha limits the visual flow applies when the configuration declares none. */
export const VISUAL_REVIEW_DEFAULTS = { maxInferences: 24, maxPreviews: 16, period: "lifetime" as const };

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
  if (value === null) delete node[keys[keys.length - 1]];
  else node[keys[keys.length - 1]] = value;
};

export const validateSettingsPatch = (patch: unknown, options: { allowEmpty?: boolean } = {}): SettingsPatch => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Alterações inválidas.");
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0 && !options.allowEmpty) throw new Error("Nenhuma alteração para salvar.");
  if (entries.length > Object.keys(SETTINGS_FIELDS).length) throw new Error("Alterações inválidas.");
  for (const [field, value] of entries) {
    const rule = has(SETTINGS_FIELDS, field) ? SETTINGS_FIELDS[field] : undefined;
    if (!rule) throw new Error(`Campo não editável: ${field.slice(0, 80)}`);
    if (value === null && !NULLABLE_FIELDS.has(field)) throw new Error(`Valor inválido para ${field}.`);
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

/** The shipped placeholder and reserved example names (RFC 2606/6761) are not a configured worker. */
export const isPlaceholderRemoteHost = (host: string): boolean =>
  host === DEFAULT_CONFIG.remote.host || /\.(invalid|example|test|localhost)$/i.test(host) || /(^|\.)example\.(com|net|org)$/i.test(host);

export type CredentialOptions = { sessionEnv?: NodeJS.ProcessEnv; managerEnv?: NodeJS.ProcessEnv | null; files?: SecretFiles };

/** Report where each credential comes from for background processing, never its value. */
export const readCredentialStatus = async (config: AppConfig, options: CredentialOptions = {}) =>
  describeCredentials({
    sessionEnv: options.sessionEnv ?? process.env,
    managerEnv: options.managerEnv ?? null,
    configApiKey: !!config.openai.apiKey,
    files: options.files
  });

const valuesOf = (config: AppConfig): Record<string, unknown> => {
  const values = Object.fromEntries(Object.keys(SETTINGS_FIELDS).map((field) => [field, getPath(config, field) ?? null]));
  // An absent capture profile behaves as the standard profile.
  if (values["capture.profile"] === null) values["capture.profile"] = "standard";
  const visual = config.visualReview || VISUAL_REVIEW_DEFAULTS;
  values["visualReview.maxInferences"] = visual.maxInferences;
  values["visualReview.maxPreviews"] = visual.maxPreviews;
  return values;
};

const DEFAULT_VALUES = valuesOf(DEFAULT_CONFIG);

const describeSettings = (value: Record<string, unknown>) => {
  const config = mergeConfig(DEFAULT_CONFIG, value as never);
  return {
    values: valuesOf(config),
    defaults: DEFAULT_VALUES,
    apps: CALL_APPLICATIONS.map((id) => ({
      id,
      label: CALL_APPLICATION_IDENTITIES[id].label,
      kind: CALL_APPLICATION_IDENTITIES[id].kind,
      defaultEnabled: CALL_APPLICATION_IDENTITIES[id].defaultEnabled
    })),
    // Facts the screen discloses but does not edit directly.
    readOnly: {
      backendOutsideList: !(CAPTURE_BACKENDS as readonly string[]).includes(config.backend) ? config.backend : null,
      backendExplicit: typeof value.backend === "string",
      obsEnabled: config.obs.enabled,
      remoteConfigured: !isPlaceholderRemoteHost(config.remote.host),
      summaryLocal: config.summary.provider === "ollama" && isLoopback(config.summary.ollamaUrl),
      visualPolicyDeclared: !!value.visualReview,
      legacyApiKeyInConfig: !!config.openai.apiKey,
      obsPasswordInConfig: !!config.obs.password
    },
    config
  };
};

export async function readSettings(path = getConfigPath(), env: NodeJS.ProcessEnv = process.env, credentialOptions: Omit<CredentialOptions, "sessionEnv"> = {}) {
  const current = await readConfigRevision(path);
  const { config, ...described } = describeSettings(current.value);
  return { revision: current.revision, exists: current.exists, path: current.path, ...described, credentials: await readCredentialStatus(config, { ...credentialOptions, sessionEnv: env }) };
}

/** Apply a validated patch to the raw file value, keeping cross-field invariants explicit. */
export const applySettingsPatch = (previous: Record<string, any>, fields: SettingsPatch): Record<string, any> => {
  const next = structuredClone(previous);
  const visual = Object.keys(fields).some((field) => field.startsWith("visualReview."));
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith("visualReview.")) setPath(next, field, value);
  }
  if (visual) {
    const current = next.visualReview && typeof next.visualReview === "object" ? next.visualReview : {};
    next.visualReview = {
      maxInferences: fields["visualReview.maxInferences"] ?? current.maxInferences ?? VISUAL_REVIEW_DEFAULTS.maxInferences,
      maxPreviews: fields["visualReview.maxPreviews"] ?? current.maxPreviews ?? VISUAL_REVIEW_DEFAULTS.maxPreviews,
      period: "lifetime"
    };
  }
  // Only refuse what this patch introduces; an older file is never blocked from unrelated saves.
  const merged = mergeConfig(DEFAULT_CONFIG, next as never);
  const touches = (...names: string[]) => names.some((name) => has(fields, name));
  if (touches("processing.defaultTarget", "remote.host") && merged.processing.defaultTarget === "remote" && isPlaceholderRemoteHost(merged.remote.host)) {
    throw new Error("Configure o worker remoto antes de escolher o processamento remoto.");
  }
  if (touches("archive.enabled", "archive.vaio", "remote.host") && merged.archive.enabled && merged.archive.vaio && isPlaceholderRemoteHost(merged.remote.host)) {
    throw new Error("Configure o worker remoto antes de arquivar originais nele.");
  }
  return next;
};

export async function saveSettings(
  revision: string,
  patch: unknown,
  path = getConfigPath(),
  beforeCommit?: () => Promise<void>,
  options: { initialize?: boolean; credentials?: Omit<CredentialOptions, "sessionEnv"> } = {}
) {
  const fields = validateSettingsPatch(patch, { allowEmpty: options.initialize === true });
  // An empty patch only creates the file on first use. The revision binds file existence,
  // so a file created after this check still fails the commit's revision comparison.
  if (!Object.keys(fields).length && (await readConfigRevision(path)).exists) throw new Error("Nenhuma alteração para salvar.");
  const result = await commitConfigChange(revision, path, (previous) => applySettingsPatch(previous, fields), beforeCommit);
  const receipt = { saved: true as const, changed: Object.keys(fields), backupCreated: result.backupCreated, cleanupPending: result.cleanupPending, prunedBackups: result.prunedBackups };
  // A failed re-read must not turn a published change into a reported failure.
  const after = await readSettings(result.path, process.env, options.credentials).catch(() => undefined);
  return after ? { ...after, ...receipt, needsReload: false } : { ...receipt, needsReload: true };
}

/* ---------- Configuration backups ---------- */

const readBounded = async (path: string, limit = 1024 * 1024): Promise<Buffer> => {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Arquivo inválido ou grande demais.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const parseConfigObject = (bytes: Buffer): Record<string, any> => {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("O arquivo não contém uma configuração.");
  validateConfig(mergeConfig(DEFAULT_CONFIG, value));
  return value;
};

export type ConfigBackup = { name: string; modifiedAt: string; bytes: number; valid: boolean };

export async function listConfigBackups(path = getConfigPath()): Promise<ConfigBackup[]> {
  const directory = dirname(path), pattern = configBackupPattern(path);
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const backups = await Promise.all(names.filter((name) => pattern.test(name)).map(async (name): Promise<ConfigBackup | null> => {
    const file = join(directory, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    const valid = await readBounded(file).then(parseConfigObject).then(() => true, () => false);
    return { name, modifiedAt: stat.mtime.toISOString(), bytes: stat.size, valid };
  }));
  return backups.filter((item): item is ConfigBackup => !!item)
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, 50);
}

/** Restore a previous configuration; the current one is backed up first by the commit path. */
export async function restoreConfigBackup(revision: string, name: unknown, path = getConfigPath()) {
  if (typeof name !== "string" || !configBackupPattern(path).test(name)) throw new Error("Cópia de segurança inválida.");
  const value = parseConfigObject(await readBounded(join(dirname(path), name)));
  const result = await commitConfigChange(revision, path, () => value);
  return { restored: name, backupCreated: result.backupCreated, prunedBackups: result.prunedBackups };
}

/* ---------- Export and import ---------- */

const assertUserFile = (target: unknown): string => {
  if (typeof target !== "string" || !isAbsolute(target) || target.length > 4096 || CONTROL.test(target) || !target.endsWith(".json")) {
    throw new Error("Escolha um arquivo .json com caminho absoluto.");
  }
  return target;
};

/** Write the configuration without credentials (openai.apiKey, obs.password) to a user-chosen file. */
export async function exportSettings(target: unknown, path = getConfigPath()) {
  const destination = assertUserFile(target);
  const current = await readConfigRevision(path);
  const value = structuredClone(current.value);
  if (value.openai && typeof value.openai === "object") delete value.openai.apiKey;
  if (value.obs && typeof value.obs === "object") delete value.obs.password;
  const parent = await fs.lstat(dirname(destination)).catch(() => null);
  if (!parent?.isDirectory()) throw new Error("A pasta de destino não existe.");
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("O destino não é um arquivo comum.");
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return { exported: destination, credentialsOmitted: true };
}

/**
 * Read a configuration file for import. Only allowlisted, individually valid fields are
 * returned for the Studio draft; the user reviews and saves them through the normal path.
 */
export async function readImportFile(target: unknown) {
  const source = assertUserFile(target);
  const value = JSON.parse((await readBounded(source)).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("O arquivo não contém uma configuração.");
  const merged = mergeConfig(DEFAULT_CONFIG, value);
  const values: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const field of Object.keys(SETTINGS_FIELDS)) {
    if (field.startsWith("visualReview.")) {
      if (value.visualReview) values[field] = getPath(merged, field);
      continue;
    }
    if (getPath(value, field) === undefined) continue;
    const candidate = getPath(merged, field);
    if (SETTINGS_FIELDS[field](candidate)) values[field] = candidate;
    else rejected.push(field);
  }
  const flatten = (node: unknown, prefix = ""): string[] => node && typeof node === "object" && !Array.isArray(node)
    ? Object.entries(node).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key))
    : [prefix];
  const ignored = flatten(value).filter((field) => field && !has(SETTINGS_FIELDS, field) && !field.startsWith("visualReview."))
    .filter((field) => !["openai.apiKey", "obs.password"].includes(field)).slice(0, 100);
  return { values, rejected, ignored, credentialsIgnored: !!(value.openai?.apiKey || value.obs?.password) };
}
