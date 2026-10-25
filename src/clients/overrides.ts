import { dirname, join } from "node:path";
import type { FactClient, JobFacts } from "../library-index/types";
import type { TimesheetContext } from "../timesheet/types";
import {
  PrivateFileError,
  SHA256_PATTERN,
  UUID_PATTERN,
  ensurePrivateDir,
  fileLockName,
  isFileSystemError,
  isIsoTime,
  isRecord,
  readPrivateJson,
  recordingDataDir,
  withLock,
  writePrivateFileAtomic
} from "../people/store";

/** A person's choice of client(s) for one recording; `clientCodes: []` means "no client". */
export type ClientOverride = { jobId: string; mediaSha256: string; clientCodes: string[]; setAt: string };
export type ClientOverridesFile = { version: 1; rev: number; entries: ClientOverride[] };

export const CLIENT_OVERRIDE_LIMITS = { maxEntries: 5_000, maxCodesPerEntry: 10, maxFileBytes: 2 * 1024 * 1024 } as const;

export const CLIENT_OVERRIDE_ERRORS = {
  stale: "As escolhas de cliente mudaram em outra janela; recarregue e tente de novo.",
  invalidFile: "O arquivo de escolhas de cliente é inválido; corrija ou remova o arquivo antes de editar.",
  invalidRecording: "Gravação inválida para escolher o cliente.",
  invalidCodes: "Escolha até 10 clientes válidos, sem repetir.",
  unknownClient: "Cliente não encontrado no catálogo.",
  busy: "Outra operação está salvando estes dados; tente de novo em instantes.",
  storage: "Não foi possível ler ou salvar as escolhas de cliente; verifique as permissões e o espaço em disco."
} as const;

export const CLIENT_OVERRIDE_KNOWN_ERRORS: readonly string[] = Object.values(CLIENT_OVERRIDE_ERRORS);

const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;

export const defaultClientOverridesPath = (): string => join(recordingDataDir(), "client-overrides.json");

const validCodes = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= CLIENT_OVERRIDE_LIMITS.maxCodesPerEntry &&
  value.every((code) => typeof code === "string" && CLIENT_CODE.test(code)) && new Set(value).size === value.length;

export const validateClientOverrides = (value: unknown): ClientOverridesFile => {
  const invalid = (): never => { throw new Error(CLIENT_OVERRIDE_ERRORS.invalidFile); };
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0 ||
    !Array.isArray(value.entries) || value.entries.length > CLIENT_OVERRIDE_LIMITS.maxEntries) return invalid();
  const jobs = new Set<string>();
  const entries = value.entries.map((item): ClientOverride => {
    if (!isRecord(item) || typeof item.jobId !== "string" || !UUID_PATTERN.test(item.jobId) || jobs.has(item.jobId) ||
      typeof item.mediaSha256 !== "string" || !SHA256_PATTERN.test(item.mediaSha256) || !validCodes(item.clientCodes) || !isIsoTime(item.setAt)) {
      return invalid();
    }
    jobs.add(item.jobId);
    return { jobId: item.jobId, mediaSha256: item.mediaSha256, clientCodes: [...item.clientCodes], setAt: item.setAt };
  });
  return { version: 1, rev: value.rev as number, entries };
};

/** The override of a recording: its own job first, else the latest one set for the same media (a reprocessed copy). */
export const overrideFor = (file: ClientOverridesFile | undefined, jobId: string, mediaSha256?: string): ClientOverride | undefined => {
  if (!file) return undefined;
  const exact = file.entries.find((entry) => entry.jobId === jobId);
  if (exact || !mediaSha256) return exact;
  return file.entries
    .filter((entry) => entry.mediaSha256 === mediaSha256)
    .sort((a, b) => b.setAt.localeCompare(a.setAt))[0];
};

/**
 * Clients of indexed facts with manual overrides applied, limited to the catalog when one is
 * given. Overrides win over anything the index derived; a stale index never hides a choice.
 */
export const effectiveClients = (
  facts: Pick<JobFacts, "jobId" | "mediaSha256" | "clients">,
  overrides?: ClientOverridesFile,
  catalog?: TimesheetContext
): FactClient[] => {
  const known = catalog ? new Map(catalog.clients.map((client) => [client.code, client.name])) : undefined;
  const override = overrideFor(overrides, facts.jobId, facts.mediaSha256);
  if (override) {
    if (override.clientCodes.length === 0) return [];
    // When every chosen client left the catalog, the automatic assignment applies again.
    const codes = known ? override.clientCodes.filter((code) => known.has(code)) : override.clientCodes;
    if (codes.length > 0) {
      return codes.map((code) => ({
        code,
        name: known?.get(code) ?? facts.clients.find((client) => client.code === code)?.name ?? code,
        source: "manual",
        confidence: 1
      }));
    }
  }
  const seen = new Set<string>();
  return facts.clients.filter((client) => {
    if (seen.has(client.code) || (known && !known.has(client.code))) return false;
    seen.add(client.code);
    return true;
  }).map((client) => ({ ...client, name: known?.get(client.code) ?? client.name }));
};

