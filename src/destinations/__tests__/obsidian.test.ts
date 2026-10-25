import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_MESSAGES, SHARE_WARNINGS, renderShare, renderTextShare, type ShareNote } from "../../share/render";
import { DeliveryLog } from "../log";
import { deliverObsidian, obsidianFileName, obsidianFolderParts, obsidianOpenUrl, sanitizeFileNamePart } from "../obsidian";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const OTHER_JOB = "11111111-2222-4333-8444-555555555555";

const note = (overrides: Partial<ShareNote> = {}): ShareNote => ({
  jobId: JOB,
  title: "Weekly sync",
  date: "2026-10-25T14:05:00.000Z",
  people: ["Ana"],
  overview: "All good.",
  decisions: ["Ship it"],
  actions: [],
  link: `falatrace://recording/${JOB}`,
  ...overrides
});

const share = (overrides: Partial<ShareNote> = {}) =>
  renderShare(note(overrides), { frontmatter: false, language: "pt-BR", include: "summary", timeZone: "UTC" });

let root: string;
let vault: string;
let log: DeliveryLog;
const EXPECTED_NAME = "2026-10-25 14-05 — Weekly sync.md";

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-obsidian-"));
  vault = join(root, "vault");
  await fs.mkdir(vault);
  log = new DeliveryLog({ dir: join(root, "log") });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const deliver = (content = share(), extra: Partial<Parameters<typeof deliverObsidian>[0]> = {}, deps: Parameters<typeof deliverObsidian>[1] = {}) =>
  deliverObsidian({ share: content, vault, folder: "FalaTrace", timeZone: "UTC", ...extra }, { log, ...deps });

