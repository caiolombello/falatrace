import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { execStart, isMissingUnitError, quoteSystemd, serviceLaunchCommand } from "../runtime/systemd-units";

const getLaunchCommand = (): string[] => serviceLaunchCommand();

const getUnitPath = (): string =>
  join(homedir(), ".config", "systemd", "user", "recording-cli-calls.service");

const getNetworkProbeUnitPath = (): string =>
  join(homedir(), ".config", "systemd", "user", "recording-cli-network-probe.service");

export const buildNetworkProbeUnit = (launchCommand = getLaunchCommand()): string =>
  `[Unit]\nDescription=FalaTrace aggregate network metadata probe\nPartOf=recording-cli-calls.service\n\n[Service]\nType=simple\nExecStart=${execStart([...launchCommand, "calls", "network-probe"])}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nRestrictNamespaces=yes\nRestrictSUIDSGID=yes\nLockPersonality=yes\nRestrictRealtime=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\nUMask=0077\n# Mount namespace directives are intentionally omitted because ss -p needs the desktop namespace for process attribution.\n`;

export const buildCallMonitorUnit = (config: AppConfig, launchCommand = getLaunchCommand()): string => {
  if (/[\r\n\0]/.test(config.recordingsDir)) {
    throw new Error("recordingsDir contains unsupported control characters");
  }
  return `[Unit]\nDescription=FalaTrace call monitor\nAfter=graphical-session.target pipewire.service wireplumber.service recording-cli-network-probe.service\nWants=recording-cli-network-probe.service\nPartOf=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${execStart([...launchCommand, "calls", "run"])}\nEnvironmentFile=-%h/.config/recording-cli/calls.env\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli/jobs ${quoteSystemd(config.recordingsDir)}\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
};

export const installCallMonitorService = async (config: AppConfig): Promise<string> => {
  if (!config.callDetection.enabled) {
    throw new Error("Set callDetection.enabled=true before installing the call monitor service");
  }
  const unitPath = getUnitPath();
  await fs.mkdir(join(homedir(), ".config", "systemd", "user"), {
    recursive: true,
    mode: 0o700
  });
  await fs.mkdir(join(homedir(), ".local", "state", "recording-cli"), {
    recursive: true,
    mode: 0o700
  });
  await fs.mkdir(config.recordingsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(unitPath, buildCallMonitorUnit(config), { mode: 0o600 });
  await fs.writeFile(getNetworkProbeUnitPath(), buildNetworkProbeUnit(), { mode: 0o600 });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "recording-cli-calls.service"]);
  await runCommand("systemctl", ["--user", "restart", "recording-cli-calls.service"]);
  return unitPath;
};

/**
 * Stop and remove the monitor. A monitor that fails to stop keeps recording with the configuration
 * it started with, so only a unit that is already gone lets removal go on; any other failure stops
 * here, before the files are removed and the monitor reported disabled.
 */
export const uninstallCallMonitorService = async (run: typeof runCommand = runCommand): Promise<string> => {
  const unitPath = getUnitPath();
  const unlessMissing = (error: unknown): void => { if (!isMissingUnitError(error)) throw error; };
  await run("systemctl", ["--user", "disable", "--now", "recording-cli-calls.service"]).catch(unlessMissing);
  await run("systemctl", ["--user", "stop", "recording-cli-network-probe.service"]).catch(unlessMissing);
  await fs.rm(unitPath, { force: true });
  await fs.rm(getNetworkProbeUnitPath(), { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
  return unitPath;
};
