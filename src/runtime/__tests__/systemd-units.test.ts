import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { buildArchiveUnits, uninstallArchiveTimer } from "../../archive/service";
import { buildSyncUnits, buildWorkerUnit, uninstallSyncTimer } from "../../jobs/service";
import { buildProtonBackupUnits, uninstallProtonBackupTimer } from "../../proton/service";
import { buildCallMonitorUnit, uninstallCallMonitorService } from "../../calls/service";
import { buildTrayUnit, uninstallTrayService } from "../../tray/service";
import { queueAlignedSubtitles } from "../../subtitles/service";
import { playbackRunArgs } from "../../desktop/playback";
import { cliEntryForBun, getServiceLaunchCommand } from "../launcher";
import { execStart, quoteSystemd, quoteSystemdPath, removeUserUnits, transientCommand, userUnitDir } from "../systemd-units";

test("command arguments never expand environment variables in units or transient commands", () => {
  // systemd expands $NAME and the braced form in command lines, even quoted; "$$" is a literal dollar sign.
  const braced = "$" + "{release}";
  expect(execStart([`/opt/falatrace-${braced}/falatrace`, "$HOME"])).toBe(`"/opt/falatrace-$${braced}/falatrace" "$$HOME"`);
  const config = structuredClone(DEFAULT_CONFIG);
  const launch = ["/opt/falatrace-$release/falatrace"];
  for (const unit of [buildCallMonitorUnit(config, launch), buildTrayUnit(launch), buildWorkerUnit(config, launch), buildSyncUnits(config, launch).service]) {
    expect(unit).toContain('ExecStart="/opt/falatrace-$$release/falatrace" ');
  }
  expect(transientCommand([`/rec/a $HOME ${braced}.mkv`])).toEqual([`/rec/a $$HOME $${braced}.mkv`]);
  const playback = playbackRunArgs("recording-studio-playback-1", launch, "123e4567-e89b-42d3-a456-426614174000", "/rec/$cost.mkv", {});
  expect(playback.slice(playback.indexOf("--") + 1)).toEqual(["/opt/falatrace-$$release/falatrace", "desktop", "playback", "123e4567-e89b-42d3-a456-426614174000", "/rec/$$cost.mkv"]);
});

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

test("subtitles and playback units started by the Studio read the configuration the Studio reads", async () => {
  const runs: string[][] = [];
  await queueAlignedSubtitles("123e4567-e89b-42d3-a456-426614174000", async (command, args) => { runs.push([command, ...args]); return { stdout: "", stderr: "" }; });
  const env = { PATH: "/usr/bin", XDG_CONFIG_HOME: "/custom/config", XDG_STATE_HOME: "/custom/state", XDG_DATA_HOME: "/custom/data" };
  const playback = playbackRunArgs("recording-studio-playback-1", ["/x/falatrace"], "123e4567-e89b-42d3-a456-426614174000", "/rec/a.mkv", env);
  const [subtitles = []] = runs;
  const subtitleOptions = subtitles.slice(0, subtitles.indexOf("--"));
  for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) {
    expect(subtitleOptions).toContain(`--setenv=${name}=${process.env[name]}`);
    expect(playback.slice(0, playback.indexOf("--"))).toContain(`--setenv=${name}=${env[name as keyof typeof env]}`);
  }
  expect(playback.slice(playback.indexOf("--"))).toEqual(["--", "/x/falatrace", "desktop", "playback", "123e4567-e89b-42d3-a456-426614174000", "/rec/a.mkv"]);
});

/** The user manager's UnitPath for a configuration directory, in systemd's order. */
const unitPath = (config: string, home = "/home/u"): string[] => [
  `${config}/systemd/user.control`, "/run/user/1000/systemd/user.control", "/run/user/1000/systemd/transient",
  "/run/user/1000/systemd/generator.early", `${config}/systemd/user`, "/etc/xdg/systemd/user", "/etc/systemd/user",
  "/run/user/1000/systemd/user", "/run/systemd/user", "/run/user/1000/systemd/generator", `${home}/.local/share/systemd/user`,
  "/usr/local/lib/systemd/user", "/usr/lib/systemd/user", "/run/user/1000/systemd/generator.late"
];
/** A systemctl that reports `listing` as the manager's UnitPath and accepts everything else. */
const managerListing = (listing: string[], runs: string[][] = []) => async (command: string, args: string[]) => {
  runs.push([command, ...args]);
  return { stdout: args.includes("--property=UnitPath") ? `${listing.join(" ")}\n` : "", stderr: "" };
};