describe("deliverObsidian", () => {
  test("creates the note with frontmatter, 0644, in a new folder", async () => {
    const content = share();
    const receipt = await deliver(content);
    const path = join(vault, "FalaTrace", EXPECTED_NAME);
    expect(receipt).toMatchObject({ destination: "obsidian", result: "created", location: path, target: path, warnings: [] });
    expect(await fs.readFile(path, "utf8")).toBe(content.document);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o644 & ~process.umask());
    expect((await fs.stat(join(vault, "FalaTrace"))).isDirectory()).toBe(true);
    expect((await log.read(JOB))[0]).toMatchObject({ destination: "obsidian", result: "created", target: path });
  });

  test("the same content again is reused, never rewritten", async () => {
    await deliver();
    const path = join(vault, "FalaTrace", EXPECTED_NAME);
    const before = await fs.stat(path);
    const receipt = await deliver();
    expect(receipt.result).toBe("reused");
    expect(receipt.location).toBe(path);
    expect((await fs.stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(join(vault, "FalaTrace"))).toEqual([EXPECTED_NAME]);
  });

  test("an untouched earlier delivery of the same recording is replaced atomically", async () => {
    await deliver();
    const updated = share({ overview: "Changed summary." });
    const receipt = await deliver(updated);
    const path = join(vault, "FalaTrace", EXPECTED_NAME);
    expect(receipt.result).toBe("replaced");
    expect(await fs.readFile(path, "utf8")).toBe(updated.document);
    expect(await fs.readdir(join(vault, "FalaTrace"))).toEqual([EXPECTED_NAME]);
    // A third version replaces the second, because the log now holds the second's hash.
    expect((await deliver(share({ overview: "Third." }))).result).toBe("replaced");
  });

  test("a note the user edited is never overwritten: the new version goes to (2)", async () => {
    await deliver();
    const path = join(vault, "FalaTrace", EXPECTED_NAME);
    const edited = `${await fs.readFile(path, "utf8")}\nMy own remark.\n`;
    await fs.writeFile(path, edited);
    const updated = share({ overview: "Changed summary." });
    const receipt = await deliver(updated);
    expect(receipt.result).toBe("created");
    expect(receipt.location).toBe(join(vault, "FalaTrace", "2026-10-25 14-05 — Weekly sync (2).md"));
    expect(await fs.readFile(path, "utf8")).toBe(edited);
  });

  test("without a delivery record the existing file is kept", async () => {
    await deliverObsidian({ share: share(), vault, folder: "FalaTrace", timeZone: "UTC" }, {});
    const receipt = await deliver(share({ overview: "Changed summary." }));
    expect(receipt.result).toBe("created");
    expect(receipt.location?.endsWith("(2).md")).toBe(true);
  });

  test("a file of another recording or a user note with the same name is kept", async () => {
    const folder = join(vault, "FalaTrace");
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, EXPECTED_NAME), "# My own note\n");
    const first = await deliver();
    expect(first.location?.endsWith("(2).md")).toBe(true);
    expect(await fs.readFile(join(folder, EXPECTED_NAME), "utf8")).toBe("# My own note\n");
    const other = renderShare(note({ jobId: OTHER_JOB, link: `falatrace://recording/${OTHER_JOB}` }), { frontmatter: false, language: "pt-BR", include: "summary", timeZone: "UTC" });
    const second = await deliver(other);
    expect(second.location?.endsWith("(3).md")).toBe(true);
  });

  test("a symlink at the target name is never followed or replaced", async () => {
    const folder = join(vault, "FalaTrace");
    await fs.mkdir(folder);
    const outside = join(root, "outside.md");
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, join(folder, EXPECTED_NAME));
    const receipt = await deliver();
    expect(receipt.location?.endsWith("(2).md")).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("secret");
  });

  test("concurrent deliveries of different content never clobber each other", async () => {
    const shares = Array.from({ length: 5 }, (_, index) => share({ overview: `Version ${index}` }));
    const receipts = await Promise.all(shares.map((content) => deliverObsidian({ share: content, vault, folder: "FalaTrace", timeZone: "UTC" }, { log: new DeliveryLog({ dir: join(root, "log") }) })));
    // Serialized by the lock: one creation, then each version replaces the untouched previous one.
    expect(receipts.map((receipt) => receipt.result).sort()).toEqual(["created", "replaced", "replaced", "replaced", "replaced"]);
    const files = await fs.readdir(join(vault, "FalaTrace"));
    expect(files).toEqual([EXPECTED_NAME]);
    const text = await fs.readFile(join(vault, "FalaTrace", EXPECTED_NAME), "utf8");
    expect(shares.some((content) => content.document === text)).toBe(true);
    expect((await log.read(JOB)).length).toBe(5);
  });

  test("opens the note through obsidian://open?path=, and only warns when that fails", async () => {
    const opened: string[] = [];
    const receipt = await deliver(share(), { open: true }, { openUrl: async (url) => { opened.push(url); } });
    expect(opened).toEqual([obsidianOpenUrl(receipt.location as string)]);
    expect(opened[0]).toBe(`obsidian://open?path=${encodeURIComponent(join(vault, "FalaTrace", EXPECTED_NAME))}`);
    expect(opened[0]).not.toContain("/vault/");
    const failed = await deliver(share({ overview: "Other" }), { open: true }, { openUrl: async () => { throw new Error("no handler"); } });
    expect(failed.warnings).toEqual([SHARE_WARNINGS.obsidianNotOpened]);
  });

  test("library results (no recording) are written and reused, never replaced", async () => {
    const text = renderTextShare({ title: "What did I promise?", text: "- Send deck", language: "en", date: "2026-10-25T10:00:00Z" });
    const first = await deliver(text);
    expect(first.result).toBe("created");
    expect((await deliver(text)).result).toBe("reused");
    const changed = renderTextShare({ title: "What did I promise?", text: "- Send deck\n- Call Ana", language: "en", date: "2026-10-25T10:00:00Z" });
    expect((await deliver(changed)).location?.endsWith("(2).md")).toBe(true);
    expect((await log.read("library")).length).toBe(3);
  });

  test("vault must be an existing real folder", async () => {
    await expect(deliver(share(), { vault: "" })).rejects.toThrow(SHARE_MESSAGES.obsidianNotConfigured);
    await expect(deliver(share(), { vault: "relative/vault" })).rejects.toThrow(SHARE_MESSAGES.obsidianVaultInvalid);
    await expect(deliver(share(), { vault: join(root, "missing") })).rejects.toThrow(SHARE_MESSAGES.obsidianVaultInvalid);
    await fs.writeFile(join(root, "file"), "x");
    await expect(deliver(share(), { vault: join(root, "file") })).rejects.toThrow(SHARE_MESSAGES.obsidianVaultInvalid);
    await fs.symlink(vault, join(root, "vault-link"));
    await expect(deliver(share(), { vault: join(root, "vault-link") })).rejects.toThrow(SHARE_MESSAGES.obsidianVaultInvalid);
  });

  test("folder traversal and symlinked folders are refused", async () => {
    for (const folder of ["../outside", "a/../../b", "/abs", "a//b", "./a", "a\nb", " a"]) {
      await expect(deliver(share(), { folder })).rejects.toThrow(SHARE_MESSAGES.obsidianFolderInvalid);
    }
    const outside = join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, join(vault, "Linked"));
    await expect(deliver(share(), { folder: "Linked/Notes" })).rejects.toThrow(SHARE_MESSAGES.obsidianFolderInvalid);
    expect(await fs.readdir(outside)).toEqual([]);
    const receipt = await deliver(share(), { folder: "" });
    expect(receipt.location).toBe(join(vault, EXPECTED_NAME));
    const nested = await deliver(share({ overview: "x" }), { folder: "Work/Meetings/" });
    expect(nested.location).toBe(join(vault, "Work", "Meetings", EXPECTED_NAME));
  });

  test("gives up after 99 candidate names", async () => {
    const folder = join(vault, "FalaTrace");
    await fs.mkdir(folder);
    for (let index = 1; index <= 99; index += 1) {
      await fs.writeFile(join(folder, obsidianFileName(share(), index, "UTC")), "user note");
    }
    await expect(deliver()).rejects.toThrow(SHARE_MESSAGES.obsidianNoFreeName);
  });
});

