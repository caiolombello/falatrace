import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_MESSAGES, SHARE_WARNINGS, renderShare, type ShareNote } from "../../share/render";
import { copyToSystemClipboard, deliverClipboard, privateShareDir, pruneShareDir, runWithInput, type RunWithInput } from "../clipboard";
import { DeliveryLog } from "../log";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const note: ShareNote = {
  jobId: JOB,
  title: "Daily",
  date: "2026-10-25T09:00:00.000Z",
  people: [],
  overview: "Short summary.",
  decisions: [],
  actions: [],
  link: `falatrace://recording/${JOB}`
};
const share = (frontmatter = false) => renderShare(note, { frontmatter, language: "pt-BR", include: "summary", timeZone: "UTC" });

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-clipboard-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const recorder = (failing: string[] = []) => {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const run: RunWithInput = async (command, args, input) => {
    calls.push({ command, args, input });
    if (failing.includes(command)) throw new Error(`${command} missing`);
  };
  return { calls, run };
};

describe("deliverClipboard", () => {
  test("return mode hands the content back for the Studio, running nothing", async () => {
    const { calls, run } = recorder();
    const content = share(true);
    const receipt = await deliverClipboard({ share: content, mode: "return" }, { run, log: new DeliveryLog({ dir: join(root, "log") }) });
    expect(receipt).toMatchObject({ destination: "clipboard", result: "returned", content: content.markdown, target: "clipboard" });
    expect(calls).toEqual([]);
    expect((await new DeliveryLog({ dir: join(root, "log") }).read(JOB))[0].result).toBe("returned");
  });

  test("system mode tries wl-copy, then xclip, then xsel, as the session allows", async () => {
    const wayland = recorder();
    const content = share();
    const receipt = await deliverClipboard({ share: content, mode: "system" }, { run: wayland.run, env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } });
    expect(receipt).toMatchObject({ result: "copied", target: "clipboard:wl-copy" });
    expect(wayland.calls).toEqual([{ command: "wl-copy", args: ["--type", "text/plain;charset=utf-8"], input: content.markdown }]);

    const fallback = recorder(["wl-copy"]);
    expect((await deliverClipboard({ share: content, mode: "system" }, { run: fallback.run, env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0" } })).target).toBe("clipboard:xclip");
    expect(fallback.calls.map((call) => call.command)).toEqual(["wl-copy", "xclip"]);
    expect(fallback.calls[1].args).toEqual(["-selection", "clipboard"]);

    const x11 = recorder(["xclip"]);
    expect((await deliverClipboard({ share: content, mode: "system" }, { run: x11.run, env: { DISPLAY: ":0" } })).target).toBe("clipboard:xsel");
    expect(x11.calls.map((call) => call.command)).toEqual(["xclip", "xsel"]);
  });

  test("without a working clipboard the content goes to a private file", async () => {
    const { calls, run } = recorder(["wl-copy", "xclip", "xsel"]);
    const runtime = join(root, "runtime");
    await fs.mkdir(runtime, { mode: 0o700 });
    const content = share();
    const receipt = await deliverClipboard({ share: content, mode: "system" }, { run, env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0", XDG_RUNTIME_DIR: runtime } });
    expect(calls.length).toBe(3);
    expect(receipt.result).toBe("saved");
    expect(receipt.warnings).toEqual([SHARE_WARNINGS.clipboardUnavailable]);
    const path = receipt.location as string;
    expect(path.startsWith(join(runtime, "recording-cli", "share"))).toBe(true);
    expect(await fs.readFile(path, "utf8")).toBe(content.markdown);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(runtime, "recording-cli", "share"))).mode & 0o777).toBe(0o700);
  });

  test("no display at all skips the tools", async () => {
    const { calls, run } = recorder();
    const receipt = await deliverClipboard({ share: share(), mode: "system" }, { run, env: {}, fileDir: await fs.mkdtemp(join(root, "files-")) });
    expect(calls).toEqual([]);
    expect(receipt.result).toBe("saved");
  });

  test("when even the file cannot be written the error says so", async () => {
    const { run } = recorder(["wl-copy", "xclip", "xsel"]);
    await expect(deliverClipboard({ share: share(), mode: "system" }, { run, env: { DISPLAY: ":0" }, fileDir: join(root, "missing", "dir") })).rejects.toThrow(SHARE_MESSAGES.clipboardFailed);
  });

  test("refuses an unknown mode", async () => {
    await expect(deliverClipboard({ share: share(), mode: "x" as never })).rejects.toThrow(SHARE_MESSAGES.invalidOptions);
  });
});

describe("desktop helpers", () => {
  test("runWithInput feeds stdin and reports failures", async () => {
    const out = join(root, "out.txt");
    await runWithInput("/bin/sh", ["-c", 'cat > "$0"', out], "olá\nmundo", { timeoutMs: 5_000 });
    expect(await fs.readFile(out, "utf8")).toBe("olá\nmundo");
    await expect(runWithInput("/bin/sh", ["-c", "exit 3"], "", { timeoutMs: 5_000 })).rejects.toThrow("exited with 3");
    await expect(runWithInput(join(root, "no-such-tool"), [], "", { timeoutMs: 5_000 })).rejects.toThrow();
    const started = Date.now();
    await expect(runWithInput("/bin/sh", ["-c", "sleep 5"], "", { timeoutMs: 100 })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("copyToSystemClipboard returns undefined when nothing works", async () => {
    expect(await copyToSystemClipboard("x", { run: recorder(["wl-copy"]).run, env: { WAYLAND_DISPLAY: "w" } })).toBeUndefined();
  });

  test("privateShareDir prefers XDG_RUNTIME_DIR and falls back to the state folder", async () => {
    const runtime = join(root, "runtime");
    await fs.mkdir(runtime, { mode: 0o700 });
    expect(await privateShareDir("handoff", { XDG_RUNTIME_DIR: runtime })).toBe(join(runtime, "recording-cli", "handoff"));
    const state = join(root, "state");
    expect(await privateShareDir("handoff", { XDG_STATE_HOME: state })).toBe(join(state, "recording-cli", "handoff"));
    expect(await privateShareDir("share", { XDG_RUNTIME_DIR: join(root, "missing"), XDG_STATE_HOME: state })).toBe(join(state, "recording-cli", "share"));
    await fs.symlink(runtime, join(root, "runtime-link"));
    expect(await privateShareDir("share", { XDG_RUNTIME_DIR: join(root, "runtime-link"), XDG_STATE_HOME: state })).toBe(join(state, "recording-cli", "share"));
    expect(await privateShareDir("share", { XDG_RUNTIME_DIR: "relative", XDG_STATE_HOME: state })).toBe(join(state, "recording-cli", "share"));
  });

  test("privateShareDir refuses a symlinked component and tightens permissions", async () => {
    const runtime = join(root, "runtime");
    await fs.mkdir(runtime, { mode: 0o700 });
    const elsewhere = join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, join(runtime, "recording-cli"));
    await expect(privateShareDir("share", { XDG_RUNTIME_DIR: runtime })).rejects.toThrow(SHARE_MESSAGES.handoffFailed);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    const other = join(root, "runtime2");
    await fs.mkdir(join(other, "recording-cli", "share"), { recursive: true, mode: 0o755 });
    await fs.chmod(join(other, "recording-cli", "share"), 0o755);
    const dir = await privateShareDir("share", { XDG_RUNTIME_DIR: other });
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("pruneShareDir keeps the newest files and drops day-old ones", async () => {
    const dir = join(root, "prune");
    await fs.mkdir(dir);
    const now = new Date();
    const names: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const name = `${crypto.randomUUID()}.md`;
      names.push(name);
      await fs.writeFile(join(dir, name), "x");
      const time = new Date(now.getTime() - (55 - index) * 1000);
      await fs.utimes(join(dir, name), time, time);
    }
    const old = `${crypto.randomUUID()}.md`;
    await fs.writeFile(join(dir, old), "x");
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    await fs.utimes(join(dir, old), twoDaysAgo, twoDaysAgo);
    await fs.writeFile(join(dir, "keep-me.txt"), "x");
    await pruneShareDir(dir, now);
    const left = await fs.readdir(dir);
    expect(left).toContain("keep-me.txt");
    expect(left).not.toContain(old);
    expect(left.length).toBe(51);
    expect(left).not.toContain(names[0]);
    expect(left).toContain(names[54]);
  });
});
