import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "./command";

const quoteSystemd = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const getLaunchCommand = (): string[] => {
  const executableName = basename(process.execPath);
  if (executableName === "bun" || executableName.startsWith("bun-")) {
    return [process.execPath, process.argv[1]];
  }
  return [process.execPath];
};

const getUnitDir = (): string => join(homedir(), ".config", "systemd", "user");

const execStart = (args: string[]): string => args.map(quoteSystemd).join(" ");

const systemdPath = (path: string): string =>
  path.startsWith("~/") ? `%h/${path.slice(2)}` : path;

export const installWorkerService = async (config: AppConfig): Promise<string> => {
  const unitDir = getUnitDir();
  const unitPath = join(unitDir, "recording-cli-worker.service");
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    unitPath,
    `[Unit]\nDescription=FalaTrace processing worker\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${execStart([...getLaunchCommand(), "worker", "run"])}\nEnvironmentFile=-%h/.config/recording-cli/worker.env\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/share/recording-cli ${quoteSystemd(systemdPath(config.remote.archiveDir))}\n\n[Install]\nWantedBy=default.target\n`
  );
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-worker.service"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-worker.service"]);
  return unitPath;
};

export const installSyncTimer = async (config: AppConfig): Promise<string[]> => {
  const unitDir = getUnitDir();
  const servicePath = join(unitDir, "recording-cli-sync.service");
  const timerPath = join(unitDir, "recording-cli-sync.timer");
  await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    servicePath,
    `[Unit]\nDescription=Synchronize FalaTrace jobs\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${execStart([...getLaunchCommand(), "jobs", "sync"])}\nExecStart=${execStart([...getLaunchCommand(), "jobs", "cleanup"])}\nEnvironmentFile=-%h/.config/recording-cli/worker.env\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli ${quoteSystemd(config.recordingsDir)}\n`
  );
  await fs.writeFile(
    timerPath,
    `[Unit]\nDescription=Periodically synchronize FalaTrace jobs\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${config.processing.syncIntervalMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
  );
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-sync.timer"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-sync.timer"]);
  return [servicePath, timerPath];
};
