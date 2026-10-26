import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { opencodeLockdown } from "../assistant/providers/common";
import { AI_APP_TARGETS, type AiAppTarget } from "../config/defaults";
import { SHARE_MESSAGES, SHARE_WARNINGS, ShareError, assertRenderedShare, sha256Hex, type RenderedShare, type ShareLanguage } from "../share/render";
import {
  copyToSystemClipboard,
  ensurePrivateTree,
  openUrlWithXdg,
  privateShareDir,
  pruneShareDir,
  writePrivateNewFile,
  type OpenUrl,
  type RunWithInput
} from "./clipboard";
import { recordDelivery, type DeliveryLog, type DeliveryReceipt, type DeliveryResult } from "./log";

/**
 * "Open in my AI": hands the note to an AI app without sending anything itself.
 * - Web apps: the content is copied and the bare page opens. Meeting text never goes into a web URL,
 *   because some of them submit `?q=` on load, before the user has seen it.
 * - Claude Desktop: `claude://claude.ai/new?q=` pre-fills a chat the user still has to send; Claude
 *   truncates q at about 14,000 characters, so longer content is copied instead.
 * - Command-line tools: the content goes into a private file in a folder of its own, and a terminal
 *   opens there with the tool and a short prompt to read that file.
 */

export const AI_WEB_URLS = Object.freeze({
  "chatgpt-web": "https://chatgpt.com/",
  "claude-web": "https://claude.ai/new",
  "gemini-web": "https://gemini.google.com/app"
} as const);

export const CLAUDE_DESKTOP_URL = "claude://claude.ai/new";
export const CLAUDE_DESKTOP_Q_MAX = 14_000;
/** Linux caps one argument at 128 KiB (MAX_ARG_STRLEN); xdg-open gets the URL as one. */
const MAX_URL_BYTES = 100_000;

type WebTarget = keyof typeof AI_WEB_URLS;
type CliTarget = "claude-cli" | "codex-cli" | "gemini-cli" | "opencode-cli";

/**
 * `lockdown`: settings the tool starts with, through env(1) in the terminal command. OpenCode
 * runs commands, edits and web fetches without asking by default; with these it asks first,
 * like the other tools do, while reading the handoff folder stays free.
 */
const CLI_TOOLS: Record<CliTarget, { binary: string; args: (prompt: string) => string[]; lockdown?: Record<string, string> }> = {
  "claude-cli": { binary: "claude", args: (prompt) => [prompt] },
  "codex-cli": { binary: "codex", args: (prompt) => [prompt] },
  "gemini-cli": { binary: "gemini", args: (prompt) => ["--prompt-interactive", prompt] },
  "opencode-cli": { binary: "opencode", args: (prompt) => ["--prompt", prompt], lockdown: opencodeLockdown("ask") }
};

export const isAiAppTarget = (value: unknown): value is AiAppTarget =>
  typeof value === "string" && (AI_APP_TARGETS as readonly string[]).includes(value);
const isWebTarget = (target: AiAppTarget): target is WebTarget => target in AI_WEB_URLS;
const isCliTarget = (target: AiAppTarget): target is CliTarget => target in CLI_TOOLS;

/** The prompt the terminal tool starts with; it names the file, never its content. */
export const handoffPrompt = (fileName: string, language: ShareLanguage = "pt-BR"): string => {
  if (language === "en") return `Read the file ${fileName} (context from a meeting recorded in FalaTrace) and help me with it.`;
  if (language === "es") return `Lee el archivo ${fileName} (contexto de una reunión registrada en FalaTrace) y ayúdame con él.`;
  return `Leia o arquivo ${fileName} (contexto de uma reunião registrada no FalaTrace) e me ajude com ele.`;
};

/** claude:// URL: with `q` when the text fits Claude's limit, else the bare URL (the text is copied instead). */
export const buildClaudeDesktopUrl = (content: string): { url: string; inline: boolean } => {
  if (content.length > 0 && content.length <= CLAUDE_DESKTOP_Q_MAX) {
    const url = `${CLAUDE_DESKTOP_URL}?q=${encodeURIComponent(content)}`;
    if (Buffer.byteLength(url, "utf8") <= MAX_URL_BYTES) return { url, inline: true };
  }
  return { url: CLAUDE_DESKTOP_URL, inline: false };
};

/** Argument vector of a terminal tool for a handoff file name. */
export const buildCliHandoffCommand = (target: AiAppTarget, fileName: string, language: ShareLanguage = "pt-BR"): string[] => {
  if (!isCliTarget(target)) throw new ShareError(SHARE_MESSAGES.aiAppInvalid, "invalid");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(fileName)) throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
  const tool = CLI_TOOLS[target];
  const settings = Object.entries(tool.lockdown ?? {}).map(([name, value]) => `${name}=${value}`);
  return [...(settings.length > 0 ? ["env", ...settings] : []), tool.binary, ...tool.args(handoffPrompt(fileName, language))];
};

/** Absolute path of an executable found on PATH, or undefined. */
export const findOnPath = async (binary: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> => {
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, binary);
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
};

export type LaunchTerminal = (command: string[], options: { workingDirectory: string }) => Promise<void>;

