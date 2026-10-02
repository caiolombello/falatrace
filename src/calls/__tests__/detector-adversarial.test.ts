import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { classifyCall, parsePipeWireNode } from "../classifier";
import { JsonValueStreamParser, PipeWireGraph } from "../pipewire";
import { readCallStatus } from "../status";
import { version as productVersion } from "../../../package.json";

const apps = DEFAULT_CONFIG.callDetection.apps;
const node = (extra: Record<string, unknown> = {}, state: unknown = "running") => ({
  id: 1, type: "PipeWire:Interface:Node",
  info: { state, props: { "application.process.binary": "zen", "media.class": "Stream/Input/Audio", "stream.is-live": true, ...extra } }
});

describe("synthetic adversarial detector parsing", () => {
  test("unknown node fields and escaped Unicode labels do not alter classification", () => {
    const graph = new PipeWireGraph();
    graph.apply([{ ...node({ "unknown.property": "Synthetic \u202e [label] \\\"" }), unknown: { active: false } }]);
    expect(classifyCall(graph.values(), apps).active).toBe(true);
    expect(classifyCall(graph.values(), apps).app).toBe("zen");
  });

  for (const state of ["Running", "running\u0000", " running", "running\u202e", "runnіng", ["running"], { state: "running" }]) {
    test(`noncanonical state ${JSON.stringify(state)} stays inactive`, () => {
      const parsed = parsePipeWireNode(node({}, state));
      expect(parsed).not.toBeNull();
      expect(classifyCall([parsed!], apps).active).toBe(false);
    });
  }

  test("long or non-string app attribution is ignored", () => {
    for (const binary of ["zen" + "x".repeat(501), ["zen"], { binary: "zen" }, "zеn", "zen\u0000"]) {
      const parsed = parsePipeWireNode(node({ "application.process.binary": binary }));
      expect(classifyCall([parsed!], apps).active).toBe(false);
    }
  });

  test("invalid objects and non-safe IDs do not populate the graph", () => {
    const graph = new PipeWireGraph();
    for (const value of [null, [], {}, { ...node(), id: -1 }, { ...node(), id: 1.5 }, { ...node(), id: Number.MAX_SAFE_INTEGER + 1 }, { ...node(), info: [] }, { ...node(), type: "PipeWire:Interface:Port" }]) {
      expect(parsePipeWireNode(value)).toBeNull();
      graph.apply([value]);
    }
    expect(graph.values()).toEqual([]);
    expect(() => graph.apply({ id: 1 })).toThrow("invalid object batch");
  });

  test("object batch has a finite node count bound", () => {
    const graph = new PipeWireGraph();
    expect(() => graph.apply(Array.from({ length: 100_001 }, () => null))).toThrow("invalid object batch");
    expect(graph.values()).toEqual([]);
  });

  test("every code-unit chunk boundary handles quotes, slashes, brackets and Unicode", () => {
    const payload = [{ ...node({ "node.description": 'Synthetic [x] \\ "quoted" \n café 😃' }), unknown: { inner: ["}", "["] } }];
    const text = JSON.stringify(payload);
    for (let boundary = 1; boundary < text.length; boundary++) {
      const parser = new JsonValueStreamParser();
      const emitted = [...parser.push(text.slice(0, boundary)), ...parser.push(text.slice(boundary))];
      expect(emitted).toEqual([payload]);
    }
  });

  test("truncated arrays do not emit nodes before a complete frame", () => {
    const text = JSON.stringify([node()]);
    const parser = new JsonValueStreamParser();
    expect(parser.push(text.slice(0, -1))).toEqual([]);
    expect(parser.push(text.slice(-1))).toEqual([[node()]]);
  });

  for (const malformed of ['{"id":1}', 'true', '[[}]', '[{"x":"bad\\q"}]', '[{"x":1,}]', '[1]garbage']) {
    test(`malformed framing ${JSON.stringify(malformed)} is refused`, () => {
      expect(() => new JsonValueStreamParser().push(malformed)).toThrow();
    });
  }

  test("large incomplete ASCII frame is refused at the existing 16 MiB bound", () => {
    const parser = new JsonValueStreamParser();
    expect(() => parser.push('["' + "x".repeat(16 * 1024 * 1024))).toThrow("size limit");
  }, 20_000);

  test("parse failures cannot delete existing nodes via an invalid ID", () => {
    const graph = new PipeWireGraph();
    graph.apply([node()]);
    graph.apply([{ id: "1", type: null }, { id: 1.5, info: null }, { id: -1, info: null }]);
    expect(classifyCall(graph.values(), apps).active).toBe(true);
    expect(graph.values()).toHaveLength(1);
  });
});

