// Desktop notifications with buttons. libnotify >= 0.7.10 `notify-send -A name=Label` waits and prints
// the chosen action name; older versions have no actions, so a plain notification is shown instead.
// Waiting can take minutes, so callers never await it on their own path: they start a detached
// transient unit (`<launcher> notify <kind> …`) through buildDetachedNotifyArgs, which waits and acts.
import type { AppConfig } from "../config/defaults";
import { runCommandDirect } from "../jobs/command";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { singleLine } from "../runtime/private-file";
import { transientCommand, transientUnitEnvironment } from "../runtime/systemd-units";

export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

export type NotificationAction = { id: string; label: string };

export type NotifyWithActionsOptions = {
  title: string;
  /** Plain text; may hold several lines. Markup characters are escaped. */
  body: string;
  actions: NotificationAction[];
  /** How long the notification may wait for a choice (also its display time where the server honours it). */
  timeoutMs: number;
  appName?: string;
  icon?: string;
  /** Desktop entry the notification belongs to (shown with its name and icon). */
  desktopEntry?: string;
  urgency?: "low" | "normal" | "critical";
  signal?: AbortSignal;
};

export type NotifyDeps = {
  run?: CommandRunner;
  /** notify-send executable; resolved through PATH by default. */
  command?: string;
  /** Skips the `--help` probe when known. */
  supportsActions?: boolean;
};

export const NOTIFY_DEFAULTS = { appName: "FalaTrace", icon: "media-record", desktopEntry: "recording-studio" } as const;

export const NOTIFY_LIMITS = {
  titleLength: 120,
  lineLength: 240,
  bodyLines: 8,
  bodyLength: 1_000,
  labelLength: 48,
  maxActions: 4,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60 * 60_000
} as const;

export const NOTIFY_ERRORS = {
  invalidNotification: "Notificação inválida.",
  failed: "Não foi possível mostrar a notificação da área de trabalho.",
  invalidCommand: "Pedido de notificação inválido.",
  spawnFailed: "Não foi possível iniciar a notificação em segundo plano. Verifique o journal do usuário."
} as const;

export const NOTIFY_KNOWN_ERRORS: readonly string[] = Object.values(NOTIFY_ERRORS);

const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DESKTOP_ENTRY = /^[A-Za-z0-9._-]{1,64}$/;
const ICON = /^[A-Za-z0-9._/-]{1,200}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_HASH = /^[0-9a-f]{64}$/;

/** Bodies may carry markup on most servers; escaping keeps meeting text from becoming links or styling. */
const escapeMarkup = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Each line cleaned on its own; whole lines are kept while they fit the length cap. */
const cleanBody = (body: string): string => {
  const lines = body.split(/\r\n|\r|\n/).map((line) => singleLine(line, NOTIFY_LIMITS.lineLength)).filter(Boolean).slice(0, NOTIFY_LIMITS.bodyLines);
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > NOTIFY_LIMITS.bodyLength) break;
    text = next;
  }
  return text;
};

type CleanNotification = {
  title: string; body: string; actions: NotificationAction[]; timeoutMs: number;
  appName: string; icon: string; desktopEntry: string; urgency: "low" | "normal" | "critical";
};

const cleanNotification = (options: NotifyWithActionsOptions): CleanNotification => {
  if (!options || typeof options !== "object") throw new Error(NOTIFY_ERRORS.invalidNotification);
  const title = typeof options.title === "string" ? singleLine(options.title, NOTIFY_LIMITS.titleLength) : "";
  const body = typeof options.body === "string" ? cleanBody(options.body) : "";
  const appName = singleLine(typeof options.appName === "string" ? options.appName : NOTIFY_DEFAULTS.appName, 40);
  const icon = options.icon ?? NOTIFY_DEFAULTS.icon;
  const desktopEntry = options.desktopEntry ?? NOTIFY_DEFAULTS.desktopEntry;
  const urgency = options.urgency ?? "normal";
  const timeoutMs = options.timeoutMs;
  if (!title || !appName || typeof icon !== "string" || !ICON.test(icon) || icon.includes("..") ||
    typeof desktopEntry !== "string" || !DESKTOP_ENTRY.test(desktopEntry) ||
    (urgency !== "low" && urgency !== "normal" && urgency !== "critical") ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < NOTIFY_LIMITS.minTimeoutMs || timeoutMs > NOTIFY_LIMITS.maxTimeoutMs ||
    !Array.isArray(options.actions) || options.actions.length > NOTIFY_LIMITS.maxActions) {
    throw new Error(NOTIFY_ERRORS.invalidNotification);
  }
  const seen = new Set<string>();
  const actions = options.actions.map((action) => {
    const label = action && typeof action.label === "string" ? singleLine(action.label, NOTIFY_LIMITS.labelLength) : "";
    if (!action || typeof action.id !== "string" || !ACTION_ID.test(action.id) || seen.has(action.id) || !label) {
      throw new Error(NOTIFY_ERRORS.invalidNotification);
    }
    seen.add(action.id);
    return { id: action.id, label };
  });
  return { title, body, actions, timeoutMs, appName, icon, desktopEntry, urgency };
};