test("units go where the user manager loads them, even when its XDG_CONFIG_HOME differs from this process's", async () => {
  const home = "/home/u";
  const runs: string[][] = [];
  // The manager shares this process's custom configuration directory.
  expect(await userUnitDir(managerListing(unitPath("/custom/config"), runs), { XDG_CONFIG_HOME: "/custom/config" }, home)).toBe("/custom/config/systemd/user");
  expect(runs).toEqual([["systemctl", "--user", "show", "--property=UnitPath", "--value"]]);
  // Only this process has one: the manager still loads ~/.config/systemd/user.
  expect(await userUnitDir(managerListing(unitPath(`${home}/.config`)), { XDG_CONFIG_HOME: "/custom/config" }, home)).toBe(`${home}/.config/systemd/user`);
  // Only the manager has one.
  expect(await userUnitDir(managerListing(unitPath("/manager/config")), {}, home)).toBe("/manager/config/systemd/user");
  // Older managers list only directories that exist.
  expect(await userUnitDir(managerListing([`${home}/.config/systemd/user`, "/etc/systemd/user", "/usr/lib/systemd/user"]), { XDG_CONFIG_HOME: "/custom/config" }, home)).toBe(`${home}/.config/systemd/user`);
  // The manager cannot be asked: this process's environment decides, as systemd's client tools do.
  const noBus = async () => { throw new Error("systemctl failed with code 1: Failed to connect to bus: No such file or directory"); };
  expect(await userUnitDir(noBus, { XDG_CONFIG_HOME: "/custom/config" }, home)).toBe("/custom/config/systemd/user");
  expect(await userUnitDir(noBus, { XDG_CONFIG_HOME: "relative/config" }, home)).toBe(`${home}/.config/systemd/user`);
});

test("removal deletes the unit files from the directory the user manager loads", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-units-"));
  try {
    const unitDir = join(root, "manager-config", "systemd", "user");
    await fs.mkdir(unitDir, { recursive: true });
    for (const name of ["recording-cli-sync.timer", "recording-cli-sync.service"]) await fs.writeFile(join(unitDir, name), "x");
    expect(await uninstallSyncTimer(managerListing(unitPath(join(root, "manager-config"))))).toEqual([
      join(unitDir, "recording-cli-sync.timer"), join(unitDir, "recording-cli-sync.service")
    ]);
    expect(await fs.readdir(unitDir)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
    // systemd 256 and later name the bus scope and transport.
    const noUserBus = async (_command: string, args: string[]) => {
      if (args.includes("disable")) throw new Error("systemctl failed with code 1: Failed to connect to user scope bus via local transport: No such file or directory");
      return { stdout: "", stderr: "" };
    };
    await expect(removeUserUnits(["recording-cli-sync.timer"], ["recording-cli-sync.timer"], noUserBus, root)).rejects.toThrow("user scope bus");
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
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-units-"));
  try {
    const unitDir = join(root, "config", "systemd", "user");
    const units = ["recording-cli-calls.service", "recording-cli-network-probe.service", "recording-cli-tray.service"].map((name) => join(unitDir, name));
    await fs.mkdir(unitDir, { recursive: true });
    for (const unit of units) await fs.writeFile(unit, "x");
    const listed = managerListing(unitPath(join(root, "config")));
    const refusing = (message: string) => async (command: string, args: string[]) => {
      if (args.includes("disable") || args.includes("stop")) throw new Error(`systemctl failed with code 1: ${message}`);
      return listed(command, args);
    };
    // A monitor that keeps running would keep recording: its files stay and the failure is reported.
    const noBus = refusing("Failed to connect to bus: No such file or directory");
    await expect(uninstallCallMonitorService(noBus)).rejects.toThrow("Failed to connect to bus");
    await expect(uninstallTrayService(noBus)).rejects.toThrow("Failed to connect to bus");
    for (const unit of units) expect(await Bun.file(unit).exists()).toBe(true);
    // Units that are already gone do not block removal, which deletes them where the manager loads them.
    const gone = refusing("Unit recording-cli-calls.service not loaded.");
    expect(await uninstallCallMonitorService(gone)).toBe(units[0]);
    expect(await uninstallTrayService(gone)).toBe(units[2]);
    for (const unit of units) expect(await Bun.file(unit).exists()).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
