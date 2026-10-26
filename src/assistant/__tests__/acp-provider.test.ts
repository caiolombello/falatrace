import { describe, expect, test } from "bun:test";
import { existsSync, promises as fs, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppConfig, ASSISTANT_TOOL_AGENTS } from "../../config/defaults";
import {
  ACP_AGENTS,
  ACP_KNOWN_ERRORS,
  ACP_MESSAGES,
  acpAuthMessage,
  acpExitedMessage,
  acpFailedMessage,
  acpNotFoundMessage,
  acpProtocolMessage,
  acpVersionMessage,
  choosePermissionOutcome,
  createAcpProvider,
  RESTRICTIVE_MODE_IDS,
  resolveAcpAgent,
  restrictiveModeRequest
} from "../providers/acp";
import { COMMON_PROVIDER_MESSAGES, MAX_ANSWER_CHARACTERS } from "../providers/common";
import { SHELL_WORDS_MESSAGES } from "../providers/shell-words";
import { ProviderError } from "../types";
import { configWith as baseConfig, chatRequest, processGone, readLog, waitFor, withTempDir } from "./provider-helpers";

/** These tests drive the agents themselves: each agent's tools are accepted unless a test says otherwise. */
const configWith = (assistant: Partial<AppConfig["assistant"]>): AppConfig => baseConfig({ agentToolsAccepted: [...ASSISTANT_TOOL_AGENTS], ...assistant });

const BUN = process.execPath;
const AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

type Fixture = { bin: string; log: string; root: string; env: (mode: string) => NodeJS.ProcessEnv };

/**
 * A PATH with wrappers named like real agents that start the fake agent. Agents get a minimal
 * environment, so each mode has its own wrappers carrying the fake agent's settings.
 */
const fixture = async (dir: string, commands: string[] = ["codex-acp"]): Promise<Fixture> => {
  const log = join(dir, "agent.log");
  const root = join(dir, "work");
  const binFor = (mode: string): string => {
    const bin = join(dir, `bin-${mode}`);
    if (existsSync(bin)) return bin;
    mkdirSync(bin);
    for (const name of commands) {
      writeFileSync(join(bin, name), `#!/bin/sh\nexport FAKE_ACP_MODE='${mode}' FAKE_ACP_LOG='${log}'\nexec "${BUN}" "${AGENT}" "$@"\n`, { mode: 0o755 });
    }
    return bin;
  };
  return { bin: binFor("normal"), log, root, env: (mode) => ({ PATH: `${binFor(mode)}:/usr/bin:/bin`, HOME: process.env.HOME }) };
};

const fast = { startMs: 10_000, cancelGraceMs: 2_000, killGraceMs: 1_000 };
const codex = (f: Fixture, mode: string, timeouts: Record<string, number> = {}) =>
  createAcpProvider(configWith({ provider: "acp", acpAgent: "codex" }), { env: f.env(mode), workspaceRoot: f.root, timeouts: { ...fast, ...timeouts } });

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: (error as Error).message, code: (error as ProviderError).code }).toEqual({ message, code });
};

const received = (log: Array<Record<string, unknown>>, method: string) =>
  log.filter((entry) => entry.event === "recv" && (entry.message as Record<string, unknown>).method === method).map((entry) => entry.message as Record<string, unknown>);
const event = (log: Array<Record<string, unknown>>, name: string) => log.find((entry) => entry.event === name);
/** The JSON-RPC answer the fake agent recorded for one of its requests. */
const responseOf = (log: Array<Record<string, unknown>>, name: string): Record<string, unknown> => {
  const entry = event(log, name);
  if (!entry) throw new Error(`no ${name} entry in the agent log`);
  return entry.response as Record<string, unknown>;
};

