import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, tempDir } from "../../people/__tests__/fixtures";
import { loadTimesheetContext } from "../../timesheet/context";
import { DEFAULT_CONFIG } from "../../config/defaults";
import {
  CLIENT_CATALOG_ERRORS,
  CLIENT_CATALOG_KNOWN_ERRORS,
  CLIENT_CATALOG_LIMITS,
  addCatalogClient,
  deleteCatalogClient,
  nextClientCode,
  readClientCatalog,
  renameCatalogClient,
  updateCatalogClient
} from "../catalog";

afterEach(removeTempDirs);

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** A hand-edited catalog: tabs, unknown fields everywhere, a compact client, a colleague with e-mail. */
const HAND_EDITED = `{
\t"version": 1,
\t"ownerName": "Caio",
\t"x-notes": { "keep": [1, 2.50, "três"] },
\t"colleagues": [ { "name": "Ana", "email": "ana@example.com", "aliases": [] } ],
\t"clients": [
\t\t{
\t\t\t"code": "CL001",
\t\t\t"name": "Acme Brasil",
\t\t\t"aliases": ["acme"],
\t\t\t"responsibleNames": ["Ana"],
\t\t\t"x-crm": "https://crm.example/acme"
\t\t},
\t\t{"code":"CL002","name":"Beta Saúde","aliases":[],"responsibleNames":[],"x-color":"#00ff00"},
\t\t{
\t\t\t"code": "CL007",
\t\t\t"name": "Gama \\"Ltda\\"",
\t\t\t"responsibleNames": []
\t\t}
\t],
\t"taskTypes": [ { "id": 2, "name": "Entregas", "slug": "entregas" } ],
\t"x-trailing": true
}
`;

const setup = async (content?: string) => {
  const root = await tempDir("client-catalog-");
  const path = join(root, "config", "timesheet-context.json");
  if (content !== undefined) {
    await fs.mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, content, { mode: 0o600 });
  }
  return { root, path, directory: join(root, "config") };
};

const files = async (directory: string): Promise<string[]> => (await fs.readdir(directory)).sort();
const backups = async (directory: string): Promise<string[]> => (await files(directory)).filter((name) => name.includes(".bak-"));

/** Everything except the named client must be byte-identical. */
const withoutClient = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from) + end.length;
  expect(from).toBeGreaterThan(0);
  return text.slice(0, from) + text.slice(to);
};

describe("readClientCatalog", () => {
  test("a missing file is an empty, editable catalog", async () => {
    const { path } = await setup();
    const read = await readClientCatalog(path);
    expect(read).toMatchObject({ state: "missing", revision: null, editable: true });
    expect(read.context.clients).toEqual([]);
  });

  test("a valid file gives its clients and a revision", async () => {
    const { path } = await setup(HAND_EDITED);
    const read = await readClientCatalog(path);
    expect(read.state).toBe("ok");
    expect(read.revision).toBe(sha(HAND_EDITED));
    expect(read.context.clients.map((client) => client.code)).toEqual(["CL001", "CL002", "CL007"]);
    expect(read.editable).toBe(true);
  });

  test("an invalid file degrades to no clients with the fixed message", async () => {
    for (const content of ["{", "", JSON.stringify({ version: 1, colleagues: [], taskTypes: [], clients: [{ code: "A" }] })]) {
      const { path } = await setup(content);
      const read = await readClientCatalog(path);
      expect(read).toMatchObject({ state: "invalid", revision: null, editable: false, error: CLIENT_CATALOG_ERRORS.invalid });
      expect(read.context.clients).toEqual([]);
    }
  });

  test("a symlinked catalog is readable but not editable here", async () => {
    const { root, path, directory } = await setup();
    const target = join(root, "dotfiles.json");
    await fs.writeFile(target, HAND_EDITED);
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink(target, path);
    const read = await readClientCatalog(path);
    expect(read).toMatchObject({ state: "ok", editable: false });
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notRegular);
    expect(await fs.readFile(target, "utf8")).toBe(HAND_EDITED);
  });
});

