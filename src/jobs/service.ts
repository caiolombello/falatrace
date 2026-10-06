import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "./command";
import {
  createUnitWritablePaths, execStart, persistentUnitEnvironment, persistentUnitWritablePaths, quoteSystemd, quoteSystemdPath, removeUserUnits,
  serviceLaunchCommand, userUnitDir
} from "../runtime/systemd-units";

export const buildWorkerUnit = (config: AppConfig, launchCommand = serviceLaunchCommand(), env: NodeJS.ProcessEnv = process.env): string =>
  `[Unit]\nDescription=FalaTrace processing worker\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${execStart([...launchCommand, "worker", "run"])}\nEnvironmentFile=-%h/.config/recording-cli/worker.env\n${persistentUnitEnvironment(env)}Restart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/share/recording-cli ${quoteSystemdPath(config.remote.archiveDir)}${persistentUnitWritablePaths(["data"], env)}\n\n[Install]\nWantedBy=default.target\n`;

export const installWorkerService = async (config: AppConfig): Promise<string> => {
  const unitDir = await userUnitDir();
  const unitPath = join(unitDir, "recording-cli-worker.service");
  const unit = buildWorkerUnit(config);
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await createUnitWritablePaths(unit);
  await fs.writeFile(unitPath, unit, { mode: 0o600 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-worker.service"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-worker.service"]);
  return unitPath;
};

export const buildSyncUnits = (config: AppConfig, launchCommand = serviceLaunchCommand(), env: NodeJS.ProcessEnv = process.env): { service: string; timer: string } => ({
  service: `[Unit]\nDescription=Synchronize FalaTrace jobs\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${execStart([...launchCommand, "jobs", "sync"])}\nExecStart=${execStart([...launchCommand, "jobs", "cleanup"])}\nEnvironmentFile=-%h/.config/recording-cli/worker.env\n${persistentUnitEnvironment(env)}NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli ${quoteSystemd(config.recordingsDir)}${persistentUnitWritablePaths(["state", "data"], env)}\n`,
  timer: `[Unit]\nDescription=Periodically synchronize FalaTrace jobs\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${config.processing.syncIntervalMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
});

/** Process queued jobs (local and remote) periodically; the service exits after each run. */
export const installSyncTimer = async (config: AppConfig): Promise<string[]> => {
  const unitDir = await userUnitDir();
  const servicePath = join(unitDir, "recording-cli-sync.service");
  const timerPath = join(unitDir, "recording-cli-sync.timer");
  const units = buildSyncUnits(config);
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await createUnitWritablePaths(units.service);
  await fs.writeFile(servicePath, units.service, { mode: 0o600 });
  await fs.writeFile(timerPath, units.timer, { mode: 0o600 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-sync.timer"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-sync.timer"]);
  return [servicePath, timerPath];
};

/** Stop periodic processing. Queued jobs are kept and can still be processed manually. */
export const uninstallSyncTimer = async (run: typeof runCommand = runCommand): Promise<string[]> =>
  removeUserUnits(["recording-cli-sync.timer", "recording-cli-sync.service"], ["recording-cli-sync.timer", "recording-cli-sync.service"], run);
