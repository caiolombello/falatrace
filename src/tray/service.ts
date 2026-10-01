import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runCommand } from "../jobs/command";
import { checkTrayDependencies } from "./runtime";

const SERVICE_NAME = "recording-cli-tray.service";

const quoteSystemd = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const getLaunchCommand = (): string[] => {
  const executableName = basename(process.execPath);
  if (executableName === "bun" || executableName.startsWith("bun-")) {
    return [process.execPath, process.argv[1]];
  }
  return [process.execPath];
};

const execStart = (args: string[]): string => args.map(quoteSystemd).join(" ");

const getUnitPath = (): string =>
  join(homedir(), ".config", "systemd", "user", SERVICE_NAME);

export const buildTrayUnit = (launchCommand = getLaunchCommand()): string =>
  `[Unit]\nDescription=FalaTrace tray indicator\nAfter=graphical-session.target recording-cli-calls.service\nPartOf=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${execStart([...launchCommand, "tray", "run"])}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nRestrictAddressFamilies=AF_UNIX\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;

export const installTrayService = async (): Promise<string> => {
  await checkTrayDependencies();
  const unitPath = getUnitPath();
  await fs.mkdir(join(homedir(), ".config", "systemd", "user"), {
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

export const uninstallTrayService = async (): Promise<string> => {
  const unitPath = getUnitPath();
  await runCommand("systemctl", ["--user", "disable", "--now", SERVICE_NAME])
    .catch(() => undefined);
  await fs.rm(unitPath, { force: true });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  return unitPath;
};
