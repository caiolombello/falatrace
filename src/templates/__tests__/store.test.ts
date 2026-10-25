import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigPath } from "../../config/load";
import { BUILT_IN_TEMPLATES, TEMPLATE_KNOWN_ERRORS, TEMPLATE_MESSAGES, TemplateValidationError, type SummaryTemplate } from "../catalog";
import {
  MAX_CUSTOM_TEMPLATES,
  MAX_TEMPLATE_FILE_BYTES,
  TemplateStore,
  defaultTemplatesDir,
  deleteCustomTemplate,
  getTemplate,
  inspectCustomTemplates,
  listTemplates,
  saveCustomTemplate,
  validateTemplateFile
} from "../store";

const template = (slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `custom:${slug}`,
  version: 1,
  builtIn: false,
  name: { "pt-BR": `Comitê ${slug}`, en: `Committee ${slug}`, es: `Comité ${slug}` },
  description: "Monthly risk committee that reviews open risks and mitigation owners.",
  titleKeywords: ["comite de riscos"],
  transcriptKeywords: ["apetite de risco"],
  sections: [
    { id: "risks", title: { "pt-BR": "Riscos", en: "Risks", es: "Riesgos" }, instruction: "Each open risk with its rating as stated." },
    { id: "incidents", title: { "pt-BR": "Incidentes", en: "Incidents", es: "Incidentes" }, instruction: "New incidents since the last committee." },
    { id: "owners", title: { "pt-BR": "Responsáveis", en: "Owners", es: "Responsables" }, instruction: "Mitigation owners and dates as stated." }
  ],
  guidance: "Keep risk ids exactly as said.",
  ...overrides
});

const storedFile = (slug: string, overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify({ version: 1, updatedAt: "2026-10-25T10:00:00.000Z", template: template(slug, overrides) }, null, 2)}\n`;

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
};

let root: string;
let dir: string;
let store: TemplateStore;
const clock = () => new Date("2026-10-25T12:34:56.000Z");

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "templates-"));
  dir = join(root, "config", "templates");
  store = new TemplateStore({ dir, now: clock });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("default location", () => {
  const defaultDir = defaultTemplatesDir();
  afterAll(async () => {
    await fs.rm(defaultDir, { recursive: true, force: true });
  });

  test("sits next to the active config file, inside the isolated XDG_CONFIG_HOME", async () => {
    expect(process.env.XDG_CONFIG_HOME).toBeTruthy();
    expect(defaultDir).toBe(join(dirname(getConfigPath()), "templates"));
    expect(defaultDir).toBe(join(process.env.XDG_CONFIG_HOME!, "recording-cli", "templates"));
    const saved = await saveCustomTemplate(template("padrao"));
    expect(saved.id).toBe("custom:padrao");
    const stat = await fs.stat(join(defaultDir, "padrao.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(defaultDir)).mode & 0o777).toBe(0o700);
    expect((await listTemplates()).map((item) => item.id)).toContain("custom:padrao");
    expect((await getTemplate("custom:padrao"))!.name.en).toBe("Committee padrao");
    expect((await inspectCustomTemplates()).problems).toEqual([]);
    expect(await deleteCustomTemplate("custom:padrao", { expectedVersion: 1 })).toBe(true);
    expect(await getTemplate("custom:padrao")).toBeUndefined();
  });

  test("follows XDG_CONFIG_HOME of the process that uses it", async () => {
    const config = join(root, "other-config");
    const script = `
      const { saveCustomTemplate, defaultTemplatesDir } = await import(${JSON.stringify(join(import.meta.dir, "..", "store.ts"))});
      await saveCustomTemplate(${JSON.stringify(template("filho"))});
      console.log(defaultTemplatesDir());
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: config, TMPDIR: process.env.TMPDIR },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(join(config, "recording-cli", "templates"));
    const file = validateTemplateFile(JSON.parse(await fs.readFile(join(config, "recording-cli", "templates", "filho.json"), "utf8")));
    expect(file.template.id).toBe("custom:filho");
  });
});

