// falatrace:// links open a place in the Studio and nothing else: a recording, a calendar event's
// brief, or the capture page. Browsers and other apps can fire these links, so they never export,
// send, delete, record or run an AI action. A running Studio receives them through a small private
// inbox it polls; otherwise the Studio is started with the link as an argument (and the same link
// waits in the inbox for its first poll).
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createPrivateFile, ensurePrivateDirectory, isIsoTime, isRecord, parseJson, PrivateFileError, readPrivateFile, recordingStateDir,
  removePrivateFile
} from "../runtime/private-file";
import { acquireSingleton, type SingletonLease } from "../runtime/singleton";

export const OPEN_REQUEST_ERRORS = {
  invalidUri: "Link do FalaTrace inválido.",
  unsafeInbox: "A pasta de pedidos do FalaTrace Studio não é uma pasta privada; remova-a para continuar."
} as const;

export const OPEN_REQUEST_KNOWN_ERRORS: readonly string[] = Object.values(OPEN_REQUEST_ERRORS);

export type FalatraceTarget =
  | { kind: "recording"; jobId: string }
  | { kind: "event"; eventIdHash: string }
  | { kind: "capture" };

/** Longer input is refused before any matching; the longest valid link (the event form) has 82 characters. */
export const FALATRACE_URI_MAX_LENGTH = 96;

const RECORDING_URI = /^falatrace:\/\/recording\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const EVENT_URI = /^falatrace:\/\/event\/([0-9a-f]{64})$/;
const CAPTURE_URI = "falatrace://capture";

/**
 * Accepts exactly `falatrace://recording/<uuid-v4>`, `falatrace://event/<64 hex>` and
 * `falatrace://capture` (lowercase, no query, fragment, trailing slash or extra segment).
 * Anything else is null.
 */
export const parseFalatraceUri = (uri: unknown): FalatraceTarget | null => {
  if (typeof uri !== "string" || uri.length > FALATRACE_URI_MAX_LENGTH) return null;
  if (uri === CAPTURE_URI) return { kind: "capture" };
  const recording = RECORDING_URI.exec(uri);
  if (recording) return { kind: "recording", jobId: recording[1] };
  const event = EVENT_URI.exec(uri);
  if (event) return { kind: "event", eventIdHash: event[1] };
  return null;
};

/** The link for a target; throws for a target that would not parse back. */
export const falatraceUri = (target: FalatraceTarget): string => {
  const uri = target?.kind === "capture" ? CAPTURE_URI
    : target?.kind === "recording" ? `falatrace://recording/${target.jobId}`
      : target?.kind === "event" ? `falatrace://event/${target.eventIdHash}` : "";
  if (!parseFalatraceUri(uri)) throw new Error(OPEN_REQUEST_ERRORS.invalidUri);
  return uri;
};

export const STUDIO_INBOX_LIMITS = {
  /** Requests handed to the Studio per take; older ones are dropped. */
  maxTake: 20,
  /** Requests kept waiting; queuing more drops the oldest. */
  maxPending: 20,
  maxAgeMs: 5 * 60_000,
  /** Clock skew tolerated for a request stamped in the future. */
  maxFutureMs: 60_000,
  maxFileBytes: 1024,
  /** Directory entries looked at per take, so a flooded folder cannot stall the Studio. */
  maxScan: 500
} as const;

/** `$XDG_RUNTIME_DIR/recording-cli/studio-inbox`, or the state directory when there is no runtime directory. */
export const studioInboxDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && isAbsolute(runtime) && !/\p{Cc}/u.test(runtime)
    ? join(runtime, "recording-cli", "studio-inbox")
    : join(recordingStateDir(env, home), "studio-inbox");
};

export type StudioInboxOptions = { dir?: string; now?: () => number };

export type StudioOpenRequest = { target: FalatraceTarget; uri: string; queuedAt: string };

