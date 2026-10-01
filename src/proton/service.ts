import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";

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

export const installProtonBackupTimer = async (
  config: AppConfig
): Promise<string[]> => {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const servicePath = join(unitDir, "recording-cli-proton-backup.service");
  const timerPath = join(unitDir, "recording-cli-proton-backup.timer");
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    servicePath,
    `[Unit]\nDescription=Back up completed FalaTrace jobs to Proton Drive\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${execStart([...getLaunchCommand(), "backup", "sync"])}\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli\n`
  );
  await fs.writeFile(
    timerPath,
    `[Unit]\nDescription=Periodically back up FalaTrace jobs to Proton Drive\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=${config.processing.syncIntervalMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
  );
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", [
    "--user",
    "enable",
    "recording-cli-proton-backup.timer"
  ]);
  await runCommand("systemctl", [
    "--user",
    "restart",
    "recording-cli-proton-backup.timer"
  ]);
  return [servicePath, timerPath];
};
