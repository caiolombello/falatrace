import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { JobFacts } from "../library-index/types";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";

/* ---------- Private JSON files (shared by the people, clients and actions stores) ---------- */

export const recordingDataDir = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "recording-cli");

export type PrivateFileProblem = "unsafe" | "too-large" | "malformed" | "busy";

/** A file or directory FalaTrace refuses to read or replace; each store maps it to its own message. */
export class PrivateFileError extends Error {
  constructor(readonly problem: PrivateFileProblem) {
    super(`private file ${problem}`);
    this.name = "PrivateFileError";
  }
}

/** Bytes of a regular file (never through a symlink), or undefined when it does not exist. */
export const readPrivateFile = async (path: string, maxBytes: number): Promise<Buffer | undefined> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new PrivateFileError("unsafe");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PrivateFileError("unsafe");
    if (stat.size > maxBytes) throw new PrivateFileError("too-large");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new PrivateFileError("too-large");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
};

export const readPrivateJson = async (path: string, maxBytes: number): Promise<{ value: unknown; bytes: Buffer } | undefined> => {
  const bytes = await readPrivateFile(path, maxBytes);
  if (!bytes) return undefined;
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    throw new PrivateFileError("malformed");
  }
};

/** Creates the directory 0700 or checks an existing one: a real directory owned by this user. */
export const ensurePrivateDir = async (directory: string): Promise<void> => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PrivateFileError("unsafe");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new PrivateFileError("unsafe");
  if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
};

/** Replaces a file atomically (0600 temporary file created exclusively, then renamed). */
export const writePrivateFileAtomic = async (path: string, bytes: Buffer | string): Promise<void> => {
  const existing = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new PrivateFileError("unsafe");
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
};

