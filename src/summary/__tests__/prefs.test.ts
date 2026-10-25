import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUMMARY_PREFS_ERRORS, SUMMARY_PREFS_KNOWN_ERRORS, SummaryPrefsConflictError, SummaryPrefsStore, clearSummaryPrefsIndexCache,
  defaultSummaryPrefsDir, findSummaryPrefsForJob, validateSummaryPrefs
} from "../prefs";

const roots: string[] = [];
afterEach(async () => {
  clearSummaryPrefsIndexCache();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "summary-prefs-"));
  roots.push(root);
  return { root, store: new SummaryPrefsStore(join(root, "prefs")) };
};
const ID = "123e4567-e89b-42d3-a456-426614174000";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 12, minute));

test("saves private choices with a revision check and reads them back", async () => {
  const { root, store } = await fixture();
  expect(await store.read(ID)).toBeUndefined();
  const saved = await store.save(ID, { expectedRev: 0, templateId: "one-on-one", language: "en", sourcePath: join(root, "a.mkv"), now: at(1) });
  expect(saved).toEqual({ version: 1, id: ID, rev: 1, templateId: "one-on-one", language: "en", updatedAt: at(1).toISOString(), sourcePath: join(root, "a.mkv") });
  expect(await store.read(ID.toUpperCase())).toEqual(saved);
  expect((await fs.stat(store.pathFor(ID))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
  const before = await fs.readFile(store.pathFor(ID), "utf8");
  const conflict = store.save(ID, { expectedRev: 0, templateId: "standup" });
  await expect(conflict).rejects.toBeInstanceOf(SummaryPrefsConflictError);
  await expect(store.save(ID, { expectedRev: 0, templateId: "standup" })).rejects.toThrow(SUMMARY_PREFS_ERRORS.conflict);
  expect(await fs.readFile(store.pathFor(ID), "utf8")).toBe(before);
  // An unchanged save writes nothing.
  const stat = await fs.stat(store.pathFor(ID));
  expect(await store.save(ID, { expectedRev: 1, templateId: "one-on-one", language: "en", now: at(2) })).toEqual(saved);
  const after = await fs.stat(store.pathFor(ID));
  expect([after.ino, after.mtimeMs]).toEqual([stat.ino, stat.mtimeMs]);
  // "auto" clears a choice; the recording path is kept when not given.
  const cleared = await store.save(ID, { expectedRev: 1, templateId: "auto", language: "auto", now: at(3) });
  expect(cleared).toEqual({ version: 1, id: ID, rev: 2, updatedAt: at(3).toISOString(), sourcePath: join(root, "a.mkv") });
  expect(await store.remove(ID)).toBe(true);
  expect(await store.remove(ID)).toBe(false);
  // Nothing chosen and nothing stored: no file.
  expect((await store.save(ID, { expectedRev: 0, templateId: "auto" })).rev).toBe(0);
  expect(await fs.access(store.pathFor(ID)).then(() => true, () => false)).toBe(false);
});

test("invalid choices are refused with known messages and write nothing", async () => {
  const { root, store } = await fixture();
  const cases: Array<[() => Promise<unknown>, string]> = [
    [() => store.save("not-a-uuid", { expectedRev: 0, templateId: "general" }), SUMMARY_PREFS_ERRORS.invalidId],
    [() => store.save(ID, { expectedRev: -1, templateId: "general" }), SUMMARY_PREFS_ERRORS.invalidRev],
    [() => store.save(ID, { expectedRev: 0.5, templateId: "general" }), SUMMARY_PREFS_ERRORS.invalidRev],
    [() => store.save(ID, { expectedRev: 0, templateId: "Bad Template" }), SUMMARY_PREFS_ERRORS.invalidTemplate],
    [() => store.save(ID, { expectedRev: 0, templateId: "custom:" }), SUMMARY_PREFS_ERRORS.invalidTemplate],
    [() => store.save(ID, { expectedRev: 0, language: "fr" as never }), SUMMARY_PREFS_ERRORS.invalidLanguage],
    [() => store.save(ID, { expectedRev: 0, sourcePath: "relative.mkv" }), SUMMARY_PREFS_ERRORS.invalidSourcePath],
    [() => store.save(ID, { expectedRev: 0, sourcePath: join(root, "bad\nname.mkv") }), SUMMARY_PREFS_ERRORS.invalidSourcePath],
    [() => store.save(ID, { expectedRev: 0, templateId: "general", now: new Date(Number.NaN) }), SUMMARY_PREFS_ERRORS.invalidTime]
  ];
  for (const [run, message] of cases) {
    await expect(run()).rejects.toThrow(message);
    expect(SUMMARY_PREFS_KNOWN_ERRORS).toContain(message);
  }
  expect(await fs.access(store.root).then(() => true, () => false)).toBe(false);
  expect(new Set(SUMMARY_PREFS_KNOWN_ERRORS).size).toBe(SUMMARY_PREFS_KNOWN_ERRORS.length);
  for (const message of SUMMARY_PREFS_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].+\.$/);
});

test("damaged, linked or unsafe files are refused and kept as they are", async () => {
  const { root, store } = await fixture();
  await store.save(ID, { expectedRev: 0, templateId: "general" });
  const path = store.pathFor(ID);
  for (const raw of ["{", "[]", JSON.stringify({ version: 2, id: ID, rev: 1, updatedAt: at(0).toISOString() }),
    JSON.stringify({ version: 1, id: ID, rev: 1, updatedAt: at(0).toISOString(), extra: true }),
    JSON.stringify({ version: 1, id: ID, rev: 0, updatedAt: at(0).toISOString() }),
    JSON.stringify({ version: 1, id: ID, rev: 1, updatedAt: at(0).toISOString(), language: "auto" }),
    JSON.stringify({ version: 1, id: randomUUID(), rev: 1, updatedAt: at(0).toISOString() }), "x".repeat(17 * 1024)]) {
    await fs.writeFile(path, raw, { mode: 0o600 });
    await expect(store.read(ID)).rejects.toThrow(SUMMARY_PREFS_ERRORS.corrupted);
    await expect(store.save(ID, { expectedRev: 1, templateId: "standup" })).rejects.toThrow(SUMMARY_PREFS_ERRORS.corrupted);
    expect(await fs.readFile(path, "utf8")).toBe(raw);
  }
  await fs.rm(path);
  const target = join(root, "target.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, id: ID, rev: 1, updatedAt: at(0).toISOString() }));
  await fs.symlink(target, path);
  await expect(store.read(ID)).rejects.toThrow(SUMMARY_PREFS_ERRORS.unsafeFile);
  await fs.rm(path);
  await fs.chmod(store.root, 0o755);
  await expect(store.read(ID)).rejects.toThrow(SUMMARY_PREFS_ERRORS.unsafeDir);
  const linked = new SummaryPrefsStore(join(root, "linked"));
  await fs.symlink(store.root, linked.root);
  await expect(linked.read(ID)).rejects.toThrow(SUMMARY_PREFS_ERRORS.unsafeDir);
  expect(() => validateSummaryPrefs({ version: 1, id: ID, rev: 1, updatedAt: "yesterday" })).toThrow(SUMMARY_PREFS_ERRORS.corrupted);
});

test("parallel saves on one revision: exactly one wins", async () => {
  const { store } = await fixture();
  const results = await Promise.allSettled(["general", "standup", "planning", "retrospective"].map((templateId) => store.save(ID, { expectedRev: 0, templateId })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SummaryPrefsConflictError);
  expect((await store.read(ID))?.rev).toBe(1);
});

test("a job finds its choices by id, else by its recording file; other recordings never match", async () => {
  const { root, store } = await fixture();
  const source = join(root, "rec-1.mkv");
  const jobId = randomUUID();
  expect(await findSummaryPrefsForJob({ id: jobId, sourcePath: source }, store)).toBeUndefined();
  const older = randomUUID(), newer = randomUUID(), other = randomUUID(), damaged = randomUUID();
  await store.save(older, { expectedRev: 0, templateId: "standup", sourcePath: source, now: at(1) });
  await store.save(newer, { expectedRev: 0, templateId: "planning", sourcePath: source, now: at(2) });
  await store.save(other, { expectedRev: 0, templateId: "postmortem", sourcePath: join(root, "rec-2.mkv"), now: at(3) });
  await fs.writeFile(store.pathFor(damaged), "{", { mode: 0o600 });
  expect((await findSummaryPrefsForJob({ id: jobId, sourcePath: source }, store))?.templateId).toBe("planning");
  expect(await findSummaryPrefsForJob({ id: jobId, sourcePath: join(root, "rec-3.mkv") }, store)).toBeUndefined();
  // The job's own choices win; its own damaged file is reported.
  await store.save(jobId, { expectedRev: 0, language: "es" });
  expect((await findSummaryPrefsForJob({ id: jobId, sourcePath: source }, store))?.language).toBe("es");
  await expect(findSummaryPrefsForJob({ id: damaged, sourcePath: source }, store)).rejects.toThrow(SUMMARY_PREFS_ERRORS.corrupted);
  // A changed file is re-read (cache refreshed by file identity).
  await store.save(newer, { expectedRev: 1, templateId: "planning", sourcePath: join(root, "moved.mkv"), now: at(4) });
  expect((await findSummaryPrefsForJob({ id: randomUUID(), sourcePath: source }, store))?.templateId).toBe("standup");
});

test("default folder is under XDG_DATA_HOME", () => {
  expect(defaultSummaryPrefsDir()).toBe(join(process.env.XDG_DATA_HOME!, "recording-cli", "summary-prefs"));
});