describe("addCatalogClient", () => {
  test("creates the file when there is none, like time init-context would", async () => {
    const { path } = await setup();
    const result = await addCatalogClient(path, { name: "  Acme  ", aliases: ["acme", " ACME ", ""], responsibleNames: ["Ana"] });
    expect(result.client).toEqual({ code: "CL001", name: "Acme", aliases: ["acme"], responsibleNames: ["Ana"] });
    expect(result.backupPath).toBeUndefined();
    const text = await fs.readFile(path, "utf8");
    expect(result.revision).toBe(sha(text));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const loaded = await loadTimesheetContext({ ...structuredClone(DEFAULT_CONFIG), timesheet: { ...DEFAULT_CONFIG.timesheet, contextPath: path } });
    expect(loaded.clients).toEqual([result.client!]);
    expect(JSON.parse(text)).toEqual({ version: 1, colleagues: [], clients: [result.client!], taskTypes: [] });
  });

  test("appends a client keeping every other byte, and backs up the previous file", async () => {
    const { path, directory } = await setup(HAND_EDITED);
    const result = await addCatalogClient(path, { name: "Delta", aliases: ["dlt"] }, { expectedRevision: sha(HAND_EDITED) });
    expect(result.client!.code).toBe("CL008");
    const text = await fs.readFile(path, "utf8");
    // The new element follows the last client with the file's own separator and indentation.
    expect(text).toBe(HAND_EDITED.replace(
      '\t\t\t"responsibleNames": []\n\t\t}\n\t],',
      '\t\t\t"responsibleNames": []\n\t\t},\n\t\t{\n\t\t\t"code": "CL008",\n\t\t\t"name": "Delta",\n\t\t\t"aliases": [\n\t\t\t\t"dlt"\n\t\t\t],\n\t\t\t"responsibleNames": []\n\t\t}\n\t],'
    ));
    expect(result.backupPath).toBeDefined();
    expect(await fs.readFile(result.backupPath!, "utf8")).toBe(HAND_EDITED);
    expect((await fs.stat(result.backupPath!)).mode & 0o777).toBe(0o600);
    // Nothing else is left behind.
    expect((await files(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("appends after a compact last element using the compact style", async () => {
    const compact = '{"version":1,"colleagues":[],"taskTypes":[],"clients":[{"code":"A1","name":"Alfa","aliases":[],"responsibleNames":[]}],"extra":{"a":1}}';
    const { path } = await setup(compact);
    await addCatalogClient(path, { code: "B2", name: "Bravo" });
    expect(await fs.readFile(path, "utf8")).toBe(compact.replace('"responsibleNames":[]}]', '"responsibleNames":[]},{"code":"B2","name":"Bravo","aliases":[],"responsibleNames":[]}]'));
  });

  test("fills an empty clients array on its own lines, keeping CRLF line ends", async () => {
    const crlf = '{\r\n  "version": 1,\r\n  "colleagues": [],\r\n  "clients": [],\r\n  "taskTypes": []\r\n}\r\n';
    const { path } = await setup(crlf);
    await addCatalogClient(path, { code: "A1", name: "Alfa" });
    const text = await fs.readFile(path, "utf8");
    expect(text).toBe('{\r\n  "version": 1,\r\n  "colleagues": [],\r\n  "clients": [\r\n    {\r\n      "code": "A1",\r\n      "name": "Alfa",\r\n      "aliases": [],\r\n      "responsibleNames": []\r\n    }\r\n  ],\r\n  "taskTypes": []\r\n}\r\n');
  });

  test("codes stay unique; names and aliases must not identify another client", async () => {
    const { path } = await setup(HAND_EDITED);
    await expect(addCatalogClient(path, { code: "CL002", name: "Outro" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.duplicateCode);
    await expect(addCatalogClient(path, { name: "ACME" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.conflict);
    await expect(addCatalogClient(path, { name: "Nova", aliases: ["beta saude"] })).rejects.toThrow(CLIENT_CATALOG_ERRORS.conflict);
    await expect(addCatalogClient(path, { name: "cl007" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.conflict);
    expect(await fs.readFile(path, "utf8")).toBe(HAND_EDITED);
  });

  test("input is validated before the file is touched", async () => {
    const { path, directory } = await setup(HAND_EDITED);
    await expect(addCatalogClient(path, { name: "" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidName);
    await expect(addCatalogClient(path, { name: "a\nb" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidName);
    await expect(addCatalogClient(path, { name: "x".repeat(201) })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidName);
    await expect(addCatalogClient(path, { name: "Ok", code: "-bad" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidCode);
    await expect(addCatalogClient(path, { name: "Ok", code: "x".repeat(21) })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidCode);
    await expect(addCatalogClient(path, { name: "Ok", aliases: ["a\tb"] })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidList);
    await expect(addCatalogClient(path, { name: "Ok", aliases: Array.from({ length: 31 }, (_, n) => `alias ${n}`) })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidList);
    await expect(addCatalogClient(path, { name: "Ok", responsibleNames: [42 as unknown as string] })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidList);
    await expect(addCatalogClient(path, null as never)).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalidName);
    expect(await fs.readFile(path, "utf8")).toBe(HAND_EDITED);
    expect(await backups(directory)).toEqual([]);
  });

  test("the catalog is limited to 500 clients", async () => {
    const full = JSON.stringify({
      version: 1, colleagues: [], taskTypes: [],
      clients: Array.from({ length: CLIENT_CATALOG_LIMITS.maxClients }, (_, n) => ({ code: `C${n}`, name: `Cliente ${n}`, aliases: [], responsibleNames: [] }))
    });
    const { path } = await setup(full);
    await expect(addCatalogClient(path, { name: "Mais um" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.full);
  });

  test("two windows adding at once both land, with different codes", async () => {
    const { path } = await setup(HAND_EDITED);
    await Promise.all([addCatalogClient(path, { name: "Delta" }), addCatalogClient(path, { name: "Épsilon" })]);
    const read = await readClientCatalog(path);
    expect(read.context.clients.map((client) => client.code)).toEqual(["CL001", "CL002", "CL007", "CL008", "CL009"]);
  });
});

describe("updateCatalogClient", () => {
  test("renames one client and keeps its unknown fields; everything else stays byte for byte", async () => {
    const { path } = await setup(HAND_EDITED);
    const result = await renameCatalogClient(path, "CL001", "Acme Brasil S.A.");
    expect(result.client).toEqual({ code: "CL001", name: "Acme Brasil S.A.", aliases: ["acme"], responsibleNames: ["Ana"] });
    const text = await fs.readFile(path, "utf8");
    expect(withoutClient(text, '{\n\t\t\t"code": "CL001"', "\t\t}")).toBe(withoutClient(HAND_EDITED, '{\n\t\t\t"code": "CL001"', "\t\t}"));
    expect(text).toContain('\t\t{\n\t\t\t"code": "CL001",\n\t\t\t"name": "Acme Brasil S.A.",\n\t\t\t"aliases": [\n\t\t\t\t"acme"\n\t\t\t],\n\t\t\t"responsibleNames": [\n\t\t\t\t"Ana"\n\t\t\t],\n\t\t\t"x-crm": "https://crm.example/acme"\n\t\t}');
  });

  test("a compact client stays compact", async () => {
    const { path } = await setup(HAND_EDITED);
    await updateCatalogClient(path, "CL002", { aliases: ["beta"], responsibleNames: ["Bruno"] });
    const text = await fs.readFile(path, "utf8");
    expect(text).toBe(HAND_EDITED.replace(
      '{"code":"CL002","name":"Beta Saúde","aliases":[],"responsibleNames":[],"x-color":"#00ff00"}',
      '{"code":"CL002","name":"Beta Saúde","aliases":["beta"],"responsibleNames":["Bruno"],"x-color":"#00ff00"}'
    ));
  });

  test("an absent list is not added just to be empty", async () => {
    const { path } = await setup(HAND_EDITED);
    await updateCatalogClient(path, "CL007", { aliases: [], name: "Gama" });
    const text = await fs.readFile(path, "utf8");
    expect(text).toContain('\t\t{\n\t\t\t"code": "CL007",\n\t\t\t"name": "Gama",\n\t\t\t"responsibleNames": []\n\t\t}');
  });

  test("no real change writes nothing and makes no backup", async () => {
    const { path, directory } = await setup(HAND_EDITED);
    const result = await updateCatalogClient(path, "CL001", { name: "Acme Brasil", aliases: ["acme"] }, { expectedRevision: sha(HAND_EDITED) });
    expect(result.revision).toBe(sha(HAND_EDITED));
    expect(await fs.readFile(path, "utf8")).toBe(HAND_EDITED);
    expect(await backups(directory)).toEqual([]);
  });

  test("unknown clients, conflicts and a missing catalog are refused", async () => {
    const { path } = await setup(HAND_EDITED);
    await expect(updateCatalogClient(path, "CL404", { name: "x" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notFound);
    await expect(updateCatalogClient(path, "../etc", { name: "x" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notFound);
    await expect(updateCatalogClient(path, "CL002", { aliases: ["ACME"] })).rejects.toThrow(CLIENT_CATALOG_ERRORS.conflict);
    // Keeping a name the client already had is fine even if the catalog already had a clash.
    await updateCatalogClient(path, "CL001", { responsibleNames: [] });
    const missing = await setup();
    await expect(updateCatalogClient(missing.path, "CL001", { name: "x" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notFound);
  });
});

describe("deleteCatalogClient", () => {
  test("removes the first, middle or last client cleanly", async () => {
    for (const [code, start, end] of [
      ["CL001", '{\n\t\t\t"code": "CL001"', '\t\t},\n\t\t'],
      ["CL002", '{"code":"CL002"', '"#00ff00"},\n\t\t'],
      ["CL007", ',\n\t\t{\n\t\t\t"code": "CL007"', "\t\t}"]
    ] as const) {
      const { path } = await setup(HAND_EDITED);
      const result = await deleteCatalogClient(path, code);
      const text = await fs.readFile(path, "utf8");
      expect(text).toBe(withoutClient(HAND_EDITED, start, end));
      expect(result.context.clients.map((client) => client.code)).not.toContain(code);
      expect(JSON.parse(text)["x-notes"]).toEqual({ keep: [1, 2.5, "três"] });
    }
  });

  test("removing the only client leaves an empty array", async () => {
    const { path } = await setup('{"version":1,"colleagues":[],"taskTypes":[],"clients":[ {"code":"A","name":"Alfa"} ]}');
    await deleteCatalogClient(path, "A");
    expect(await fs.readFile(path, "utf8")).toBe('{"version":1,"colleagues":[],"taskTypes":[],"clients":[]}');
    await expect(deleteCatalogClient(path, "A")).rejects.toThrow(CLIENT_CATALOG_ERRORS.notFound);
  });
});

describe("safety", () => {
  test("an invalid catalog is never edited", async () => {
    const broken = '{"version":1,"clients":[{"code":"A","name":"Alfa"},{"code":"A","name":"Duplicado"}],"colleagues":[],"taskTypes":[]}';
    const { path, directory } = await setup(broken);
    await expect(addCatalogClient(path, { name: "Beta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalid);
    await expect(deleteCatalogClient(path, "A")).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalid);
    // Invalid wins over stale: the person must fix the file first.
    await expect(updateCatalogClient(path, "A", { name: "x" }, { expectedRevision: "0".repeat(64) })).rejects.toThrow(CLIENT_CATALOG_ERRORS.invalid);
    expect(await fs.readFile(path, "utf8")).toBe(broken);
    expect(await backups(directory)).toEqual([]);
  });

  test("an edit based on an older read is refused", async () => {
    const { path } = await setup(HAND_EDITED);
    const read = await readClientCatalog(path);
    await addCatalogClient(path, { name: "Delta" }, { expectedRevision: read.revision });
    await expect(addCatalogClient(path, { name: "Épsilon" }, { expectedRevision: read.revision })).rejects.toThrow(CLIENT_CATALOG_ERRORS.stale);
    // A read of a missing file promises the file is still missing.
    const missing = await setup();
    await addCatalogClient(missing.path, { name: "Alfa" }, { expectedRevision: null });
    await expect(addCatalogClient(missing.path, { name: "Beta" }, { expectedRevision: null })).rejects.toThrow(CLIENT_CATALOG_ERRORS.stale);
  });

  test("duplicate 'clients' keys: the one JSON.parse uses is the one edited", async () => {
    const doubled = '{"version":1,"clients":[{"code":"OLD","name":"Ignorado"}],"colleagues":[],"taskTypes":[],"clients":[{"code":"A","name":"Alfa"}]}';
    const { path } = await setup(doubled);
    await addCatalogClient(path, { code: "B", name: "Bravo" });
    const text = await fs.readFile(path, "utf8");
    expect(text).toBe(doubled.replace('{"code":"A","name":"Alfa"}]', '{"code":"A","name":"Alfa"},{"code":"B","name":"Bravo","aliases":[],"responsibleNames":[]}]'));
  });

  test("a catalog that is not valid UTF-8 is shown but never rewritten", async () => {
    // "Café" saved as Latin-1: JSON.parse accepts the decoded text (with U+FFFD), so only a
    // byte round-trip check stops an edit from rewriting this client's name.
    const latin1 = Buffer.concat([
      Buffer.from('{"version":1,"colleagues":[],"taskTypes":[],"clients":[{"code":"A","name":"Caf'),
      Buffer.from([0xe9]),
      Buffer.from('"}]}')
    ]);
    const { path, directory } = await setup();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path, latin1, { mode: 0o600 });
    const read = await readClientCatalog(path);
    expect(read.state).toBe("ok");
    expect(read.editable).toBe(false);
    await expect(addCatalogClient(path, { name: "Beta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.unsupported);
    await expect(renameCatalogClient(path, "A", "Café")).rejects.toThrow(CLIENT_CATALOG_ERRORS.unsupported);
    await expect(deleteCatalogClient(path, "A")).rejects.toThrow(CLIENT_CATALOG_ERRORS.unsupported);
    expect((await fs.readFile(path)).equals(latin1)).toBe(true);
    expect(await backups(directory)).toEqual([]);
  });

  test("a dangling symlink reads as missing but is not offered for editing", async () => {
    const { root, path, directory } = await setup();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.symlink(join(root, "nowhere.json"), path);
    const read = await readClientCatalog(path);
    expect(read.state).toBe("missing");
    expect(read.editable).toBe(false);
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notRegular);
    await expect(fs.lstat(join(root, "nowhere.json"))).rejects.toThrow();
  });

  test("a world-writable folder is refused", async () => {
    const { path, directory } = await setup(HAND_EDITED);
    await fs.chmod(directory, 0o777);
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.unsafeDirectory);
    expect(await fs.readFile(path, "utf8")).toBe(HAND_EDITED);
    await fs.chmod(directory, 0o700);
  });

  test("a symlinked folder of the user's own is accepted", async () => {
    const { root, path } = await setup(HAND_EDITED);
    const linkDirectory = join(root, "linked");
    await fs.symlink(join(root, "config"), linkDirectory);
    await addCatalogClient(join(linkDirectory, "timesheet-context.json"), { name: "Delta" });
    expect((await readClientCatalog(path)).context.clients).toHaveLength(4);
  });

  test("a directory where the file should be is refused", async () => {
    const { path } = await setup();
    await fs.mkdir(path, { recursive: true });
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.notRegular);
    expect((await readClientCatalog(path)).state).toBe("invalid");
  });

  test("an oversized catalog is not edited here", async () => {
    const { path } = await setup(`${HAND_EDITED}${" ".repeat(CLIENT_CATALOG_LIMITS.maxFileBytes)}`);
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.tooLarge);
  });

  test("only the newest backups of this catalog are kept; other files are left alone", async () => {
    const { path, directory } = await setup(HAND_EDITED);
    await fs.writeFile(join(directory, "timesheet-context.json.bak-notes.txt"), "minhas notas");
    let tick = Date.parse("2026-10-25T12:00:00.000Z");
    for (let index = 0; index < CLIENT_CATALOG_LIMITS.backupsKept + 3; index++) {
      await addCatalogClient(path, { name: `Cliente novo ${index}` }, { now: () => new Date(tick++) });
    }
    const made = (await backups(directory)).filter((name) => /\.bak-\d+-[0-9a-f-]{36}$/.test(name));
    expect(made).toHaveLength(CLIENT_CATALOG_LIMITS.backupsKept);
    expect(await fs.readFile(join(directory, "timesheet-context.json.bak-notes.txt"), "utf8")).toBe("minhas notas");
  });

  test("a catalog path that cannot exist fails with a Portuguese message", async () => {
    const { root } = await setup();
    await fs.writeFile(join(root, "plain-file"), "x");
    const path = join(root, "plain-file", "timesheet-context.json");
    await expect(addCatalogClient(path, { name: "Delta" })).rejects.toThrow(CLIENT_CATALOG_ERRORS.permission);
    expect((await readClientCatalog(path)).state).toBe("invalid");
  });

  test("every error message is listed for translation", () => {
    for (const message of Object.values(CLIENT_CATALOG_ERRORS)) expect(CLIENT_CATALOG_KNOWN_ERRORS).toContain(message);
    expect(CLIENT_CATALOG_ERRORS.invalid).toBe("O catálogo de clientes é inválido; corrija o arquivo antes de editar.");
  });
});

describe("nextClientCode", () => {
  test("continues the CLnnn sequence and skips taken codes", () => {
    const context = (codes: string[]) => ({ version: 1 as const, colleagues: [], taskTypes: [], clients: codes.map((code) => ({ code, name: code, aliases: [], responsibleNames: [] })) });
    expect(nextClientCode(context([]))).toBe("CL001");
    expect(nextClientCode(context(["CL009", "X"]))).toBe("CL010");
    expect(nextClientCode(context(["CL999"]))).toBe("CL1000");
  });
});
