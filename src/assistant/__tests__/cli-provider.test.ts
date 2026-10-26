import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { type AppConfig, ASSISTANT_TOOL_AGENTS, type AssistantCliTool } from "../../config/defaults";
import {
  buildCliInvocation,
  CLI_KNOWN_ERRORS,
  CLI_MESSAGES,
  CLI_TOOLS,
  cliEmptyMessage,
  cliFailedMessage,
  cliNotFoundMessage,
  cliSignedOutMessage,
  createCliProvider,
  GEMINI_STDIN_INSTRUCTION,
  type ProbeRunner,
  probeCliSignIn
} from "../providers/cli";
import { COMMON_PROVIDER_MESSAGES, MAX_ANSWER_CHARACTERS } from "../providers/common";
import { ProviderError } from "../types";
import { installFakeClis, readFakeCliRun, wrapFakeTools } from "./fixtures/fake-clis";
import { configWith as baseConfig, chatRequest, processGone, waitFor, withTempDir } from "./provider-helpers";

/** These tests drive the tools themselves: each tool's tools are accepted unless a test says otherwise. */
const configWith = (assistant: Partial<AppConfig["assistant"]>): AppConfig => baseConfig({ agentToolsAccepted: [...ASSISTANT_TOOL_AGENTS], ...assistant });

type Setup = { bin: string; log: string; root: string; env: (extra?: Record<string, string>) => NodeJS.ProcessEnv };

const setup = async (dir: string): Promise<Setup> => {
  const bin = await installFakeClis(dir);
  const log = join(dir, "cli");
  const root = join(dir, "work");
  return {
    bin,
    log,
    root,
    // FAKE_* settings reach the fakes through their wrappers; the rest is the user's environment.
    env: (extra = {}) => {
      const fake = Object.fromEntries(Object.entries({ FAKE_CLI_LOG: log, ...extra }).filter(([name]) => name.startsWith("FAKE_")));
      const user = Object.fromEntries(Object.entries(extra).filter(([name]) => !name.startsWith("FAKE_")));
      return { PATH: `${wrapFakeTools(bin, fake)}:/usr/bin:/bin`, HOME: process.env.HOME, ...user };
    }
  };
};

const cli = (s: Setup, tool: AssistantCliTool, options: { model?: string; env?: Record<string, string>; timeouts?: Record<string, number> } = {}) =>
  createCliProvider(configWith({ provider: "cli", cliTool: tool, cliModel: options.model ?? "" }), {
    env: s.env(options.env),
    workspaceRoot: s.root,
    timeouts: { stopGraceMs: 300, ...options.timeouts }
  });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: (error as Error).message, code: (error as ProviderError).code }).toEqual({ message, code });
};

const exists = (path: string) => fs.stat(path).then(() => true, () => false);