/**
 * The notify-send arguments. Options come first and `--` ends them, so a title that starts with
 * a dash is never read as a flag.
 */
export const buildNotifySendArgs = (options: NotifyWithActionsOptions, withActions: boolean): string[] => {
  const clean = cleanNotification(options);
  return [
    "-a", clean.appName,
    "-i", clean.icon,
    "-h", `string:desktop-entry:${clean.desktopEntry}`,
    "-u", clean.urgency,
    ...(withActions ? clean.actions.flatMap((action) => ["-A", `${action.id}=${action.label}`]) : []),
    "-t", String(clean.timeoutMs),
    "--",
    clean.title,
    escapeMarkup(clean.body)
  ];
};

const probeCache = new Map<string, Promise<boolean>>();

/** Forget probe results (tests, or after the system package changed). */
export const clearNotifySendProbeCache = (): void => probeCache.clear();

/** Whether this notify-send knows `--action` (libnotify >= 0.7.10). Probed once per process. */
export const notifySendSupportsActions = (deps: Pick<NotifyDeps, "run" | "command"> = {}): Promise<boolean> => {
  const command = deps.command ?? "notify-send";
  const run = deps.run ?? runCommandDirect;
  const key = deps.run ? "" : command;
  const cached = key ? probeCache.get(key) : undefined;
  if (cached) return cached;
  const probe = run(command, ["--help"], { timeoutMs: 3_000 })
    .then((result) => /(^|\s)--action\b/m.test(`${result.stdout}\n${result.stderr}`), () => false);
  if (key) probeCache.set(key, probe);
  return probe;
};

const isTimeout = (error: unknown): boolean => /timed out|cancelled/i.test(error instanceof Error ? error.message : String(error));

/**
 * Show a notification and wait for a button. Resolves with the chosen action id, or null when the
 * notification timed out, was dismissed, or the system cannot show buttons (a plain notification is
 * shown then). Rejects with a known error when no notification could be shown at all.
 */
export const notifyWithActions = async (options: NotifyWithActionsOptions, deps: NotifyDeps = {}): Promise<string | null> => {
  const clean = cleanNotification(options);
  const command = deps.command ?? "notify-send";
  const run = deps.run ?? runCommandDirect;
  const withActions = clean.actions.length > 0 && (deps.supportsActions ?? await notifySendSupportsActions({ run: deps.run, command }));
  const args = buildNotifySendArgs(options, withActions);
  if (options.signal?.aborted) return null;
  try {
    // Waiting ends with the notification's own timeout; the margin only guards a stuck process.
    const result = await run(command, args, { timeoutMs: withActions ? clean.timeoutMs + 10_000 : 10_000, signal: options.signal });
    if (!withActions) return null;
    const chosen = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    return chosen && clean.actions.some((action) => action.id === chosen) ? chosen : null;
  } catch (error) {
    if (options.signal?.aborted || isTimeout(error)) return null;
    throw new Error(NOTIFY_ERRORS.failed);
  }
};

export type NotificationLanguage = "pt-BR" | "en";

/** Same rule as the Studio: the saved choice wins; "auto" keeps Portuguese for pt_* and C/POSIX locales, English otherwise. */
export const notificationLanguage = (config: Pick<AppConfig, "studio">, env: NodeJS.ProcessEnv = process.env): NotificationLanguage => {
  const choice = config.studio?.language;
  if (choice === "en") return "en";
  if (choice === "pt-BR") return "pt-BR";
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return locale === "" || /^(pt|C$|C\.|POSIX$)/.test(locale) ? "pt-BR" : "en";
};

export const DETACHED_NOTIFY_KINDS = ["ready", "reminder"] as const;
export type DetachedNotifyKind = (typeof DETACHED_NOTIFY_KINDS)[number];
export type DetachedNotifyTarget = { kind: "ready"; job: string } | { kind: "reminder"; event: string };

/** Detached helpers end on their own; this caps a helper that hangs anyway. */
const DETACHED_MAX_RUNTIME_SECONDS = 40 * 60;

const detachedTarget = (kind: unknown, args: unknown): DetachedNotifyTarget => {
  const value = args && typeof args === "object" ? args as { job?: unknown; event?: unknown } : {};
  if (kind === "ready" && typeof value.job === "string" && JOB_ID.test(value.job) && value.event === undefined) return { kind, job: value.job };
  if (kind === "reminder" && typeof value.event === "string" && EVENT_HASH.test(value.event) && value.job === undefined) return { kind, event: value.event };
  throw new Error(NOTIFY_ERRORS.invalidCommand);
};

/** `recording-cli-<kind>-<id>`: one helper per job or event, so systemd refuses a second one while the first waits. */
export const detachedNotifyUnitName = (kind: DetachedNotifyKind, args: { job?: string; event?: string }): string => {
  const target = detachedTarget(kind, args);
  return `recording-cli-${target.kind}-${target.kind === "ready" ? target.job : target.event}`;
};

