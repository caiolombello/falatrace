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

/** Quote one ExecStart or path argument. `%` is doubled so values never act as specifiers. */
export const quoteSystemd = (value: string): string =>
  `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const execStart = (args: string[]): string => args.map(quoteSystemd).join(" ");

/** `~/x` becomes the `%h/x` specifier; anything else is used as given. */
export const systemdPath = (path: string): string => (path.startsWith("~/") ? `%h/${path.slice(2)}` : path);

export const userUnitDir = (): string => join(homedir(), ".config", "systemd", "user");

export const serviceLaunchCommand = (): string[] => getServiceLaunchCommand();

/** Disable and stop units, remove their files and reload; missing units are not an error. */
export const removeUserUnits = async (
  unitFiles: string[],
  stopUnits: string[],
  run: typeof runCommand = runCommand,
  unitDir = userUnitDir()
): Promise<string[]> => {
  for (const unit of stopUnits) await run("systemctl", ["--user", "disable", "--now", unit]).catch(() => undefined);
  const removed: string[] = [];
  for (const name of unitFiles) {
    const path = join(unitDir, name);
    await fs.rm(path, { force: true });
    removed.push(path);
  }
  await run("systemctl", ["--user", "daemon-reload"]);
  return removed;
};
