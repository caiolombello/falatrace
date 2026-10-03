import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";

// Every request uses the production JSONL bridge. No UI, capture or provider stub is used.
// Both the parent runner and each child validate the marked disposable HOME/XDG first.
assertQaIsolation();
const sourceRoot = join(import.meta.dir, "../../..");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const privateSentinel = "synthetic-private-g4-sentinel";
type Reply = { id: number; ok: boolean; result?: Record<string, unknown>; error?: string };
type Fixture = { root: string; env: NodeJS.ProcessEnv; config: string };

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "g4-onboarding-bridge-"));
  // Bun's disposable transpiler cache is unrelated to product state. Disable only
  // that compiler cache so the filesystem snapshots cover every fixture path.
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const [key, directory] of [
    ["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_STATE_HOME", "state"],
    ["XDG_DATA_HOME", "data"], ["XDG_RUNTIME_DIR", "runtime"],
    ["XDG_CACHE_HOME", "cache"], ["TMPDIR", "tmp"]
  ] as const) {
    env[key] = join(root, directory);
    await fs.mkdir(env[key]!, { mode: 0o700 });
  }
  assertQaIsolation(env);
  // Synthetic existing state proves onboarding does not enqueue jobs, change capture,
  // grant provider access, consume a provider budget or rewrite recording artifacts.
  for (const [path, bytes] of [
    ["state/recording-cli/recording-session.json", '{"state":"synthetic-active-capture"}\n'],
    ["state/recording-cli/jobs/11111111-1111-4111-8111-111111111111.json", '{"state":"queued","synthetic":true}\n'],
    ["state/recording-cli/agent-context/grants/22222222-2222-4222-8222-222222222222.json", '{"synthetic":"provider-grant-preserved"}\n'],
    ["state/recording-cli/visual-review/provider-analysis/attempts.json", '{"version":1,"attempts":[]}\n'],
    ["state/recording-cli/visual-review/budget.json", '{"synthetic":"budget-preserved"}\n'],
    ["data/recording-cli/jobs/11111111-1111-4111-8111-111111111111/transcript.json", '{"text":"synthetic-artifact-preserved"}\n'],
    ["home/Videos/synthetic-recording.mkv", "synthetic-media-only\n"]
  ]) {
    const file = join(root, path!);
    await fs.mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes!, { mode: 0o600 });
  }
  return { root, env, config: join(env.XDG_CONFIG_HOME!, "recording-cli/config.json") };
}

async function withFixture(run: (value: Fixture) => Promise<void>) {
  const value = await fixture();
  try { await run(value); }
  finally { await fs.rm(value.root, { recursive: true, force: true }); }
}

async function snapshot(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function walk(relative = "") {
    for (const name of (await fs.readdir(join(root, relative))).sort()) {
      const child = join(relative, name), path = join(root, child), stat = await fs.lstat(path);
      if (stat.isDirectory()) {
        result[child] = { kind: "directory", mode: stat.mode & 0o777 };
        await walk(child);
      } else {
        expect(stat.isFile()).toBe(true);
        result[child] = { kind: "file", mode: stat.mode & 0o777, mtime: stat.mtimeMs, hash: sha256(await fs.readFile(path)) };
      }
    }
  }
  await walk();
  return result;
}

async function nonConfigSnapshot(value: Fixture) {
  const files = await snapshot(value.root);
  return Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith("config/")));
}

