import { expect, test } from "bun:test";
import { buildLiveUnitArgs } from "../../live/unit";
import { buildDetachedNotifyArgs } from "../../notify/actions";
import { buildRemindersUnit } from "../../reminders/unit";
import { familyLoader } from "../families";
import { parseLiveArgs } from "../live";
import { parseNotifyArgs } from "../notify";
import { parseRemindersArgs } from "../reminders";

// The service and the detached helpers run the CLI with fixed argv; the CLI must accept exactly that.
const LAUNCH = ["/opt/Fala Trace $HOME/bin/bun", "/opt/Fala Trace/src/cli/index.ts"];
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT = "c".repeat(64);

/** systemd's reading of an ExecStart= line we write: quoted words, `\` escapes, `%%` and `$$`. */
const execStartArgv = (unit: string): string[] => {
  const line = unit.split("\n").find((candidate) => candidate.startsWith("ExecStart="));
  if (!line) throw new Error("no ExecStart");
  return [...line.slice("ExecStart=".length).matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1]!.replace(/\\(.)/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$"));
};

/** The command after systemd-run's `--`, with `$$` read back as `$`. */
const transientArgv = (args: string[]): string[] => args.slice(args.indexOf("--") + 1).map((arg) => arg.replaceAll("$$", "$"));

/** The CLI arguments: what follows the launcher. */
const cliArgs = (argv: string[]): string[] => {
  expect(argv.slice(0, LAUNCH.length)).toEqual(LAUNCH);
  return argv.slice(LAUNCH.length);
};

test("the reminders service runs `reminders run`, which the CLI accepts", () => {
  const args = cliArgs(execStartArgv(buildRemindersUnit(LAUNCH, {})));
  expect(args).toEqual(["reminders", "run"]);
  expect(familyLoader(args[0])).toBeFunction();
  expect(parseRemindersArgs(args)).toEqual({ action: "run" });
});

test("the detached notification helpers run `notify ready --job` and `notify reminder --event`, which the CLI accepts", () => {
  const ready = cliArgs(transientArgv(buildDetachedNotifyArgs("ready", { job: JOB }, { launchCommand: LAUNCH, env: {} })));
  expect(ready).toEqual(["notify", "ready", "--job", JOB]);
  expect(familyLoader(ready[0])).toBeFunction();
  expect(parseNotifyArgs(ready)).toEqual({ kind: "ready", job: JOB });
  const reminder = cliArgs(transientArgv(buildDetachedNotifyArgs("reminder", { event: EVENT }, { launchCommand: LAUNCH, env: {} })));
  expect(reminder).toEqual(["notify", "reminder", "--event", EVENT]);
  expect(parseNotifyArgs(reminder)).toEqual({ kind: "reminder", event: EVENT });
});

test("the live transcript unit runs `live run --session`, which the CLI accepts", () => {
  const args = cliArgs(transientArgv(buildLiveUnitArgs({ sessionId: SESSION, launch: LAUNCH, env: {}, home: "/home/synthetic" })));
  expect(args).toEqual(["live", "run", "--session", SESSION]);
  expect(familyLoader(args[0])).toBeFunction();
  expect(parseLiveArgs(args)).toEqual({ action: "run", sessionId: SESSION });
});

test("the internal commands refuse anything but their exact form", () => {
  expect(() => parseRemindersArgs(["reminders", "run", "--now"])).toThrow();
  expect(() => parseRemindersArgs(["reminders"])).toThrow();
  expect(() => parseNotifyArgs(["notify", "ready", "--job", "../etc"])).toThrow();
  expect(() => parseNotifyArgs(["notify", "ready", "--event", EVENT])).toThrow();
  expect(() => parseLiveArgs(["live", "run"])).toThrow();
  expect(() => parseLiveArgs(["live", "run", "--session", "../x"])).toThrow();
  expect(parseLiveArgs(["live", "show", SESSION, "--follow"])).toEqual({ action: "show", sessionId: SESSION, follow: true, json: false });
});