/** Lock name scoped to one file, valid for acquireSingleton. */
export const fileLockName = (prefix: string, path: string): string =>
  `${prefix}-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;

/** Runs `work` while holding a per-user lock, waiting up to `timeoutMs` for another holder. */
export const withLock = async <T>(name: string, work: () => Promise<T>, timeoutMs = 5_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lease: SingletonLease | undefined;
  while (!lease) {
    try {
      lease = await acquireSingleton(name);
    } catch (error) {
      if ((error as Error).message !== `${name} is already running`) throw error;
      if (Date.now() >= deadline) throw new PrivateFileError("busy");
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  try {
    return await work();
  } finally {
    await lease.release();
  }
};

/** Errors of the disk itself (permissions, read-only or full file system) that stores report in Portuguese. */
export const FILE_SYSTEM_ERROR_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "EISDIR", "ENOTDIR"]);

export const isFileSystemError = (error: unknown): boolean =>
  error instanceof Error && FILE_SYSTEM_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isIsoTime = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 10 && value.length <= 40 && Number.isFinite(Date.parse(value));

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/* ---------- People ---------- */

export const PEOPLE_LIMITS = { maxPeople: 2_000, maxAliases: 30, maxNameLength: 80, maxFileBytes: 2 * 1024 * 1024 } as const;

export const PEOPLE_ERRORS = {
  stale: "As pessoas mudaram em outra janela; recarregue e tente de novo.",
  invalidFile: "O arquivo de pessoas é inválido; corrija ou remova o arquivo antes de editar.",
  notFound: "Pessoa não encontrada.",
  invalidId: "Identificador de pessoa inválido.",
  invalidName: "Nome inválido: use de 1 a 80 caracteres, sem quebras de linha.",
  conflict: "Esse nome já pertence a outra pessoa; use Mesclar para juntar as duas.",
  mergeSelf: "Não é possível mesclar uma pessoa com ela mesma.",
  aliasesFull: "Limite de 30 apelidos atingido para esta pessoa.",
  peopleFull: "Limite de pessoas atingido.",
  aliasMissing: "Esse apelido não existe para esta pessoa.",
  notMerged: "Esta pessoa não está mesclada com outra.",
  busy: "Outra operação está salvando estes dados; tente de novo em instantes.",
  storage: "Não foi possível ler ou salvar as pessoas; verifique as permissões e o espaço em disco."
} as const;

export const PEOPLE_KNOWN_ERRORS: readonly string[] = Object.values(PEOPLE_ERRORS);

export type StoredPerson = {
  id: string;
  displayName: string;
  aliases: string[];
  hidden: boolean;
  /** Set when this person was merged into another; its names then resolve to that person. */
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
};

export type PeopleFile = { version: 1; rev: number; people: StoredPerson[] };

export const defaultPeopleDir = (): string => join(recordingDataDir(), "people");

/** Identity of a name: NFC, trimmed, single spaces, pt-BR lowercase, without accents. */
export const personKey = (name: string): string =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");

/** True when the text holds C0/C1 control characters (line breaks included). */
export const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** A name typed by a person, tidied; throws when it cannot be a name. */
export const cleanPersonName = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 400) throw new Error(PEOPLE_ERRORS.invalidName);
  const name = value.normalize("NFC").trim().replace(/[ \t]+/g, " ");
  if (!name || name.length > PEOPLE_LIMITS.maxNameLength || hasControlCharacters(name) || !personKey(name)) throw new Error(PEOPLE_ERRORS.invalidName);
  return name;
};

const validStoredName = (value: unknown): value is string => {
  try {
    return cleanPersonName(value) === value;
  } catch {
    return false;
  }
};

export const validatePeopleFile = (value: unknown): PeopleFile => {
  const invalid = (): never => { throw new Error(PEOPLE_ERRORS.invalidFile); };
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.rev) || (value.rev as number) < 0 ||
    !Array.isArray(value.people) || value.people.length > PEOPLE_LIMITS.maxPeople) return invalid();
  const ids = new Set<string>();
  const people = value.people.map((item): StoredPerson => {
    if (!isRecord(item) || typeof item.id !== "string" || !UUID_PATTERN.test(item.id) || ids.has(item.id) ||
      !validStoredName(item.displayName) || !Array.isArray(item.aliases) || item.aliases.length > PEOPLE_LIMITS.maxAliases ||
      !item.aliases.every(validStoredName) || typeof item.hidden !== "boolean" || !isIsoTime(item.createdAt) || !isIsoTime(item.updatedAt) ||
      (item.mergedInto !== undefined && (typeof item.mergedInto !== "string" || !UUID_PATTERN.test(item.mergedInto) || item.mergedInto === item.id))) {
      return invalid();
    }
    ids.add(item.id);
    return {
      id: item.id,
      displayName: item.displayName as string,
      aliases: [...item.aliases as string[]],
      hidden: item.hidden,
      ...(item.mergedInto ? { mergedInto: item.mergedInto as string } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  });
  const byId = new Map(people.map((person) => [person.id, person]));
  for (const person of people) {
    // Merges form chains that must end at a person who is not merged.
    let current: StoredPerson | undefined = person;
    for (let steps = 0; current?.mergedInto; steps++) {
      current = byId.get(current.mergedInto);
      if (!current || steps > people.length) return invalid();
    }
  }
  return { version: 1, rev: value.rev as number, people };
};

/** Default diarizer labels are not names, even if a fact marks them confirmed. */
export const GENERIC_SPEAKER_LABEL = /^(?:falante|speaker|pessoa|participante|hablante|orador|interlocutor)\s*\d+$/iu;

export type FactParticipant = { name: string; role: "speaker" | "attendee"; self: boolean };

/** People of one recording: confirmed speaker names and calendar attendees. */
export const factParticipants = (facts: Pick<JobFacts, "speakers" | "attendees">): FactParticipant[] => {
  const participants: FactParticipant[] = [];
  for (const speaker of Array.isArray(facts.speakers) ? facts.speakers.slice(0, 200) : []) {
    if (!isRecord(speaker) || speaker.confirmed !== true || typeof speaker.label !== "string") continue;
    const name = speaker.label.trim().replace(/\s+/g, " ");
    if (name && name.length <= 200 && !GENERIC_SPEAKER_LABEL.test(name)) participants.push({ name, role: "speaker", self: false });
  }
  for (const attendee of Array.isArray(facts.attendees) ? facts.attendees.slice(0, 200) : []) {
    if (!isRecord(attendee) || typeof attendee.name !== "string") continue;
    const name = attendee.name.trim().replace(/\s+/g, " ");
    if (name && name.length <= 200 && !GENERIC_SPEAKER_LABEL.test(name)) participants.push({ name, role: "attendee", self: attendee.self === true });
  }
  return participants;
};

/** A person as pages address it: a stored record, or a name nobody edited yet ("name:<key>"). */
export type PersonRef = { id: string; key?: string; stored?: StoredPerson };

const NAME_ID = /^name:(.{1,200})$/su;

/** Resolves names and ids through aliases and merges. Read-only view of one PeopleFile. */
export class PeopleDirectory {
  private readonly byId = new Map<string, StoredPerson>();
  private readonly claims = new Map<string, string>();

  constructor(readonly file: PeopleFile = { version: 1, rev: 0, people: [] }) {
    for (const person of file.people) this.byId.set(person.id, person);
    // When two records claim the same name (hand-edited file), the first one wins.
    for (const person of file.people) {
      const root = this.root(person.id);
      if (!root) continue;
      for (const name of [person.displayName, ...person.aliases]) {
        const key = personKey(name);
        if (key && !this.claims.has(key)) this.claims.set(key, root.id);
      }
    }
  }

  /** The record a stored id ends at after following merges. */
  root(id: string): StoredPerson | undefined {
    let current = this.byId.get(id);
    for (let steps = 0; current?.mergedInto && steps <= this.file.people.length; steps++) current = this.byId.get(current.mergedInto);
    return current?.mergedInto ? undefined : current;
  }

  record(id: string): StoredPerson | undefined {
    return this.byId.get(id);
  }

  /** Stored person (root id) that owns this name key, if any. */
  claimantOf(key: string): string | undefined {
    return this.claims.get(key);
  }

  /** Person id for a name seen in a meeting: the stored person that claims it, else "name:<key>". */
  idForName(name: string): string | undefined {
    const key = personKey(name);
    if (!key) return undefined;
    return this.claims.get(key) ?? `name:${key}`;
  }

  /** Current person behind an id given by a page; merged and renamed people lead to their record. */
  resolveId(id: unknown): PersonRef | undefined {
    if (typeof id !== "string" || id.length > 210) return undefined;
    if (UUID_PATTERN.test(id)) {
      const stored = this.root(id);
      return stored ? { id: stored.id, stored } : undefined;
    }
    const match = NAME_ID.exec(id);
    if (!match) return undefined;
    const key = personKey(match[1]!);
    if (!key || key !== match[1]) return undefined;
    const claimant = this.claims.get(key);
    if (claimant) {
      const stored = this.byId.get(claimant)!;
      return { id: stored.id, stored };
    }
    return { id: `name:${key}`, key };
  }

  /** The root record and every record merged into it. */
  members(rootId: string): StoredPerson[] {
    return this.file.people.filter((person) => this.root(person.id)?.id === rootId);
  }

  roots(): StoredPerson[] {
    return this.file.people.filter((person) => !person.mergedInto);
  }

  isHidden(id: string): boolean {
    return this.byId.get(id)?.hidden === true;
  }
}

export type PeopleEditOptions = { expectedRev?: number };
export type PeopleEditResult = { file: PeopleFile; personId: string; changed: boolean };
export type PeopleStoreOptions = { now?: () => Date; newId?: () => string; lockTimeoutMs?: number };

const EMPTY_PEOPLE: PeopleFile = { version: 1, rev: 0, people: [] };

const mapFileError = (error: unknown): never => {
  if (error instanceof PrivateFileError) throw new Error(error.problem === "busy" ? PEOPLE_ERRORS.busy : PEOPLE_ERRORS.invalidFile);
  if (isFileSystemError(error)) throw new Error(PEOPLE_ERRORS.storage);
  throw error;
};

/** Manual corrections to people: renames, aliases, merges, hidden. Missing file = nobody edited yet. */
export class PeopleStore {
  constructor(readonly root = defaultPeopleDir(), private readonly options: PeopleStoreOptions = {}) {}

  get path(): string {
    return join(this.root, "people.json");
  }

  async read(): Promise<PeopleFile> {
    const raw = await readPrivateJson(this.path, PEOPLE_LIMITS.maxFileBytes).catch(mapFileError);
    return raw ? validatePeopleFile(raw.value) : structuredClone(EMPTY_PEOPLE);
  }

  async directory(): Promise<PeopleDirectory> {
    return new PeopleDirectory(await this.read());
  }

  /** New display name; the previous one stays as an alias so older labels still find the person. */
  async rename(id: string, newName: string, options: PeopleEditOptions & { currentName?: string } = {}): Promise<PeopleEditResult> {
    const name = cleanPersonName(newName);
    const key = personKey(name);
    return this.mutate(options.expectedRev, (draft, directory, now) => {
      const target = this.target(directory, id);
      const claimant = directory.claimantOf(key);
      if (claimant && claimant !== target.id) throw new Error(PEOPLE_ERRORS.conflict);
      const person = this.materialize(draft, target, options.currentName, now);
      const previousKey = personKey(person.displayName);
      if (previousKey !== key && !person.aliases.some((alias) => personKey(alias) === previousKey)) person.aliases.push(person.displayName);
      person.aliases = person.aliases.filter((alias) => personKey(alias) !== key);
      if (person.aliases.length > PEOPLE_LIMITS.maxAliases) throw new Error(PEOPLE_ERRORS.aliasesFull);
      person.displayName = name;
      return person.id;
    });
  }

  async addAlias(id: string, alias: string, options: PeopleEditOptions & { currentName?: string } = {}): Promise<PeopleEditResult> {
    const name = cleanPersonName(alias);
    const key = personKey(name);
    return this.mutate(options.expectedRev, (draft, directory, now) => {
      const target = this.target(directory, id);
      const claimant = directory.claimantOf(key);
      if (claimant && claimant !== target.id) throw new Error(PEOPLE_ERRORS.conflict);
      if (claimant === target.id || target.key === key) return target.id;
      const person = this.materialize(draft, target, options.currentName, now);
      if (person.aliases.length >= PEOPLE_LIMITS.maxAliases) throw new Error(PEOPLE_ERRORS.aliasesFull);
      person.aliases.push(name);
      return person.id;
    });
  }

  async removeAlias(id: string, alias: string, options: PeopleEditOptions = {}): Promise<PeopleEditResult> {
    if (typeof alias !== "string" || alias.length > 400) throw new Error(PEOPLE_ERRORS.aliasMissing);
    const key = personKey(alias);
    return this.mutate(options.expectedRev, (draft, directory) => {
      const target = this.target(directory, id);
      const person = target.stored && draft.people.find((candidate) => candidate.id === target.id);
      if (!person?.aliases.some((item) => personKey(item) === key)) throw new Error(PEOPLE_ERRORS.aliasMissing);
      person.aliases = person.aliases.filter((item) => personKey(item) !== key);
      return person.id;
    });
  }

  /** Everything known as `sourceId` becomes `targetId`. A stored source keeps its record (undo with unmerge). */
  async merge(sourceId: string, targetId: string, options: PeopleEditOptions & { sourceName?: string; targetName?: string } = {}): Promise<PeopleEditResult> {
    return this.mutate(options.expectedRev, (draft, directory, now) => {
      const source = this.target(directory, sourceId);
      const target = this.target(directory, targetId);
      if (source.id === target.id) throw new Error(PEOPLE_ERRORS.mergeSelf);
      const person = this.materialize(draft, target, options.targetName, now);
      if (source.stored) {
        for (const candidate of draft.people) {
          if (candidate.id === source.id || candidate.mergedInto === source.id) candidate.mergedInto = person.id;
        }
      } else {
        if (person.aliases.length >= PEOPLE_LIMITS.maxAliases) throw new Error(PEOPLE_ERRORS.aliasesFull);
        person.aliases.push(this.nameFor(source, options.sourceName));
      }
      return person.id;
    });
  }

  async unmerge(id: string, options: PeopleEditOptions = {}): Promise<PeopleEditResult> {
    return this.mutate(options.expectedRev, (draft, directory) => {
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new Error(PEOPLE_ERRORS.invalidId);
      if (!directory.record(id)) throw new Error(PEOPLE_ERRORS.notFound);
      const person = draft.people.find((candidate) => candidate.id === id);
      if (!person?.mergedInto) throw new Error(PEOPLE_ERRORS.notMerged);
      delete person.mergedInto;
      return person.id;
    });
  }

  async setHidden(id: string, hidden: boolean, options: PeopleEditOptions & { currentName?: string } = {}): Promise<PeopleEditResult> {
    return this.mutate(options.expectedRev, (draft, directory, now) => {
      const target = this.target(directory, id);
      if (!target.stored && !hidden) return target.id;
      const person = this.materialize(draft, target, options.currentName, now);
      person.hidden = hidden === true;
      return person.id;
    });
  }

  private target(directory: PeopleDirectory, id: string): PersonRef {
    const ref = directory.resolveId(id);
    if (ref) return ref;
    throw new Error(typeof id === "string" && (UUID_PATTERN.test(id) || NAME_ID.test(id)) ? PEOPLE_ERRORS.notFound : PEOPLE_ERRORS.invalidId);
  }

  private nameFor(ref: PersonRef, hint: string | undefined): string {
    if (hint !== undefined) {
      try {
        const name = cleanPersonName(hint);
        if (personKey(name) === ref.key) return name;
      } catch {
        // A bad hint falls back to the key, which always resolves to the same person.
      }
    }
    return cleanPersonName(ref.key);
  }

  /** The draft record for a reference, creating it for a name nobody edited yet. */
  private materialize(draft: PeopleFile, ref: PersonRef, hint: string | undefined, now: string): StoredPerson {
    if (ref.stored) return draft.people.find((person) => person.id === ref.id)!;
    if (draft.people.length >= PEOPLE_LIMITS.maxPeople) throw new Error(PEOPLE_ERRORS.peopleFull);
    const person: StoredPerson = {
      id: (this.options.newId || randomUUID)(),
      displayName: this.nameFor(ref, hint),
      aliases: [],
      hidden: false,
      createdAt: now,
      updatedAt: now
    };
    draft.people.push(person);
    return person;
  }

  private async mutate(expectedRev: number | undefined, change: (draft: PeopleFile, directory: PeopleDirectory, now: string) => string): Promise<PeopleEditResult> {
    if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0)) throw new Error(PEOPLE_ERRORS.stale);
    return withLock(fileLockName("people", this.path), async () => {
      const current = await this.read();
      if (expectedRev !== undefined && current.rev !== expectedRev) throw new Error(PEOPLE_ERRORS.stale);
      const draft = structuredClone(current);
      const now = (this.options.now?.() ?? new Date()).toISOString();
      const personId = change(draft, new PeopleDirectory(current), now);
      const before = new Map(current.people.map((person) => [person.id, JSON.stringify(person)]));
      let changed = draft.people.length !== current.people.length;
      for (const person of draft.people) {
        if (before.get(person.id) === JSON.stringify(person)) continue;
        changed = true;
        if (before.has(person.id)) person.updatedAt = now;
      }
      if (!changed) return { file: current, personId, changed: false };
      draft.rev = current.rev + 1;
      const file = validatePeopleFile(draft);
      const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
      if (bytes.length > PEOPLE_LIMITS.maxFileBytes) throw new Error(PEOPLE_ERRORS.peopleFull);
      await ensurePrivateDir(this.root).catch(mapFileError);
      await writePrivateFileAtomic(this.path, bytes).catch(mapFileError);
      return { file, personId, changed: true };
    }, this.options.lockTimeoutMs).catch((error) => mapFileError(error));
  }
}
