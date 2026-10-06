import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { buildArchiveUnits } from "../../archive/service";
import { buildSyncUnits, buildWorkerUnit } from "../../jobs/service";
import { buildProtonBackupUnits } from "../../proton/service";
import { buildCallMonitorUnit } from "../../calls/service";
import { buildTrayUnit } from "../../tray/service";
import { cliEntryForBun, getServiceLaunchCommand } from "../launcher";
import { execStart, quoteSystemd, removeUserUnits, systemdPath } from "../systemd-units";

test("unit arguments are quoted and never act as systemd specifiers", () => {
  expect(quoteSystemd('/a b/"c"\\d%h')).toBe('"/a b/\\"c\\"\\\\d%%h"');
  expect(execStart(["/x/falatrace", "calls", "run"])).toBe('"/x/falatrace" "calls" "run"');
  expect(systemdPath("~/Videos")).toBe("%h/Videos");
  expect(systemdPath("/abs")).toBe("/abs");
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

test("source runs from the Studio bridge launch the CLI entry, not bridge.ts", () => {
  expect(cliEntryForBun("/repo/src/cli/index.ts")).toBe("/repo/src/cli/index.ts");
  expect(cliEntryForBun("/repo/dist/index.js")).toBe("/repo/dist/index.js");
  expect(cliEntryForBun("/repo/src/desktop/bridge.ts")).toBe(join(import.meta.dir, "../../cli/index.ts"));
  expect(getServiceLaunchCommand("/usr/bin/bun", cliEntryForBun("/repo/src/desktop/bridge.ts"), [])[1]).toMatch(/src\/cli\/index\.ts$/);
});
