import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { emptyTimesheetContext } from "../timesheet/context";
import { type TimesheetClient, type TimesheetContext, validateTimesheetContext } from "../timesheet/types";
import { PrivateFileError, fileLockName, hasControlCharacters, isFileSystemError, isRecord, withLock } from "../people/store";
import { normalizeClientText } from "./resolve";

/**
 * Editing the client catalog (`config.timesheet.contextPath`) from the app. The file is the
 * person's own: edits splice the raw JSON so every other client, colleague, task type and
 * unknown field stays byte for byte, keep a private backup and replace the file atomically.
 */

export const CLIENT_CATALOG_LIMITS = { maxClients: 500, maxListItems: 30, maxNameLength: 200, maxFileBytes: 8 * 1024 * 1024, backupsKept: 10 } as const;

export const CLIENT_CATALOG_ERRORS = {
  invalid: "O catálogo de clientes é inválido; corrija o arquivo antes de editar.",
  stale: "O catálogo de clientes mudou em outra janela; recarregue e tente de novo.",
  notFound: "Cliente não encontrado.",
  duplicateCode: "Já existe um cliente com esse código.",
  invalidCode: "Código de cliente inválido: use até 20 letras, números, ponto, sublinhado, dois-pontos ou hífen, começando por letra ou número.",
  invalidName: "Nome do cliente inválido: use de 1 a 200 caracteres, sem quebras de linha.",
  invalidList: "Apelidos e responsáveis: até 30 itens de até 200 caracteres cada, sem quebras de linha.",
  conflict: "Esse nome ou apelido já identifica outro cliente.",
  full: "O catálogo atingiu o limite de 500 clientes.",
  notRegular: "O catálogo de clientes não é um arquivo comum (por exemplo, um link simbólico); edite-o diretamente.",
  unsafeDirectory: "A pasta do catálogo de clientes não é segura; nada foi alterado.",
  tooLarge: "O catálogo de clientes é grande demais para ser editado aqui.",
  busy: "Outra operação está salvando estes dados; tente de novo em instantes.",
  permission: "Não foi possível ler ou gravar o catálogo de clientes; verifique as permissões e o espaço em disco.",
  unsupported: "Não foi possível editar o catálogo sem alterar outros dados; edite o arquivo diretamente."
} as const;

export const CLIENT_CATALOG_KNOWN_ERRORS: readonly string[] = Object.values(CLIENT_CATALOG_ERRORS);

export type ClientCatalogRead = {
  path: string;
  /** "invalid" pages show no clients; edits are refused until the file is fixed. */
  state: "ok" | "missing" | "invalid";
  context: TimesheetContext;
  /** sha256 of the file bytes (null when missing); pass it back as expectedRevision. */
  revision: string | null;
  /** False when the app will not replace the file (a symlink, for example). */
  editable: boolean;
  error?: string;
};

export type ClientInput = { code?: string; name: string; aliases?: string[]; responsibleNames?: string[] };
export type ClientChanges = { name?: string; aliases?: string[]; responsibleNames?: string[] };
export type CatalogEditOptions = { expectedRevision?: string | null; lockTimeoutMs?: number; now?: () => Date };
export type CatalogEditResult = { context: TimesheetContext; revision: string; client?: TimesheetClient; backupPath?: string };

const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(message); };

/* ---------- Reading ---------- */

const readBytes = async (path: string, followSymlink: boolean): Promise<Buffer | undefined> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | (followSymlink ? 0 : constants.O_NOFOLLOW));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new PrivateFileError("unsafe");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PrivateFileError("unsafe");
    if (stat.size > CLIENT_CATALOG_LIMITS.maxFileBytes) throw new PrivateFileError("too-large");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > CLIENT_CATALOG_LIMITS.maxFileBytes) throw new PrivateFileError("too-large");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
};

/** The catalog for pages: never throws; a missing file is an empty catalog, an invalid one shows no clients. */
export const readClientCatalog = async (path: string): Promise<ClientCatalogRead> => {
  const symlink = await fs.lstat(path).then((stat) => stat.isSymbolicLink(), () => false);
  try {
    const bytes = await readBytes(path, true);
    // A dangling symlink reads as missing, but edits refuse to replace a symlink.
    if (!bytes) return { path, state: "missing", context: emptyTimesheetContext(), revision: null, editable: !symlink };
    const text = bytes.toString("utf8");
    // Text that is not valid UTF-8 is shown, but edits would rewrite it (see commit).
    const editable = !symlink && Buffer.from(text, "utf8").equals(bytes);
    return { path, state: "ok", context: validateTimesheetContext(JSON.parse(text)), revision: sha256(bytes), editable };
  } catch {
    return { path, state: "invalid", context: emptyTimesheetContext(), revision: null, editable: false, error: CLIENT_CATALOG_ERRORS.invalid };
  }
};

