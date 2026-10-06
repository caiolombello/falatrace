import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { buildArchiveUnits, uninstallArchiveTimer } from "../../archive/service";
import { buildSyncUnits, buildWorkerUnit, uninstallSyncTimer } from "../../jobs/service";
import { buildProtonBackupUnits, uninstallProtonBackupTimer } from "../../proton/service";
import { buildCallMonitorUnit, uninstallCallMonitorService } from "../../calls/service";
import { buildTrayUnit, uninstallTrayService } from "../../tray/service";
import { cliEntryForBun, getServiceLaunchCommand } from "../launcher";
import { execStart, quoteSystemd, quoteSystemdPath, removeUserUnits } from "../systemd-units";

test("unit arguments are quoted and never act as systemd specifiers", () => {
  expect(quoteSystemd('/a b/"c"\\d%h')).toBe('"/a b/\\"c\\"\\\\d%%h"');
  expect(execStart(["/x/falatrace", "calls", "run"])).toBe('"/x/falatrace" "calls" "run"');
  expect(quoteSystemdPath("~/Videos/A%B")).toBe('"%h/Videos/A%%B"');
  expect(quoteSystemdPath("/abs/A%B")).toBe('"/abs/A%%B"');
});

test("the worker keeps %h live in its writable archive path", () => {
  const unit = buildWorkerUnit(DEFAULT_CONFIG, ["/bin/falatrace"], {});
  expect(unit).toContain('ReadWritePaths=%h/.local/share/recording-cli "%h/Videos/RecordingArchive"\n');
  expect(unit).not.toContain("%%h");
});

test("installed units carry the installer's XDG directories and may write the custom state and data", () => {
  const env = { XDG_CONFIG_HOME: "/custom/con fig", XDG_STATE_HOME: "/custom/st%ate", XDG_DATA_HOME: "/custom/data", XDG_CACHE_HOME: "relative/ignored" };
  const config = structuredClone(DEFAULT_CONFIG);
  const launch = ["/x/falatrace"];
  const units = {
    calls: buildCallMonitorUnit(config, launch, env), tray: buildTrayUnit(launch, env), worker: buildWorkerUnit(config, launch, env),
    sync: buildSyncUnits(config, launch, env).service, backup: buildProtonBackupUnits(config, launch, env).service, archive: buildArchiveUnits(config, launch, env).service
  };
  for (const unit of Object.values(units)) {
    expect(unit).toContain('Environment="XDG_CONFIG_HOME=/custom/con fig"\nEnvironment="XDG_STATE_HOME=/custom/st%%ate"\nEnvironment="XDG_DATA_HOME=/custom/data"\n');
    expect(unit).not.toContain("XDG_CACHE_HOME");
  }
  const writable = (unit: string) => unit.split("\n").find((line) => line.startsWith("ReadWritePaths="));
  expect(writable(units.sync)).toEndWith(' "-/custom/st%%ate/recording-cli" "-/custom/data/recording-cli"');
  expect(writable(units.backup)).toEndWith(' "-/custom/st%%ate/recording-cli" "-/custom/data/recording-cli"');
  expect(writable(units.archive)).toEndWith(' "-/custom/st%%ate/recording-cli" "-/custom/data/recording-cli"');
  expect(writable(units.calls)).toEndWith(' "-/custom/st%%ate/recording-cli" "-/custom/data/recording-cli/jobs"');
  expect(writable(units.worker)).toEndWith(' "-/custom/data/recording-cli"');
  // Without custom directories the units are what they were.
  expect(buildSyncUnits(config, launch, {}).service).not.toContain("XDG_");
});

test("every generated unit uses the same launch command", () => {
  const launch = ["/home/u/.local/bin/falatrace"];
  const config = structuredClone(DEFAULT_CONFIG);
  config.archive.enabled = true;
  const units = [
    buildCallMonitorUnit(config, launch), buildTrayUnit(launch), buildWorkerUnit(config, launch),
    buildSyncUnits(config, launch).service, buildProtonBackupUnits(config, launch).service, buildArchiveUnits(config, launch).service
  ];
  for (const unit of units) expect(unit).toContain('ExecStart="/home/u/.local/bin/falatrace" ');
});

