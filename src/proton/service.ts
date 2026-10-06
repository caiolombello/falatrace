import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { execStart, persistentUnitEnvironment, persistentUnitWritablePaths, removeUserUnits, serviceLaunchCommand, userUnitDir } from "../runtime/systemd-units";

export const buildProtonBackupUnits = (config: AppConfig, launchCommand = serviceLaunchCommand(), env: NodeJS.ProcessEnv = process.env): { service: string; timer: string } => ({
  service: `[Unit]\nDescription=Back up completed FalaTrace jobs to Proton Drive\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${execStart([...launchCommand, "backup", "sync"])}\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin\n${persistentUnitEnvironment(env)}NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli${persistentUnitWritablePaths(["state", "data"], env)}\n`,
  timer: `[Unit]\nDescription=Periodically back up FalaTrace jobs to Proton Drive\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=${config.processing.syncIntervalMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
});

export const installProtonBackupTimer = async (config: AppConfig): Promise<string[]> => {
  const unitDir = userUnitDir();
  const servicePath = join(unitDir, "recording-cli-proton-backup.service");
  const timerPath = join(unitDir, "recording-cli-proton-backup.timer");
  const units = buildProtonBackupUnits(config);
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(servicePath, units.service, { mode: 0o600 });
  await fs.writeFile(timerPath, units.timer, { mode: 0o600 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-proton-backup.timer"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-proton-backup.timer"]);
  return [servicePath, timerPath];
};

/** Stop periodic Proton backups. Existing remote copies and the backup ledger are kept. */
export const uninstallProtonBackupTimer = async (run: typeof runCommand = runCommand): Promise<string[]> =>
  removeUserUnits(["recording-cli-proton-backup.timer", "recording-cli-proton-backup.service"], ["recording-cli-proton-backup.timer", "recording-cli-proton-backup.service"], run);