const defaultLaunchTerminal: LaunchTerminal = async (command, options) => {
  // Loaded on use: the tray runtime pulls in recording and call modules sharing never needs otherwise.
  const { launchInTerminal } = await import("../tray/runtime");
  await launchInTerminal(command, options);
};

export type AiAppDeliverInput = {
  share: RenderedShare;
  target: AiAppTarget;
  /** "return": the Studio copies `content` itself; "system": copy here with wl-copy/xclip/xsel (CLI). */
  clipboard: "return" | "system";
  /** Open the app now (default true). The Studio may pass false and open `url` after copying. */
  open?: boolean;
};

export type AiAppDeps = {
  run?: RunWithInput;
  env?: NodeJS.ProcessEnv;
  openUrl?: OpenUrl;
  launchTerminal?: LaunchTerminal;
  which?: (binary: string) => Promise<string | undefined>;
  log?: DeliveryLog;
  now?: () => Date;
  /** Base folder for handoff files; defaults to privateShareDir("handoff"). */
  handoffDir?: string;
};

export const deliverAiApp = async (input: AiAppDeliverInput, deps: AiAppDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  if (!isAiAppTarget(input.target)) throw new ShareError(SHARE_MESSAGES.aiAppInvalid, "invalid");
  if (input.clipboard !== "return" && input.clipboard !== "system") throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const open = input.open !== false;
  const target = input.target;
  const content = share.body;
  const sha256 = sha256Hex(content);
  const logTarget = `ai-app:${target}`;
  const warnings: string[] = [];

  const finish = async (receipt: Omit<DeliveryReceipt, "at" | "destination" | "target" | "sha256" | "warnings">): Promise<DeliveryReceipt> => {
    const at = now().toISOString();
    await recordDelivery(deps.log, share.jobId, {
      at, destination: "ai-app", target: logTarget, sha256, result: receipt.result, ...(receipt.location ? { location: receipt.location } : {})
    });
    return { at, destination: "ai-app", target: logTarget, sha256, warnings, ...receipt };
  };

  const openApp = async (url: string): Promise<boolean> => {
    if (!open) return false;
    try {
      await (deps.openUrl ?? openUrlWithXdg)(url);
      return true;
    } catch {
      warnings.push(SHARE_WARNINGS.appNotOpened);
      return false;
    }
  };

  if (isCliTarget(target)) {
    const tool = CLI_TOOLS[target];
    if (!(await (deps.which ?? ((binary: string) => findOnPath(binary, env)))(tool.binary))) throw new ShareError(SHARE_MESSAGES.aiToolMissing, "config");
    const id = randomUUID();
    const fileName = `falatrace-${id.slice(0, 8)}.md`;
    let folder: string;
    let path: string;
    try {
      const base = deps.handoffDir ?? (await privateShareDir("handoff", env));
      await pruneShareDir(base, now());
      folder = join(base, id);
      await ensurePrivateTree(base, folder);
      path = join(folder, fileName);
      await writePrivateNewFile(path, content);
    } catch {
      throw new ShareError(SHARE_MESSAGES.handoffFailed, "io");
    }
    const command = buildCliHandoffCommand(target, fileName, share.language);
    if (open) {
      try {
        await (deps.launchTerminal ?? defaultLaunchTerminal)(command, { workingDirectory: folder });
      } catch {
        throw new ShareError(SHARE_MESSAGES.terminalFailed, "unavailable");
      }
    }
    return finish({ result: open ? "opened" : "saved", location: path, command });
  }

  let openFailed = false;
  if (target === "claude-desktop") {
    const built = buildClaudeDesktopUrl(content);
    if (built.inline) {
      // open: false → the Studio opens `url` itself.
      if (!open) return finish({ result: "returned", url: built.url });
      if (await openApp(built.url)) return finish({ result: "opened", url: built.url });
      // Claude did not open (the warning is already there): copy the content below, so the
      // "open it and paste" advice can be followed, instead of leaving it only inside the URL.
      openFailed = true;
    }
  }

  // Web apps, and Claude Desktop with content past the q limit: copy, then open the bare page.
  const url = isWebTarget(target) ? AI_WEB_URLS[target] : CLAUDE_DESKTOP_URL;
  let copied: DeliveryResult = "returned";
  let location: string | undefined;
  if (input.clipboard === "system") {
    if (await copyToSystemClipboard(content, { run: deps.run, env })) {
      copied = "copied";
    } else {
      try {
        const dir = await privateShareDir("share", env);
        await pruneShareDir(dir, now());
        location = join(dir, `${randomUUID()}.md`);
        await writePrivateNewFile(location, content);
      } catch {
        throw new ShareError(SHARE_MESSAGES.clipboardFailed, "io");
      }
      copied = "saved";
      warnings.push(SHARE_WARNINGS.clipboardUnavailable);
    }
  }
  warnings.push(SHARE_WARNINGS.pasteInApp);
  const opened = openFailed ? false : await openApp(url);
  return finish({
    result: opened ? "opened" : copied,
    url,
    ...(input.clipboard === "return" ? { content } : {}),
    ...(location ? { location } : {})
  });
};