describe("custom templates", () => {
  test("no folder yet: only built-ins", async () => {
    expect(await store.list()).toEqual([...BUILT_IN_TEMPLATES]);
    expect(await store.inspect()).toEqual({ templates: [], problems: [] });
    expect(await store.get("custom:nada")).toBeUndefined();
    expect(await store.get("standup")).toBe(BUILT_IN_TEMPLATES[2]);
    expect(await store.remove("custom:nada")).toBe(false);
    await expect(fs.lstat(dir)).rejects.toThrow();
  });

  test("create, update with version check and delete", async () => {
    const created = await store.save(template("riscos", { version: 7 }));
    expect(created.version).toBe(1);
    expect(created.builtIn).toBe(false);
    const raw = JSON.parse(await fs.readFile(join(dir, "riscos.json"), "utf8"));
    expect(Object.keys(raw)).toEqual(["version", "updatedAt", "template"]);
    expect(raw.version).toBe(1);
    expect(raw.updatedAt).toBe("2026-10-25T12:34:56.000Z");
    expect(raw.template).toEqual(created);
    expect((await fs.stat(join(dir, "riscos.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);

    expect(await store.get("custom:riscos")).toEqual(created);
    const list = await store.list();
    expect(list.slice(0, BUILT_IN_TEMPLATES.length)).toEqual([...BUILT_IN_TEMPLATES]);
    expect(list[list.length - 1]).toEqual(created);

    const updated = await store.save(template("riscos", { description: "Quarterly risk committee." }), { expectedVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.description).toBe("Quarterly risk committee.");
    expect((await failure(store.save(template("riscos"), { expectedVersion: 1 }))).message).toBe(TEMPLATE_MESSAGES.conflict);
    expect((await failure(store.save(template("riscos")))).message).toBe(TEMPLATE_MESSAGES.exists);
    expect((await failure(store.remove("custom:riscos", { expectedVersion: 1 }))).message).toBe(TEMPLATE_MESSAGES.conflict);
    expect((await store.get("custom:riscos"))!.version).toBe(2);

    expect(await store.remove("custom:riscos", { expectedVersion: 2 })).toBe(true);
    expect(await store.remove("custom:riscos")).toBe(false);
    expect(await store.get("custom:riscos")).toBeUndefined();
    expect((await failure(store.save(template("riscos"), { expectedVersion: 2 }))).message).toBe(TEMPLATE_MESSAGES.missing);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("an existing folder with loose permissions is made private on save", async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.chmod(dir, 0o755);
    await store.save(template("privado"));
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(dir, "privado.json"))).mode & 0o777).toBe(0o600);
  });

  test("a file of exactly the size limit is read whole", async () => {
    await fs.mkdir(dir, { recursive: true });
    const text = storedFile("limite");
    await fs.writeFile(join(dir, "limite.json"), text + " ".repeat(MAX_TEMPLATE_FILE_BYTES - Buffer.byteLength(text)));
    expect((await fs.stat(join(dir, "limite.json"))).size).toBe(MAX_TEMPLATE_FILE_BYTES);
    expect((await store.get("custom:limite"))?.id).toBe("custom:limite");
    await fs.appendFile(join(dir, "limite.json"), " ");
    expect((await store.inspect()).problems).toEqual([{ file: "limite.json", reason: "too-large" }]);
  });

  test("custom templates are listed by id after the built-ins", async () => {
    await store.save(template("zeta"));
    await store.save(template("alfa"));
    await store.save(template("meio"));
    expect((await store.inspect()).templates.map((item) => item.id)).toEqual(["custom:alfa", "custom:meio", "custom:zeta"]);
  });

  test("built-ins cannot be changed or deleted", async () => {
    const standup = structuredClone(BUILT_IN_TEMPLATES[2]);
    expect((await failure(store.save(standup))).message).toBe(TEMPLATE_MESSAGES.builtInReadOnly);
    expect((await failure(store.save(template("x", { id: "risk", builtIn: true })))).message).toBe(TEMPLATE_MESSAGES.customIdRequired);
    expect((await failure(store.remove("standup"))).message).toBe(TEMPLATE_MESSAGES.builtInReadOnly);
    for (const id of ["risk", "custom:../x", "custom:", "", 5 as unknown as string]) {
      expect((await failure(store.remove(id))).message).toBe(TEMPLATE_MESSAGES.invalidId);
    }
    expect(await store.get("custom:../x")).toBeUndefined();
    expect(await store.get(5 as unknown as string)).toBeUndefined();
  });

  test("invalid templates and versions are refused before touching the disk", async () => {
    const invalid = await failure(store.save({ id: "custom:x" }));
    expect(invalid).toBeInstanceOf(TemplateValidationError);
    expect(TEMPLATE_KNOWN_ERRORS).toContain(invalid.message);
    for (const expectedVersion of [0, -1, 1.5, "1" as unknown as number, Number.MAX_SAFE_INTEGER]) {
      expect((await failure(store.save(template("x"), { expectedVersion }))).message).toBe(TEMPLATE_MESSAGES.invalid);
      expect((await failure(store.remove("custom:x", { expectedVersion }))).message).toBe(TEMPLATE_MESSAGES.invalid);
    }
    await expect(fs.lstat(dir)).rejects.toThrow();
  });

  test("at most 100 custom templates", async () => {
    await fs.mkdir(dir, { recursive: true });
    for (let index = 0; index < MAX_CUSTOM_TEMPLATES; index++) {
      const slug = `t${String(index).padStart(3, "0")}`;
      await fs.writeFile(join(dir, `${slug}.json`), storedFile(slug));
    }
    expect((await store.inspect()).templates.length).toBe(MAX_CUSTOM_TEMPLATES);
    expect((await failure(store.save(template("novo")))).message).toBe(TEMPLATE_MESSAGES.limit);
    // Updating an existing one still works at the limit.
    expect((await store.save(template("t000"), { expectedVersion: 1 })).version).toBe(2);
    await fs.writeFile(join(dir, "zz1.json"), storedFile("zz1"));
    await fs.writeFile(join(dir, "zz2.json"), storedFile("zz2"));
    const inspected = await store.inspect();
    expect(inspected.templates.length).toBe(MAX_CUSTOM_TEMPLATES);
    expect(inspected.problems).toEqual([{ file: "zz1.json", reason: "over-limit" }, { file: "zz2.json", reason: "over-limit" }]);
  });
});

describe("untrusted files", () => {
  test("broken files are skipped and reported; other names are ignored", async () => {
    await fs.mkdir(dir, { recursive: true });
    const outside = join(root, "outside.json");
    await fs.writeFile(outside, storedFile("link"));
    await fs.writeFile(join(dir, "ok.json"), storedFile("ok"));
    await fs.writeFile(join(dir, "broken.json"), "{ not json");
    await fs.writeFile(join(dir, "old.json"), storedFile("old").replace('"version": 1,', '"version": 2,'));
    await fs.writeFile(join(dir, "extra.json"), JSON.stringify({ version: 1, updatedAt: "2026-10-25T10:00:00.000Z", template: template("extra"), more: 1 }));
    await fs.writeFile(join(dir, "badtpl.json"), storedFile("badtpl", { sections: [] }));
    await fs.writeFile(join(dir, "builtin.json"), JSON.stringify({ version: 1, updatedAt: "2026-10-25T10:00:00.000Z", template: BUILT_IN_TEMPLATES[0] }));
    await fs.writeFile(join(dir, "mismatch.json"), storedFile("other"));
    await fs.writeFile(join(dir, "huge.json"), " ".repeat(MAX_TEMPLATE_FILE_BYTES + 1));
    await fs.symlink(outside, join(dir, "link.json"));
    await fs.mkdir(join(dir, "folder.json"));
    expect(Bun.spawnSync(["mkfifo", join(dir, "fifo.json")]).exitCode).toBe(0);
    for (const ignored of ["README.md", ".hidden.json", "UPPER.json", "ok.json.bak", ".x.tmp"]) await fs.writeFile(join(dir, ignored), "x");

    const { templates, problems } = await store.inspect();
    expect(templates.map((item) => item.id)).toEqual(["custom:ok"]);
    expect(problems).toEqual([
      { file: "badtpl.json", reason: "invalid-template" },
      { file: "broken.json", reason: "invalid-json" },
      { file: "builtin.json", reason: "invalid-template" },
      { file: "extra.json", reason: "invalid-template" },
      { file: "fifo.json", reason: "not-a-file" },
      { file: "folder.json", reason: "not-a-file" },
      { file: "huge.json", reason: "too-large" },
      { file: "link.json", reason: "not-a-file" },
      { file: "mismatch.json", reason: "id-mismatch" },
      { file: "old.json", reason: "invalid-template" }
    ]);
    expect((await store.list()).length).toBe(BUILT_IN_TEMPLATES.length + 1);
    for (const id of ["custom:broken", "custom:link", "custom:fifo", "custom:huge"]) {
      expect((await failure(store.get(id))).message).toBe(TEMPLATE_MESSAGES.invalidFile);
    }
  });

  test("a symlink in place of a template is never followed or overwritten", async () => {
    await fs.mkdir(dir, { recursive: true });
    const outside = join(root, "victim.json");
    await fs.writeFile(outside, "do not touch");
    await fs.symlink(outside, join(dir, "alvo.json"));
    expect((await failure(store.save(template("alvo")))).message).toBe(TEMPLATE_MESSAGES.exists);
    expect((await failure(store.save(template("alvo"), { expectedVersion: 1 }))).message).toBe(TEMPLATE_MESSAGES.invalidFile);
    expect((await failure(store.remove("custom:alvo", { expectedVersion: 1 }))).message).toBe(TEMPLATE_MESSAGES.invalidFile);
    expect(await fs.readFile(outside, "utf8")).toBe("do not touch");
    // Deleting removes the link itself, never its target.
    expect(await store.remove("custom:alvo")).toBe(true);
    await expect(fs.lstat(join(dir, "alvo.json"))).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("do not touch");
  });

  test("a folder in place of a template is never removed", async () => {
    await fs.mkdir(join(dir, "pasta.json"), { recursive: true });
    expect((await failure(store.remove("custom:pasta"))).message).toBe(TEMPLATE_MESSAGES.invalidFile);
    expect((await fs.lstat(join(dir, "pasta.json"))).isDirectory()).toBe(true);
  });

  test("a broken file can still be deleted, but not updated", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "ruim.json"), "{");
    expect((await failure(store.save(template("ruim"), { expectedVersion: 1 }))).message).toBe(TEMPLATE_MESSAGES.invalidFile);
    expect(await store.remove("custom:ruim")).toBe(true);
  });

  test("an unsafe templates folder is refused", async () => {
    const real = join(root, "real-templates");
    await fs.mkdir(real, { recursive: true });
    await fs.writeFile(join(real, "ok.json"), storedFile("ok"));
    await fs.mkdir(dirname(dir), { recursive: true });
    await fs.symlink(real, dir);
    expect(await store.inspect()).toEqual({ templates: [], problems: [{ file: ".", reason: "unsafe-directory" }] });
    expect(await store.list()).toEqual([...BUILT_IN_TEMPLATES]);
    expect(await store.get("custom:ok")).toBeUndefined();
    expect((await failure(store.save(template("novo")))).message).toBe(TEMPLATE_MESSAGES.unsafeDirectory);
    expect((await failure(store.remove("custom:ok"))).message).toBe(TEMPLATE_MESSAGES.unsafeDirectory);
    expect(await fs.readdir(real)).toEqual(["ok.json"]);

    await fs.unlink(dir);
    await fs.writeFile(dir, "not a folder");
    expect((await store.inspect()).problems).toEqual([{ file: ".", reason: "unsafe-directory" }]);
    expect((await failure(store.save(template("novo")))).message).toBe(TEMPLATE_MESSAGES.unsafeDirectory);
    expect(await fs.readFile(dir, "utf8")).toBe("not a folder");
  });

  test("a file where a parent folder should be never breaks listing", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "config"), "not a folder");
    // dir is <root>/config/templates, so every lstat fails with ENOTDIR.
    expect(await store.inspect()).toEqual({ templates: [], problems: [{ file: ".", reason: "unsafe-directory" }] });
    expect(await store.list()).toEqual([...BUILT_IN_TEMPLATES]);
    expect(await store.get("custom:x")).toBeUndefined();
    expect(await store.get("standup")).toBe(BUILT_IN_TEMPLATES[2]);
    expect((await failure(store.save(template("novo")))).message).toBe(TEMPLATE_MESSAGES.unsafeDirectory);
    expect((await failure(store.remove("custom:x"))).message).toBe(TEMPLATE_MESSAGES.unsafeDirectory);
    expect(await fs.readFile(join(root, "config"), "utf8")).toBe("not a folder");
  });

  test("validateTemplateFile is strict", () => {
    const valid = JSON.parse(storedFile("x"));
    expect(validateTemplateFile(valid).template.id).toBe("custom:x");
    for (const bad of [null, [], { ...valid, version: 2 }, { ...valid, extra: 1 }, { ...valid, updatedAt: "ontem" }, { ...valid, updatedAt: "x".repeat(41) },
      { ...valid, template: { ...valid.template, builtIn: true } }, { version: 1, updatedAt: valid.updatedAt, template: BUILT_IN_TEMPLATES[0] }]) {
      expect(() => validateTemplateFile(bad)).toThrow();
    }
  });
});

