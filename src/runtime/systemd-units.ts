import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const execStart = (args: string[]): string => args.map(quoteSystemd).join(" ");

export const userUnitDir = (): string => join(homedir(), ".config", "systemd", "user");

export const serviceLaunchCommand = (): string[] => getServiceLaunchCommand();

/** systemctl's wording when a unit was never installed or is already gone. */
const MISSING_UNIT = /does not exist|not loaded|No such file or directory|not found/i;
/** The user manager could not be reached: nothing is known about the unit, even when errno reads ENOENT. */
const BUS_UNREACHABLE = /Failed to connect to (?:the )?bus|Failed to get D-Bus connection|Transport endpoint is not connected/i;

/** A systemctl failure that only says the unit is not there: stopping or disabling it is already done. */
export const isMissingUnitError = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error);
  return MISSING_UNIT.test(text) && !BUS_UNREACHABLE.test(text);
};

/**
 * Disable and stop units, remove their files and reload. A unit that is already missing is
 * not an error; any other failure stops here, before the files are removed, so a unit that
 * keeps running is never reported as disabled.
 */
export const removeUserUnits = async (
  unitFiles: string[],
  stopUnits: string[],
  run: typeof runCommand = runCommand,
  unitDir = userUnitDir()
): Promise<string[]> => {
  for (const unit of stopUnits) {
    await run("systemctl", ["--user", "disable", "--now", unit]).catch((error: unknown) => {
      if (!isMissingUnitError(error)) throw error;
    });
  }
  const removed: string[] = [];
  for (const name of unitFiles) {
    const path = join(unitDir, name);
    await fs.rm(path, { force: true });
    removed.push(path);
  }
  await run("systemctl", ["--user", "daemon-reload"]);
  return removed;
};