const REQUEST_NAME = /^(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const LEFTOVER_NAME = /^\.\d{13}-[0-9a-f-]{36}\.json\.(?:\d+\.[0-9a-f-]{36}\.tmp|taking-\d+-[0-9a-f-]{36})$/;

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code || "";

/** Unlink a claimed or leftover entry; a directory planted under a request name is removed only when empty. */
const discard = async (path: string): Promise<void> => {
  await fs.unlink(path).catch(() => fs.rmdir(path)).catch(() => undefined);
};

const inboxDirectory = async (dir: string): Promise<void> => {
  try {
    await ensurePrivateDirectory(dir, { tighten: true });
  } catch (error) {
    if (error instanceof PrivateFileError) throw new Error(OPEN_REQUEST_ERRORS.unsafeInbox);
    throw error;
  }
};

const requestNames = async (dir: string): Promise<{ requests: string[]; leftovers: string[] }> => {
  const names = await fs.readdir(dir).catch((error) => { if (errorCode(error) === "ENOENT") return [] as string[]; throw error; });
  const scanned = names.slice(0, STUDIO_INBOX_LIMITS.maxScan);
  return { requests: scanned.filter((name) => REQUEST_NAME.test(name)).sort(), leftovers: scanned.filter((name) => LEFTOVER_NAME.test(name)) };
};

/** Leave a link for the running Studio. Returns the parsed target; refuses anything that is not a valid link. */
export const queueStudioOpen = async (uri: string, options: StudioInboxOptions = {}): Promise<FalatraceTarget> => {
  const target = parseFalatraceUri(uri);
  if (!target) throw new Error(OPEN_REQUEST_ERRORS.invalidUri);
  const dir = options.dir ?? studioInboxDir();
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || now > 9_999_999_999_999) throw new Error(OPEN_REQUEST_ERRORS.invalidUri);
  await inboxDirectory(dir);
  const name = `${String(now).padStart(13, "0")}-${randomUUID()}.json`;
  const body = `${JSON.stringify({ version: 1, uri: falatraceUri(target), queuedAt: new Date(now).toISOString() })}\n`;
  try {
    await createPrivateFile(join(dir, name), body, STUDIO_INBOX_LIMITS.maxFileBytes);
  } catch (error) {
    if (error instanceof PrivateFileError) throw new Error(OPEN_REQUEST_ERRORS.unsafeInbox);
    throw error;
  }
  const { requests } = await requestNames(dir);
  for (const old of requests.slice(0, Math.max(0, requests.length - STUDIO_INBOX_LIMITS.maxPending))) {
    await removePrivateFile(join(dir, old)).catch(() => undefined);
  }
  return target;
};

const readRequest = (text: string | undefined): { uri: string; queuedAt: string; target: FalatraceTarget } | undefined => {
  const value = text === undefined ? undefined : parseJson(text);
  if (!isRecord(value) || value.version !== 1 || !isIsoTime(value.queuedAt)) return undefined;
  const target = parseFalatraceUri(value.uri);
  return target ? { uri: falatraceUri(target), queuedAt: new Date(Date.parse(value.queuedAt)).toISOString(), target } : undefined;
};

/**
 * Take the waiting links: each file is claimed with a rename (so two readers never get the same one),
 * read and deleted. Stale (> 5 min), future-dated or invalid requests are dropped. Returns at most 20,
 * oldest first, with repeats of the same link folded into the latest one.
 */