describe("concurrency", () => {
  test("two windows saving the same version: exactly one wins", async () => {
    await store.save(template("disputa"));
    const writers = Array.from({ length: 6 }, (_value, index) =>
      new TemplateStore({ dir }).save(template("disputa", { description: `Edited by window ${index}.` }), { expectedVersion: 1 }));
    const results = await Promise.allSettled(writers);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.map((result) => (result.reason as Error).message)).toEqual(Array(5).fill(TEMPLATE_MESSAGES.conflict));
    const stored = (await store.get("custom:disputa")) as SummaryTemplate;
    expect(stored.version).toBe(2);
    expect(stored.description).toBe((fulfilled[0] as PromiseFulfilledResult<SummaryTemplate>).value.description);
  });

  test("two windows creating the same id: exactly one wins", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => new TemplateStore({ dir }).save(template("novo"))));
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => ((result as PromiseRejectedResult).reason as Error).message))
      .toEqual(Array(3).fill(TEMPLATE_MESSAGES.exists));
  });

  test("a lock that stays busy gives a clear message", async () => {
    const busy = new TemplateStore({ dir, lockTimeoutMs: 60, lock: async (name) => { throw new Error(`${name} is already running`); } });
    expect((await failure(busy.save(template("x")))).message).toBe(TEMPLATE_MESSAGES.busy);
    expect((await failure(busy.remove("custom:x"))).message).toBe(TEMPLATE_MESSAGES.busy);
    const broken = new TemplateStore({ dir, lock: async () => { throw new Error("socket failure"); } });
    expect((await failure(broken.save(template("x")))).message).toBe("socket failure");
  });

  test("the lock is released after failures and is scoped to the folder", async () => {
    const names: string[] = [];
    let held = 0;
    const counting = new TemplateStore({
      dir,
      lock: async (name) => {
        names.push(name);
        held += 1;
        return { release: async () => { held -= 1; } };
      }
    });
    await counting.save(template("a"));
    await failure(counting.save(template("a")));
    await failure(counting.save(template("a"), { expectedVersion: 9 }));
    await counting.remove("custom:a");
    expect(held).toBe(0);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toMatch(/^templates-[a-f0-9]{24}$/);
    const other = new TemplateStore({ dir: join(root, "elsewhere"), lock: async (name) => { names.push(name); return { release: async () => undefined }; } });
    await other.save(template("b"));
    expect(new Set(names).size).toBe(2);
  });
});