async function bridge(value: Fixture, requests: unknown[]): Promise<Reply[]> {
  const child = Bun.spawn([
    "/usr/bin/python3", "-I", join(sourceRoot, "scripts/qa-run.py"), process.execPath,
    "run", "--preload", join(sourceRoot, "scripts/offline-network.ts"),
    join(sourceRoot, "src/desktop/bridge.ts")
  ], { cwd: sourceRoot, env: value.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).not.toContain(privateSentinel);
  expect(stdout).not.toContain(value.root);
  const replies: Reply[] = stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(replies).toHaveLength(requests.length);
  return replies.sort((a, b) => a.id - b.id);
}

function successful(reply: Reply): Record<string, unknown> {
  expect(reply.ok).toBe(true);
  expect(reply.error).toBeUndefined();
  if (!reply.ok || !reply.result) throw new Error(`Synthetic bridge request ${reply.id} failed: ${reply.error}`);
  return reply.result;
}

async function seedConfig(value: Fixture, bytes: string) {
  await fs.mkdir(join(value.config, ".."), { recursive: true, mode: 0o700 });
  await fs.writeFile(value.config, bytes, { mode: 0o600 });
}

describe("G4 onboarding through the guarded production desktop bridge", () => {
  test("fresh reads and closing without save leave configuration and all existing state untouched", async () => withFixture(async value => {
    const before = await snapshot(value.root);
    const replies = await bridge(value, [{ id: 1, op: "onboarding-read" }, { id: 2, op: "onboarding-read" }]);
    const fresh = successful(replies[0]!);
    expect(fresh.exists).toBe(false);
    expect(fresh.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(successful(replies[1]!)).toEqual(fresh);
    expect(await fs.access(value.config).then(() => true, () => false)).toBe(false);
    // Cancel has no bridge save request: close stdin and prove no directory/file changes.
    expect(await snapshot(value.root)).toEqual(before);
  }), 10000);

  test("explicit fresh save returns the actual private revision without creating jobs or running providers", async () => withFixture(async value => {
    const before = await nonConfigSnapshot(value);
    const draft = successful((await bridge(value, [{ id: 1, op: "onboarding-read" }]))[0]!);
    const saved = successful((await bridge(value, [{ id: 2, op: "onboarding-save-local", payload: { revision: draft.revision } }]))[0]!);
    const bytes = await fs.readFile(value.config);
    expect(saved).toMatchObject({ saved: true, backupCreated: false, exists: true, local: true, transcriptionLocal: true, processingTarget: "local", automaticEnqueue: false });
    expect(JSON.parse(bytes.toString())).toMatchObject({ transcription: { provider: "whisper-cpp" }, summary: { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }, processing: { defaultTarget: "local", autoEnqueue: false } });
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.revision).not.toBe(draft.revision);
    expect((await fs.stat(value.config)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(value.config, ".."))).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(join(value.config, ".."))).toEqual(["config.json"]);
    const reread = successful((await bridge(value, [{ id: 3, op: "onboarding-read" }]))[0]!);
    expect(reread.revision).toBe(saved.revision);
    expect(await nonConfigSnapshot(value)).toEqual(before);
  }), 10000);

  test("existing external routes are disclosed without secrets; read/cancel preserves bytes and local save keeps an exact private backup", async () => withFixture(async value => {
    const original = {
      future: { marker: privateSentinel, unknown: [1, "kept"] },
      obs: { password: privateSentinel }, openai: { apiKey: privateSentinel },
      transcription: { provider: "openai", language: "en", future: { keep: true } },
      summary: { provider: "ollama", ollamaUrl: `https://name:${privateSentinel}@summary.example.invalid/private-path?token=${privateSentinel}`, ollamaModel: "synthetic-model", future: "kept" },
      processing: { defaultTarget: "remote", autoEnqueue: true, syncIntervalMinutes: 17, future: "kept" },
      remote: { host: `${privateSentinel}.invalid`, user: privateSentinel, identityFile: `/synthetic/${privateSentinel}` },
      archive: { enabled: true, vaio: true, proton: true },
      proton: { enabled: true, targetFolder: `/my-files/${privateSentinel}` },
      s3: { enabled: true, bucket: privateSentinel, prefix: privateSentinel, profile: privateSentinel },
      timesheet: { enabled: true, aiClassification: true }
    };
    const bytes = JSON.stringify(original, null, "\t") + "\n\n";
    await seedConfig(value, bytes);
    const before = await snapshot(value.root), otherState = await nonConfigSnapshot(value);
    const draft = successful((await bridge(value, [{ id: 1, op: "onboarding-read" }]))[0]!);
    expect(draft).toMatchObject({ exists: true, summaryProvider: "ollama", destination: "https://summary.example.invalid", local: false, transcriptionProvider: "openai", transcriptionLocal: false, processingTarget: "remote", automaticEnqueue: true, archiveEnabled: true, archiveExternal: true, s3Enabled: true, protonEnabled: true, timesheetAIExternal: true });
    expect(draft.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(draft.transcriptionDestination).toContain("externo");
    expect(draft.processingDestination).toContain("remoto");
    expect(draft.archiveDestinations).toEqual(["Worker remoto", "Proton Drive"]);
    expect(draft.s3Destination).toContain("externo");
    expect(JSON.stringify(draft)).not.toContain("private-path");
    expect(JSON.stringify(draft)).not.toContain("token=");
    expect(await snapshot(value.root)).toEqual(before);
    const saved = successful((await bridge(value, [{ id: 2, op: "onboarding-save-local", payload: { revision: draft.revision } }]))[0]!);
    expect(saved).toMatchObject({ saved: true, backupCreated: true, local: true, transcriptionLocal: true, processingTarget: "local", automaticEnqueue: false, archiveExternal: true, s3Enabled: true, protonEnabled: true, timesheetAIExternal: true });
    const afterBytes = await fs.readFile(value.config), after = JSON.parse(afterBytes.toString());
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.revision).not.toBe(draft.revision);
    const reread = successful((await bridge(value, [{ id: 3, op: "onboarding-read" }]))[0]!);
    expect(reread.revision).toBe(saved.revision);
    expect(after).toEqual({ ...original, transcription: { ...original.transcription, provider: "whisper-cpp" }, summary: { ...original.summary, provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }, processing: { ...original.processing, defaultTarget: "local", autoEnqueue: false } });
    const names = (await fs.readdir(join(value.config, ".."))).sort();
    expect(names).toHaveLength(2);
    const backup = names.find(name => name.startsWith("config.json.bak-"))!;
    expect(backup).toBeDefined();
    expect(await fs.readFile(join(value.config, "..", backup), "utf8")).toBe(bytes);
    expect((await fs.stat(join(value.config, "..", backup))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(value.config)).mode & 0o777).toBe(0o600);
    expect(await nonConfigSnapshot(value)).toEqual(otherState);
  }), 10000);

  test.each(["openai", "gemini", "whisper-cpp"])("loopback summary does not hide %s transcription or remote processing", async provider => withFixture(async value => {
    const bytes = JSON.stringify({ transcription: { provider }, summary: { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }, processing: { defaultTarget: "remote", autoEnqueue: true }, remote: { host: `${privateSentinel}.invalid` } });
    await seedConfig(value, bytes);
    const before = await snapshot(value.root);
    const draft = successful((await bridge(value, [{ id: 1, op: "onboarding-read" }]))[0]!);
    expect(draft.local).toBe(true);
    expect(draft.transcriptionProvider).toBe(provider);
    expect(draft.transcriptionLocal).toBe(false);
    expect(draft.transcriptionDestination).toContain(provider === "whisper-cpp" ? "remoto" : "externo");
    expect(draft.processingTarget).toBe("remote");
    expect(draft.processingDestination).toContain("remoto");
    expect(await snapshot(value.root)).toEqual(before);
  }), 10000);

  test("stale save returns a sanitized failure and preserves the newer configuration without a backup", async () => withFixture(async value => {
    await seedConfig(value, '{}\n');
    const draft = successful((await bridge(value, [{ id: 1, op: "onboarding-read" }]))[0]!);
    const newer = JSON.stringify({ future: privateSentinel, processing: { autoEnqueue: true, defaultTarget: "remote" } }) + "\n";
    await fs.writeFile(value.config, newer);
    const before = await snapshot(value.root);
    const reply = (await bridge(value, [{ id: 2, op: "onboarding-save-local", payload: { revision: draft.revision } }]))[0]!;
    expect(reply.ok).toBe(false);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toMatch(/configuração|salvamento/);
    expect(reply.error).not.toContain("EPERM");
    expect(await fs.readFile(value.config, "utf8")).toBe(newer);
    expect(await snapshot(value.root)).toEqual(before);
    const reread = successful((await bridge(value, [{ id: 3, op: "onboarding-read" }]))[0]!);
    expect(reread.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(reread.revision).not.toBe(draft.revision);
    expect(reread.automaticEnqueue).toBe(true);
  }), 10000);

  test("malformed read and unscoped payloads fail without echoing secrets or changing files", async () => withFixture(async value => {
    const malformed = `{"future":"${privateSentinel}", malformed JSON`;
    await seedConfig(value, malformed);
    const before = await snapshot(value.root);
    const malformedReply = (await bridge(value, [{ id: 1, op: "onboarding-read" }]))[0]!;
    expect(malformedReply.ok).toBe(false);
    expect(malformedReply.error).toMatch(/ler a configuração/);
    expect(malformedReply.error).not.toMatch(/JSON|SyntaxError/);
    expect(await snapshot(value.root)).toEqual(before);
    await seedConfig(value, '{}\n');
    const validBefore = await snapshot(value.root);
    const revision = successful((await bridge(value, [{ id: 7, op: "onboarding-read" }]))[0]!).revision;
    const replies = await bridge(value, [
      { id: 2, op: "onboarding-read", payload: { config: privateSentinel } },
      { id: 3, op: "onboarding-save-local", payload: { revision, command: privateSentinel } },
      { id: 4, op: "onboarding-save-local", payload: { revision: 123 } },
      { id: 5, op: "onboarding-save-local", payload: { revision: privateSentinel } },
      { id: 6, op: "onboarding-save-local", payload: {} }
    ]);
    for (const reply of replies) {
      expect(reply.ok).toBe(false);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toMatch(/configuração|salvamento/);
    }
    expect(await snapshot(value.root)).toEqual(validBefore);
  }), 10000);
});
