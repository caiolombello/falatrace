import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ASSISTANT_TOOL_AGENTS, DEFAULT_CONFIG } from "../../config/defaults";
import {
  agentToolsNotAccepted,
  CHILD_ENVIRONMENT_NAMES,
  COMMON_PROVIDER_MESSAGES,
  childEnvironment,
  createPrivateWorkspace,
  Deadline,
  defaultSpawn,
  defaultWorkspaceRoot,
  flattenConversation,
  INTERNAL_SECRET_NAMES,
  MAX_REQUEST_CHARACTERS,
  opencodeLockdown,
  opencodePermissions,
  publicEndpoint,
  readBounded,
  readLines,
  runCaptured,
  validateChatRequest
} from "../providers/common";
import { ProviderError } from "../types";
import { chatRequest, processGone, streamOf, waitFor, withTempDir } from "./provider-helpers";

const collect = async (stream: ReadableStream<Uint8Array>, maxLineBytes = 1024, signal?: AbortSignal): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of readLines(stream, { maxLineBytes, signal })) lines.push(line);
  return lines;
};

describe("validateChatRequest", () => {
  test("accepts a conversation that ends with a question", () => {
    expect(() => validateChatRequest(chatRequest())).not.toThrow();
  });

  test("refuses empty, malformed, prefilled and oversized requests", () => {
    const expectCode = (patch: Parameters<typeof chatRequest>[0], message: string) => {
      try {
        validateChatRequest(chatRequest(patch));
        throw new Error("expected a failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).code).toBe("bad-request");
        expect((error as Error).message).toBe(message);
      }
    };
    expectCode({ messages: [] }, COMMON_PROVIDER_MESSAGES.emptyConversation);
    expectCode({ messages: [{ role: "system" as never, content: "x" }] }, COMMON_PROVIDER_MESSAGES.emptyConversation);
    expectCode({ messages: [{ role: "user", content: 1 as never }] }, COMMON_PROVIDER_MESSAGES.emptyConversation);
    expectCode({ system: undefined as never }, COMMON_PROVIDER_MESSAGES.emptyConversation);
    expectCode({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "prefill" }] }, COMMON_PROVIDER_MESSAGES.lastNotUser);
    expectCode({ messages: [{ role: "user", content: "   " }] }, COMMON_PROVIDER_MESSAGES.lastNotUser);
    expectCode({ messages: Array.from({ length: 401 }, () => ({ role: "user" as const, content: "q" })) }, COMMON_PROVIDER_MESSAGES.requestTooLarge);
    expectCode({ system: "x".repeat(MAX_REQUEST_CHARACTERS), messages: [{ role: "user", content: "q" }] }, COMMON_PROVIDER_MESSAGES.requestTooLarge);
  });
});

describe("Deadline", () => {
  test("tells a caller abort from a timeout", async () => {
    const parent = new AbortController();
    const cancelled = new Deadline(parent.signal, { totalMs: 10_000 });
    parent.abort();
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.fired).toBe("cancelled");
    expect(cancelled.failure()?.code).toBe("cancelled");
    cancelled.dispose();

    const total = new Deadline(undefined, { totalMs: 20 });
    await waitFor(() => total.signal.aborted);
    expect(total.failure()?.code).toBe("timeout");
    expect(() => total.throwIfFired()).toThrow(COMMON_PROVIDER_MESSAGES.timeout);
    total.dispose();

    const already = new AbortController();
    already.abort();
    expect(new Deadline(already.signal, { totalMs: 10_000 }).fired).toBe("cancelled");
  });

  test("the idle timer restarts on activity and fires on silence", async () => {
    const deadline = new Deadline(undefined, { totalMs: 10_000, idleMs: 60 });
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(25);
      deadline.touch();
    }
    expect(deadline.fired).toBeUndefined();
    await waitFor(() => deadline.fired === "timeout");
    deadline.dispose();
  });

  test("dispose stops timers and detaches from the parent", async () => {
    const parent = new AbortController();
    const deadline = new Deadline(parent.signal, { totalMs: 20, idleMs: 20 });
    deadline.dispose();
    await Bun.sleep(40);
    parent.abort();
    expect(deadline.fired).toBeUndefined();
  });
});

