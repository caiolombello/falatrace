import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import { deriveMeetingTitle } from "../../jobs/types";
import { TimeEntryStore } from "../../timesheet/store";
import { buildAiContextFiles, getClientAiContextPath, renderClientContext } from "../context";

const blue = { code: "project:blue", name: "Synthetic Blue", aliases: [], responsibleNames: [] };
const other = { code: "CL002", name: "Synthetic Other", aliases: [], responsibleNames: [] };
const owned = renderClientContext(blue, [], { maxMeetings: 10, maxCharacters: 8000, generatedAt: "2026-01-01" }).content;

const fixture = async (run: (f: any) => Promise<void>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "alpha6-cleanup-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.processing.defaultTarget = "local";
    config.timesheet.contextPath = join(root, "catalog.json");
    await fs.writeFile(config.timesheet.contextPath, JSON.stringify({ version: 1, clients: [blue, other], colleagues: [], taskTypes: [] }));
    const outputDir = join(root, "memory");
    const clients = join(outputDir, "clients");
    await fs.mkdir(clients, { recursive: true });
    const jobStore = new JobStore(join(root, "jobs"), join(root, "job-data"));
    const timeStore = new TimeEntryStore(join(root, "entries"));
    const build = (client?: string) => buildAiContextFiles(config, { outputDir, jobStore, timeStore, client });
    await run({ root, config, outputDir, clients, jobStore, timeStore, build });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test("cleanup preserves unmarked managed-looking files outside and inside the catalog", async () => fixture(async f => {
  const unknown = join(f.clients, `client-${"a".repeat(64)}.md`);
  const current = await getClientAiContextPath(f.config, blue.code, f.outputDir);
  const notes = join(f.clients, "notes.md");
  for (const path of [unknown, current, notes]) await fs.writeFile(path, `Private synthetic note: ${basename(path)}`);
  const before = await Promise.all([unknown, current, notes].map(path => fs.readFile(path)));
  await f.build();
  for (const [i, path] of [unknown, current, notes].entries()) expect(await fs.readFile(path)).toEqual(before[i]);
}));

test("cleanup removes explicitly generated stale contexts in both filename schemes", async () => fixture(async f => {
  const current = await getClientAiContextPath(f.config, blue.code, f.outputDir);
  const legacy = join(f.clients, "CL002.md");
  const obsolete = join(f.clients, `client-${"b".repeat(64)}.md`);
  for (const path of [current, legacy, obsolete]) await fs.writeFile(path, owned);
  await f.build();
  for (const path of [current, legacy, obsolete]) expect(await fs.lstat(path).then(() => true, () => false)).toBe(false);
}));

test("an unreadable unknown context is preserved without aborting the build", async () => fixture(async f => {
  const unknown = join(f.clients, `client-${"1".repeat(64)}.md`);
  const text = "Unrelated synthetic private note";
  await fs.writeFile(unknown, text, { mode: 0o000 });
  const report = await f.build();
  expect(report.clients).toHaveLength(0);
  expect((await fs.lstat(unknown)).mode & 0o777).toBe(0);
  await fs.chmod(unknown, 0o600);
  expect(await fs.readFile(unknown, "utf8")).toBe(text);
}));

test("cleanup preserves symlinks, their targets, directories and partial markers", async () => fixture(async f => {
  const target = join(f.root, "generated-target.md");
  const link = join(f.clients, `client-${"c".repeat(64)}.md`);
  const directory = join(f.clients, `client-${"d".repeat(64)}.md`);
  const partial = join(f.clients, `client-${"e".repeat(64)}.md`);
  await fs.writeFile(target, owned);
  await fs.symlink(target, link);
  await fs.mkdir(directory);
  await fs.writeFile(partial, owned.split("\n")[0]!);
  await f.build();
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(target, "utf8")).toBe(owned);
  expect((await fs.lstat(directory)).isDirectory()).toBe(true);
  expect(await fs.readFile(partial, "utf8")).toBe(owned.split("\n")[0]!);
}));

test("filtered cleanup preserves contexts belonging to other clients", async () => fixture(async f => {
  const selected = await getClientAiContextPath(f.config, blue.code, f.outputDir);
  const legacy = join(f.clients, "CL002.md");
  const obsolete = join(f.clients, `client-${"f".repeat(64)}.md`);
  for (const path of [selected, legacy, obsolete]) await fs.writeFile(path, owned);
  await f.build(blue.code);
  expect(await fs.lstat(selected).then(() => true, () => false)).toBe(false);
  expect(await fs.readFile(legacy, "utf8")).toBe(owned);
  expect(await fs.readFile(obsolete, "utf8")).toBe(owned);
}));

test("cleanup retains a generated context with an active synthetic meeting", async () => fixture(async f => {
  const media = join(f.root, "synthetic.mkv");
  await fs.writeFile(media, "synthetic media fixture");
  const job = await f.jobStore.enqueue(f.config, media);
  await fs.mkdir(job.artifactDir, { recursive: true });
  const overview = "Synthetic Blue reviewed a synthetic example.";
  await fs.writeFile(join(job.artifactDir, "summary.json"), JSON.stringify({ version: 1, provider: "openai", model: "gpt-4o-mini", title: deriveMeetingTitle(overview), overview, topics: [], decisions: [], actionItems: [] }));
  await f.jobStore.update(job.id, "completed");
  const report = await f.build();
  expect(report.clients).toHaveLength(1);
  const path = await getClientAiContextPath(f.config, blue.code, f.outputDir);
  expect(await fs.readFile(path, "utf8")).toContain(job.id);
  await f.build();
  expect(await fs.readFile(path, "utf8")).toContain(job.id);
}));