describe("file names", () => {
  test("follow <YYYY-MM-DD HH-mm — title>.md in the given zone", () => {
    expect(obsidianFileName(share(), 1, "UTC")).toBe(EXPECTED_NAME);
    expect(obsidianFileName(share(), 2, "America/Sao_Paulo")).toBe("2026-10-25 11-05 — Weekly sync (2).md");
  });

  test("path separators, traversal, control and invisible characters are removed", () => {
    const hostile = share({ title: "../../etc/passwd\u0000\u202Egnp.exe\u200B: a*b?c\"d<e>f|g#h^i[j]k\\l\nm" });
    const name = obsidianFileName(hostile, 1, "UTC");
    expect(name).toBe("2026-10-25 14-05 — etc passwd gnp.exe a b c d e f g h i j k l m.md");
    expect(name).not.toMatch(/[/\\\u202E\u200B]|\p{Cc}/u);
    expect(sanitizeFileNamePart("...hidden")).toBe("hidden");
    expect(sanitizeFileNamePart("  ..  ")).toBe("");
    expect(sanitizeFileNamePart("trailing dots...")).toBe("trailing dots");
  });

  test("an empty or dot-only title uses the localized fallback", () => {
    expect(obsidianFileName(share({ title: "../.." }), 1, "UTC")).toBe("2026-10-25 14-05 — Reunião sem título.md");
  });

  test("names are at most 120 characters and 240 bytes, suffix included", () => {
    const long = share({ title: "A".repeat(300) });
    for (const candidate of [1, 2, 10, 99]) {
      const name = obsidianFileName(long, candidate, "UTC");
      expect(name.length).toBeLessThanOrEqual(120);
      expect(name.endsWith(candidate > 1 ? ` (${candidate}).md` : "A.md")).toBe(true);
    }
    const wide = share({ title: "😀".repeat(200) });
    const name = obsidianFileName(wide, 1, "UTC");
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(240);
    expect(name.endsWith(".md")).toBe(true);
    expect(name).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
  });

  test("folder parts", () => {
    expect(obsidianFolderParts("")).toEqual([]);
    expect(obsidianFolderParts("FalaTrace")).toEqual(["FalaTrace"]);
    expect(obsidianFolderParts("Work/Meetings/")).toEqual(["Work", "Meetings"]);
    expect(() => obsidianFolderParts("a/./b")).toThrow(SHARE_MESSAGES.obsidianFolderInvalid);
  });
});
