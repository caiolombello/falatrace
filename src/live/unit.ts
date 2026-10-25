import { homedir } from "node:os";
import { runCommandDirect } from "../jobs/command";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { transientCommand, transientUnitEnvironment } from "../runtime/systemd-units";
import { LIVE_MESSAGES, LiveError, validateLiveSessionId } from "./store";

/**
 * The live worker runs as its own transient user unit, next to the capture unit and outside any
 * caller sandbox, with a low CPU share so the call and the recording always come first.
 */

export const liveUnitName = (sessionId: string): string => `recording-cli-live-${validateLiveSessionId(sessionId)}.service`;

export type LiveUnitOptions = {
  sessionId: string;
  /** Command that runs the CLI (the stable launcher by default). */
  launch?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/** A day is far longer than any meeting; the unit never outlives a forgotten stop by more. */
const RUNTIME_MAX_SECONDS = 24 * 3600;

/** `systemd-run` arguments that start `<falatrace> live run --session <id>` as a transient unit. */
export const buildLiveUnitArgs = (options: LiveUnitOptions): string[] => {
  const sessionId = validateLiveSessionId(options.sessionId);
  const env = options.env ?? process.env;
  const launch = options.launch ?? getServiceLaunchCommand();
  if (!launch.length || launch.some((part) => typeof part !== "string" || !part || /\p{Cc}/u.test(part))) {
    throw new Error("Invalid live unit launch command");
  }
  const audioEnvironment = ["PULSE_SERVER"]
    .filter((name) => env[name] && !/\p{Cc}/u.test(env[name] as string))
    .map((name) => `--setenv=${name}=${env[name]}`);
  return [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${liveUnitName(sessionId)}`,
    "--property=Type=exec",
    "--property=Nice=10",
    "--property=CPUWeight=20",
    "--property=MemoryMax=1G",
    "--property=UMask=0077",
    // SIGTERM reaches the worker only; it stops the tap itself and may finish the chunk in progress.
    "--property=KillMode=mixed",
    "--property=TimeoutStopSec=30",
    `--property=RuntimeMaxSec=${RUNTIME_MAX_SECONDS}`,
    "--property=Restart=no",
    ...transientUnitEnvironment(env, options.home ?? homedir()),
    ...audioEnvironment,
    "--description=FalaTrace live transcript",
    "--",
    ...transientCommand([...launch, "live", "run", "--session", sessionId])
  ];
};

export type LiveUnitDeps = {
  run?: typeof runCommandDirect;
  launch?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
};

const MISSING_UNIT = /not loaded|does not exist|No such file or directory|not found/i;

/** Start the worker unit. Returns the unit name. */
export const startLiveUnit = async (sessionId: string, deps: LiveUnitDeps = {}): Promise<string> => {
  const args = buildLiveUnitArgs({ sessionId, launch: deps.launch, env: deps.env, home: deps.home });
  try {
    await (deps.run ?? runCommandDirect)("systemd-run", args, { timeoutMs: 15_000 });
  } catch (error) {
    throw new LiveError(LIVE_MESSAGES.unitStartFailed, { cause: error });
  }
  return liveUnitName(sessionId);
};

/**
 * Stop the worker unit. False when it was not running (already finished or never started).
 * `noBlock` only queues the stop: the worker may take up to its grace period to finish a chunk,
 * and a capture stop must not wait for a preview.
 */
export const stopLiveUnit = async (sessionId: string, deps: LiveUnitDeps & { noBlock?: boolean } = {}): Promise<boolean> => {
  const unit = liveUnitName(sessionId);
  try {
    await (deps.run ?? runCommandDirect)("systemctl", ["--user", "stop", ...(deps.noBlock ? ["--no-block"] : []), unit], { timeoutMs: deps.noBlock ? 15_000 : 45_000 });
    return true;
  } catch (error) {
    if (error instanceof Error && MISSING_UNIT.test(error.message)) return false;
    throw new LiveError(LIVE_MESSAGES.unitStopFailed, { cause: error });
  }
};

export const liveUnitActive = async (sessionId: string, deps: LiveUnitDeps = {}): Promise<boolean> => {
  const unit = liveUnitName(sessionId);
  const result = await (deps.run ?? runCommandDirect)("systemctl", ["--user", "show", unit, "--property=ActiveState"], { timeoutMs: 5_000 })
    .catch(() => ({ stdout: "", stderr: "" }));
  return /^ActiveState=(active|activating|deactivating|reloading)$/m.test(result.stdout);
};
