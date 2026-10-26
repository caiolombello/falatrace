import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { clearNotesIndexCache, NOTES_ERRORS, NotesStore } from "../../notes";
import { TEMPLATE_MESSAGES, TemplateStore } from "../../templates";
import { type NotesCliDeps, runNotesCli } from "../notes";
import { CLI_MESSAGES, CLI_USAGE } from "../shared";
import { runTemplatesCli } from "../templates";
import { captureIO, fakeJobs, tempRoot } from "./cli-helpers";

const roots: string[] = [];
afterEach(async () => {
  clearNotesIndexCache();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPTURE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const notesDeps = async (stdin: string[], jobs = fakeJobs([])) => {
  const root = await tempRoot("falatrace-notes-cli-");
  roots.push(root);
  const store = new NotesStore(join(root, "notes"));
  const capture = captureIO();
  const deps: NotesCliDeps = {
    io: capture.io, store: () => store, jobs: () => jobs,
    findForJob: (job, current) => import("../../notes").then(({ findNotesForJob }) => findNotesForJob(job, current, { exists: async () => true })),
    readStdin: async () => stdin.shift() ?? ""
  };
  return { deps, store, capture, root };
};

test("notes edit replaces the notepad from stdin, keeps line identities, and show/path read them back", async () => {
  const sourcePath = "/recordings/Daily-aaaaaaaa/meeting.mkv";
  const { deps, store, capture } = await notesDeps(["# Pauta\n- orçamento\n[ ] mandar proposta\n\n", "# Pauta\n- orçamento revisado\n[ ] mandar proposta\n"], fakeJobs([{ id: JOB, sourcePath }]));
  await runNotesCli(["notes", "edit", JOB], deps);
  expect(capture.out()).toBe("# Pauta\n- orçamento\n[ ] mandar proposta\n");
  const first = await store.read(JOB);
  // Notes added after processing remember the recording, so a later job of the same file finds them.
  expect(first).toMatchObject({ rev: 1, sourcePath });
  await runNotesCli(["notes", "edit", JOB], deps);
  const second = await store.read(JOB);
  expect(second?.rev).toBe(2);
  // Unchanged lines keep their ids; the edited line keeps its slot.
  expect(second?.entries.map((entry) => entry.id)).toEqual(first?.entries.map((entry) => entry.id));
  const shown = captureIO();
  await runNotesCli(["notes", "show", JOB], { ...deps, io: shown.io });
  expect(shown.out()).toBe("# Pauta\n- orçamento revisado\n[ ] mandar proposta\n");
  const json = captureIO();
  await runNotesCli(["notes", "show", JOB, "--json"], { ...deps, io: json.io });
  expect(JSON.parse(json.out())).toMatchObject({ id: JOB, rev: 2, version: 1 });
  const path = captureIO();
  await runNotesCli(["notes", "path", JOB], { ...deps, io: path.io });
  expect(path.out()).toBe(`${store.pathFor(JOB)}\n`);
  // A save based on an older revision is refused instead of overwriting the other window's edit.
  await expect(runNotesCli(["notes", "edit", JOB, "--rev", "1"], deps)).rejects.toThrow(NOTES_ERRORS.conflict);
});

test("a job's notes typed during the capture are found by the recording file and edited in place", async () => {
  const sourcePath = "/recordings/Weekly-bbbbbbbb/meeting.mkv";
  const { deps, store } = await notesDeps(["Decidimos lançar\nNova linha\n"], fakeJobs([{ id: JOB, sourcePath }]));
  await store.save(CAPTURE, { text: "Decidimos lançar\n", expectedRev: 0, sourcePath, mediaStartedAt: "2026-10-25T13:00:00.000Z" });
  const shown = captureIO();
  await runNotesCli(["notes", "show", JOB], { ...deps, io: shown.io });
  expect(shown.out()).toBe("Decidimos lançar\n");
  const path = captureIO();
  await runNotesCli(["notes", "path", JOB], { ...deps, io: path.io });
  expect(path.out()).toBe(`${store.pathFor(CAPTURE)}\n`);
  await runNotesCli(["notes", "edit", JOB], { ...deps, io: captureIO().io });
  expect((await store.read(CAPTURE))?.rev).toBe(2);
  expect(await store.read(JOB)).toBeUndefined();
});

test("notes without an id, with a bad id or an unknown subcommand fail with a Portuguese message", async () => {
  const { deps, capture } = await notesDeps([]);
  await expect(runNotesCli(["notes"], deps)).rejects.toThrow(CLI_USAGE.notes);
  await expect(runNotesCli(["notes", "show"], deps)).rejects.toThrow(CLI_USAGE.notes);
  await expect(runNotesCli(["notes", "show", "../etc/passwd"], deps)).rejects.toThrow(NOTES_ERRORS.invalidId);
  await expect(runNotesCli(["notes", "edit", JOB, "--rev", "x"], deps)).rejects.toThrow(CLI_MESSAGES.revInvalid);
  await expect(runNotesCli(["notes", "remove", JOB], deps)).rejects.toThrow(CLI_USAGE.notes);
  // A recording with no notes shows nothing.
  await runNotesCli(["notes", "show", JOB], deps);
  expect(capture.out()).toBe("");
  await runNotesCli(["notes", "help"], deps);
  expect(capture.out()).toContain("notes edit <id>");
});

test("templates list, show, init (a custom copy) and delete", async () => {
  const root = await tempRoot("falatrace-templates-cli-");
  roots.push(root);
  const store = new TemplateStore({ dir: join(root, "templates") });
  const run = async (...args: string[]) => {
    const capture = captureIO();
    await runTemplatesCli(["templates", ...args], { io: capture.io, store: () => store });
    return capture.out();
  };
  const listed = JSON.parse(await run("list"));
  expect(listed.templates.map((item: { id: string }) => item.id)).toContain("postmortem");
  expect(listed.problems).toEqual([]);
  expect(JSON.parse(await run("show", "standup")).sections.length).toBeGreaterThanOrEqual(3);
  const created = JSON.parse(await run("init", "postmortem", "Comitê", "de", "Riscos"));
  expect(created.id).toBe("custom:comite-de-riscos");
  expect(created.path).toBe(join(root, "templates", "comite-de-riscos.json"));
  expect(created.template).toMatchObject({ builtIn: false, version: 1, name: { "pt-BR": "Comitê de Riscos" } });
  const stored = JSON.parse(await fs.readFile(created.path, "utf8"));
  expect(stored.template.sections).toEqual(JSON.parse(await run("show", "postmortem")).sections);
  expect(JSON.parse(await run("list")).templates.map((item: { id: string }) => item.id)).toContain("custom:comite-de-riscos");
  await expect(run("init", "postmortem", "Comitê de Riscos")).rejects.toThrow(TEMPLATE_MESSAGES.exists);
  await expect(run("init", "nope", "X")).rejects.toThrow(CLI_MESSAGES.templateNotFound);
  await expect(run("init", "general", "!!!")).rejects.toThrow(CLI_MESSAGES.templateNameInvalid);
  await expect(run("show", "custom:nope")).rejects.toThrow(CLI_MESSAGES.templateNotFound);
  await expect(run("delete", "general")).rejects.toThrow(TEMPLATE_MESSAGES.builtInReadOnly);
  expect(JSON.parse(await run("delete", "custom:comite-de-riscos"))).toEqual({ id: "custom:comite-de-riscos", deleted: true });
  expect(JSON.parse(await run("delete", "custom:comite-de-riscos"))).toEqual({ id: "custom:comite-de-riscos", deleted: false });
  await expect(run()).rejects.toThrow(CLI_USAGE.templates);
});