describe("stream readers", () => {
  test("readLines handles CRLF, split chunks, multibyte characters and a final line without newline", async () => {
    const bytes = new TextEncoder().encode("ação\r\nsegunda linha\n\nfim");
    const pieces = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      }
    });
    expect(await collect(stream)).toEqual(["ação", "segunda linha", "", "fim"]);
  });

  test("readLines refuses a line longer than the limit", async () => {
    await expect(collect(streamOf(["x".repeat(2000)]), 100)).rejects.toThrow(COMMON_PROVIDER_MESSAGES.malformedStream);
  });

  test("readLines stops when the signal aborts, even if the stream hangs", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const reading = (async () => {
      for await (const line of readLines(streamOf(["um\n"], { hangAfter: true }), { maxLineBytes: 100, signal: controller.signal })) lines.push(line);
    })();
    await waitFor(() => lines.length === 1);
    controller.abort();
    await reading;
    expect(lines).toEqual(["um"]);
  });

  test("readBounded keeps the head or the tail within the limit", async () => {
    expect(await readBounded(streamOf(["abc", "def", "ghi"]), 5)).toEqual({ text: "abcde", truncated: true });
    expect(await readBounded(streamOf(["abc", "def", "ghi"]), 4, "tail")).toEqual({ text: "fghi", truncated: true });
    expect(await readBounded(streamOf(["abc"]), 10)).toEqual({ text: "abc", truncated: false });
    expect(await readBounded(undefined, 10)).toEqual({ text: "", truncated: false });
  });

  test("readBounded streams only accepted bytes to its callback", async () => {
    const chunks: Uint8Array[] = [];
    const result = await readBounded(streamOf(["abc", "def", "ghi"]), 5, "head", { onChunk: (chunk) => { chunks.push(chunk); } });
    expect(Buffer.concat(chunks).toString()).toBe("abcde");
    expect(result).toEqual({ text: "abcde", truncated: true });
  });

  test("readBounded with stopWhenFull cancels a body that never ends", async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("0123456789"));
      },
      cancel() {
        cancelled = true;
      }
    });
    expect(await readBounded(endless, 25, "head", { stopWhenFull: true })).toEqual({ text: "0123456789012345678901234", truncated: true });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
    // Exactly full is not cut.
    expect(await readBounded(streamOf(["abc", "de"]), 5, "head", { stopWhenFull: true })).toEqual({ text: "abcde", truncated: false });
  });
});