describe("ACP client", () => {
  test("initialize → session/new → session/prompt, streaming only agent message text", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const provider = codex(f, "normal");
      const request = chatRequest();
      const result = await provider.run(request);
      expect(result).toEqual({ text: "Olá, mundo.", stopReason: "end" });
      expect(request.deltas).toEqual(["Olá, ", "mundo."]);
      const log = await readLog(f.log);
      const initialize = received(log, "initialize")[0] as Record<string, unknown>;
      expect(initialize.params).toEqual({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "falatrace", title: "FalaTrace", version: expect.any(String) }
      });
      const sessionNew = received(log, "session/new")[0] as { params: { cwd: string; mcpServers: unknown[] } };
      expect(sessionNew.params.mcpServers).toEqual([]);
      expect(sessionNew.params.cwd.startsWith(`${f.root}/`)).toBe(true);
      // The agent ran in that same fresh, private, empty directory, which is gone afterwards.
      expect(event(log, "cwd")).toMatchObject({ cwd: sessionNew.params.cwd, entries: [], mode700: true, processCwd: sessionNew.params.cwd });
      await expect(fs.stat(sessionNew.params.cwd)).rejects.toThrow();
      const prompt = received(log, "session/prompt")[0] as { params: { sessionId: string; prompt: Array<{ type: string; text: string }> } };
      expect(prompt.params.sessionId).toBe("sess-1");
      expect(prompt.params.prompt).toHaveLength(1);
      expect(prompt.params.prompt[0]?.type).toBe("text");
      expect(prompt.params.prompt[0]?.text).toContain(request.system);
      expect(prompt.params.prompt[0]?.text).toContain("User:\nQuem decidiu o prazo?");
      // Thoughts, images, plans, unknown kinds and other sessions never reach the answer.
      for (const hidden of ["PENSAMENTO-OCULTO", "OUTRA-SESSAO", "AAAA"]) expect(result.text).not.toContain(hidden);
      // stdin was closed so the agent could exit on its own.
      expect(event(log, "stdin-closed")).toBeDefined();
      expect(await processGone(event(log, "start")?.pid as number)).toBe(true);
    });
  }, 20_000);

  test("every permission request is turned down and client methods are refused", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const result = await codex(f, "permission").run(chatRequest());
      // A new messageId starts a new paragraph.
      expect(result.text).toBe("Olá, mundo.\n\nSem ferramentas.");
      const log = await readLog(f.log);
      expect(responseOf(log, "permission").result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
      expect(responseOf(log, "permission-always").result).toEqual({ outcome: { outcome: "selected", optionId: "never" } });
      expect(responseOf(log, "permission-none").result).toEqual({ outcome: { outcome: "cancelled" } });
      for (const name of ["fs", "terminal", "unknown"]) {
        expect(responseOf(log, name).error).toEqual({ code: -32601, message: "Method not found" });
      }
    });
  }, 20_000);

  test("presets launch their own command; Claude always hides subscription login", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, ["claude-agent-acp", "gemini", "grok"]);
      const run = async (agent: "claude" | "gemini" | "grok") => {
        await fs.rm(f.log, { force: true });
        await createAcpProvider(configWith({ provider: "acp", acpAgent: agent }), { env: f.env("normal"), workspaceRoot: f.root, timeouts: fast }).run(chatRequest());
        return (event(await readLog(f.log), "start") as { argv: string[] }).argv;
      };
      expect(await run("claude")).toEqual(["--hide-claude-auth"]);
      // No extensions and no MCP server of the user's.
      expect(await run("gemini")).toEqual(["--acp", "-e", "none", "--allowed-mcp-server-names", "falatrace-no-mcp-server"]);
      expect(await run("grok")).toEqual(["agent", "stdio"]);
    });
  }, 20_000);

  test("agents that run tools without asking start with their own tools refused, and without the user's ssh/gpg agents", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, ["opencode", "goose", "codex-acp", "grok"]);
      const startEnv = async (agent: "opencode" | "goose" | "codex" | "grok", user: Record<string, string> = {}) => {
        await fs.rm(f.log, { force: true });
        const env = { ...f.env("normal"), SSH_AUTH_SOCK: join(dir, "ssh.sock"), GPG_AGENT_INFO: join(dir, "gpg.sock"), NOTION_TOKEN: "x", ...user };
        await createAcpProvider(configWith({ provider: "acp", acpAgent: agent }), { env, workspaceRoot: f.root, timeouts: fast }).run(chatRequest());
        return (event(await readLog(f.log), "start") as { env: Record<string, string> }).env;
      };
      // The user's own values for the same settings are overridden.
      const opencode = await startEnv("opencode", { OPENCODE_PERMISSION: '{"bash":"allow"}' });
      expect(Object.keys(opencode).sort()).toEqual(["OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"]);
      const inline = JSON.parse(opencode.OPENCODE_CONFIG_CONTENT as string) as { permission: Record<string, string> };
      expect(JSON.parse(opencode.OPENCODE_PERMISSION as string)).toEqual(inline.permission);
      // "*" first, then each built-in tool OpenCode allows by default, all refused.
      expect(Object.keys(inline.permission)[0]).toBe("*");
      for (const tool of ["*", "bash", "edit", "webfetch", "websearch", "read", "task", "external_directory"]) expect(inline.permission[tool]).toBe("deny");
      expect(new Set(Object.values(inline.permission))).toEqual(new Set(["deny"]));
      expect(await startEnv("goose", { GOOSE_MODE: "auto" })).toEqual({ GOOSE_MODE: "chat" });
      expect(await startEnv("codex", { INITIAL_AGENT_MODE: "agent-full-access" })).toEqual({ INITIAL_AGENT_MODE: "read-only" });
      // An agent with no lockdown of its own still loses the sockets and FalaTrace's secrets.
      expect(await startEnv("grok")).toEqual({});
    });
  }, 30_000);

  test("the session is put in the most restrictive mode the agent offers before the question is sent", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const methodsOf = (log: Array<Record<string, unknown>>) =>
        log.filter((entry) => entry.event === "recv").map((entry) => (entry.message as Record<string, unknown>).method).filter((method) => typeof method === "string");

      // "mode" config option (Claude Agent, codex-acp): set through session/set_config_option, groups included.
      expect((await codex(f, "config-modes").run(chatRequest())).text).toBe("Olá, mundo.");
      let log = await readLog(f.log);
      expect(received(log, "session/set_config_option").map((message) => message.params)).toEqual([{ sessionId: "sess-1", configId: "mode", value: "plan" }]);
      expect(received(log, "session/set_mode")).toEqual([]);
      expect(methodsOf(log)).toEqual(["initialize", "session/new", "session/set_config_option", "session/prompt"]);

      // Only the older `modes`: session/set_mode, "ask" before "plan".
      await fs.rm(f.log, { force: true });
      await codex(f, "legacy-modes").run(chatRequest());
      log = await readLog(f.log);
      expect(received(log, "session/set_mode").map((message) => message.params)).toEqual([{ sessionId: "sess-1", modeId: "ask" }]);
      expect(methodsOf(log)).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"]);

      // Already restricted, offering no restrictive mode, or no modes at all: nothing to switch.
      for (const mode of ["already-restricted", "no-restrictive-mode", "normal"]) {
        await fs.rm(f.log, { force: true });
        await codex(f, mode).run(chatRequest());
        expect(methodsOf(await readLog(f.log))).toEqual(["initialize", "session/new", "session/prompt"]);
      }

      // An agent that refuses the mode it offered never gets the question.
      await fs.rm(f.log, { force: true });
      await expectProviderError(codex(f, "config-modes-refused").run(chatRequest()), acpFailedMessage("Codex"), "unavailable");
      expect(received(await readLog(f.log), "session/prompt")).toEqual([]);
    });
  }, 30_000);

  test("a custom command is split without a shell and its arguments stay out of the destination", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, []);
      const log = join(dir, "custom.log");
      const config = configWith({ provider: "acp", acpAgent: "custom", acpCommand: `'${BUN}' '${AGENT}' --mode normal --log '${log}' --token "s3cr3t value"` });
      const provider = createAcpProvider(config, { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME }, workspaceRoot: f.root, timeouts: fast });
      // The arguments only reach the destination as a hash, so a change to them asks for consent again.
      expect(provider.destination).toEqual({ kind: "acp", id: "acp:custom", label: "ACP personalizado (ACP)", endpoint: BUN, model: "", external: true, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(JSON.stringify(provider.destination)).not.toContain("s3cr3t");
      expect(await provider.check()).toEqual({ ready: true });
      expect((await provider.run(chatRequest())).text).toBe("Olá, mundo.");
      // The fake agent logs the arguments after its own script path.
      expect((event(await readLog(log), "start") as { argv: string[] }).argv).toEqual(["--mode", "normal", "--log", log, "--token", "s3cr3t value"]);

      const piped = createAcpProvider(configWith({ provider: "acp", acpAgent: "custom", acpCommand: "agent acp | tee /tmp/x" }), { workspaceRoot: f.root });
      expect(await piped.check()).toEqual({ ready: false, problem: "misconfigured", message: SHELL_WORDS_MESSAGES.shellFeature });
      await expectProviderError(piped.run(chatRequest()), SHELL_WORDS_MESSAGES.shellFeature, "bad-request");
      const empty = createAcpProvider(configWith({ provider: "acp", acpAgent: "custom", acpCommand: "" }), { workspaceRoot: f.root });
      expect(empty.destination.endpoint).toBe("");
      expect(await empty.check()).toEqual({ ready: false, problem: "misconfigured", message: ACP_MESSAGES.customMissing });
      const missing = createAcpProvider(configWith({ provider: "acp", acpAgent: "custom", acpCommand: "/nonexistent/agent acp" }), { workspaceRoot: f.root });
      expect(await missing.check()).toEqual({ ready: false, problem: "missing-binary", message: ACP_MESSAGES.customNotFound });
    });
  }, 20_000);

  test("a missing agent is reported without spawning anything", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, []);
      const provider = createAcpProvider(configWith({ provider: "acp", acpAgent: "kiro" }), { env: { PATH: f.bin }, workspaceRoot: f.root });
      expect(await provider.check()).toEqual({ ready: false, problem: "missing-binary", message: acpNotFoundMessage(ACP_AGENTS.kiro) });
      await expectProviderError(provider.run(chatRequest()), acpNotFoundMessage(ACP_AGENTS.kiro), "unavailable");
      expect(provider.destination).toMatchObject({ id: "acp:kiro", endpoint: "kiro-cli", subscription: "plano do Kiro" });
      await expect(fs.readdir(f.root)).rejects.toThrow();
    });
  });

  test("an agent whose tools cannot be switched off never starts until the user accepted that agent", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, ["codex-acp", "goose"]);
      // Accepted for another agent only: Codex is still refused.
      const config = configWith({ provider: "acp", acpAgent: "codex", agentToolsAccepted: ["acp:opencode", "cli:codex"] });
      const provider = createAcpProvider(config, { env: f.env("normal"), workspaceRoot: f.root, timeouts: fast });
      expect(await provider.check()).toEqual({ ready: false, problem: "misconfigured", message: COMMON_PROVIDER_MESSAGES.toolsNotAccepted });
      await expectProviderError(provider.run(chatRequest()), COMMON_PROVIDER_MESSAGES.toolsNotAccepted, "bad-request");
      expect(existsSync(f.log)).toBe(false);
      await expect(fs.readdir(f.root)).rejects.toThrow();
      // goose runs in its "chat" mode, which has no tools: no acceptance needed.
      const goose = createAcpProvider(configWith({ provider: "acp", acpAgent: "goose", agentToolsAccepted: [] }), { env: f.env("normal"), workspaceRoot: f.root, timeouts: fast });
      expect(await goose.check()).toEqual({ ready: true });
      expect((await goose.run(chatRequest())).text).toBe("Olá, mundo.");
    });
  }, 20_000);

  test("authentication required (-32000) names the agent's login command", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir, ["codex-acp", "claude-agent-acp"]);
      await expectProviderError(codex(f, "auth").run(chatRequest()), acpAuthMessage(ACP_AGENTS.codex), "auth");
      expect(acpAuthMessage(ACP_AGENTS.codex)).toContain("`codex login`");
      await expectProviderError(codex(f, "prompt-auth").run(chatRequest()), acpAuthMessage(ACP_AGENTS.codex), "auth");
      const claude = createAcpProvider(configWith({ provider: "acp", acpAgent: "claude" }), { env: f.env("auth"), workspaceRoot: f.root, timeouts: fast });
      await expectProviderError(claude.run(chatRequest()), acpAuthMessage(ACP_AGENTS.claude), "auth");
      expect(acpAuthMessage(ACP_AGENTS.claude)).toContain("--console");
    });
  }, 20_000);

  test("protocol problems: wrong version, crash, silent exit, stray output, odd stop reasons", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      await expectProviderError(codex(f, "bad-version").run(chatRequest()), acpVersionMessage("Codex"), "protocol");
      await expectProviderError(codex(f, "crash").run(chatRequest()), acpExitedMessage("Codex"), "unavailable");
      await expectProviderError(codex(f, "exit-silently").run(chatRequest()), acpExitedMessage("Codex"), "unavailable");
      expect((await codex(f, "garbage").run(chatRequest())).text).toBe("Olá, mundo.");
      expect((await codex(f, "stderr-flood").run(chatRequest())).text).toBe("Olá, mundo.");
      expect(await codex(f, "max-tokens").run(chatRequest())).toMatchObject({ stopReason: "length" });
      expect(await codex(f, "refusal").run(chatRequest())).toMatchObject({ stopReason: "refusal" });
      expect(await codex(f, "odd-stop").run(chatRequest())).toMatchObject({ text: "Olá, mundo.", stopReason: "end" });
      expect(await codex(f, "no-stop").run(chatRequest())).toMatchObject({ text: "Olá, mundo.", stopReason: "end" });
      expect(acpProtocolMessage("Codex")).toBe("O agente Codex respondeu fora do protocolo ACP.");
    });
  }, 30_000);

  test("cancel sends session/cancel, answers late permissions with cancelled, and stops the process tree", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const controller = new AbortController();
      const request = chatRequest({ signal: controller.signal });
      const running = codex(f, "tree").run(request);
      await waitFor(async () => event(await readLog(f.log), "waiting") !== undefined, 10_000);
      controller.abort();
      await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      expect(request.deltas).toEqual(["Olá, ", "mundo."]);
      const log = await readLog(f.log);
      expect(received(log, "session/cancel")).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess-1" } }]);
      expect(responseOf(log, "permission-after-cancel").result).toEqual({ outcome: { outcome: "cancelled" } });
      // The helper the agent started is stopped with it.
      const helper = event(log, "child")?.pid as number;
      await waitFor(() => processGone(helper));
      expect(await processGone(event(log, "start")?.pid as number)).toBe(true);
      expect(await fs.readdir(f.root)).toEqual([]);
    });
  }, 20_000);

  test("an agent that ignores the cancel is killed after the grace period", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const controller = new AbortController();
      const running = codex(f, "ignore-cancel", { cancelGraceMs: 200, killGraceMs: 200 }).run(chatRequest({ signal: controller.signal }));
      await waitFor(async () => event(await readLog(f.log), "waiting") !== undefined, 10_000);
      const started = Date.now();
      controller.abort();
      await expectProviderError(running, COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      expect(Date.now() - started).toBeLessThan(3_000);
      const log = await readLog(f.log);
      expect(event(log, "cancel-received")).toBeDefined();
      await waitFor(() => processGone(event(log, "start")?.pid as number));
    });
  }, 20_000);

  test("an answer past the size limit is cut, and the agent is asked to stop", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const request = chatRequest();
      const result = await codex(f, "flood").run(request);
      expect(result.stopReason).toBe("length");
      expect(result.text.length).toBeLessThanOrEqual(MAX_ANSWER_CHARACTERS);
      expect(result.text.startsWith("Olá, mundo.")).toBe(true);
      expect(request.deltas.join("")).toBe(result.text);
      expect(received(await readLog(f.log), "session/cancel")).toHaveLength(1);
    });
  }, 20_000);

  test("after an overflow, an agent that ignores the cancel is stopped and the cut answer returned", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const started = Date.now();
      const result = await codex(f, "flood-ignore", { cancelGraceMs: 200, killGraceMs: 200 }).run(chatRequest());
      expect(result.stopReason).toBe("length");
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(async () => processGone(event(await readLog(f.log), "start")?.pid as number));
    });
  }, 20_000);

  test("timeouts: a stalled start and a turn that runs too long", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      await expectProviderError(codex(f, "stall-init", { startMs: 300 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      await fs.rm(f.log, { force: true });
      await expectProviderError(codex(f, "slow", { totalMs: 1_500 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      // The turn was cancelled politely before the agent was stopped.
      expect(received(await readLog(f.log), "session/cancel")).toHaveLength(1);
      await expectProviderError(codex(f, "slow", { idleMs: 400 }).run(chatRequest()), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
    });
  }, 30_000);

  test("a wedged agent that stopped reading a large prompt is still stopped when the turn times out", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      // Far more than a pipe holds, so writing the prompt blocks while the agent does not read.
      const request = chatRequest({ system: `Instruções. ${"contexto da reunião ".repeat(90_000)}` });
      const started = Date.now();
      await expectProviderError(codex(f, "stuck", { idleMs: 400, cancelGraceMs: 300, killGraceMs: 300 }).run(request), COMMON_PROVIDER_MESSAGES.timeout, "timeout");
      // The agent stays stuck for 30 s: returning well before that means it was stopped, not waited for.
      expect(Date.now() - started).toBeLessThan(8_000);
      const log = await readLog(f.log);
      expect(event(log, "stuck")).toBeDefined();
      expect(event(log, "unstuck")).toBeUndefined();
      await waitFor(() => processGone(event(log, "start")?.pid as number));
      expect(await fs.readdir(f.root)).toEqual([]);
    });
  }, 20_000);

  test("an already-cancelled request and a prefilled conversation never start the agent", async () => {
    await withTempDir(async (dir) => {
      const f = await fixture(dir);
      const controller = new AbortController();
      controller.abort();
      await expectProviderError(codex(f, "normal").run(chatRequest({ signal: controller.signal })), COMMON_PROVIDER_MESSAGES.cancelled, "cancelled");
      await expectProviderError(codex(f, "normal").run(chatRequest({ messages: [{ role: "assistant", content: "x" }] })), COMMON_PROVIDER_MESSAGES.lastNotUser, "bad-request");
      expect(event(await readLog(f.log), "start")).toBeUndefined();
    });
  }, 20_000);
});

