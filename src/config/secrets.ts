import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigPath } from "./load";
import { acquireSingleton } from "../runtime/singleton";

/**
 * Provider credentials live outside config.json, in private KEY=value files.
 *
 * Resolution order, identical for every process (terminal, Studio bridge, call
 * monitor, timers and per-job systemd units):
 *   1. an explicit environment variable whose value did not come from a legacy file
 *      (a file this module rejects included);
 *   2. secrets.env next to the active configuration (written by the Studio);
 *   3. ~/.config/recording-cli/worker.env, then calls.env (legacy, still loaded by units);
 *   4. the caller's own legacy fallback (config.openai.apiKey for OpenAI).
 *
 * Generated units load worker.env or calls.env through EnvironmentFile=, so their
 * process environment repeats those values; a value equal to a legacy file is ranked as
 * that file, which lets a key saved in the Studio replace an older one everywhere. systemd
 * also loads a legacy file this module rejects, so values found in a rejected file are
 * dropped from the environment and never used.
 * Values are never logged, returned to the UI or written anywhere but secrets.env.
 */
export const SECRET_NAMES = ["OPENAI_API_KEY", "GEMINI_API_KEY", "RECORDING_CLI_OBS_PASSWORD"] as const;
export type SecretName = typeof SECRET_NAMES[number];
export type SecretFileName = "secrets.env" | "worker.env" | "calls.env";
export type SecretSource = "environment" | SecretFileName | "config" | "missing";

const MAX_SECRET_FILE_BYTES = 64 * 1024;
/** Upper bound for reading a rejected legacy file only to recognise its values. */
const MAX_REJECTED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_LENGTH = 4096;

export const isSecretName = (value: unknown): value is SecretName =>
  typeof value === "string" && (SECRET_NAMES as readonly string[]).includes(value);

export type SecretFiles = Record<SecretFileName, string>;

/** secrets.env follows the active configuration directory; legacy files keep their historical path. */
export const getSecretFiles = (configPath = getConfigPath(), home = homedir()): SecretFiles => ({
  "secrets.env": join(dirname(configPath), "secrets.env"),
  "worker.env": join(home, ".config", "recording-cli", "worker.env"),
  "calls.env": join(home, ".config", "recording-cli", "calls.env")
});

export type SecretFileState = {
  file: SecretFileName;
  path: string;
  exists: boolean;
  usable: boolean;
  /** Group or others can read it: still used, but reported so the user can chmod 600. */
  tooOpen: boolean;
  problem?: string;
  values: Map<string, string>;
  /** Values of a rejected legacy file, kept only so resolution can drop them from the environment. */
  rejectedValues?: Map<string, string>;
};

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return value;
};

const LINE_END = "\n\r";
const BLANK = " \t\n\r";

/**
 * Parse an environment file with the rules systemd's EnvironmentFile= uses (env-file.c), so a
 * value read here is the value a unit receives: lines starting with # or ; are comments;
 * unquoted values drop surrounding blanks, honour backslash escapes and continue on a
 * trailing backslash; single quotes are verbatim; double quotes unescape only ", \, ` and $;
 * quoted values may span lines. A leading `export ` is accepted, as in a shell.
 */
export const parseEnvFile = (content: string): Map<string, string> => {
  const values = new Map<string, string>();
  type State = "preKey" | "key" | "preValue" | "value" | "valueEscape" | "single" | "double" | "doubleEscape" | "comment" | "commentEscape";
  let state: State = "preKey";
  let key = "";
  let value = "";
  let keyBlank = -1;
  let valueBlank = -1;
  const push = () => {
    const name = (keyBlank >= 0 ? key.slice(0, keyBlank) : key).replace(/^export[ \t]+/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) values.set(name, value);
    key = "";
    value = "";
    keyBlank = -1;
    valueBlank = -1;
  };
  for (const c of content) {
    switch (state) {
      case "preKey":
        if (c === "#" || c === ";") state = "comment";
        else if (!BLANK.includes(c)) { state = "key"; key = c; keyBlank = -1; }
        break;
      case "key":
        if (LINE_END.includes(c)) { state = "preKey"; key = ""; }
        else if (c === "=") { state = "preValue"; valueBlank = -1; }
        else {
          if (!BLANK.includes(c)) keyBlank = -1;
          else if (keyBlank < 0) keyBlank = key.length;
          key += c;
        }
        break;
      case "preValue":
        if (LINE_END.includes(c)) { state = "preKey"; push(); }
        else if (c === "'") state = "single";
        else if (c === '"') state = "double";
        else if (c === "\\") state = "valueEscape";
        else if (!BLANK.includes(c)) { state = "value"; value += c; }
        break;
      case "value":
        if (LINE_END.includes(c)) {
          state = "preKey";
          if (valueBlank >= 0) value = value.slice(0, valueBlank);
          push();
        } else if (c === "\\") { state = "valueEscape"; valueBlank = -1; }
        else {
          if (!BLANK.includes(c)) valueBlank = -1;
          else if (valueBlank < 0) valueBlank = value.length;
          value += c;
        }
        break;
      case "valueEscape":
        state = "value";
        if (!LINE_END.includes(c)) value += c;
        break;
      case "single":
        if (c === "'") state = "preValue";
        else value += c;
        break;
      case "double":
        if (c === '"') state = "preValue";
        else if (c === "\\") state = "doubleEscape";
        else value += c;
        break;
      case "doubleEscape":
        state = "double";
        if ('"\\`$'.includes(c)) value += c;
        else if (c !== "\n") value += `\\${c}`;
        break;
      case "comment":
        if (c === "\\") state = "commentEscape";
        else if (LINE_END.includes(c)) state = "preKey";
        break;
      case "commentEscape":
        state = LINE_END.includes(c) ? "preKey" : "comment";
        break;
    }
  }
  if (state === "value" && valueBlank >= 0) value = value.slice(0, valueBlank);
  if (["preValue", "value", "valueEscape", "single", "double", "doubleEscape"].includes(state)) push();
  return values;
};