describe("text helpers", () => {
  test("flattenConversation fences instructions and turns with a random boundary", () => {
    const request = chatRequest();
    const text = flattenConversation(request.system, request.messages, "abc123");
    expect(text.startsWith("<falatrace-instructions-abc123>\nYou answer questions about meetings.")).toBe(true);
    expect(text).toContain("</falatrace-instructions-abc123>");
    expect(text).toContain("User:\nPrimeira pergunta?\n\nAssistant:\nPrimeira resposta.\n\nUser:\nQuem decidiu o prazo?");
    expect(text).toContain("</falatrace-conversation-abc123>");
    expect(text.trimEnd().endsWith("Do not use tools.")).toBe(true);
    const random = flattenConversation("s", [{ role: "user", content: "q" }]);
    expect(random).toMatch(/^<falatrace-instructions-[0-9a-f]{12}>/);
    expect(flattenConversation("s", [{ role: "user", content: "q" }])).not.toBe(random);
  });

  test("publicEndpoint drops credentials, query and fragment", () => {
    expect(publicEndpoint(new URL("https://user:secret@example.com:8443/api/v1?key=abc#frag"))).toBe("https://example.com:8443/api/v1");
  });

  test("childEnvironment keeps the user's home, path and locale and turns colours off", () => {
    expect(childEnvironment({ PATH: "/bin", HOME: "/home/ana", LC_TIME: "pt_BR.UTF-8" })).toEqual({ PATH: "/bin", HOME: "/home/ana", LC_TIME: "pt_BR.UTF-8", NO_COLOR: "1" });
  });

  test("childEnvironment drops FalaTrace's internal secrets but keeps the user's provider keys", () => {
    const env = { PATH: "/bin", OPENAI_API_KEY: "sk-user", ANTHROPIC_API_KEY: "sk-ant-user" } as Record<string, string>;
    for (const name of INTERNAL_SECRET_NAMES) env[name] = `value-of-${name}`;
    const child = childEnvironment(env);
    for (const name of INTERNAL_SECRET_NAMES) expect(child[name]).toBeUndefined();
    expect(child).toEqual({ PATH: "/bin", OPENAI_API_KEY: "sk-user", ANTHROPIC_API_KEY: "sk-ant-user", NO_COLOR: "1" });
    expect(INTERNAL_SECRET_NAMES).toEqual(["RECORDING_CLI_OBS_PASSWORD", "GOOGLE_CLIENT_SECRET", "NOTION_TOKEN", "SLACK_WEBHOOK_URL", "CUSTOM_API_KEY"]);
  });

  test("childEnvironment is minimal: ssh/gpg agents, the display and other programs' settings stay out; a lockdown wins over the user's values", () => {
    const env = {
      PATH: "/bin", HOME: "/home/ana", XDG_CONFIG_HOME: "/home/ana/.config", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", HTTPS_PROXY: "http://proxy:3128",
      SSH_AUTH_SOCK: "/run/user/1000/ssh", SSH_AGENT_PID: "42", GPG_AGENT_INFO: "/run/user/1000/gnupg", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0",
      NPM_CONFIG_USERCONFIG: "/home/ana/.npmrc", DATABASE_URL: "postgres://placeholder", RECORDING_CLI_CONFIG: "/home/ana/c.json", LD_PRELOAD: "/tmp/x.so", NODE_OPTIONS: "--require /tmp/x.js",
      GOOSE_MODE: "auto", GOOSE_PROVIDER: "ollama", CODEX_HOME: "/home/ana/.codex", AWS_PROFILE: "work", GH_TOKEN: "placeholder-token"
    };
    expect(childEnvironment(env, { GOOSE_MODE: "chat" })).toEqual({
      PATH: "/bin", HOME: "/home/ana", XDG_CONFIG_HOME: "/home/ana/.config", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", HTTPS_PROXY: "http://proxy:3128",
      GOOSE_MODE: "chat", GOOSE_PROVIDER: "ollama", CODEX_HOME: "/home/ana/.codex", AWS_PROFILE: "work", GH_TOKEN: "placeholder-token", NO_COLOR: "1"
    });
    for (const name of ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DISPLAY", "LD_PRELOAD", "NODE_OPTIONS"]) expect(CHILD_ENVIRONMENT_NAMES).not.toContain(name);
  });

  test("agents whose tools FalaTrace cannot switch off need the user's acceptance, one by one", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(agentToolsNotAccepted(config, "acp:codex")).toBe(true);
    expect(agentToolsNotAccepted(config, "cli:opencode")).toBe(true);
    // Tools switched off by the agent's own settings: goose in chat mode, the claude CLI with --tools "".
    expect(agentToolsNotAccepted(config, "acp:goose")).toBe(false);
    expect(agentToolsNotAccepted(config, "cli:claude")).toBe(false);
    expect(agentToolsNotAccepted(config, "api:openrouter")).toBe(false);
    config.assistant.agentToolsAccepted = ["acp:codex"];
    expect(agentToolsNotAccepted(config, "acp:codex")).toBe(false);
    expect(agentToolsNotAccepted(config, "cli:codex")).toBe(true);
    expect(COMMON_PROVIDER_MESSAGES.toolsNotAccepted).toContain("Configurações › Perguntar e receitas");
  });

  test("the Studio asks for the OK on exactly the agents that need it", async () => {
    const qml = await fs.readFile(join(import.meta.dir, "..", "..", "desktop", "SettingsAssistantPage.qml"), "utf8");
    const listed = /readonly property var toolAgents: (\[[^\]]*\])/.exec(qml)?.[1];
    expect(JSON.parse(listed ?? "[]")).toEqual([...ASSISTANT_TOOL_AGENTS]);
  });

  test("OpenCode permissions name '*' first and then every built-in tool, so no rule of the user's comes after them", () => {
    const deny = opencodePermissions("deny");
    const tools = ["read", "edit", "glob", "grep", "list", "bash", "task", "todowrite", "skill", "lsp", "question", "webfetch", "websearch", "external_directory", "doom_loop"];
    expect(Object.keys(deny)).toEqual(["*", ...tools]);
    expect(new Set(Object.values(deny))).toEqual(new Set(["deny"]));
    // At the terminal the user approves commands, edits, web access and other folders; reading stays free.
    const ask = opencodePermissions("ask");
    expect(Object.keys(ask)).toEqual(["*", ...tools]);
    for (const tool of ["*", "edit", "bash", "task", "skill", "webfetch", "websearch", "external_directory", "doom_loop"]) expect(ask[tool]).toBe("ask");
    for (const tool of ["read", "glob", "grep", "list", "lsp", "todowrite", "question"]) expect(ask[tool]).toBe("allow");
    expect(opencodeLockdown("deny")).toEqual({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: deny }), OPENCODE_PERMISSION: JSON.stringify(deny) });
  });
});