describe("subscription CLIs", () => {
  test("claude: prompt on stdin, tools and MCP off, JSON result, private empty folder", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const provider = cli(s, "claude", { env: { NOTION_TOKEN: "secret_notion", OPENAI_API_KEY: "sk-user" } });
      const request = chatRequest();
      const result = await provider.run(request);
      expect(result).toEqual({ text: "Resposta do Claude.", stopReason: "end", usage: { inputTokens: 120, outputTokens: 7 } });
      // No streaming: the whole answer arrives once.
      expect(request.deltas).toEqual(["Resposta do Claude."]);
      const run = await readFakeCliRun(s.log);
      expect(run.argv).toEqual(["-p", "--output-format", "json", "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--permission-mode", "dontAsk", "--max-turns", "1", "--no-session-persistence"]);
      // The conversation went on stdin, never in argv.
      expect(run.stdin).toContain(request.system);
      expect(run.stdin).toContain("User:\nQuem decidiu o prazo?");
      expect(run.argv.join(" ")).not.toContain("Quem decidiu");
      // A fresh, empty folder under the workspace root, removed afterwards.
      expect(run.cwd.startsWith(`${s.root}/`)).toBe(true);
      expect(run.listing).toBe("");
      expect(await exists(run.cwd)).toBe(false);
      expect(await fs.readdir(s.root)).toEqual([]);
      // FalaTrace's own credentials stay out of the tool's environment; the user's provider keys do not.
      expect(run.env.has("NOTION_TOKEN")).toBe(false);
      expect(run.env.get("OPENAI_API_KEY")).toBe("sk-user");
      expect(run.env.get("NO_COLOR")).toBe("1");
      expect(provider.destination).toEqual({
        kind: "cli",
        id: "cli:claude",
        label: "Claude Code",
        endpoint: "claude",
        model: "",
        external: true,
        subscription: "plano do Claude via Claude Code"
      });
    });
  });

  test("claude: a model is passed with --model; a warning line before the JSON is tolerated", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const provider = cli(s, "claude", { model: "sonnet", env: { FAKE_CLI_MODE: "warning" } });
      expect(provider.destination).toMatchObject({ label: "Claude Code · sonnet", model: "sonnet" });
      expect((await provider.run(chatRequest())).text).toBe("Depois do aviso.");
      expect((await readFakeCliRun(s.log)).argv.slice(-2)).toEqual(["--model", "sonnet"]);
      expect((await cli(s, "claude", { env: { FAKE_CLI_MODE: "max" } }).run(chatRequest())).stopReason).toBe("length");
    });
  });

  test("codex: exec read-only in the empty folder; the answer comes from the -o file next to it", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const request = chatRequest();
      const result = await cli(s, "codex", { model: "gpt-6.1-sol" }).run(request);
      expect(result).toEqual({ text: "Resposta do Codex.", stopReason: "end" });
      const run = await readFakeCliRun(s.log);
      const outputIndex = run.argv.indexOf("-o");
      const output = run.argv[outputIndex + 1] as string;
      expect(run.argv).toEqual([
        "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", run.cwd, "--color", "never",
        "-m", "gpt-6.1-sol", "-o", output, "-"
      ]);
      // The output file lives outside the working folder, which stays empty.
      expect(output.startsWith(`${run.cwd}/`)).toBe(false);
      expect(output.endsWith("/last.txt")).toBe(true);
      expect(run.listing).toBe("");
      expect(run.stdin).toContain("Quem decidiu o prazo?");
      expect(await fs.readdir(s.root)).toEqual([]);
    });
  });

  test("codex: a planted link instead of the answer file is never followed", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const target = join(dir, "private.txt");
      await fs.writeFile(target, "CONTEUDO-PRIVADO");
      const provider = cli(s, "codex", { env: { FAKE_CLI_MODE: "symlink", FAKE_CLI_TARGET: target } });
      const error = await provider.run(chatRequest()).then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).toBe(cliFailedMessage(CLI_TOOLS.codex));
      expect((error as Error).message).not.toContain("CONTEUDO-PRIVADO");
      await expectProviderError(cli(s, "codex", { env: { FAKE_CLI_MODE: "nofile" } }).run(chatRequest()), cliFailedMessage(CLI_TOOLS.codex), "unavailable");
    });
  });

  test("gemini: short instruction in -p, context on stdin, JSON response", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const result = await cli(s, "gemini", { model: "flash" }).run(chatRequest());
      expect(result).toEqual({ text: "Resposta do Gemini.", stopReason: "end" });
      const run = await readFakeCliRun(s.log);
      // No extensions and no MCP server of the user's.
      expect(run.argv).toEqual(["-p", GEMINI_STDIN_INSTRUCTION, "-o", "json", "-e", "none", "--allowed-mcp-server-names", "falatrace-no-mcp-server", "-m", "flash"]);
      expect(run.stdin).toContain("Quem decidiu o prazo?");
    });
  });

  test("opencode: text events are joined in order, other events and stray lines skipped", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      expect(await cli(s, "opencode").run(chatRequest())).toEqual({ text: "Parte um.\n\nParte dois.", stopReason: "end" });
      expect((await readFakeCliRun(s.log)).argv).toEqual(["run", "--format", "json"]);
      await expectProviderError(cli(s, "opencode", { env: { FAKE_CLI_MODE: "error" } }).run(chatRequest()), cliFailedMessage(CLI_TOOLS.opencode), "unavailable");
    });
  });

  test("opencode runs with every permission refused, overriding the user's own, and without ssh/gpg agents", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const user = { OPENCODE_PERMISSION: '{"bash":"allow"}', OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}', SSH_AUTH_SOCK: join(dir, "ssh.sock"), GPG_AGENT_INFO: join(dir, "gpg.sock") };
      await cli(s, "opencode", { env: user }).run(chatRequest());
      const run = await readFakeCliRun(s.log);
      const inline = JSON.parse(run.env.get("OPENCODE_CONFIG_CONTENT") ?? "{}") as { permission?: Record<string, string> };
      expect(Object.keys(inline.permission ?? {})[0]).toBe("*");
      for (const tool of ["*", "bash", "edit", "webfetch", "websearch", "read", "external_directory"]) expect(inline.permission?.[tool]).toBe("deny");
      expect(JSON.parse(run.env.get("OPENCODE_PERMISSION") ?? "{}")).toEqual(inline.permission ?? {});
      expect(run.env.has("SSH_AUTH_SOCK")).toBe(false);
      expect(run.env.has("GPG_AGENT_INFO")).toBe(false);
      // Other tools get no OpenCode settings.
      await cli(s, "gemini").run(chatRequest());
      expect((await readFakeCliRun(s.log)).env.has("OPENCODE_CONFIG_CONTENT")).toBe(false);
    });
  });

  test("a failed run asks the status command: signed out becomes an auth error naming the login", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      await expectProviderError(
        cli(s, "claude", { env: { FAKE_CLI_MODE: "error", FAKE_CLAUDE_AUTH: "none" } }).run(chatRequest()),
        cliSignedOutMessage(CLI_TOOLS.claude),
        "auth"
      );
      await expectProviderError(cli(s, "claude", { env: { FAKE_CLI_MODE: "error" } }).run(chatRequest()), cliFailedMessage(CLI_TOOLS.claude), "unavailable");
      await expectProviderError(cli(s, "claude", { env: { FAKE_CLI_MODE: "garbage" } }).run(chatRequest()), cliFailedMessage(CLI_TOOLS.claude), "unavailable");
      await expectProviderError(cli(s, "codex", { env: { FAKE_CLI_MODE: "error", FAKE_CODEX_AUTH: "none" } }).run(chatRequest()), cliSignedOutMessage(CLI_TOOLS.codex), "auth");
      // Gemini reports a missing sign-in with exit code 41.
      await expectProviderError(cli(s, "gemini", { env: { FAKE_CLI_MODE: "auth" } }).run(chatRequest()), cliSignedOutMessage(CLI_TOOLS.gemini), "auth");
      await expectProviderError(cli(s, "gemini", { env: { FAKE_CLI_MODE: "error" } }).run(chatRequest()), cliFailedMessage(CLI_TOOLS.gemini), "unavailable");
      await expectProviderError(cli(s, "claude", { env: { FAKE_CLI_MODE: "empty" } }).run(chatRequest()), cliEmptyMessage(CLI_TOOLS.claude), "protocol");
      expect(cliSignedOutMessage(CLI_TOOLS.codex)).toContain("`codex login`");
    });
  });

  test("an oversized answer is cut to the answer limit", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const request = chatRequest();
      const result = await cli(s, "claude", { env: { FAKE_CLI_MODE: "huge" } }).run(request);
      expect(result.stopReason).toBe("length");
      expect(result.text).toHaveLength(MAX_ANSWER_CHARACTERS);
      expect(request.deltas).toEqual([result.text]);
    });
  });

  test("cancel sends SIGINT, then SIGTERM, and removes the folder", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const controller = new AbortController();
      const running = cli(s, "claude", { env: { FAKE_CLI_MODE: "slow" } }).run(chatRequest({ signal: controller.signal }));
      await waitFor(() => exists(`${s.log}.pid`));
      const pid = Number((await fs.readFile(`${s.log}.pid`, "utf8")).trim());
      controller.abort();
      await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      expect((await fs.readFile(`${s.log}.signals`, "utf8")).trim().split("\n")).toEqual(["INT", "TERM"]);
      await waitFor(() => processGone(pid));
      expect(await fs.readdir(s.root)).toEqual([]);
    });
  }, 15_000);

  test("a run that takes too long times out and is stopped", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const started = Date.now();
      await expectProviderError(cli(s, "gemini", { env: { FAKE_CLI_MODE: "slow" }, timeouts: { totalMs: 400 } }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(async () => processGone(Number((await fs.readFile(`${s.log}.pid`, "utf8")).trim())));
    });
  }, 15_000);

  test("a tool whose own tools cannot be switched off never starts until the user accepted it; claude needs no acceptance", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      for (const tool of ["codex", "gemini", "opencode"] as const) {
        const provider = createCliProvider(configWith({ provider: "cli", cliTool: tool, agentToolsAccepted: ["acp:codex"] }), { env: s.env(), workspaceRoot: s.root });
        expect(await provider.check()).toEqual({ ready: false, problem: "misconfigured", message: COMMON_PROVIDER_MESSAGES.toolsNotAccepted });
        await expectProviderError(provider.run(chatRequest()), COMMON_PROVIDER_MESSAGES.toolsNotAccepted, "bad-request");
      }
      expect(await exists(`${s.log}.argv`)).toBe(false);
      // claude runs with --tools "" and no MCP servers.
      const claude = createCliProvider(configWith({ provider: "cli", cliTool: "claude", agentToolsAccepted: [] }), { env: s.env(), workspaceRoot: s.root });
      expect((await claude.run(chatRequest())).text).toBe("Resposta do Claude.");
    });
  });

  test("nothing starts for an already-cancelled request, a missing tool or an unsafe model name", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      const aborted = new AbortController();
      aborted.abort();
      await expectProviderError(cli(s, "claude").run(chatRequest({ signal: aborted.signal })), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      await expectProviderError(cli(s, "claude").run(chatRequest({ messages: [{ role: "assistant", content: "x" }] })), COMMON_PROVIDER_MESSAGES.lastNotUser, "bad-request");
      expect(await exists(`${s.log}.argv`)).toBe(false);

      const missing = createCliProvider(configWith({ provider: "cli", cliTool: "codex" }), { env: { PATH: join(dir, "empty") }, workspaceRoot: s.root });
      expect(await missing.check()).toEqual({ ready: false, problem: "missing-binary", message: cliNotFoundMessage(CLI_TOOLS.codex) });
      await expectProviderError(missing.run(chatRequest()), cliNotFoundMessage(CLI_TOOLS.codex), "unavailable");

      for (const model of ["--dangerously-skip-permissions", "a b", "x;rm", `m${"x".repeat(200)}`, "-m"]) {
        const unsafe = cli(s, "claude", { model });
        expect(await unsafe.check()).toEqual({ ready: false, problem: "misconfigured", message: CLI_MESSAGES.invalidModel });
        await expectProviderError(unsafe.run(chatRequest()), CLI_MESSAGES.invalidModel, "bad-request");
      }
      expect(await exists(`${s.log}.argv`)).toBe(false);
    });
  });

  test("a tool on PATH that cannot be started is reported in Portuguese, not as a raw spawn error", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "work");
      const bin = join(dir, "broken");
      await fs.mkdir(bin);
      // An install whose interpreter is gone: found on PATH, but posix_spawn fails.
      await fs.writeFile(join(bin, "claude"), "#!/nonexistent/interpreter\necho never\n", { mode: 0o755 });
      const broken = createCliProvider(configWith({ provider: "cli", cliTool: "claude" }), { env: { PATH: bin, HOME: process.env.HOME }, workspaceRoot: root });
      await expectProviderError(broken.run(chatRequest()), cliNotFoundMessage(CLI_TOOLS.claude), "unavailable");
      // Another launch failure (EACCES) gets the same fixed message, and the private folder is removed either way.
      const failing = createCliProvider(configWith({ provider: "cli", cliTool: "gemini" }), {
        env: { PATH: bin, HOME: process.env.HOME },
        which: () => "/usr/bin/gemini",
        workspaceRoot: root,
        spawn: () => {
          throw new Error(`EACCES: permission denied, posix_spawn '${dir}/gemini'`);
        }
      });
      await expectProviderError(failing.run(chatRequest()), cliNotFoundMessage(CLI_TOOLS.gemini), "unavailable");
      expect(await fs.readdir(root)).toEqual([]);
    });
  });

  test("check() uses the cheap status commands where the tool has one", async () => {
    await withTempDir(async (dir) => {
      const s = await setup(dir);
      expect(await cli(s, "claude").check()).toEqual({ ready: true });
      expect(await cli(s, "claude", { env: { FAKE_CLAUDE_AUTH: "none" } }).check()).toEqual({ ready: false, problem: "signed-out", message: cliSignedOutMessage(CLI_TOOLS.claude) });
      expect(await cli(s, "codex").check()).toEqual({ ready: true });
      expect(await cli(s, "codex", { env: { FAKE_CODEX_AUTH: "none" } }).check()).toEqual({ ready: false, problem: "signed-out", message: cliSignedOutMessage(CLI_TOOLS.codex) });
      // No status command: found is enough.
      expect(await cli(s, "gemini").check()).toEqual({ ready: true });
      // Status probes never send meeting content.
      expect(await exists(`${s.log}.argv`)).toBe(false);
      const aborted = new AbortController();
      aborted.abort();
      await expectProviderError(cli(s, "claude").check(aborted.signal), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
    });
  });
});

