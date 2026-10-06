import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runCommand } from "../jobs/command";
import { getServiceLaunchCommand } from "./launcher";

/**
 * Shared helpers for the user-level systemd units FalaTrace writes. Every generated
 * unit uses the same quoting and the same launch command, so all of them follow the
 * stable ~/.local/bin link of the running release after an update.
 */

const escapeSystemd = (value: string): string => value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** Quote one ExecStart or path argument. `%` is doubled so values never act as specifiers. */
export const quoteSystemd = (value: string): string => `"${escapeSystemd(value)}"`;

/**
 * Quote a path for directives such as ReadWritePaths=. A leading `~/` becomes the `%h`
 * specifier, which must stay unescaped; every other `%` is still doubled.
 */
export const quoteSystemdPath = (path: string): string =>
  path.startsWith("~/") ? `"%h/${escapeSystemd(path.slice(2))}"` : quoteSystemd(path);

/**
 * systemd expands $NAME and ${NAME} in command lines, quoted or not, and reads "$$" as a literal
 * dollar sign. Every argument we pass is literal.
 */
const escapeDollar = (value: string): string => value.replaceAll("$", () => "$$");

export const execStart = (args: string[]): string => args.map((arg) => quoteSystemd(escapeDollar(arg))).join(" ");

/** The command after systemd-run's "--": the user manager expands it like ExecStart= by default. */
export const transientCommand = (args: string[]): string[] => args.map(escapeDollar);

/** The unit directory systemd derives from an environment: $XDG_CONFIG_HOME/systemd/user, else ~/.config/systemd/user. */
const configUnitDir = (env: NodeJS.ProcessEnv, home: string): string => {
  const configHome = env.XDG_CONFIG_HOME;
  return join(configHome && isAbsolute(configHome) ? configHome : join(home, ".config"), "systemd", "user");
};

/**
 * Where the user manager loads unit files from. The manager derives it from its own environment,
 * which need not match this process's, so the directory comes from the manager's search path: this
 * process's configuration directory or ~/.config/systemd/user when the manager lists it, otherwise
 * the configuration directory it lists with its ".control" twin, ahead of the runtime one. When the
 * manager cannot be asked, this process's environment decides, as systemd's own client tools do.
 */
export const userUnitDir = async (
  run: typeof runCommand = runCommand,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): Promise<string> => {
  const own = configUnitDir(env, home);
  const output = await run("systemctl", ["--user", "show", "--property=UnitPath", "--value"]).then((result) => result.stdout.trim(), () => "");
  const listed = (dir: string): boolean => ` ${output} `.includes(` ${dir} `);
  return [own, join(home, ".config", "systemd", "user")].find(listed)
    ?? output.split(/\s+/).find((entry) => entry.endsWith("/systemd/user") && listed(`${entry}.control`))
    ?? own;
};

export const serviceLaunchCommand = (): string[] => getServiceLaunchCommand();

/** The user manager may not share this process's XDG directories, so transient units get them explicitly. */
const XDG_DIRECTORIES = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

/**
 * `systemd-run --setenv` arguments for a transient unit that must read the same configuration and
 * write the same state as this process: its PATH and the XDG directories it was started with.
 */
const xdgDirectories = (env: NodeJS.ProcessEnv): Array<[string, string]> =>
  XDG_DIRECTORIES.flatMap((name) => {
    const value = env[name];
    return value && isAbsolute(value) && !/\p{Cc}/u.test(value) ? [[name, value] as [string, string]] : [];
  });

export const transientUnitEnvironment = (env: NodeJS.ProcessEnv = process.env): string[] => [
  `--setenv=PATH=${env.PATH || ""}`,
  ...xdgDirectories(env).map(([name, value]) => `--setenv=${name}=${value}`)
];

/** `Environment=` lines that give an installed unit the XDG directories of the process installing it. */
export const persistentUnitEnvironment = (env: NodeJS.ProcessEnv = process.env): string =>
  xdgDirectories(env).map(([name, value]) => `Environment=${quoteSystemd(`${name}=${value}`)}\n`).join("");

/**
 * Writable paths a sandboxed unit needs when the state or data directory is not the default one:
 * the FalaTrace folders under XDG_STATE_HOME and XDG_DATA_HOME, each optional ("-") so a folder that
 * does not exist yet never stops the unit. Empty when neither is set.
 */
export const persistentUnitWritablePaths = (folders: Array<"state" | "data" | "data/jobs">, env: NodeJS.ProcessEnv = process.env): string => {
  const directories = Object.fromEntries(xdgDirectories(env));
  return folders.flatMap((folder) => {
    const base = folder === "state" ? directories.XDG_STATE_HOME : directories.XDG_DATA_HOME;
    return base ? [` ${quoteSystemd(`-${join(base, "recording-cli", folder === "data/jobs" ? "jobs" : "")}`.replace(/\/$/, ""))}`] : [];
  }).join("");
};

/** systemctl's wording when a unit was never installed or is already gone. */
const MISSING_UNIT = /does not exist|not loaded|No such file or directory|not found/i;
/**
 * The user manager could not be reached: nothing is known about the unit, even when errno reads ENOENT.
 * systemd 256 and later say "Failed to connect to user scope bus via local transport".
 */
const BUS_UNREACHABLE = /Failed to connect to (?:[\w ]+ )?bus\b|Failed to get D-Bus connection|Transport endpoint is not connected/i;

export const isBusUnreachableError = (error: unknown): boolean => BUS_UNREACHABLE.test(error instanceof Error ? error.message : String(error));

/** A systemctl failure that only says the unit is not there: stopping or disabling it is already done. */
export const isMissingUnitError = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return MISSING_UNIT.test(text) && !BUS_UNREACHABLE.test(text);
};

/**
 * Disable and stop units, remove their files and reload. Timers are disabled and stopped; the
 * services they start have no [Install] section and are stopped, so a run in progress does not
 * outlive the removal. A unit that is already missing is not an error; any other failure stops
 * here, before the files are removed, so a unit that keeps running is never reported as disabled.
 */
export const removeUserUnits = async (
  unitFiles: string[],
  stopUnits: string[],
  run: typeof runCommand = runCommand,
  unitDir?: string
): Promise<string[]> => {
  for (const unit of stopUnits) {
    const args = unit.endsWith(".timer") ? ["--user", "disable", "--now", unit] : ["--user", "stop", unit];
    await run("systemctl", args).catch((error: unknown) => {
      if (!isMissingUnitError(error)) throw error;
    });
  }
  const directory = unitDir ?? await userUnitDir(run);
  const removed: string[] = [];
  for (const name of unitFiles) {
    const path = join(directory, name);
    await fs.rm(path, { force: true });
    removed.push(path);
  }
  await run("systemctl", ["--user", "daemon-reload"]);
  return removed;
};