/** Credentials from a KEY=value file: empty values and values with control characters are left out. */
export const parseSecretLines = (content: string): Map<string, string> =>
  new Map([...parseEnvFile(content)].filter(([, value]) => value !== "" && !/\p{Cc}/u.test(value)));

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export const readSecretFile = async (file: SecretFileName, path: string): Promise<SecretFileState> => {
  const state: SecretFileState = { file, path, exists: false, usable: false, tooOpen: false, values: new Map() };
  let handle: FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return state;
    state.exists = true;
    state.problem = code === "ELOOP" ? "é um link simbólico; ignorado" : "não pôde ser lido";
    return state;
  }
  try {
    state.exists = true;
    const stat = await handle.stat();
    const uid = currentUid();
    if (!stat.isFile()) state.problem = "não é um arquivo comum; ignorado";
    else if (uid !== undefined && stat.uid !== uid) state.problem = "pertence a outro usuário; ignorado";
    else if (stat.mode & 0o022) state.problem = "outros usuários podem alterá-lo; ignorado";
    else if (stat.size > MAX_SECRET_FILE_BYTES) state.problem = "é grande demais; ignorado";
    if (state.problem) return state;
    state.tooOpen = (stat.mode & 0o044) !== 0;
    state.values = parseSecretLines((await handle.readFile()).toString("utf8"));
    state.usable = true;
    return state;
  } finally {
    await handle.close();
  }
};

/**
 * Units load worker.env and calls.env through EnvironmentFile= even when this module rejects
 * them, so their environment repeats the rejected values. Read such a file the way systemd
 * does (following links) only to recognise those values; they are never used.
 */
const readRejectedValues = async (path: string): Promise<Map<string, string>> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return new Map();
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_REJECTED_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseSecretLines(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return new Map();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const readSecretFiles = async (files: SecretFiles = getSecretFiles()): Promise<SecretFileState[]> =>
  Promise.all((["secrets.env", "worker.env", "calls.env"] as const).map(async (file) => {
    const state = await readSecretFile(file, files[file]);
    if (file !== "secrets.env" && state.exists && !state.usable) state.rejectedValues = await readRejectedValues(files[file]);
    return state;
  }));

export type ResolvedSecret = { value?: string; source: Exclude<SecretSource, "config"> };

/** Pure resolution shared by readSecret and the diagnostics. */
export const resolveSecretFrom = (name: string, env: NodeJS.ProcessEnv, states: SecretFileState[]): ResolvedSecret => {
  const fileValue = (file: SecretFileName) => states.find((state) => state.file === file && state.usable)?.values.get(name);
  const envValue = env[name]?.trim() || undefined;
  // A unit that loads a rejected legacy file repeats its values: drop them, never use them.
  const rejected = states.map((state) => state.rejectedValues?.get(name)?.trim());
  const fromEnv = envValue && !rejected.includes(envValue) ? envValue : undefined;
  const legacy = [fileValue("worker.env")?.trim(), fileValue("calls.env")?.trim()];
  if (fromEnv && !legacy.includes(fromEnv)) return { value: fromEnv, source: "environment" };
  for (const file of ["secrets.env", "worker.env", "calls.env"] as const) {
    const value = fileValue(file);
    if (value) return { value, source: file };
  }
  return fromEnv ? { value: fromEnv, source: "environment" } : { source: "missing" };
};

export const resolveSecret = async (
  name: SecretName,
  env: NodeJS.ProcessEnv = process.env,
  files: SecretFiles = getSecretFiles()
): Promise<ResolvedSecret> => resolveSecretFrom(name, env, await readSecretFiles(files));

const resolvedValues = new Set<string>();

/** Replace every credential this process has resolved; used before persisting error text. */
export const redactResolvedSecrets = (message: string): string => {
  let redacted = message;
  for (const value of resolvedValues) if (value.length >= 4) redacted = redacted.replaceAll(value, "[redacted]");
  return redacted;
};

/** Credential for a provider call. Never log or return the value to a UI. */
export const readSecret = async (
  name: SecretName,
  env: NodeJS.ProcessEnv = process.env,
  files: SecretFiles = getSecretFiles()
): Promise<string | undefined> => {
  const { value } = await resolveSecret(name, env, files);
  if (value) resolvedValues.add(value);
  return value;
};

const validateSecretValue = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Valor inválido.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SECRET_LENGTH || /\p{Cc}/u.test(trimmed)) {
    throw new Error("Valor inválido: use uma única linha, sem caracteres de controle.");
  }
  return trimmed;
};