describe("private workspaces", () => {
  test("the default root is the runtime dir, else the state dir, never a shared temp dir", () => {
    expect(defaultWorkspaceRoot({ XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/ana" })).toBe("/run/user/1000/recording-cli/assistant");
    expect(defaultWorkspaceRoot({ XDG_STATE_HOME: "/home/ana/.state", HOME: "/home/ana" })).toBe("/home/ana/.state/recording-cli/assistant-work");
    expect(defaultWorkspaceRoot({ HOME: "/home/ana" })).toBe("/home/ana/.local/state/recording-cli/assistant-work");
    expect(defaultWorkspaceRoot({ XDG_RUNTIME_DIR: "relative", HOME: "/home/ana" })).toBe("/home/ana/.local/state/recording-cli/assistant-work");
  });

  test("creates empty 0700 directories, removes them, and refuses a linked root", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "root");
      const first = await createPrivateWorkspace(root);
      const second = await createPrivateWorkspace(root);
      expect(first.path).not.toBe(second.path);
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(first.path)).mode & 0o777).toBe(0o700);
      expect(await fs.readdir(first.path)).toEqual([]);
      await fs.writeFile(join(first.path, "left-behind"), "x");
      await first.remove();
      await first.remove();
      await expect(fs.stat(first.path)).rejects.toThrow();
      await second.remove();

      await fs.mkdir(join(dir, "elsewhere"));
      await fs.symlink(join(dir, "elsewhere"), join(dir, "linked"));
      await expect(createPrivateWorkspace(join(dir, "linked"))).rejects.toThrow("Unsafe assistant workspace directory");
      await expect(createPrivateWorkspace("relative/root")).rejects.toThrow();
    });
  });
});

describe("runCaptured", () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };

  test("pipes stdin, captures stdout and the exit code", async () => {
    await withTempDir(async (dir) => {
      const result = await runCaptured(defaultSpawn, ["/bin/sh", "-c", "tr a-z A-Z; echo oops >&2; exit 3"], { cwd: dir, env, input: "olá mundo", timeoutMs: 5_000 });
      expect(result).toMatchObject({ exitCode: 3, stdout: "OLá MUNDO", timedOut: false, cancelled: false });
      expect(result.stderr).toContain("oops");
      const big = "x".repeat(3 * 1024 * 1024);
      expect((await runCaptured(defaultSpawn, ["/bin/sh", "-c", "wc -c"], { cwd: dir, env, input: big, timeoutMs: 10_000 })).stdout.trim()).toBe(String(big.length));
    });
  });

  test("a timeout stops the whole process group", async () => {
    await withTempDir(async (dir) => {
      const pidFile = join(dir, "child.pid");
      const started = Date.now();
      const result = await runCaptured(defaultSpawn, ["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: dir, env, timeoutMs: 300, graceMs: 500 });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      await waitFor(() => processGone(pid));
    });
  });

  test("abort sends the configured signals in order", async () => {
    await withTempDir(async (dir) => {
      const signals = join(dir, "signals");
      const controller = new AbortController();
      const script = `trap 'echo INT >> ${signals}' INT; trap 'echo TERM >> ${signals}; exit 143' TERM; echo ready; while true; do sleep 1 & wait $!; done`;
      const running = runCaptured(defaultSpawn, ["/bin/sh", "-c", script], { cwd: dir, env, timeoutMs: 10_000, signal: controller.signal, stopSignals: ["SIGINT", "SIGTERM"], graceMs: 300 });
      await Bun.sleep(150);
      controller.abort();
      const result = await running;
      expect(result.cancelled).toBe(true);
      expect((await fs.readFile(signals, "utf8")).trim().split("\n")).toEqual(["INT", "TERM"]);
      const aborted = new AbortController();
      aborted.abort();
      expect((await runCaptured(defaultSpawn, ["/bin/true"], { cwd: dir, env, timeoutMs: 1_000, signal: aborted.signal })).cancelled).toBe(true);
    });
  });

  test("a background helper holding stdout open does not keep a finished tool waiting", async () => {
    await withTempDir(async (dir) => {
      const pidFile = join(dir, "helper.pid");
      const started = Date.now();
      const result = await runCaptured(defaultSpawn, ["/bin/sh", "-c", `(sleep 30; echo late) & echo $! > ${pidFile}; echo done`], { cwd: dir, env, timeoutMs: 10_000, graceMs: 300 });
      expect(result).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false });
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(async () => processGone(Number((await fs.readFile(pidFile, "utf8")).trim())));
    });
  });

  test("bounds what it keeps from stdout", async () => {
    await withTempDir(async (dir) => {
      const result = await runCaptured(defaultSpawn, ["/bin/sh", "-c", "head -c 100000 /dev/zero | tr '\\0' a"], { cwd: dir, env, timeoutMs: 5_000, maxOutputBytes: 1000 });
      expect(result.stdout).toHaveLength(1000);
      expect(result.truncated).toBe(true);
    });
  });
});
