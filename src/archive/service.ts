import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { getArchiveStateDir } from "./store";
import { getArchiveDataDir } from "./proton";
import { quoteSystemd as quote, removeUserUnits, serviceLaunchCommand, userUnitDir } from "../runtime/systemd-units";

export const buildArchiveUnits = (config: AppConfig, command: string[]): { service: string; timer: string } => ({
  service: `[Unit]\nDescription=Archive original recordings independently of transcription\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${[...command, "archive", "sync", "--limit", "3"].map(quote).join(" ")}\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin\nEnvironment=PROTON_DRIVE_CACHE_DIR=%h/.local/share/recording-cli/proton-drive-runtime\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli\nTimeoutStartSec=infinity\nNice=10\nIOSchedulingClass=idle\n`,
  timer: `[Unit]\nDescription=Retry original recording archive copies\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=${config.archive.syncIntervalMinutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
});

export const installArchiveTimer = async (config: AppConfig): Promise<string[]> => {
  if (!config.archive.enabled || (!config.archive.vaio && !config.archive.proton)) throw new Error("Habilite ao menos um destino em archive antes de instalar o timer");
  const units = buildArchiveUnits(config, serviceLaunchCommand());
  const unitDir = userUnitDir();
  for (const directory of [unitDir, getArchiveStateDir(), getArchiveDataDir()]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const [kind, content] of Object.entries(units)) {
    const path = join(unitDir, `recording-cli-archive.${kind}`);
    try {
      const existing = await fs.readFile(path);
      await fs.writeFile(`${path}.before-${Date.now()}`, existing, { mode: 0o600, flag: "wx" });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.writeFile(path, content, { mode: 0o600 }); paths.push(path);
  }
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", "recording-cli-archive.timer"]);
  return paths;
};

/** Stop periodic original-media copies. Existing copies and the archive catalog are kept. */
export const uninstallArchiveTimer = async (): Promise<string[]> =>
  removeUserUnits(["recording-cli-archive.timer", "recording-cli-archive.service"], ["recording-cli-archive.timer"]);