export const takeStudioOpens = async (options: StudioInboxOptions = {}): Promise<StudioOpenRequest[]> => {
  const dir = options.dir ?? studioInboxDir();
  const stat = await fs.lstat(dir).catch((error) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
  if (!stat) return [];
  await inboxDirectory(dir);
  const now = (options.now ?? Date.now)();
  const { requests, leftovers } = await requestNames(dir);
  const taken: StudioOpenRequest[] = [];
  for (const name of requests) {
    const claimed = join(dir, `.${name}.taking-${process.pid}-${randomUUID()}`);
    try {
      await fs.rename(join(dir, name), claimed);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    let request: ReturnType<typeof readRequest>;
    try {
      request = readRequest(await readPrivateFile(claimed, STUDIO_INBOX_LIMITS.maxFileBytes));
    } catch {
      request = undefined;
    } finally {
      // Whatever was claimed goes, even a planted symlink (only the link is removed, never its target).
      await discard(claimed);
    }
    if (!request) continue;
    const age = now - Date.parse(request.queuedAt);
    if (age > STUDIO_INBOX_LIMITS.maxAgeMs || age < -STUDIO_INBOX_LIMITS.maxFutureMs) continue;
    taken.push(request);
  }
  // A crash between claim and delete, or during a write, leaves a hidden file; old ones are swept.
  for (const name of leftovers) {
    const path = join(dir, name);
    const info = await fs.lstat(path).catch(() => undefined);
    if (info && !info.isDirectory() && now - info.mtimeMs > STUDIO_INBOX_LIMITS.maxAgeMs) await discard(path);
  }
  const folded = taken.filter((request, index) => !taken.slice(index + 1).some((later) => later.uri === request.uri));
  return folded.slice(-STUDIO_INBOX_LIMITS.maxTake);
};

/** Abstract-socket lock the Studio bridge holds while it runs. */
export const STUDIO_PRESENCE_LOCK = "desktop-studio";

export type PresenceDeps = { lock?: (name: string) => Promise<SingletonLease> };

const isHeld = (error: unknown): boolean => /already running/.test(error instanceof Error ? error.message : String(error));

/** Tries, `delayMs` apart, before another Studio is taken to hold the presence lock. */
export const STUDIO_PRESENCE_RETRY = { attempts: 4, delayMs: 100 } as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Called by the bridge at startup and kept for its lifetime. Null when another Studio already
 * holds it (that one keeps receiving the links). `studioIsRunning` takes the same lock for an
 * instant to check it, so a lock found held is tried again a few times before giving up: a bridge
 * that gave up on a mere check would go without presence for its whole life, and every later link
 * would start another Studio.
 */
export const holdStudioPresence = async (
  deps: PresenceDeps & { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<SingletonLease | null> => {
  const attempts = Math.max(1, deps.attempts ?? STUDIO_PRESENCE_RETRY.attempts);
  for (let attempt = 1; ; attempt++) {
    try {
      return await (deps.lock ?? acquireSingleton)(STUDIO_PRESENCE_LOCK);
    } catch (error) {
      if (!isHeld(error)) throw error;
      if (attempt >= attempts) return null;
      await (deps.sleep ?? defaultSleep)(STUDIO_PRESENCE_RETRY.delayMs);
    }
  }
};

/** Whether a Studio holds the presence lock right now. */
export const studioIsRunning = async (deps: PresenceDeps = {}): Promise<boolean> => {
  try {
    const lease = await (deps.lock ?? acquireSingleton)(STUDIO_PRESENCE_LOCK);
    await lease.release();
    return false;
  } catch (error) {
    return isHeld(error);
  }
};

export type OpenInStudioDeps = StudioInboxOptions & PresenceDeps & {
  isRunning?: () => Promise<boolean>;
  /** Starts the Studio with extra arguments; defaults to launchRecordingStudio. */
  launch?: (extraArgs: string[]) => Promise<unknown>;
  /** Also leave the link in the inbox when starting the Studio (default true). */
  queueOnLaunch?: boolean;
};

/**
 * Open a link in the Studio: queued for a running Studio, else the Studio is started with the link
 * as its last argument. Throws a known error for anything that is not a valid falatrace:// link.
 */
export const openInStudio = async (uri: string, deps: OpenInStudioDeps = {}): Promise<"queued" | "launched"> => {
  const target = parseFalatraceUri(uri);
  if (!target) throw new Error(OPEN_REQUEST_ERRORS.invalidUri);
  const canonical = falatraceUri(target);
  const inbox: StudioInboxOptions = { dir: deps.dir, now: deps.now };
  const running = await (deps.isRunning ?? (() => studioIsRunning({ lock: deps.lock })))();
  if (running) {
    await queueStudioOpen(canonical, inbox);
    return "queued";
  }
  // The inbox copy covers a Studio that does not read its arguments; a failure there must not stop the launch.
  if (deps.queueOnLaunch !== false) await queueStudioOpen(canonical, inbox).catch(() => undefined);
  const launch = deps.launch ?? (async (extraArgs: string[]) => {
    const { launchRecordingStudio } = await import("../tray/runtime");
    await launchRecordingStudio(undefined, undefined, extraArgs);
  });
  await launch([canonical]);
  return "launched";
};
