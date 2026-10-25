import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import {
  buildRemindersUnit, installRemindersService, REMINDERS_UNIT, REMINDERS_UNIT_ERRORS, REMINDERS_UNIT_KNOWN_ERRORS, remindersServiceProblem,
  uninstallRemindersService
} from "../unit";

const LAUNCHER = ["/home/user/.local/bin/falatrace"];
const CLIENT = "123456789012-abcdefghij0123456789.apps.googleusercontent.com";

const config = (options: { reminders?: "auto" | "on" | "off"; gnome?: boolean; google?: boolean; detection?: "record" | "notify-only" } = {}): AppConfig => {
  const value = structuredClone(DEFAULT_CONFIG);
  value.reminders.mode = options.reminders ?? "auto";
  value.calendar.enabled = options.gnome ?? true;
  value.google = { clientId: options.google ? CLIENT : "", calendar: options.google === true };
  value.callDetection.enabled = options.detection !== undefined;
  value.callDetection.mode = options.detection ?? "notify-only";
  return value;
};

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-reminders-unit-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("the reminders unit", () => {
  test("runs `reminders run` sandboxed like the call monitor, with only the state directory writable", () => {
    const unit = buildRemindersUnit(LAUNCHER, { PATH: "/usr/bin" });
    expect(unit).toContain('ExecStart="/home/user/.local/bin/falatrace" "reminders" "run"\n');
    for (const line of [
      "Type=simple", "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=strict", "ProtectHome=read-only",
      "ReadWritePaths=%h/.local/state/recording-cli\n", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "UMask=0077",
      "PartOf=graphical-session.target", "WantedBy=default.target", "Restart=on-failure"
    ]) expect(unit).toContain(line);
    expect(unit).not.toContain("share/recording-cli");
    expect(unit).not.toContain("EnvironmentFile");
  });

  test("custom XDG directories reach the unit and its writable paths", () => {
    const unit = buildRemindersUnit(LAUNCHER, { PATH: "/usr/bin", XDG_STATE_HOME: "/custom/state", XDG_CONFIG_HOME: "/custom/config" });
    expect(unit).toContain('Environment="XDG_STATE_HOME=/custom/state"');
    expect(unit).toContain('Environment="XDG_CONFIG_HOME=/custom/config"');
    expect(unit).toContain('ReadWritePaths=%h/.local/state/recording-cli "-/custom/state/recording-cli"\n');
  });

  test("launcher paths are quoted, % and $ are literal, and control characters are refused", () => {
    const unit = buildRemindersUnit(["/opt/fala%trace/$HOME/bin/falatrace"], {});
    expect(unit).toContain('ExecStart="/opt/fala%%trace/$$HOME/bin/falatrace" "reminders" "run"');
    expect(() => buildRemindersUnit(["/bin/x\nExecStartPre=/bin/evil"])).toThrow(REMINDERS_UNIT_ERRORS.invalidLauncher);
    expect(() => buildRemindersUnit([])).toThrow(REMINDERS_UNIT_ERRORS.invalidLauncher);
  });

  test("the service is wanted only when reminders are on and a calendar is connected", () => {
    expect(remindersServiceProblem(config())).toBeUndefined();
    expect(remindersServiceProblem(config({ reminders: "off" }))).toBe(REMINDERS_UNIT_ERRORS.off);
    expect(remindersServiceProblem(config({ detection: "record" }))).toBe(REMINDERS_UNIT_ERRORS.off);
    expect(remindersServiceProblem(config({ detection: "record", reminders: "on" }))).toBeUndefined();
    expect(remindersServiceProblem(config({ gnome: false }))).toBe(REMINDERS_UNIT_ERRORS.noCalendar);
    expect(remindersServiceProblem(config({ gnome: false, google: true }))).toBeUndefined();
  });
});

describe("install and uninstall", () => {
  test("install writes a private unit, creates its writable path, reloads, enables and restarts", async () => {
    const root = await tempDir();
    const unitDir = join(root, "systemd", "user");
    const calls: string[] = [];
    const run = async (command: string, args: string[] = []) => { calls.push([command, ...args].join(" ")); return { stdout: "", stderr: "" }; };
    const path = await installRemindersService(config(), { run, unitDir, launchCommand: LAUNCHER, env: { PATH: "/usr/bin" }, home: root });
    expect(path).toBe(join(unitDir, REMINDERS_UNIT));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path, "utf8")).toBe(buildRemindersUnit(LAUNCHER, { PATH: "/usr/bin" }));
    expect((await fs.stat(join(root, ".local", "state", "recording-cli"))).isDirectory()).toBe(true);
    expect(calls).toEqual([
      "systemctl --user daemon-reload", `systemctl --user enable ${REMINDERS_UNIT}`, `systemctl --user restart ${REMINDERS_UNIT}`
    ]);
  });

  test("install is refused when the service would have nothing to do", async () => {
    const run = async () => { throw new Error("must not run"); };
    await expect(installRemindersService(config({ reminders: "off" }), { run, unitDir: await tempDir() })).rejects.toThrow(REMINDERS_UNIT_ERRORS.off);
    await expect(installRemindersService(config({ gnome: false }), { run, unitDir: await tempDir() })).rejects.toThrow(REMINDERS_UNIT_ERRORS.noCalendar);
  });

  test("uninstall tolerates a missing unit but stops on any other failure, before removing the file", async () => {
    const unitDir = await tempDir();
    const path = join(unitDir, REMINDERS_UNIT);
    await fs.writeFile(path, "unit");
    const calls: string[] = [];
    const missing = async (command: string, args: string[] = []) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("disable")) throw new Error(`Unit ${REMINDERS_UNIT} does not exist`);
      return { stdout: "", stderr: "" };
    };
    expect(await uninstallRemindersService({ run: missing, unitDir })).toBe(path);
    expect(calls).toEqual([`systemctl --user disable --now ${REMINDERS_UNIT}`, "systemctl --user daemon-reload"]);
    await expect(fs.stat(path)).rejects.toThrow();

    await fs.writeFile(path, "unit");
    const broken = async () => { throw new Error("Failed to connect to user scope bus via local transport"); };
    await expect(uninstallRemindersService({ run: broken, unitDir })).rejects.toThrow("Failed to connect");
    expect(await fs.readFile(path, "utf8")).toBe("unit");
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(REMINDERS_UNIT_KNOWN_ERRORS).toEqual(Object.values(REMINDERS_UNIT_ERRORS));
    for (const message of REMINDERS_UNIT_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