test("removing units disables them, deletes their files and reloads", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-units-"));
  try {
    await fs.writeFile(join(root, "recording-cli-sync.timer"), "x");
    const runs: string[][] = [];
    const removed = await removeUserUnits(["recording-cli-sync.timer", "recording-cli-sync.service"], ["recording-cli-sync.timer"],
      async (command, args) => { runs.push([command, ...args]); return { stdout: "", stderr: "" }; }, root);
    expect(removed).toEqual([join(root, "recording-cli-sync.timer"), join(root, "recording-cli-sync.service")]);
    expect(await fs.readdir(root)).toEqual([]);
    expect(runs).toEqual([["systemctl", "--user", "disable", "--now", "recording-cli-sync.timer"], ["systemctl", "--user", "daemon-reload"]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a unit that fails to stop keeps its files; one that is already gone does not block removal", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-units-"));
  try {
    await fs.writeFile(join(root, "recording-cli-sync.timer"), "x");
    const failing = async (_command: string, args: string[]) => {
      if (args.includes("disable")) throw new Error("systemctl failed with code 1: Failed to disable unit: Access denied");
      return { stdout: "", stderr: "" };
    };
    await expect(removeUserUnits(["recording-cli-sync.timer"], ["recording-cli-sync.timer"], failing, root)).rejects.toThrow("Access denied");
    expect(await fs.readdir(root)).toEqual(["recording-cli-sync.timer"]);

    // "No such file or directory" from an unreachable user bus says nothing about the unit.
    const noBus = async (_command: string, args: string[]) => {
      if (args.includes("disable")) throw new Error("systemctl failed with code 1: Failed to connect to bus: No such file or directory");
      return { stdout: "", stderr: "" };
    };
    await expect(removeUserUnits(["recording-cli-sync.timer"], ["recording-cli-sync.timer"], noBus, root)).rejects.toThrow("Failed to connect to bus");
    expect(await fs.readdir(root)).toEqual(["recording-cli-sync.timer"]);

    const missing = async (_command: string, args: string[]) => {
      if (args.includes("disable")) throw new Error("systemctl failed with code 1: Failed to disable unit: Unit file recording-cli-sync.timer does not exist.");
      return { stdout: "", stderr: "" };
    };
    expect(await removeUserUnits(["recording-cli-sync.timer"], ["recording-cli-sync.timer"], missing, root)).toEqual([join(root, "recording-cli-sync.timer")]);
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disabling a timer also stops a run of its service that is in progress", async () => {
  const runs: string[][] = [];
  const record = async (command: string, args: string[]) => { runs.push([command, ...args]); return { stdout: "", stderr: "" }; };
  await uninstallSyncTimer(record);
  await uninstallArchiveTimer(record);
  await uninstallProtonBackupTimer(record);
  const stops = runs.filter((run) => run.includes("stop") || run.includes("disable")).map((run) => run.slice(2).join(" "));
  expect(stops).toEqual([
    "disable --now recording-cli-sync.timer", "stop recording-cli-sync.service",
    "disable --now recording-cli-archive.timer", "stop recording-cli-archive.service",
    "disable --now recording-cli-proton-backup.timer", "stop recording-cli-proton-backup.service"
  ]);
});

test("the call monitor and tray are not reported removed while systemd cannot stop them", async () => {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const units = ["recording-cli-calls.service", "recording-cli-tray.service"].map((name) => join(unitDir, name));
  await fs.mkdir(unitDir, { recursive: true });
  for (const unit of units) await fs.writeFile(unit, "x");
  const refusing = (message: string) => async (_command: string, args: string[]) => {
    if (args.includes("disable") || args.includes("stop")) throw new Error(`systemctl failed with code 1: ${message}`);
    return { stdout: "", stderr: "" };
  };
  // A monitor that keeps running would keep recording: its files stay and the failure is reported.
  const noBus = refusing("Failed to connect to bus: No such file or directory");
  await expect(uninstallCallMonitorService(noBus)).rejects.toThrow("Failed to connect to bus");
  await expect(uninstallTrayService(noBus)).rejects.toThrow("Failed to connect to bus");
  for (const unit of units) expect(await Bun.file(unit).exists()).toBe(true);
  // Units that are already gone do not block removal.
  const gone = refusing("Unit recording-cli-calls.service not loaded.");
  expect(await uninstallCallMonitorService(gone)).toBe(units[0]);
  expect(await uninstallTrayService(gone)).toBe(units[1]);
  for (const unit of units) expect(await Bun.file(unit).exists()).toBe(false);
});

test("uninstall commands still run while the configuration is broken", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-uninstall-"));
  try {
    const home = join(root, "home");
    const xdg = join(root, "config");
    const bin = join(root, "bin");
    const log = join(root, "systemctl.log");
    await fs.mkdir(join(xdg, "recording-cli"), { recursive: true });
    await fs.writeFile(join(xdg, "recording-cli", "config.json"), "{ broken");
    await fs.mkdir(bin);
    await fs.writeFile(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
    for (const command of [["jobs", "uninstall-timer"], ["archive", "uninstall-timer"], ["backup", "uninstall-timer"], ["calls", "uninstall-service"]]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../cli/index.ts"), ...command], {
        env: { HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${bin}:/usr/bin:/bin` }, stdout: "ignore", stderr: "pipe"
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ command: command.join(" "), code, stderr }).toEqual({ command: command.join(" "), code: 0, stderr: "" });
    }
    const calls = await fs.readFile(log, "utf8");
    for (const unit of ["recording-cli-sync.timer", "recording-cli-archive.timer", "recording-cli-proton-backup.timer", "recording-cli-calls.service"]) {
      expect(calls).toContain(`--user disable --now ${unit}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source runs from the Studio bridge launch the CLI entry, not bridge.ts", () => {
  expect(cliEntryForBun("/repo/src/cli/index.ts")).toBe("/repo/src/cli/index.ts");
  expect(cliEntryForBun("/repo/dist/index.js")).toBe("/repo/dist/index.js");
  expect(cliEntryForBun("/repo/src/desktop/bridge.ts")).toBe(join(import.meta.dir, "../../cli/index.ts"));
  expect(getServiceLaunchCommand("/usr/bin/bun", cliEntryForBun("/repo/src/desktop/bridge.ts"), [])[1]).toMatch(/src\/cli\/index\.ts$/);
});
