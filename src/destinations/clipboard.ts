import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { runCommand } from "../jobs/command";
import { SHARE_MESSAGES, SHARE_WARNINGS, ShareError, assertRenderedShare, sha256Hex, type RenderedShare } from "../share/render";
import { recordDelivery, type DeliveryLog, type DeliveryReceipt } from "./log";

/**
 * Clipboard delivery, plus the small desktop helpers other destinations share: private folders
 * under $XDG_RUNTIME_DIR, a runner that feeds stdin, and xdg-open.
 * The Studio copies with its own clipboard ("return" mode); the CLI tries wl-copy, xclip and xsel,
 * and when none works writes a private file instead.
 */

/** Runs a command with `input` on stdin and waits for it to exit (not for its pipes: clipboard tools fork to serve the selection). */
export type RunWithInput = (command: string, args: string[], input: string, options: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<void>;

export const runWithInput: RunWithInput = (command, args, input, options) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], env: options.env });
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(new Error(`${command} timed out`));
    }, options.timeoutMs);
    child.once("error", (error) => done(error));
    child.once("exit", (code, signal) => (code === 0 ? done() : done(new Error(`${command} exited with ${signal ?? code}`))));
    // A tool that exits early closes stdin; the exit status reports the failure, not EPIPE.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input, "utf8");
  });

/** Opens a URL with the desktop's handler. */
export type OpenUrl = (url: string) => Promise<void>;

export const openUrlWithXdg: OpenUrl = async (url) => {
  await runCommand("xdg-open", [url], { timeoutMs: 15_000 });
};

export const CLIPBOARD_COMMANDS = Object.freeze([
  { command: "wl-copy", args: ["--type", "text/plain;charset=utf-8"], display: "WAYLAND_DISPLAY" },
  { command: "xclip", args: ["-selection", "clipboard"], display: "DISPLAY" },
  { command: "xsel", args: ["--clipboard", "--input"], display: "DISPLAY" }
] as const);

/** Copies with the first clipboard tool that works for this session; the tool's name, or undefined. */
export const copyToSystemClipboard = async (
  text: string,
  deps: { run?: RunWithInput; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string | undefined> => {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runWithInput;
  for (const tool of CLIPBOARD_COMMANDS) {
    if (!env[tool.display]) continue;
    try {
      await run(tool.command, [...tool.args], text, { timeoutMs: deps.timeoutMs ?? 5_000, env });
      return tool.command;
    } catch {
      // Not installed or no access to this display server: try the next tool.
    }
  }
  return undefined;
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

const isSafeDirectory = async (path: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(path);
    const uid = currentUid();
    return stat.isDirectory() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
};

/**
 * A private folder for files handed to other apps: $XDG_RUNTIME_DIR/recording-cli/<name> (memory-backed,
 * gone at logout), else $XDG_STATE_HOME/recording-cli/<name>. Every component below the base must be a
 * real folder owned by this user; the last one is made 0700.
 */
export const privateShareDir = async (name: "share" | "handoff", env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> => {
  if (!/^[a-z-]+$/.test(name)) throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
  const runtime = env.XDG_RUNTIME_DIR;
  const base = runtime && isAbsolute(runtime) && (await isSafeDirectory(runtime))
    ? runtime
    : env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  const target = join(base, "recording-cli", name);
  await ensurePrivateTree(base, target);
  return target;
};

/** Creates `target` below `base` (0700), refusing links or folders of another user on the way. */
export const ensurePrivateTree = async (base: string, target: string): Promise<void> => {
  const parts = relative(base, target).split(sep).filter(Boolean);
  if (parts.some((part) => part === "..")) throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
  await fs.mkdir(base, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await isSafeDirectory(base))) throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
    }
    if (!(await isSafeDirectory(current))) throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
  }
  await fs.chmod(target, 0o700);
};

/** Writes a new private file (0600, never following or replacing anything). */
export const writePrivateNewFile = async (path: string, text: string): Promise<void> => {
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(path, { force: true });
    throw error;
  }
  await handle.close();
};

const MAX_KEPT_FILES = 50;
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;

/** Best effort: keep the newest files of a share folder and drop day-old ones. */
export const pruneShareDir = async (dir: string, now: Date, keep = MAX_KEPT_FILES): Promise<void> => {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const entries: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (!/^[0-9a-f-]{36}(\.md)?$/.test(name)) continue;
    const path = join(dir, name);
    const stat = await fs.lstat(path).catch(() => undefined);
    if (stat && !stat.isSymbolicLink()) entries.push({ path, mtime: stat.mtimeMs });
  }
  entries.sort((left, right) => right.mtime - left.mtime);
  for (const [index, entry] of entries.entries()) {
    if (index >= keep || now.getTime() - entry.mtime > MAX_FILE_AGE_MS) await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
  }
};

export type ClipboardDeliverInput = {
  share: RenderedShare;
  /** "return": hand the text back for the Studio to copy; "system": copy here (CLI). */
  mode: "return" | "system";
};

export type ClipboardDeps = {
  run?: RunWithInput;
  env?: NodeJS.ProcessEnv;
  log?: DeliveryLog;
  now?: () => Date;
  /** Folder for the file written when no clipboard works; defaults to privateShareDir("share"). */
  fileDir?: string;
};

export const deliverClipboard = async (input: ClipboardDeliverInput, deps: ClipboardDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  if (input.mode !== "return" && input.mode !== "system") throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  const now = deps.now ?? (() => new Date());
  const content = share.markdown;
  const sha256 = sha256Hex(content);
  const at = now().toISOString();
  if (input.mode === "return") {
    const receipt: DeliveryReceipt = { at, destination: "clipboard", target: "clipboard", sha256, result: "returned", warnings: [], content };
    await recordDelivery(deps.log, share.jobId, { at, destination: "clipboard", target: "clipboard", sha256, result: "returned" });
    return receipt;
  }
  const tool = await copyToSystemClipboard(content, { run: deps.run, env: deps.env });
  if (tool) {
    await recordDelivery(deps.log, share.jobId, { at, destination: "clipboard", target: `clipboard:${tool}`, sha256, result: "copied" });
    return { at, destination: "clipboard", target: `clipboard:${tool}`, sha256, result: "copied", warnings: [] };
  }
  let path: string;
  try {
    const dir = deps.fileDir ?? (await privateShareDir("share", deps.env ?? process.env));
    await pruneShareDir(dir, now());
    path = join(dir, `${randomUUID()}.md`);
    await writePrivateNewFile(path, content);
  } catch {
    throw new ShareError(SHARE_MESSAGES.clipboardFailed, "io");
  }
  await recordDelivery(deps.log, share.jobId, { at, destination: "clipboard", target: "file", sha256, result: "saved", location: path });
  return { at, destination: "clipboard", target: "file", sha256, result: "saved", location: path, warnings: [SHARE_WARNINGS.clipboardUnavailable] };
};
