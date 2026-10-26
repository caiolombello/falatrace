import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { SECRET_NAMES } from "../../config/secrets";
import { NOTES_BRIDGE_MESSAGES } from "../notes-bridge";
import { queueStudioOpen, studioInboxDir } from "../open-request";

/** The production bridge, spawned through the QA harness: a few new Studio operations end to end. */
assertQaIsolation();
const repo = join(import.meta.dir, "../../..");
type Reply = { id: number; ok: boolean; result?: any; error?: string };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const environment = async (options: { config?: boolean } = {}) => {
  const root = await fs.mkdtemp(join(process.env.TMPDIR!, "studio-ops-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", LANG: "pt_BR.UTF-8" };
  for (const [key, name] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_STATE_HOME", "state"], ["XDG_DATA_HOME", "data"], ["XDG_RUNTIME_DIR", "runtime"], ["XDG_CACHE_HOME", "cache"], ["TMPDIR", "tmp"]] as const) {
    env[key] = join(root, name);
    await fs.mkdir(env[key]!, { mode: 0o700 });
  }
  assertQaIsolation(env);
  if (options.config !== false) {
    const recordings = join(root, "home", "recordings");
    await fs.mkdir(recordings, { recursive: true, mode: 0o700 });
    await fs.mkdir(join(env.XDG_CONFIG_HOME!, "recording-cli"), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(env.XDG_CONFIG_HOME!, "recording-cli/config.json"), `${JSON.stringify({ recordingsDir: recordings })}\n`, { mode: 0o600 });
  }
  return env;
};

/** One bridge process; requests are answered concurrently, so the replies are sorted by id. */
const bridge = async (env: NodeJS.ProcessEnv, requests: unknown[]): Promise<Reply[]> => {
  assertQaIsolation(env);
  const child = Bun.spawn(["/usr/bin/python3", "-I", join(repo, "scripts/qa-run.py"), process.execPath, "run", "--preload", join(repo, "scripts/offline-network.ts"), join(repo, "src/desktop/bridge.ts")],
    { cwd: repo, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Reply).sort((a, b) => a.id - b.id);
};

test("capabilities advertise the new features and first-run milestones; the wizard opening is recorded", async () => {
  const env = await environment({ config: false });
  const [read] = await bridge(env, [{ id: 1, op: "settings-read" }]);
  expect(read).toMatchObject({ ok: true, result: { exists: false } });
  const [capabilities] = await bridge(env, [{ id: 2, op: "ux-capabilities" }]);
  expect(capabilities!.ok).toBe(true);
  expect(capabilities!.result.features).toEqual({
    notes: true, live: false, assistant: true, recipes: true, share: true, actions: true, people: true, clients: true,
    upcoming: false, openInbox: true, mediaRemoval: true, templates: true, librarySearch: true
  });
  expect(capabilities!.result.firstRun.wizardOpenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(capabilities!.result.firstRun.firstSummaryAt).toBeUndefined();
});

test("notes are saved and read back; templates, links and the first-run card answer; bad payloads never echo", async () => {
  const env = await environment();
  const id = "123e4567-e89b-42d3-a456-426614174099";
  const [saved] = await bridge(env, [{ id: 1, op: "notes-save", key: id, payload: { text: "# Pauta\n- [ ] mandar a ata", expectedRev: 0 } }]);
  expect(saved).toMatchObject({ ok: true, result: { id, rev: 1, saved: true, text: "# Pauta\n- [ ] mandar a ata" } });
  await queueStudioOpen(`falatrace://recording/${id}`, { dir: studioInboxDir(env, env.HOME) });
  const replies = await bridge(env, [
    { id: 2, op: "notes-read", key: id },
    { id: 3, op: "templates-list" },
    { id: 4, op: "inbox-take" },
    { id: 5, op: "notes-save", key: id, payload: { text: "outra janela", expectedRev: 0 } },
    { id: 6, op: "notes-save", key: id, payload: { text: "x", expectedRev: 0, secret: "private-sentinel" } },
    { id: 7, op: "library-search", payload: { query: "ata" } }
  ]);
  expect(replies[0]).toMatchObject({ ok: true, result: { rev: 1, entries: [{ id: "n000001", text: "# Pauta" }, { id: "n000002", text: "- [ ] mandar a ata" }] } });
  expect(replies[1]!.result.templates).toHaveLength(9);
  expect(replies[1]!.result.default).toBe("auto");
  expect(replies[2]).toEqual({ id: 4, ok: true, result: { uris: [`falatrace://recording/${id}`] } });
  expect(replies[3]).toEqual({ id: 5, ok: false, error: "As notas mudaram em outra janela; recarregue antes de salvar." });
  expect(replies[4]).toEqual({ id: 6, ok: false, error: NOTES_BRIDGE_MESSAGES.saveFailed });
  expect(JSON.stringify(replies)).not.toContain("private-sentinel");
  expect(replies[5]).toMatchObject({ ok: true, result: { hits: [] } });
});

test("the keys page lists every secret, and the startup list and home answer with the new fields", async () => {
  const env = await environment();
  const replies = await bridge(env, [
    { id: 1, op: "settings-read" },
    { id: 2, op: "list" },
    { id: 3, op: "home-read" },
    { id: 4, op: "actions-list", payload: { status: "open" } },
    { id: 5, op: "summary-status", payload: { requestId: "123e4567-e89b-42d3-a456-426614174098" } }
  ]);
  expect(replies[0]!.ok).toBe(true);
  // Assistant API keys and share tokens appear beside the processing keys, never with their values.
  expect(replies[0]!.result.credentials.details.map((item: { name: string }) => item.name)).toEqual([...SECRET_NAMES]);
  expect(replies[1]).toMatchObject({ ok: true, result: { items: [] } });
  expect(replies[2]).toMatchObject({ ok: true, result: { upcoming: [], openActions: [], processing: [], calendarConnected: false } });
  expect(replies[3]).toMatchObject({ ok: true, result: { items: [], counts: { open: 0, done: 0 } } });
  expect(replies[4]).toEqual({ id: 5, ok: false, error: "Esta geração de notas não está mais disponível; releia as notas da reunião." });
});
