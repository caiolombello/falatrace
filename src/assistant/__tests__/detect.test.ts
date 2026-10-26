import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { detectAssistantTools } from "../detect";
import { ACP_AGENTS } from "../providers/acp";
import type { ProbeRunner } from "../providers/cli";
import { installFakeClis, wrapFakeTools } from "./fixtures/fake-clis";
import { withTempDir } from "./provider-helpers";

const ACP_ORDER = ["claude", "codex", "gemini", "opencode", "kiro", "copilot", "cursor", "goose", "qwen", "grok"] as const;

describe("detectAssistantTools", () => {
  test("reports every agent and CLI from PATH and asks only the cheap status commands", async () => {
    const installed = new Set(["codex-acp", "gemini", "claude", "codex"]);
    const looked: string[] = [];
    const probes: string[][] = [];
    const which = (command: string) => {
      looked.push(command);
      return installed.has(command) ? `/usr/local/bin/${command}` : null;
    };
    const run: ProbeRunner = async (argv) => {
      probes.push(argv);
      if (argv[0] === "/usr/local/bin/claude") return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' };
      return { exitCode: 1, stdout: "" };
    };
    const report = await detectAssistantTools({ which, run });
    expect(report.acp.map((entry) => entry.agent)).toEqual([...ACP_ORDER]);
    expect(report.acp.find((entry) => entry.agent === "codex")).toEqual({ agent: "codex", command: "codex-acp", found: true });
    expect(report.acp.find((entry) => entry.agent === "gemini")).toEqual({ agent: "gemini", command: "gemini", found: true });
    expect(report.acp.find((entry) => entry.agent === "claude")).toEqual({ agent: "claude", command: "claude-agent-acp", found: false });
    expect(report.acp.filter((entry) => entry.found).map((entry) => entry.agent)).toEqual(["codex", "gemini"]);
    expect(report.cli).toEqual([
      { tool: "claude", command: "claude", found: true, signedIn: true },
      { tool: "codex", command: "codex", found: true, signedIn: false },
      { tool: "gemini", command: "gemini", found: true, signedIn: null },
      { tool: "opencode", command: "opencode", found: false, signedIn: null }
    ]);
    expect(probes.sort()).toEqual([["/usr/local/bin/claude", "auth", "status"], ["/usr/local/bin/codex", "login", "status"]]);
    // PATH lookups only: never a download helper.
    for (const helper of ["npx", "bunx", "uvx", "npm"]) expect(looked).not.toContain(helper);
    for (const preset of Object.values(ACP_AGENTS)) expect(looked).toContain(preset.command);
  });

  test("relative or failing lookups count as not found; a cancelled scan skips the status commands", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    const relative = await detectAssistantTools({ which: (command) => `bin/${command}`, run });
    expect(relative.acp.every((entry) => !entry.found)).toBe(true);
    expect(relative.cli.every((entry) => !entry.found && entry.signedIn === null)).toBe(true);
    const throwing = await detectAssistantTools({
      which: () => {
        throw new Error("PATH unreadable");
      },
      run
    });
    expect(throwing.cli.every((entry) => !entry.found)).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await detectAssistantTools({ which: (command) => `/bin/${command}`, run, signal: aborted.signal });
    expect(cancelled.cli.every((entry) => entry.found && entry.signedIn === null)).toBe(true);
  });

  test("end to end with the real PATH lookup and status runner against fake tools", async () => {
    await withTempDir(async (dir) => {
      const bin = await installFakeClis(dir, ["claude", "codex", "gemini"]);
      await fs.writeFile(join(bin, "goose"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // Not executable: not an installed tool.
      await fs.writeFile(join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const runtime = join(dir, "runtime");
      await fs.mkdir(runtime, { mode: 0o700 });
      const report = await detectAssistantTools({ env: { PATH: wrapFakeTools(bin, { FAKE_CODEX_AUTH: "none" }), HOME: process.env.HOME, XDG_RUNTIME_DIR: runtime }, timeoutMs: 5_000 });
      expect(report.cli).toEqual([
        { tool: "claude", command: "claude", found: true, signedIn: true },
        { tool: "codex", command: "codex", found: true, signedIn: false },
        { tool: "gemini", command: "gemini", found: true, signedIn: null },
        { tool: "opencode", command: "opencode", found: false, signedIn: null }
      ]);
      expect(report.acp.filter((entry) => entry.found).map((entry) => entry.agent)).toEqual(["gemini", "goose"]);
      // Status commands ran in private folders that are gone afterwards.
      expect(await fs.readdir(join(runtime, "recording-cli", "assistant"))).toEqual([]);
    });
  });
});