const mapFileError = (error: unknown): never => {
  if (error instanceof PrivateFileError) throw new Error(error.problem === "busy" ? CLIENT_OVERRIDE_ERRORS.busy : CLIENT_OVERRIDE_ERRORS.invalidFile);
  if (isFileSystemError(error)) throw new Error(CLIENT_OVERRIDE_ERRORS.storage);
  throw error;
};

export type ClientOverridesStoreOptions = { now?: () => Date; lockTimeoutMs?: number };

export class ClientOverridesStore {
  constructor(readonly path = defaultClientOverridesPath(), private readonly options: ClientOverridesStoreOptions = {}) {}

  async read(): Promise<ClientOverridesFile> {
    const raw = await readPrivateJson(this.path, CLIENT_OVERRIDE_LIMITS.maxFileBytes).catch(mapFileError);
    return raw ? validateClientOverrides(raw.value) : { version: 1, rev: 0, entries: [] };
  }

  /** Sets the client(s) of a recording. `knownCodes` (the catalog) refuses codes that do not exist. */
  async set(input: { jobId: string; mediaSha256: string; clientCodes: string[]; expectedRev?: number; knownCodes?: readonly string[] }): Promise<ClientOverridesFile> {
    if (typeof input.jobId !== "string" || !UUID_PATTERN.test(input.jobId) || typeof input.mediaSha256 !== "string" || !SHA256_PATTERN.test(input.mediaSha256)) {
      throw new Error(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    }
    if (!validCodes(input.clientCodes)) throw new Error(CLIENT_OVERRIDE_ERRORS.invalidCodes);
    if (input.knownCodes && input.clientCodes.some((code) => !input.knownCodes!.includes(code))) throw new Error(CLIENT_OVERRIDE_ERRORS.unknownClient);
    return this.mutate(input.expectedRev, (file, now) => {
      const existing = file.entries.find((entry) => entry.jobId === input.jobId);
      if (existing && existing.mediaSha256 === input.mediaSha256 && JSON.stringify(existing.clientCodes) === JSON.stringify(input.clientCodes)) return false;
      file.entries = file.entries.filter((entry) => entry.jobId !== input.jobId);
      file.entries.push({ jobId: input.jobId, mediaSha256: input.mediaSha256, clientCodes: [...input.clientCodes], setAt: now });
      if (file.entries.length > CLIENT_OVERRIDE_LIMITS.maxEntries) {
        file.entries = file.entries.sort((a, b) => a.setAt.localeCompare(b.setAt)).slice(-CLIENT_OVERRIDE_LIMITS.maxEntries);
      }
      return true;
    });
  }

  /**
   * Back to the automatic rule. Pages pass the recording's `mediaSha256`: a reprocessed copy
   * inherits the choice made on an earlier job of the same media (overrideFor), so only
   * forgetting every choice for that media really goes back to automatic. Deleting a job
   * passes the jobId alone, so the choice keeps applying to the copies that remain.
   */
  async clear(jobId: string, options: { expectedRev?: number; mediaSha256?: string } = {}): Promise<ClientOverridesFile> {
    if (typeof jobId !== "string" || !UUID_PATTERN.test(jobId)) throw new Error(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    const media = options.mediaSha256;
    if (media !== undefined && (typeof media !== "string" || !SHA256_PATTERN.test(media))) throw new Error(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    return this.mutate(options.expectedRev, (file) => {
      const before = file.entries.length;
      file.entries = file.entries.filter((entry) => entry.jobId !== jobId && (media === undefined || entry.mediaSha256 !== media));
      return file.entries.length !== before;
    });
  }

  private async mutate(expectedRev: number | undefined, change: (file: ClientOverridesFile, now: string) => boolean): Promise<ClientOverridesFile> {
    if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0)) throw new Error(CLIENT_OVERRIDE_ERRORS.stale);
    return withLock(fileLockName("client-overrides", this.path), async () => {
      const current = await this.read();
      if (expectedRev !== undefined && current.rev !== expectedRev) throw new Error(CLIENT_OVERRIDE_ERRORS.stale);
      const draft = structuredClone(current);
      if (!change(draft, (this.options.now?.() ?? new Date()).toISOString())) return current;
      draft.rev = current.rev + 1;
      const file = validateClientOverrides(draft);
      const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
      if (bytes.length > CLIENT_OVERRIDE_LIMITS.maxFileBytes) throw new Error(CLIENT_OVERRIDE_ERRORS.invalidFile);
      await ensurePrivateDir(dirname(this.path)).catch(mapFileError);
      await writePrivateFileAtomic(this.path, bytes).catch(mapFileError);
      return file;
    }, this.options.lockTimeoutMs).catch(mapFileError);
  }
}