describe("CLI helpers", () => {
  test("buildCliInvocation never puts the prompt in argv", () => {
    const paths = { cwd: "/w/workspace", outputFile: "/w/output/last.txt" };
    expect(buildCliInvocation("claude", "/bin/claude", "", paths).argv[0]).toBe("/bin/claude");
    expect(buildCliInvocation("codex", "/bin/codex", "", paths)).toEqual({
      argv: ["/bin/codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", "/w/workspace", "--color", "never", "-o", "/w/output/last.txt", "-"],
      outputFile: "/w/output/last.txt"
    });
    expect(buildCliInvocation("gemini", "/bin/gemini", "", paths).argv).toEqual(["/bin/gemini", "-p", GEMINI_STDIN_INSTRUCTION, "-o", "json", "-e", "none", "--allowed-mcp-server-names", "falatrace-no-mcp-server"]);
    expect(buildCliInvocation("opencode", "/bin/opencode", "anthropic/claude-sonnet-5-5", paths).argv).toEqual(["/bin/opencode", "run", "--format", "json", "-m", "anthropic/claude-sonnet-5-5"]);
    expect(Object.keys(buildCliInvocation("opencode", "/bin/opencode", "", paths).lockdown ?? {}).sort()).toEqual(["OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"]);
    for (const tool of ["claude", "codex", "gemini"] as const) expect(buildCliInvocation(tool, `/bin/${tool}`, "", paths).lockdown).toBeUndefined();
  });

  test("probeCliSignIn reads claude auth status JSON and codex login status exit codes", async () => {
    const calls: string[][] = [];
    const runner = (answer: { exitCode: number | null; stdout?: string } | Error): ProbeRunner => async (argv) => {
      calls.push(argv);
      if (answer instanceof Error) throw answer;
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "" };
    };
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }))).toBe(true);
    expect(calls[0]).toEqual(["/bin/claude", "auth", "status"]);
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 0, stdout: '{"authMethod":"api_key"}' }))).toBe(true);
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 0, stdout: '{"loggedIn":false,"authMethod":"none"}' }))).toBe(false);
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 1, stdout: "" }))).toBe(false);
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 0, stdout: "not json" }))).toBeNull();
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 0, stdout: "{}" }))).toBeNull();
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: 2 }))).toBeNull();
    expect(await probeCliSignIn("claude", "/bin/claude", runner({ exitCode: null }))).toBeNull();
    expect(await probeCliSignIn("claude", "/bin/claude", runner(new Error("spawn failed")))).toBeNull();
    calls.length = 0;
    expect(await probeCliSignIn("codex", "/bin/codex", runner({ exitCode: 0 }))).toBe(true);
    expect(calls[0]).toEqual(["/bin/codex", "login", "status"]);
    expect(await probeCliSignIn("codex", "/bin/codex", runner({ exitCode: 1 }))).toBe(false);
    expect(await probeCliSignIn("codex", "/bin/codex", runner({ exitCode: null }))).toBeNull();
    calls.length = 0;
    expect(await probeCliSignIn("gemini", "/bin/gemini", runner({ exitCode: 0 }))).toBeNull();
    expect(await probeCliSignIn("opencode", "/bin/opencode", runner({ exitCode: 0 }))).toBeNull();
    expect(calls).toEqual([]);
  });

  test("known errors cover every tool", () => {
    for (const preset of Object.values(CLI_TOOLS)) {
      for (const message of [cliNotFoundMessage(preset), cliSignedOutMessage(preset), cliFailedMessage(preset), cliEmptyMessage(preset)]) expect(CLI_KNOWN_ERRORS).toContain(message);
    }
    expect(CLI_KNOWN_ERRORS).toContain(CLI_MESSAGES.invalidModel);
  });
});
