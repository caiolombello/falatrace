// A fake ACP agent for tests: newline-delimited JSON-RPC 2.0 on stdio. It streams chunks,
// sends unknown update kinds, asks for permissions and calls client methods it was not
// offered, and records everything it receives in a log file (one JSON object per line).
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, statSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const mode = argValue("--mode") ?? process.env.FAKE_ACP_MODE ?? "normal";
const logFile = argValue("--log") ?? process.env.FAKE_ACP_LOG;

const log = (entry: Record<string, unknown>): void => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

log({ event: "start", argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });

let nextId = 1000;
const waiting = new Map<number, (message: Record<string, unknown>) => void>();
const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

let cancelled = false;
let onCancel: (() => void) | undefined;
const SESSION = "sess-1";
const update = (value: Record<string, unknown>, sessionId = SESSION): void => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const chunk = (text: string, messageId?: string): void => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) });

const handlePrompt = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
  log({ event: "prompt", params });
  if (mode === "prompt-auth") {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
    return;
  }
  if (mode === "crash") process.exit(3);
  if (mode === "exit-silently") {
    chunk("parcial");
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (mode === "stderr-flood") process.stderr.write("x".repeat(1024 * 1024));
  if (mode === "garbage") {
    process.stdout.write("isto não é JSON\n");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "1.0", method: "session/update" })}\n`);
    process.stdout.write("[1,2,3]\n");
  }
  update({ sessionUpdate: "available_commands_update", availableCommands: [] });
  update({ sessionUpdate: "plan", entries: [{ content: "pensar", priority: "high", status: "pending" }] });
  update({ sessionUpdate: "some_future_update_kind", payload: { anything: true } });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PENSAMENTO-OCULTO" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OUTRA-SESSAO" } }, "another-session");
  chunk("Olá, ", "m1");
  chunk("mundo.", "m1");
  if (mode === "permission") {
    const first = await request("session/request_permission", {
      sessionId: SESSION,
      toolCall: { toolCallId: "t1", title: "Ler /etc/passwd", kind: "read" },
      options: [
        { optionId: "allow", name: "Permitir", kind: "allow_once" },
        { optionId: "always", name: "Sempre", kind: "allow_always" },
        { optionId: "reject", name: "Recusar", kind: "reject_once" },
        { optionId: "never", name: "Nunca", kind: "reject_always" }
      ]
    });
    log({ event: "permission", response: first });
    const onlyAlways = await request("session/request_permission", {
      sessionId: SESSION,
      toolCall: { toolCallId: "t2", title: "Editar" },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "never", kind: "reject_always" }]
    });
    log({ event: "permission-always", response: onlyAlways });
    const noReject = await request("session/request_permission", { sessionId: SESSION, toolCall: { toolCallId: "t3" }, options: [{ optionId: "allow", kind: "allow_once" }] });
    log({ event: "permission-none", response: noReject });
    log({ event: "fs", response: await request("fs/read_text_file", { sessionId: SESSION, path: "/etc/passwd" }) });
    log({ event: "terminal", response: await request("terminal/create", { sessionId: SESSION, command: "rm", args: ["-rf", "/"] }) });
    log({ event: "unknown", response: await request("_vendor/extension", {}) });
    chunk("Sem ferramentas.", "m2");
  }
  if (mode === "slow" || mode === "tree" || mode === "ignore-cancel") {
    if (mode === "tree") {
      const helper = spawn("sleep", ["60"], { stdio: "ignore" });
      log({ event: "child", pid: helper.pid });
    }
    log({ event: "waiting" });
    await new Promise<void>((resolve) => {
      if (cancelled) resolve();
      else onCancel = resolve;
    });
    log({ event: "cancel-received" });
    if (mode === "ignore-cancel") return;
    const late = await request("session/request_permission", { sessionId: SESSION, toolCall: { toolCallId: "t9" }, options: [{ optionId: "reject", kind: "reject_once" }] });
    log({ event: "permission-after-cancel", response: late });
    send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    return;
  }
  if (mode === "flood" || mode === "flood-ignore") {
    // More than the client's answer limit (1,000,000 characters).
    for (let index = 0; index < 1_100; index += 1) chunk("x".repeat(1000));
    // flood-ignore never ends the turn, even after session/cancel.
    if (mode === "flood-ignore") return;
  }
  const stopReason = mode === "max-tokens" ? "max_tokens" : mode === "refusal" ? "refusal" : mode === "odd-stop" ? "something_new" : "end_turn";
  send({ jsonrpc: "2.0", id, result: mode === "no-stop" ? {} : { stopReason } });
};

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    log({ event: "bad-line", line });
    return;
  }
  log({ event: "recv", message });
  if (message.method === undefined && typeof message.id === "number") {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize":
      if (mode === "stall-init") return;
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: mode === "bad-version" ? 2 : 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
      return;
    case "session/new": {
      if (mode === "auth") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required", data: { reason: "login" } } });
        return;
      }
      const cwd = String(params.cwd);
      let entries: string[] = [];
      let mode700 = false;
      try {
        entries = readdirSync(cwd);
        mode700 = (statSync(cwd).mode & 0o777) === 0o700;
      } catch {
        entries = ["<missing>"];
      }
      log({ event: "cwd", cwd, entries, mode700, processCwd: process.cwd() });
      if (mode === "stuck") {
        // A wedged agent: it answers, then neither reads its input nor writes for 30 s.
        writeSync(1, `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION } })}\n`);
        log({ event: "stuck" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        log({ event: "unstuck" });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION } });
      return;
    }
    case "session/prompt":
      void handlePrompt(message.id, params);
      return;
    case "session/cancel":
      cancelled = true;
      onCancel?.();
      return;
    default:
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
lines.on("close", () => {
  log({ event: "stdin-closed" });
  if (mode !== "ignore-stdin-close" && mode !== "ignore-cancel") process.exit(0);
});
