import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "./defaults";
import { getConfigPath, mergeConfig, validateConfig } from "./load";
import { acquireSingleton } from "../runtime/singleton";

type JsonObject = Record<string, unknown>;

export type ConfigureDefaultAudioOptions = {
  /** Injectable path for tests; production callers should omit it. */
  path?: string;
  beforeCommit?: () => Promise<void>;
};

export type ConfigureDefaultAudioResult = {
  path: string;
  backupPath?: string;
  changed: boolean;
};

const privateMode = 0o600;
const directoryMode = 0o700;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validatedConfig = (raw: JsonObject): AppConfig => {
  const config = mergeConfig(DEFAULT_CONFIG, raw as never);
  validateConfig(config);
  return config;
};

const contentHash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const backupName = (path: string): string => `${path}.bak-${Date.now()}-${randomUUID()}`;

const readRawConfig = async (path: string): Promise<{ raw: JsonObject; exists: boolean; bytes: Buffer; hash: string }> => {
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, exists: false, bytes: Buffer.alloc(0), hash: "" };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Configuração deve ser um arquivo regular");
    const bytes = await handle.readFile();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error("Configuração deve ser um objeto JSON");
    return { raw: value, exists: true, bytes, hash: contentHash(bytes) };
  } finally {
    await handle.close();
  }
};

/** Configure the capture devices without discarding unrelated or future keys. */
export const configureDefaultAudio = async (
  options: ConfigureDefaultAudioOptions = {}
): Promise<ConfigureDefaultAudioResult> => {
  const path = options.path || getConfigPath();
  const lease = await acquireSingleton(`config-audio-${contentHash(path).slice(0, 16)}`);
  try {
  const { raw, exists, bytes, hash } = await readRawConfig(path);
  const before = validatedConfig(raw);
  const capture = isObject(raw.capture) ? raw.capture : {};
  const updated: JsonObject = {
    ...raw,
    capture: { ...capture, microphone: "default", desktop: "default" }
  };
  const after = validatedConfig(updated);
  const changed = !exists || before.capture.microphone !== after.capture.microphone || before.capture.desktop !== after.capture.desktop;
  if (!changed) return { path, changed: false };

  await fs.mkdir(dirname(path), { recursive: true, mode: directoryMode });
  if (options.beforeCommit) await options.beforeCommit();
  if (exists) {
    const current = await readRawConfig(path);
    if (current.hash !== hash || !current.bytes.equals(bytes)) throw new Error("Configuração foi alterada durante a atualização; nenhuma alteração foi publicada");
  }
  let backupPath: string | undefined;
  if (exists) {
    backupPath = backupName(path);
    await fs.writeFile(backupPath, bytes, { flag: "wx", mode: privateMode });
  }
  const temporary = join(dirname(path), `.${path.split("/").pop() || "config.json"}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: privateMode });
    if (exists) {
      const current = await readRawConfig(path);
      if (current.hash !== hash || !current.bytes.equals(bytes)) throw new Error("Configuração foi alterada durante a atualização; nenhuma alteração foi publicada");
    }
    if (exists) await fs.rename(temporary, path);
    else await fs.link(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path, backupPath, changed: true };
  } finally {
    await lease.release();
  }
};