/* ---------- Raw JSON spans ---------- */

type JsonNode =
  | { kind: "object"; start: number; end: number; members: Array<{ key: string; keyStart: number; value: JsonNode }> }
  | { kind: "array"; start: number; end: number; elements: JsonNode[] }
  | { kind: "scalar"; start: number; end: number };

const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** Positions of every value in a JSON text that JSON.parse already accepted. */
const scanJson = (text: string): JsonNode => {
  let position = 0;
  const broken = (): never => { throw new Error("unexpected JSON shape"); };
  const whitespace = (): void => {
    while (position < text.length && " \t\n\r".includes(text[position]!)) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const character = text[position];
      if (character === "\\") position += 2;
      else if (character === "\"") return JSON.parse(text.slice(start, ++position)) as string;
      else position++;
    }
    return broken();
  };
  const value = (depth: number): JsonNode => {
    if (depth > 512) broken();
    whitespace();
    const start = position;
    const character = text[position];
    if (character === "{") {
      position++;
      const members: Array<{ key: string; keyStart: number; value: JsonNode }> = [];
      whitespace();
      if (text[position] === "}") return { kind: "object", start, end: ++position, members };
      for (;;) {
        whitespace();
        if (text[position] !== "\"") broken();
        const keyStart = position;
        const key = string();
        whitespace();
        if (text[position++] !== ":") broken();
        members.push({ key, keyStart, value: value(depth + 1) });
        whitespace();
        const next = text[position++];
        if (next === "}") return { kind: "object", start, end: position, members };
        if (next !== ",") broken();
      }
    }
    if (character === "[") {
      position++;
      const elements: JsonNode[] = [];
      whitespace();
      if (text[position] === "]") return { kind: "array", start, end: ++position, elements };
      for (;;) {
        elements.push(value(depth + 1));
        whitespace();
        const next = text[position++];
        if (next === "]") return { kind: "array", start, end: position, elements };
        if (next !== ",") broken();
      }
    }
    if (character === "\"") {
      string();
      return { kind: "scalar", start, end: position };
    }
    LITERAL.lastIndex = position;
    const match = LITERAL.exec(text);
    if (!match) return broken();
    position += match[0].length;
    return { kind: "scalar", start, end: position };
  };
  const root = value(0);
  whitespace();
  if (position !== text.length) broken();
  return root;
};

/** Leading whitespace of the line where `offset` starts, or null when other text precedes it. */
const lineIndentAt = (text: string, offset: number): string | null => {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return lineStart > 0 && /^[ \t]*$/.test(prefix) ? prefix : null;
};

const indentUnit = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";

const serialize = (value: unknown, indent: string | null, text: string): string =>
  indent === null
    ? JSON.stringify(value)
    : JSON.stringify(value, null, indentUnit(text)).split("\n").map((line, index) => (index === 0 ? line : indent + line))
      .join(text.includes("\r\n") ? "\r\n" : "\n");

type CatalogDocument = { text: string; clients: Extract<JsonNode, { kind: "array" }>; clientsKeyStart: number; context: TimesheetContext };

const parseDocument = (text: string): CatalogDocument => {
  let context: TimesheetContext;
  let root: JsonNode;
  try {
    context = validateTimesheetContext(JSON.parse(text));
    root = scanJson(text);
  } catch {
    return fail(CLIENT_CATALOG_ERRORS.invalid);
  }
  // JSON.parse keeps the last of repeated keys, so the last "clients" is the one in use.
  const member = root.kind === "object" ? [...root.members].reverse().find((candidate) => candidate.key === "clients") : undefined;
  if (member?.value.kind !== "array" || member.value.elements.length !== context.clients.length) return fail(CLIENT_CATALOG_ERRORS.invalid);
  return { text, clients: member.value, clientsKeyStart: member.keyStart, context };
};

const replaceElement = (document: CatalogDocument, index: number, value: Record<string, unknown>): string => {
  const { text } = document;
  const element = document.clients.elements[index]!;
  const indent = text.slice(element.start, element.end).includes("\n") ? lineIndentAt(text, element.start) : null;
  return text.slice(0, element.start) + serialize(value, indent, text) + text.slice(element.end);
};