/**
 * `systemd-run` arguments (without the executable) for a non-waiting transient unit running
 * `<launcher> notify ready --job <uuid>` or `<launcher> notify reminder --event <hash>`.
 */
export const buildDetachedNotifyArgs = (
  kind: DetachedNotifyKind,
  args: { job?: string; event?: string },
  options: { launchCommand?: string[]; env?: NodeJS.ProcessEnv } = {}
): string[] => {
  const target = detachedTarget(kind, args);
  const launchCommand = options.launchCommand ?? getServiceLaunchCommand();
  if (!Array.isArray(launchCommand) || launchCommand.length === 0 || launchCommand.some((part) => typeof part !== "string" || !part || /[\0\r\n]/.test(part))) {
    throw new Error(NOTIFY_ERRORS.invalidCommand);
  }
  const verb = target.kind === "ready" ? ["--job", target.job] : ["--event", target.event];
  return [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${detachedNotifyUnitName(kind, args)}`,
    `--property=RuntimeMaxSec=${DETACHED_MAX_RUNTIME_SECONDS}`,
    ...transientUnitEnvironment(options.env ?? process.env),
    "--",
    ...transientCommand([...launchCommand, "notify", target.kind, ...verb])
  ];
};

export const SYSTEMD_RUN = "/usr/bin/systemd-run";

/**
 * Start the detached helper and return at once. "already-shown" when the same job or event already
 * has a helper waiting (systemd refuses a second unit with that name).
 */
export const spawnDetachedNotify = async (
  kind: DetachedNotifyKind,
  args: { job?: string; event?: string },
  deps: { run?: CommandRunner; launchCommand?: string[]; env?: NodeJS.ProcessEnv } = {}
): Promise<"started" | "already-shown"> => {
  const argv = buildDetachedNotifyArgs(kind, args, deps);
  try {
    await (deps.run ?? runCommandDirect)(SYSTEMD_RUN, argv, { timeoutMs: 15_000 });
    return "started";
  } catch (error) {
    if (/already (?:loaded|exists|active)|unit .* exists/i.test(error instanceof Error ? error.message : String(error))) return "already-shown";
    throw new Error(NOTIFY_ERRORS.spawnFailed);
  }
};

/** The arguments after `notify`, exactly `ready --job <uuid>` or `reminder --event <hash>`. */
export const parseNotifyCommand = (argv: readonly string[]): DetachedNotifyTarget => {
  if (!Array.isArray(argv) || argv.length !== 3) throw new Error(NOTIFY_ERRORS.invalidCommand);
  const [kind, flag, value] = argv;
  if (kind === "ready" && flag === "--job") return detachedTarget(kind, { job: value });
  if (kind === "reminder" && flag === "--event") return detachedTarget(kind, { event: value });
  throw new Error(NOTIFY_ERRORS.invalidCommand);
};

const READY_TEXT = {
  "pt-BR": { title: "Resumo pronto", body: (name: string) => `${name}: transcrição e resumo prontos.`, open: "Abrir", openStudio: "Abrir no Studio", fallback: "Sua gravação" },
  en: { title: "Summary ready", body: (name: string) => `${name}: transcript and summary are ready.`, open: "Open", openStudio: "Open in Studio", fallback: "Your recording" }
} as const;

/** "default" is what most servers run on a click on the notification itself. */
export const readyNotificationContent = (name: string, language: NotificationLanguage = "pt-BR"): { title: string; body: string; actions: NotificationAction[] } => {
  const text = READY_TEXT[language] ?? READY_TEXT["pt-BR"];
  const shown = (typeof name === "string" ? singleLine(name, 80) : "") || text.fallback;
  return { title: text.title, body: text.body(shown), actions: [{ id: "default", label: text.open }, { id: "open", label: text.openStudio }] };
};

export const READY_NOTIFICATION_TIMEOUT_MS = 30 * 60_000;

/**
 * `notify ready --job <uuid>`: show "summary ready" and, on a click, open that recording in the
 * Studio. Only navigates; the link is built here from the validated id.
 */
export const handleReadyNotification = async (
  jobId: string,
  options: {
    name?: string;
    language?: NotificationLanguage;
    notify?: (options: NotifyWithActionsOptions) => Promise<string | null>;
    open?: (uri: string) => Promise<unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<string | null> => {
  const target = detachedTarget("ready", { job: jobId });
  if (target.kind !== "ready") throw new Error(NOTIFY_ERRORS.invalidCommand);
  const content = readyNotificationContent(options.name ?? "", options.language);
  const choice = await (options.notify ?? ((notification) => notifyWithActions(notification)))({
    ...content, timeoutMs: options.timeoutMs ?? READY_NOTIFICATION_TIMEOUT_MS, signal: options.signal
  });
  if (choice === "default" || choice === "open") {
    const open = options.open ?? (async (uri: string) => (await import("../desktop/open-request")).openInStudio(uri));
    await open(`falatrace://recording/${target.job}`);
  }
  return choice;
};