const quoteSecret = (value: string): string =>
  value.includes("'") ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : `'${value}'`;

const updateSecretFile = async (path: string, change: (lines: string[]) => string[]): Promise<void> => {
  const directory = dirname(path);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Diretório inseguro; nenhuma alteração.");
  const lease = await acquireSingleton(`secrets-${Buffer.from(path).toString("hex").slice(-32)}`);
  try {
    const current = await readSecretFile("secrets.env", path);
    if (current.exists && !current.usable) throw new Error(`secrets.env ${current.problem}. Corrija o arquivo antes de salvar.`);
    const previous = current.exists ? (await fs.readFile(path, "utf8")).split(/\r?\n/) : ["# FalaTrace: chaves privadas. Edite pelo Studio ou mantenha a permissão 600."];
    const lines = change(previous.filter((line, index, all) => !(index === all.length - 1 && line === "")));
    const temporary = join(directory, `.secrets-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    await fs.chmod(path, 0o600);
  } finally {
    await lease.release();
  }
};

const isLineFor = (name: string) => (line: string): boolean =>
  new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);

/** Store one credential in secrets.env (0600). Write-only: nothing is returned. */
export const setSecret = async (name: unknown, value: unknown, files: SecretFiles = getSecretFiles()): Promise<void> => {
  if (!isSecretName(name)) throw new Error("Chave não suportada.");
  const secret = validateSecretValue(value);
  await updateSecretFile(files["secrets.env"], (lines) => [...lines.filter((line) => !isLineFor(name)(line)), `${name}=${quoteSecret(secret)}`]);
};

/** Remove a credential from secrets.env only; legacy files are reported, never edited. */
export const removeSecret = async (name: unknown, files: SecretFiles = getSecretFiles()): Promise<{ removed: boolean }> => {
  if (!isSecretName(name)) throw new Error("Chave não suportada.");
  const current = await readSecretFile("secrets.env", files["secrets.env"]);
  if (!current.exists || !current.values.has(name)) return { removed: false };
  await updateSecretFile(files["secrets.env"], (lines) => lines.filter((line) => !isLineFor(name)(line)));
  return { removed: true };
};

export type CredentialReport = {
  name: SecretName;
  /** What background processing (timers, per-job units, call monitor) will use. */
  source: SecretSource;
  /** Present only in this Studio session's environment, which background units do not inherit. */
  sessionOnly: boolean;
  /** A higher-priority source hides the key saved in the Studio. */
  shadowsStudioKey: boolean;
  savedInStudio: boolean;
};

export type CredentialStatus = {
  openai: SecretSource;
  gemini: SecretSource;
  details: CredentialReport[];
  files: Array<{ file: SecretFileName; path: string; exists: boolean; usable: boolean; tooOpen: boolean; problem?: string }>;
  managerEnvironment: "read" | "unavailable";
};

/**
 * Describe where each credential comes from, never its value.
 * `managerEnv` is the systemd user manager environment (what units inherit); when it
 * cannot be read, background resolution uses files only and the report says so.
 */
export const describeCredentials = async (
  options: {
    sessionEnv?: NodeJS.ProcessEnv;
    managerEnv?: NodeJS.ProcessEnv | null;
    configApiKey?: boolean;
    files?: SecretFiles;
  } = {}
): Promise<CredentialStatus> => {
  const states = await readSecretFiles(options.files || getSecretFiles());
  const sessionEnv = options.sessionEnv || process.env;
  const managerEnv = options.managerEnv ?? null;
  const details = SECRET_NAMES.map((name): CredentialReport => {
    const background = resolveSecretFrom(name, managerEnv || {}, states);
    const session = resolveSecretFrom(name, sessionEnv, states);
    const savedInStudio = !!states.find((state) => state.file === "secrets.env" && state.usable)?.values.get(name);
    const source: SecretSource = background.source !== "missing" ? background.source
      : name === "OPENAI_API_KEY" && options.configApiKey ? "config" : "missing";
    return {
      name,
      source,
      sessionOnly: source === "missing" && session.source === "environment",
      shadowsStudioKey: savedInStudio && source !== "secrets.env",
      savedInStudio
    };
  });
  const sourceOf = (name: SecretName) => details.find((detail) => detail.name === name)?.source ?? "missing";
  return {
    openai: sourceOf("OPENAI_API_KEY"),
    gemini: sourceOf("GEMINI_API_KEY"),
    details,
    files: states.map(({ values: _values, rejectedValues: _rejected, ...state }) => state),
    managerEnvironment: managerEnv ? "read" : "unavailable"
  };
};

/** Parse `systemctl --user show-environment`; values stay in memory only for comparison. */
export const parseManagerEnvironment = (output: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, index))) env[line.slice(0, index)] = unquote(line.slice(index + 1));
  }
  return env;
};