const appendElement = (document: CatalogDocument, value: Record<string, unknown>): string => {
  const { text, clients } = document;
  const count = clients.elements.length;
  if (count === 0) {
    const keyIndent = lineIndentAt(text, document.clientsKeyStart);
    if (keyIndent === null) return text.slice(0, clients.start + 1) + serialize(value, null, text) + text.slice(clients.end - 1);
    const indent = keyIndent + indentUnit(text);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return `${text.slice(0, clients.start + 1)}${eol}${indent}${serialize(value, indent, text)}${eol}${keyIndent}${text.slice(clients.end - 1)}`;
  }
  const last = clients.elements[count - 1]!;
  // Reuse the spacing the file already has between elements.
  const separator = count === 1
    ? text.slice(clients.start + 1, last.start)
    : text.slice(text.indexOf(",", clients.elements[count - 2]!.end) + 1, last.start);
  const indent = text.slice(last.start, last.end).includes("\n") ? lineIndentAt(text, last.start) : null;
  return `${text.slice(0, last.end)},${separator}${serialize(value, indent, text)}${text.slice(last.end)}`;
};

const removeElement = (document: CatalogDocument, index: number): string => {
  const { text, clients } = document;
  const elements = clients.elements;
  if (elements.length === 1) return text.slice(0, clients.start + 1) + text.slice(clients.end - 1);
  if (index < elements.length - 1) return text.slice(0, elements[index]!.start) + text.slice(elements[index + 1]!.start);
  return text.slice(0, elements[index - 1]!.end) + text.slice(elements[index]!.end);
};

/* ---------- Input validation ---------- */

const cleanText = (value: unknown, maximum: number, message: string): string => {
  if (typeof value !== "string") return fail(message);
  const text = value.trim();
  if (!text || text.length > maximum || hasControlCharacters(text)) return fail(message);
  return text;
};

const cleanList = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CLIENT_CATALOG_LIMITS.maxListItems * 4) return fail(CLIENT_CATALOG_ERRORS.invalidList);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return fail(CLIENT_CATALOG_ERRORS.invalidList);
    const text = item.trim();
    if (!text) continue;
    if (text.length > CLIENT_CATALOG_LIMITS.maxNameLength || hasControlCharacters(text)) return fail(CLIENT_CATALOG_ERRORS.invalidList);
    const key = normalizeClientText(text) || text;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  if (items.length > CLIENT_CATALOG_LIMITS.maxListItems) return fail(CLIENT_CATALOG_ERRORS.invalidList);
  return items;
};

const matchTerms = (client: Pick<TimesheetClient, "code" | "name" | "aliases">): string[] =>
  [client.code, client.name, ...client.aliases].map(normalizeClientText).filter((term) => term.length >= 3);

/** Names that would make two clients indistinguishable; only terms this edit introduces are checked. */
const assertNoConflict = (context: TimesheetContext, client: TimesheetClient, previous?: TimesheetClient): void => {
  const before = new Set(previous ? matchTerms(previous) : []);
  const introduced = matchTerms(client).filter((term) => !before.has(term));
  if (introduced.length === 0) return;
  const taken = new Set(context.clients.filter((other) => other.code !== (previous?.code ?? client.code)).flatMap(matchTerms));
  if (introduced.some((term) => taken.has(term))) fail(CLIENT_CATALOG_ERRORS.conflict);
};