const status = {
  version: 1, state: "IDLE", confidence: 0, reasons: [], updatedAt: "2026-01-01T00:00:00Z",
  dryRun: false, recordingOwned: false
};

test("persisted monitor state must be a string; arrays cannot masquerade as IDLE or IN_CALL", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "detector-status-"));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const path = join(root, "recording-cli", "call-monitor.json");
    await fs.mkdir(join(root, "recording-cli"), { recursive: true });
    for (const state of [["IDLE"], ["IN_CALL"], null, 0, {}, "UNKNOWN", "IDLE\u0000"]) {
      await fs.writeFile(path, JSON.stringify({ ...status, state }));
      await expect(readCallStatus()).rejects.toThrow("Invalid call monitor status");
    }
  } finally {
    process.env.XDG_STATE_HOME = old;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI help, aliases, status JSON and error exit codes remain compatible in a synthetic HOME", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "detector-cli-"));
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), NO_COLOR: "1" };
  await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME].map(p => fs.mkdir(p, { recursive: true })));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "--preload", join(import.meta.dir, "../../../scripts/offline-network.ts"), join(import.meta.dir, "../../cli/index.ts"), ...args], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  try {
    for (const args of [[], ["help"], ["-h"], ["--help"]]) {
      const result = await run(...args);
      expect(result.code).toBe(0); expect(result.err).toBe("");
      expect(result.out).toContain(`FalaTrace ${productVersion}`); expect(result.out).toContain("calls pause");
      expect(result.out).not.toContain("\u001b");
    }
    const empty = await run("calls", "status");
    expect(empty.code).toBe(0); expect(empty.err).toBe("");
    expect(JSON.parse(empty.out).state).toBe("IDLE");
    const path = join(env.XDG_STATE_HOME, "recording-cli", "call-monitor.json");
    await fs.mkdir(join(env.XDG_STATE_HOME, "recording-cli"), { recursive: true });
    const extended = { ...status, state: "IN_CALL", futureField: { value: "Synthetic unicode café 😃" }, recordingWarning: "Synthetic\nwarning\u001b[31m" };
    await fs.writeFile(path, JSON.stringify(extended));
    const valid = await run("calls", "status");
    expect(valid.code).toBe(0); expect(valid.err).toBe("");
    expect(JSON.parse(valid.out)).toEqual(extended); expect(valid.out).not.toContain("\u001b");
    await fs.writeFile(path, JSON.stringify({ ...status, state: ["IDLE"] }));
    const invalid = await run("calls", "status");
    expect(invalid.code).toBe(1); expect(invalid.out).toBe(""); expect(invalid.err).toContain("Invalid call monitor status");
    const unknown = await run("unknown-command");
    expect(unknown.code).toBe(1); expect(unknown.err).toContain("Unknown command");
    expect(unknown.out).toContain("FalaTrace"); // Existing unknown-command contract includes help on stdout.
    for (const args of [["calls"], ["calls", "unknown"], ["context", "meeting"], ["calls", "validate", "unknown"], ["calls", "validation-report", "--session", "../synthetic"]]) {
      const result = await run(...args);
      expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.err.length).toBeGreaterThan(0);
      expect(result.err).not.toContain("\u001b");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);