describe("ACP helpers", () => {
  test("choosePermissionOutcome prefers reject_once, then reject_always, else cancelled", () => {
    const options = (kinds: string[]) => ({ options: kinds.map((kind, index) => ({ optionId: `o${index}`, kind })) });
    expect(choosePermissionOutcome(options(["allow_once", "reject_always", "reject_once"]), false)).toEqual({ outcome: { outcome: "selected", optionId: "o2" } });
    expect(choosePermissionOutcome(options(["allow_always", "reject_always"]), false)).toEqual({ outcome: { outcome: "selected", optionId: "o1" } });
    expect(choosePermissionOutcome(options(["allow_once", "allow_always"]), false)).toEqual({ outcome: { outcome: "cancelled" } });
    expect(choosePermissionOutcome(options(["reject_once"]), true)).toEqual({ outcome: { outcome: "cancelled" } });
    for (const malformed of [undefined, null, "x", { options: "x" }, { options: [{ kind: "reject_once" }] }, { options: [{ kind: "reject_once", optionId: "" }] }, { options: [{ kind: "reject_once", optionId: "x".repeat(501) }] }]) {
      expect(choosePermissionOutcome(malformed, false)).toEqual({ outcome: { outcome: "cancelled" } });
    }
  });

  test("restrictiveModeRequest picks the most restrictive mode a real agent offers", () => {
    expect(RESTRICTIVE_MODE_IDS).toEqual(["read-only", "ask", "chat", "plan"]);
    const legacy = (current: string, ids: string[]) => ({ modes: { currentModeId: current, availableModes: ids.map((id) => ({ id, name: id })) } });
    // codex-acp, Claude Agent, Cursor, Gemini CLI (its plan mode is optional).
    expect(restrictiveModeRequest(legacy("agent", ["read-only", "workspace-write", "agent", "agent-full-access"]), "s")).toEqual({ method: "session/set_mode", params: { sessionId: "s", modeId: "read-only" } });
    expect(restrictiveModeRequest(legacy("bypassPermissions", ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]), "s")?.params).toEqual({ sessionId: "s", modeId: "plan" });
    expect(restrictiveModeRequest(legacy("agent", ["agent", "plan", "ask"]), "s")?.params).toEqual({ sessionId: "s", modeId: "ask" });
    expect(restrictiveModeRequest(legacy("default", ["default", "autoEdit", "yolo"]), "s")).toBeUndefined();
    expect(restrictiveModeRequest(legacy("plan", ["default", "plan"]), "s")).toBeUndefined();
    // The "mode" config option wins over the older modes; other categories are ignored.
    const config = {
      ...legacy("auto", ["auto", "plan"]),
      configOptions: [
        { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "plan" }] },
        { id: "permission", category: "mode", type: "select", currentValue: "auto", options: [{ value: "auto" }, { value: "plan" }] }
      ]
    };
    expect(restrictiveModeRequest(config, "s")).toEqual({ method: "session/set_config_option", params: { sessionId: "s", configId: "permission", value: "plan" } });
    for (const odd of [{}, { modes: "x" }, { modes: { availableModes: [null, 3, { id: 4 }] } }, { configOptions: [{ category: "mode", type: "boolean", id: "m", currentValue: true }] }]) {
      expect(restrictiveModeRequest(odd, "s")).toBeUndefined();
    }
  });

  test("resolveAcpAgent gives argv for presets and parsed custom commands", () => {
    expect(resolveAcpAgent(configWith({ acpAgent: "opencode" }))).toMatchObject({ argv: ["opencode", "acp"], label: "OpenCode" });
    expect(resolveAcpAgent(configWith({ acpAgent: "copilot" }))).toMatchObject({ argv: ["copilot", "--acp"] });
    expect(resolveAcpAgent(configWith({ acpAgent: "cursor" }))).toMatchObject({ argv: ["cursor-agent", "acp"] });
    expect(resolveAcpAgent(configWith({ acpAgent: "custom", acpCommand: "~/bin/agent --acp" }), "/home/ana")).toMatchObject({ argv: ["/home/ana/bin/agent", "--acp"] });
    expect(resolveAcpAgent(configWith({ acpAgent: "custom", acpCommand: "X=1 agent" }))).toEqual({ error: SHELL_WORDS_MESSAGES.environment });
  });

  test("destinations name the plan each agent uses, and the known errors cover every agent", () => {
    for (const [agent, preset] of Object.entries(ACP_AGENTS)) {
      const provider = createAcpProvider(configWith({ provider: "acp", acpAgent: agent as never }));
      expect(provider.destination).toEqual({
        kind: "acp",
        id: `acp:${agent}`,
        label: `${preset.label} (ACP)`,
        endpoint: preset.command,
        model: "",
        external: true,
        ...(preset.subscription ? { subscription: preset.subscription } : {})
      });
      expect(ACP_KNOWN_ERRORS).toContain(acpNotFoundMessage(preset));
      expect(ACP_KNOWN_ERRORS).toContain(acpAuthMessage(preset));
      expect(ACP_KNOWN_ERRORS).toContain(acpFailedMessage(preset.label));
    }
    expect(ACP_AGENTS.codex.subscription).toBe("plano do ChatGPT via Codex");
    expect(ACP_AGENTS.claude.subscription).toBeUndefined();
    expect(ACP_KNOWN_ERRORS).toContain(acpExitedMessage("ACP personalizado"));
  });
});
