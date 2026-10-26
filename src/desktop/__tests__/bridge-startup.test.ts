import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";

/**
 * The Studio starts the bridge on every launch and waits for its first answer, so importing
 * bridge.ts must not load what only some operations need: the provider SDKs and the heavy families
 * (share destinations, the live transcript, media removal) load on first use.
 */
assertQaIsolation();
const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

/** Loaded on first use only; each entry is a path fragment of a module file. */
const LAZY = [
  "/node_modules/@anthropic-ai/sdk/",
  "/node_modules/openai/",
  "/src/destinations/notion.ts",
  "/src/destinations/slack.ts",
  "/src/live/worker.ts",
  "/src/live/transcribe.ts",
  "/src/media-retention/apply.ts"
];

test("importing the bridge loads no provider SDK and no heavy family", async () => {
  const root = await fs.mkdtemp(join(process.env.TMPDIR!, "bridge-startup-"));
  roots.push(root);
  // Bun lists every loaded module, ESM included, in require.cache. Loading the SDK at the end proves the
  // listing still sees ESM modules, so an empty result cannot pass by accident.
  const probe = join(root, "probe.ts");
  await fs.writeFile(probe, [
    `await import(${JSON.stringify(join(repo, "src/desktop/bridge.ts"))});`,
    "const loaded = () => Object.keys(require.cache);",
    `const lazy = ${JSON.stringify(LAZY)};`,
    "const before = lazy.filter((part) => loaded().some((path) => path.includes(part)));",
    `await import(${JSON.stringify(join(repo, "node_modules/@anthropic-ai/sdk/index.mjs"))});`,
    "const control = loaded().some((path) => path.includes(\"/node_modules/@anthropic-ai/sdk/\"));",
    "console.log(JSON.stringify({ before, control }));"
  ].join("\n"), { mode: 0o600 });
  const child = Bun.spawn(["/usr/bin/python3", "-I", join(repo, "scripts/qa-run.py"), process.execPath, "run", "--preload", join(repo, "scripts/offline-network.ts"), probe],
    { cwd: repo, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout.trim())).toEqual({ before: [], control: true });
}, 30_000);