/** Next free "CLnnn" code. */
export const nextClientCode = (context: TimesheetContext): string => {
  const used = new Set(context.clients.map((client) => client.code));
  let number = context.clients.reduce((maximum, client) => {
    const match = /^CL(\d{1,15})$/.exec(client.code);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  while (used.has(`CL${String(number).padStart(3, "0")}`)) number++;
  return `CL${String(number).padStart(3, "0")}`;
};

/* ---------- Committing ---------- */

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const backupPattern = (path: string): RegExp =>
  new RegExp(`^${escapeRegExp(basename(path))}\\.bak-\\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

/** Keeps the newest backups of this catalog; never touches other files. */
const pruneBackups = async (path: string, keep: number): Promise<void> => {
  const directory = dirname(path);
  const pattern = backupPattern(path);
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => pattern.test(name));
  const entries = (await Promise.all(names.map(async (name) => {
    const stat = await fs.lstat(join(directory, name)).catch(() => null);
    return stat?.isFile() ? { name, mtime: stat.mtimeMs } : null;
  }))).filter((entry): entry is { name: string; mtime: number } => !!entry)
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const entry of entries.slice(keep)) await fs.rm(join(directory, entry.name), { force: true }).catch(() => undefined);
};

const mapError = (error: unknown): never => {
  if (error instanceof PrivateFileError) {
    throw new Error(error.problem === "busy" ? CLIENT_CATALOG_ERRORS.busy : error.problem === "too-large" ? CLIENT_CATALOG_ERRORS.tooLarge : CLIENT_CATALOG_ERRORS.notRegular);
  }
  if (isFileSystemError(error)) throw new Error(CLIENT_CATALOG_ERRORS.permission);
  throw error;
};

/** Everything but the edited client must survive the edit unchanged (guards the raw splice). */
const assertOnlyClientChanged = (before: string, after: string, editedCode: string | undefined, addedCode?: string): TimesheetContext => {
  const previous = JSON.parse(before) as Record<string, unknown>;
  const next = JSON.parse(after) as Record<string, unknown>;
  const context = validateTimesheetContext(next);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (key !== "clients" && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) fail(CLIENT_CATALOG_ERRORS.unsupported);
  }
  const othersBefore = (previous.clients as unknown[]).filter((client) => !isRecord(client) || client.code !== editedCode);
  const othersAfter = (next.clients as unknown[]).filter((client) => !isRecord(client) || (client.code !== editedCode && client.code !== addedCode));
  if (JSON.stringify(othersBefore) !== JSON.stringify(othersAfter)) fail(CLIENT_CATALOG_ERRORS.unsupported);
  return context;
};

type Edit = (document: CatalogDocument | undefined) => { text: string; client?: TimesheetClient; editedCode?: string; addedCode?: string };

const commit = (path: string, options: CatalogEditOptions, edit: Edit): Promise<CatalogEditResult> =>
  withLock(fileLockName("timesheet-catalog", path), async () => {
    const existing = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) fail(CLIENT_CATALOG_ERRORS.notRegular);
    const before = await readBytes(path, false);
    const revision = before ? sha256(before) : null;
    // An invalid file is reported as such even when it also changed since it was read.
    const document = before ? parseDocument(before.toString("utf8")) : undefined;
    // Bytes that are not valid UTF-8 (a Latin-1 file, say) decode to U+FFFD: writing the text
    // back would silently rewrite every other client's name, so such a file is not spliced.
    if (before && document && !Buffer.from(document.text, "utf8").equals(before)) fail(CLIENT_CATALOG_ERRORS.unsupported);
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) fail(CLIENT_CATALOG_ERRORS.stale);
    const result = edit(document);
    let context: TimesheetContext;
    try {
      context = document
        ? assertOnlyClientChanged(document.text, result.text, result.editedCode, result.addedCode)
        : validateTimesheetContext(JSON.parse(result.text));
    } catch (error) {
      // The guard's own verdicts pass through; a parser or validator message (English) never reaches a page.
      if (error instanceof Error && CLIENT_CATALOG_KNOWN_ERRORS.includes(error.message)) throw error;
      return fail(CLIENT_CATALOG_ERRORS.unsupported);
    }
    const client = result.client ? { client: result.client } : {};
    if (document && result.text === document.text) return { context, revision: revision as string, ...client };
    const bytes = Buffer.from(result.text, "utf8");
    if (bytes.length > CLIENT_CATALOG_LIMITS.maxFileBytes) fail(CLIENT_CATALOG_ERRORS.tooLarge);

    const directory = dirname(path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // The folder may be a symlink (dotfile managers do that), but it must be the user's own
    // and not writable by everyone, or another account could swap the file under us.
    const directoryStat = await fs.stat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o002) !== 0 ||
      (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
      fail(CLIENT_CATALOG_ERRORS.unsafeDirectory);
    }

    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let backupPath: string | undefined;
    let replaced = false;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      if (before) {
        backupPath = `${path}.bak-${(options.now?.() ?? new Date()).getTime()}-${randomUUID()}`;
        await fs.writeFile(backupPath, before, { flag: "wx", mode: 0o600 });
        // Another program may have saved the file meanwhile: never overwrite that.
        const latest = await readBytes(path, false).catch(() => undefined);
        if (!latest || sha256(latest) !== revision) fail(CLIENT_CATALOG_ERRORS.stale);
        await fs.rename(temporary, path);
      } else {
        // link() fails when a file appeared meanwhile, where rename() would replace it.
        await fs.link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") fail(CLIENT_CATALOG_ERRORS.stale);
          throw error;
        });
      }
      replaced = true;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (!replaced && backupPath) await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
    if (backupPath) await pruneBackups(path, CLIENT_CATALOG_LIMITS.backupsKept);
    return { context, revision: sha256(bytes), ...client, ...(backupPath ? { backupPath } : {}) };
  }, options.lockTimeoutMs).catch(mapError);

export const addCatalogClient = async (path: string, input: ClientInput, options: CatalogEditOptions = {}): Promise<CatalogEditResult> => {
  if (!isRecord(input)) fail(CLIENT_CATALOG_ERRORS.invalidName);
  const name = cleanText(input.name, CLIENT_CATALOG_LIMITS.maxNameLength, CLIENT_CATALOG_ERRORS.invalidName);
  const aliases = cleanList(input.aliases);
  const responsibleNames = cleanList(input.responsibleNames);
  const requestedCode = input.code === undefined || input.code === "" ? undefined : cleanText(input.code, 20, CLIENT_CATALOG_ERRORS.invalidCode);
  if (requestedCode !== undefined && !CLIENT_CODE.test(requestedCode)) fail(CLIENT_CATALOG_ERRORS.invalidCode);
  return commit(path, options, (document) => {
    const context = document?.context ?? emptyTimesheetContext();
    if (context.clients.length >= CLIENT_CATALOG_LIMITS.maxClients) fail(CLIENT_CATALOG_ERRORS.full);
    const code = requestedCode ?? nextClientCode(context);
    if (context.clients.some((client) => client.code === code)) fail(CLIENT_CATALOG_ERRORS.duplicateCode);
    const client: TimesheetClient = { code, name, aliases, responsibleNames };
    assertNoConflict(context, client);
    if (!document) {
      return { text: `${JSON.stringify({ ...emptyTimesheetContext(), clients: [client] }, null, 2)}\n`, client, addedCode: code };
    }
    return { text: appendElement(document, { ...client }), client, addedCode: code };
  });
};

/** Changes the name, aliases or responsible names of one client; its code never changes (time entries refer to it). */
export const updateCatalogClient = async (path: string, code: string, changes: ClientChanges, options: CatalogEditOptions = {}): Promise<CatalogEditResult> => {
  if (typeof code !== "string" || !CLIENT_CODE.test(code)) fail(CLIENT_CATALOG_ERRORS.notFound);
  if (!isRecord(changes)) fail(CLIENT_CATALOG_ERRORS.invalidName);
  const name = changes.name === undefined ? undefined : cleanText(changes.name, CLIENT_CATALOG_LIMITS.maxNameLength, CLIENT_CATALOG_ERRORS.invalidName);
  const aliases = changes.aliases === undefined ? undefined : cleanList(changes.aliases);
  const responsibleNames = changes.responsibleNames === undefined ? undefined : cleanList(changes.responsibleNames);
  return commit(path, options, (document) => {
    if (!document) return fail(CLIENT_CATALOG_ERRORS.notFound);
    const index = document.context.clients.findIndex((client) => client.code === code);
    if (index < 0) return fail(CLIENT_CATALOG_ERRORS.notFound);
    const previous = document.context.clients[index]!;
    const client: TimesheetClient = {
      code,
      name: name ?? previous.name,
      aliases: aliases ?? previous.aliases,
      responsibleNames: responsibleNames ?? previous.responsibleNames
    };
    // Nothing to change: keep the file (and its formatting) as it is.
    if (JSON.stringify(client) === JSON.stringify(previous)) return { text: document.text, client, editedCode: code };
    assertNoConflict(document.context, client, previous);
    // Start from the raw object so fields FalaTrace does not know about are kept.
    const element = document.clients.elements[index]!;
    const raw = JSON.parse(document.text.slice(element.start, element.end)) as Record<string, unknown>;
    if (name !== undefined) raw.name = client.name;
    if (aliases !== undefined && (aliases.length > 0 || "aliases" in raw)) raw.aliases = client.aliases;
    if (responsibleNames !== undefined && (responsibleNames.length > 0 || "responsibleNames" in raw)) raw.responsibleNames = client.responsibleNames;
    return { text: replaceElement(document, index, raw), client, editedCode: code };
  });
};

export const renameCatalogClient = (path: string, code: string, name: string, options: CatalogEditOptions = {}): Promise<CatalogEditResult> =>
  updateCatalogClient(path, code, { name }, options);

/** Removes one client. Time entries and manual choices that name it simply stop matching it. */
export const deleteCatalogClient = async (path: string, code: string, options: CatalogEditOptions = {}): Promise<CatalogEditResult> => {
  if (typeof code !== "string" || !CLIENT_CODE.test(code)) fail(CLIENT_CATALOG_ERRORS.notFound);
  return commit(path, options, (document) => {
    if (!document) return fail(CLIENT_CATALOG_ERRORS.notFound);
    const index = document.context.clients.findIndex((client) => client.code === code);
    if (index < 0) return fail(CLIENT_CATALOG_ERRORS.notFound);
    return { text: removeElement(document, index), editedCode: code };
  });
};
