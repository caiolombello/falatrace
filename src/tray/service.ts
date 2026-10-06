import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../jobs/command";
import { execStart, isMissingUnitError, persistentUnitEnvironment, serviceLaunchCommand, userUnitDir } from "../runtime/systemd-units";
import { checkTrayDependencies } from "./runtime";

const SERVICE_NAME = "recording-cli-tray.service";

const getLaunchCommand = (): string[] => serviceLaunchCommand();

export const buildTrayUnit = (launchCommand = getLaunchCommand(), env: NodeJS.ProcessEnv = process.env): string =>
  `[Unit]\nDescription=FalaTrace tray indicator\nAfter=graphical-session.target recording-cli-calls.service\nPartOf=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${execStart([...launchCommand, "tray", "run"])}\n${persistentUnitEnvironment(env)}Restart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nRestrictAddressFamilies=AF_UNIX\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;

export const installTrayService = async (): Promise<string> => {
  await checkTrayDependencies();
  const unitDir = await userUnitDir();
  const unitPath = join(unitDir, SERVICE_NAME);
  await fs.mkdir(unitDir, {
    recursive: true,
    mode: 0o700
  });
  await fs.mkdir(join(homedir(), ".local", "state", "recording-cli"), {
    recursive: true,
    mode: 0o700
  });
  await fs.writeFile(unitPath, buildTrayUnit(), { mode: 0o600 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", SERVICE_NAME]);
  await runCommand("systemctl", ["--user", "restart", SERVICE_NAME]);
  return unitPath;
};

/** Like the call monitor: only a unit that is already gone lets removal go on after a failed stop. */
export const uninstallTrayService = async (run: typeof runCommand = runCommand): Promise<string> => {
  await run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]).catch((error: unknown) => {
    if (!isMissingUnitError(error)) throw error;
  });
  const unitPath = join(await userUnitDir(run), SERVICE_NAME);
  await fs.rm(unitPath, { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
  return unitPath;
};
