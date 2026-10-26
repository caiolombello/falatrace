import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { opencodeLockdown } from "../../assistant/providers/common";
import { buildTerminalLaunchArgs } from "../../tray/runtime";
import { SHARE_MESSAGES, SHARE_WARNINGS, renderShare, renderTextShare, type ShareNote } from "../../share/render";
import {
  AI_WEB_URLS,
  CLAUDE_DESKTOP_URL,
  buildCliHandoffCommand,
  deliverAiApp,
  findOnPath,
  handoffPrompt,
  type AiAppDeps
} from "../ai-app";
import type { RunWithInput } from "../clipboard";
import { DeliveryLog } from "../log";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const note: ShareNote = {
  jobId: JOB,
  title: "Client call — ACME",
  date: "2026-10-25T09:00:00.000Z",
  people: ["Ana"],
  client: "ACME",
  overview: "Confidential pricing discussion: R$ 120k.",
  decisions: ["Discount of 10%"],
  actions: [],
  link: `falatrace://recording/${JOB}`
};
const share = () => renderShare(note, { frontmatter: true, language: "pt-BR", include: "summary", timeZone: "UTC" });

let root: string;
let runtime: string;
const copies: string[] = [];
const opened: string[] = [];
const run: RunWithInput = async (_command, _args, input) => {
  copies.push(input);
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-ai-"));
  runtime = join(root, "runtime");
  await fs.mkdir(runtime, { mode: 0o700 });
  copies.length = 0;
  opened.length = 0;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const deps = (extra: Partial<AiAppDeps> = {}): AiAppDeps => ({
  run,
  env: { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: runtime },
  openUrl: async (url) => { opened.push(url); },
  log: new DeliveryLog({ dir: join(root, "log") }),
  ...extra
});

describe("web apps", () => {
  for (const target of ["chatgpt-web", "claude-web", "gemini-web"] as const) {
    test(`${target}: copies the note, then opens the bare page with no meeting text`, async () => {
      const content = share();
      const receipt = await deliverAiApp({ share: content, target, clipboard: "system" }, deps());
      expect(copies).toEqual([content.body]);
      expect(opened).toEqual([AI_WEB_URLS[target]]);
      expect(opened[0]).not.toContain("?");
      expect(opened[0]).not.toContain("ACME");
      expect(receipt).toMatchObject({ destination: "ai-app", target: `ai-app:${target}`, result: "opened", url: AI_WEB_URLS[target] });
      expect(receipt.warnings).toEqual([SHARE_WARNINGS.pasteInApp]);
      expect(receipt.content).toBeUndefined();
    });
  }

  test("return mode gives the Studio the text to copy and the URL to open", async () => {
    const content = share();
    const receipt = await deliverAiApp({ share: content, target: "chatgpt-web", clipboard: "return", open: false }, deps());
    expect(copies).toEqual([]);
    expect(opened).toEqual([]);
    expect(receipt).toMatchObject({ result: "returned", content: content.body, url: "https://chatgpt.com/" });
  });

  test("an app that does not open is a warning, not a failure", async () => {
    const receipt = await deliverAiApp({ share: share(), target: "claude-web", clipboard: "system" }, deps({ openUrl: async () => { throw new Error("no browser"); } }));
    expect(receipt.result).toBe("copied");
    expect(receipt.warnings).toEqual([SHARE_WARNINGS.pasteInApp, SHARE_WARNINGS.appNotOpened]);
  });

  test("no clipboard: the note is saved privately and the page still opens", async () => {
    const receipt = await deliverAiApp({ share: share(), target: "gemini-web", clipboard: "system" }, deps({ env: { XDG_RUNTIME_DIR: runtime } }));
    expect(receipt.warnings).toContain(SHARE_WARNINGS.clipboardUnavailable);
    expect(receipt.location?.startsWith(join(runtime, "recording-cli", "share"))).toBe(true);
    expect((await fs.stat(receipt.location as string)).mode & 0o777).toBe(0o600);
    expect(opened).toEqual(["https://gemini.google.com/app"]);
  });
});

describe("Claude Desktop", () => {
  test("the note is copied and only the bare claude:// URL opens: meeting text never goes on a command line", async () => {
    const content = share();
    const receipt = await deliverAiApp({ share: content, target: "claude-desktop", clipboard: "system" }, deps());
    expect(copies).toEqual([content.body]);
    expect(opened).toEqual([CLAUDE_DESKTOP_URL]);
    expect(receipt).toMatchObject({ result: "opened", url: CLAUDE_DESKTOP_URL });
    expect(receipt.warnings).toEqual([SHARE_WARNINGS.pasteInApp]);
    // The Studio copies the returned content itself and opens the bare URL afterwards.
    const deferred = await deliverAiApp({ share: content, target: "claude-desktop", clipboard: "return", open: false }, deps());
    expect(deferred).toMatchObject({ result: "returned", content: content.body, url: CLAUDE_DESKTOP_URL });
    expect(opened).toEqual([CLAUDE_DESKTOP_URL]);
  });

  test("when Claude does not open, the note is still copied and the advice to paste it stands", async () => {
    const content = share();
    const tried: string[] = [];
    const receipt = await deliverAiApp(
      { share: content, target: "claude-desktop", clipboard: "system" },
      deps({ openUrl: async (url) => { tried.push(url); throw new Error("no handler"); } })
    );
    expect(tried).toEqual([CLAUDE_DESKTOP_URL]);
    expect(copies).toEqual([content.body]);
    expect(receipt.result).toBe("copied");
    expect(receipt.warnings).toEqual([SHARE_WARNINGS.pasteInApp, SHARE_WARNINGS.appNotOpened]);
  });
});

describe("command-line tools", () => {
  const launched: Array<{ command: string[]; cwd: string }> = [];
  const cliDeps = (extra: Partial<AiAppDeps> = {}) =>
    deps({
      which: async (binary) => `/usr/local/bin/${binary}`,
      launchTerminal: async (command, options) => { launched.push({ command, cwd: options.workingDirectory }); },
      ...extra
    });
  beforeEach(() => {
    launched.length = 0;
  });

  test("writes a private handoff file in its own folder and opens the tool there", async () => {
    const content = share();
    const receipt = await deliverAiApp({ share: content, target: "claude-cli", clipboard: "system" }, cliDeps());
    const path = receipt.location as string;
    expect(path.startsWith(join(runtime, "recording-cli", "handoff"))).toBe(true);
    expect(await fs.readFile(path, "utf8")).toBe(content.body);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(runtime, "recording-cli", "handoff"))).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(dirname(path))).toEqual([basename(path)]);
    expect(launched).toEqual([{ command: ["claude", handoffPrompt(basename(path))], cwd: dirname(path) }]);
    expect(launched[0].command[1]).toBe(`Leia o arquivo ${basename(path)} (contexto de uma reunião registrada no FalaTrace) e me ajude com ele.`);
    expect(JSON.stringify(launched)).not.toContain("ACME");
    expect(receipt).toMatchObject({ result: "opened", command: launched[0].command });
    expect(copies).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("each tool gets its own interactive command", () => {
    expect(buildCliHandoffCommand("codex-cli", "f.md")).toEqual(["codex", handoffPrompt("f.md")]);
    expect(buildCliHandoffCommand("gemini-cli", "f.md")).toEqual(["gemini", "--prompt-interactive", handoffPrompt("f.md")]);
    // OpenCode runs commands and edits without asking by default: it starts with its permissions set to ask first.
    const ask = opencodeLockdown("ask");
    expect(buildCliHandoffCommand("opencode-cli", "f.md", "en")).toEqual([
      "env",
      `OPENCODE_CONFIG_CONTENT=${ask.OPENCODE_CONFIG_CONTENT}`,
      `OPENCODE_PERMISSION=${ask.OPENCODE_PERMISSION}`,
      "opencode",
      "--prompt",
      "Read the file f.md (context from a meeting recorded in FalaTrace) and help me with it."
    ]);
    expect(JSON.parse(ask.OPENCODE_PERMISSION as string)).toMatchObject({ "*": "ask", bash: "ask", edit: "ask", webfetch: "ask", external_directory: "ask", read: "allow" });
    expect(() => buildCliHandoffCommand("chatgpt-web", "f.md")).toThrow(SHARE_MESSAGES.aiAppInvalid);
    expect(() => buildCliHandoffCommand("claude-cli", "../x.md")).toThrow(SHARE_MESSAGES.handoffFailed);
    expect(handoffPrompt("f.md", "es")).toBe("Lee el archivo f.md (contexto de una reunión registrada en FalaTrace) y ayúdame con él.");
  });

  test("separate handoffs never share a folder", async () => {
    const first = await deliverAiApp({ share: share(), target: "codex-cli", clipboard: "system" }, cliDeps());
    const second = await deliverAiApp({ share: share(), target: "codex-cli", clipboard: "system" }, cliDeps());
    expect(dirname(first.location as string)).not.toBe(dirname(second.location as string));
  });

  test("a missing tool is reported before anything is written", async () => {
    await expect(deliverAiApp({ share: share(), target: "gemini-cli", clipboard: "system" }, cliDeps({ which: async () => undefined }))).rejects.toThrow(SHARE_MESSAGES.aiToolMissing);
    expect(await fs.readdir(runtime)).toEqual([]);
  });

  test("open: false prepares the file and the command without a terminal", async () => {
    const receipt = await deliverAiApp({ share: share(), target: "opencode-cli", clipboard: "system", open: false }, cliDeps());
    expect(receipt.result).toBe("saved");
    expect(launched).toEqual([]);
    expect(receipt.command?.slice(0, 2)).toEqual(["env", `OPENCODE_CONFIG_CONTENT=${opencodeLockdown("ask").OPENCODE_CONFIG_CONTENT}`]);
    expect(receipt.command?.[3]).toBe("opencode");
  });

  test("a terminal that cannot start is a clear error", async () => {
    await expect(deliverAiApp({ share: share(), target: "claude-cli", clipboard: "system" }, cliDeps({ launchTerminal: async () => { throw new Error("no terminal"); } })))
      .rejects.toThrow(SHARE_MESSAGES.terminalFailed);
  });

  test("findOnPath finds executables only", async () => {
    const bin = join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(join(bin, "codex"), "not executable", { mode: 0o644 });
    await fs.mkdir(join(bin, "gemini"));
    expect(await findOnPath("claude", { PATH: `relative:${bin}` })).toBe(join(bin, "claude"));
    expect(await findOnPath("codex", { PATH: bin })).toBeUndefined();
    expect(await findOnPath("gemini", { PATH: bin })).toBeUndefined();
    expect(await findOnPath("claude", {})).toBeUndefined();
  });

  test("the tray terminal launcher can start in a folder; without one its arguments are unchanged", () => {
    const terminal = { path: "/usr/bin/gnome-terminal", args: ["--"] };
    const env = { PATH: "/usr/bin" };
    const plain = buildTerminalLaunchArgs(terminal, ["claude", "x"], "1", env);
    expect(plain).not.toContain("--working-directory=/run/user/1000/recording-cli/handoff/abc");
    expect(plain.some((arg) => arg.startsWith("--working-directory"))).toBe(false);
    const withDir = buildTerminalLaunchArgs(terminal, ["claude", "x"], "1", env, "/run/user/1000/recording-cli/handoff/abc");
    expect(withDir.indexOf("--working-directory=/run/user/1000/recording-cli/handoff/abc")).toBeGreaterThan(0);
    expect(withDir.indexOf("--working-directory=/run/user/1000/recording-cli/handoff/abc")).toBeLessThan(withDir.indexOf("--"));
    expect(withDir.filter((arg) => !arg.startsWith("--working-directory"))).toEqual(plain);
  });
});

test("an unknown target or clipboard mode is refused", async () => {
  await expect(deliverAiApp({ share: share(), target: "copilot-web" as never, clipboard: "system" }, deps())).rejects.toThrow(SHARE_MESSAGES.aiAppInvalid);
  await expect(deliverAiApp({ share: share(), target: "claude-web", clipboard: "both" as never }, deps())).rejects.toThrow(SHARE_MESSAGES.invalidOptions);
});

test("deliveries are logged without content", async () => {
  await deliverAiApp({ share: share(), target: "chatgpt-web", clipboard: "system" }, deps());
  const records = await new DeliveryLog({ dir: join(root, "log") }).read(JOB);
  expect(records[0]).toMatchObject({ destination: "ai-app", target: "ai-app:chatgpt-web", result: "opened" });
  expect(JSON.stringify(records)).not.toContain("ACME");
});
