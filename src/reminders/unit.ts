// The user service that runs the reminder loop. Sandboxed like the call monitor: a read-only home
// with only the FalaTrace state directory writable. Desktop actions (notifications, the Studio,
// per-meeting decisions) run outside the sandbox through detached `systemd-run --user` helpers.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { upcomingEventSources } from "../calendar/upcoming";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import {
  createUnitWritablePaths, execStart, isMissingUnitError, persistentUnitEnvironment, persistentUnitWritablePaths, serviceLaunchCommand, userUnitDir
} from "../runtime/systemd-units";
import { effectiveReminderMode } from "./scheduler";

export const REMINDERS_UNIT = "recording-cli-reminders.service";

export const REMINDERS_UNIT_ERRORS = {
  off: "Os lembretes estão desligados nas configurações.",
  noCalendar: "Conecte uma agenda (Google ou GNOME) para receber lembretes.",
  invalidLauncher: "Comando do FalaTrace inválido para o serviço de lembretes."
} as const;

export const REMINDERS_UNIT_KNOWN_ERRORS: readonly string[] = Object.values(REMINDERS_UNIT_ERRORS);

/** Why the service is not needed with this configuration, or undefined when it is. */
export const remindersServiceProblem = (config: AppConfig): string | undefined => {
  if (effectiveReminderMode(config) === "off") return REMINDERS_UNIT_ERRORS.off;
  if (upcomingEventSources(config).length === 0) return REMINDERS_UNIT_ERRORS.noCalendar;
  return undefined;
};

export const buildRemindersUnit = (launchCommand: string[] = serviceLaunchCommand(), env: NodeJS.ProcessEnv = process.env): string => {
  if (!Array.isArray(launchCommand) || launchCommand.length === 0 || launchCommand.some((part) => typeof part !== "string" || !part || /[\0\r\n]/.test(part))) {
    throw new Error(REMINDERS_UNIT_ERRORS.invalidLauncher);
  }
  return [
    "[Unit]",
    "Description=FalaTrace meeting reminders",
    "After=graphical-session.target",
    "PartOf=graphical-session.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart([...launchCommand, "reminders", "run"])}`,
    `${persistentUnitEnvironment(env)}Restart=on-failure`,
    "RestartSec=30",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=%h/.local/state/recording-cli${persistentUnitWritablePaths(["state"], env)}`,
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
};

export type RemindersServiceDeps = {
  run?: typeof runCommand;
  unitDir?: string;
  launchCommand?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/** Write, enable and (re)start the service. Refused when reminders are off or no calendar is connected. */
export const installRemindersService = async (config: AppConfig, deps: RemindersServiceDeps = {}): Promise<string> => {
  const problem = remindersServiceProblem(config);
  if (problem) throw new Error(problem);
  const run = deps.run ?? runCommand;
  const unitDir = deps.unitDir ?? await userUnitDir(run);
  const unit = buildRemindersUnit(deps.launchCommand, deps.env);
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await createUnitWritablePaths(unit, deps.home);
  const unitPath = join(unitDir, REMINDERS_UNIT);
  await fs.writeFile(unitPath, unit, { mode: 0o600 });
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", REMINDERS_UNIT]);
  await run("systemctl", ["--user", "restart", REMINDERS_UNIT]);
  return unitPath;
};

/** Stop, disable and remove the service. A unit that is already gone is fine; any other failure stops before removal. */
export const uninstallRemindersService = async (deps: RemindersServiceDeps = {}): Promise<string> => {
  const run = deps.run ?? runCommand;
  await run("systemctl", ["--user", "disable", "--now", REMINDERS_UNIT]).catch((error: unknown) => {
    if (!isMissingUnitError(error)) throw error;
  });
  const unitDir = deps.unitDir ?? await userUnitDir(run);
  const unitPath = join(unitDir, REMINDERS_UNIT);
  await fs.rm(unitPath, { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
  return unitPath;
};
