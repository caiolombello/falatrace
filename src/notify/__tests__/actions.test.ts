import { afterEach, describe, expect, test } from "bun:test";
import {
  buildDetachedNotifyArgs, buildNotifySendArgs, clearNotifySendProbeCache, type CommandRunner, detachedNotifyUnitName, handleReadyNotification,
  NOTIFY_ERRORS, NOTIFY_KNOWN_ERRORS, notificationLanguage, notifySendSupportsActions, notifyWithActions, type NotifyWithActionsOptions,
  parseNotifyCommand, readyNotificationContent, spawnDetachedNotify, SYSTEMD_RUN
} from "../actions";

const JOB = "3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f";
const EVENT = "ab".repeat(32);
const XDG = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];

const options = (extra: Partial<NotifyWithActionsOptions> = {}): NotifyWithActionsOptions => ({
  title: "Em 2 min: Daily", body: "10:00–10:15\nEsta reunião não será gravada automaticamente.",
  actions: [{ id: "record", label: "Gravar" }, { id: "later", label: "Agora não" }], timeoutMs: 120_000, ...extra
});

type Call = { command: string; args: string[]; timeoutMs?: number };
const runner = (answer: (call: Call) => { stdout?: string; stderr?: string } | Error): { run: CommandRunner; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, opts) => {
      const call = { command, args, timeoutMs: opts.timeoutMs };
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) throw result;
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  };
};

const HELP_08 = "Usage:\n  notify-send [OPTION…] <SUMMARY> [BODY] - create a notification\n  -A, --action=[NAME=]Text...     Specifies the actions to display to the user.\n  -w, --wait\n";
const HELP_079 = "Usage:\n  notify-send [OPTION…] <SUMMARY> [BODY]\n  -u, --urgency=LEVEL\n  -t, --expire-time=TIME\n  -a, --app-name=APP_NAME\n";

afterEach(() => clearNotifySendProbeCache());

describe("notify-send arguments", () => {
  test("app, icon, desktop entry, actions and timeout come before `--`, then title and body", () => {
    expect(buildNotifySendArgs(options(), true)).toEqual([
      "-a", "FalaTrace", "-i", "media-record", "-h", "string:desktop-entry:recording-studio", "-u", "normal",
      "-A", "record=Gravar", "-A", "later=Agora não", "-t", "120000", "--",
      "Em 2 min: Daily", "10:00–10:15\nEsta reunião não será gravada automaticamente."
    ]);
    const plain = buildNotifySendArgs(options(), false);
    expect(plain).not.toContain("-A");
    expect(plain.slice(-3)).toEqual(["--", "Em 2 min: Daily", "10:00–10:15\nEsta reunião não será gravada automaticamente."]);
  });

  test("a title starting with a dash stays a title; body markup is escaped; text is cleaned", () => {
    const args = buildNotifySendArgs(options({
      title: "--help\u0007 me", body: "<a href=\"https://evil.example\">Clique</a> & <b>já</b>\n\n‮line2  \u0000", appName: "Fala\nTrace"
    }), true);
    expect(args.slice(-3)).toEqual(["--", "--help me", "&lt;a href=\"https://evil.example\"&gt;Clique&lt;/a&gt; &amp; &lt;b&gt;já&lt;/b&gt;\nline2"]);
    expect(args[1]).toBe("Fala Trace");
  });

  test("bodies are capped by lines and length; labels may contain '='", () => {
    const body = Array.from({ length: 20 }, (_, index) => `linha ${index} ${"x".repeat(200)}`).join("\n");
    const args = buildNotifySendArgs(options({ body, actions: [{ id: "ok", label: "a=b" }] }), true);
    const shown = args[args.length - 1];
    expect(shown.length).toBeLessThanOrEqual(1_000);
    expect(shown.split("\n").length).toBeLessThanOrEqual(8);
    expect(args).toContain("ok=a=b");
  });

  test("invalid notifications are refused", () => {
    const bad: Array<Partial<NotifyWithActionsOptions>> = [
      { title: " \u0000 " }, { timeoutMs: 999 }, { timeoutMs: 60 * 60_000 + 1 }, { timeoutMs: 1.5e3 + 0.5 },
      { actions: [{ id: "Record", label: "x" }] }, { actions: [{ id: "ok=1", label: "x" }] }, { actions: [{ id: "ok", label: "x" }, { id: "ok", label: "y" }] },
      { actions: [{ id: "ok", label: " " }] }, { actions: Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, label: "x" })) },
      { icon: "../../etc/passwd" }, { icon: "icon name" }, { desktopEntry: "recording studio" }, { desktopEntry: "x;rm" },
      { urgency: "loud" as never }, { actions: "record" as never }
    ];
    for (const extra of bad) expect(() => buildNotifySendArgs(options(extra), true)).toThrow(NOTIFY_ERRORS.invalidNotification);
    expect(() => buildNotifySendArgs(null as never, true)).toThrow(NOTIFY_ERRORS.invalidNotification);
  });
});

describe("probing for actions", () => {
  test("libnotify 0.8 advertises --action; 0.7.9 does not; a failing probe means no actions", async () => {
    expect(await notifySendSupportsActions({ run: runner(() => ({ stdout: HELP_08 })).run })).toBe(true);
    expect(await notifySendSupportsActions({ run: runner(() => ({ stdout: HELP_079 })).run })).toBe(false);
    expect(await notifySendSupportsActions({ run: runner(() => new Error("ENOENT")).run })).toBe(false);
    const probe = runner(() => ({ stdout: HELP_08 }));
    await notifySendSupportsActions({ run: probe.run, command: "/opt/notify-send" });
    expect(probe.calls).toEqual([{ command: "/opt/notify-send", args: ["--help"], timeoutMs: 3_000 }]);
  });

  test("the real probe runs once per process and command (the offline stub has no actions)", async () => {
    const first = notifySendSupportsActions();
    expect(notifySendSupportsActions()).toBe(first);
    expect(await first).toBe(false);
    clearNotifySendProbeCache();
    expect(notifySendSupportsActions()).not.toBe(first);
  });
});

describe("showing a notification with actions", () => {
  test("returns the chosen action and waits at most the notification timeout plus a margin", async () => {
    const fake = runner((call) => (call.args[0] === "--help" ? { stdout: HELP_08 } : { stdout: "record\n" }));
    expect(await notifyWithActions(options(), { run: fake.run })).toBe("record");
    expect(fake.calls.map((call) => call.args[0])).toEqual(["--help", "-a"]);
    expect(fake.calls[1].timeoutMs).toBe(130_000);
    expect(fake.calls[1].command).toBe("notify-send");
  });

  test("dismissal, timeout, unknown output and an aborted wait all mean no choice", async () => {
    for (const answer of [{ stdout: "" }, { stdout: "delete\n" }, { stdout: "1\n" }, new Error("notify-send timed out after 130000ms: ")]) {
      expect(await notifyWithActions(options(), { run: runner(() => answer).run, supportsActions: true })).toBeNull();
    }
    expect(await notifyWithActions(options(), { run: runner(() => ({ stdout: "id: 7\nlater\n" })).run, supportsActions: true })).toBe("later");
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    expect(await notifyWithActions(options({ signal: controller.signal }), { run: async () => { ran = true; return { stdout: "record", stderr: "" }; }, supportsActions: true })).toBeNull();
    expect(ran).toBe(false);
    const aborting = new AbortController();
    expect(await notifyWithActions(options({ signal: aborting.signal }), {
      supportsActions: true, run: async () => { aborting.abort(); throw new Error("notify-send cancelled"); }
    })).toBeNull();
  });

  test("without action support a plain notification is shown and no choice is waited for", async () => {
    const fake = runner((call) => (call.args[0] === "--help" ? { stdout: HELP_079 } : { stdout: "" }));
    expect(await notifyWithActions(options(), { run: fake.run })).toBeNull();
    expect(fake.calls[1].args).not.toContain("-A");
    expect(fake.calls[1].timeoutMs).toBe(10_000);
    const none = runner(() => ({ stdout: "" }));
    expect(await notifyWithActions(options({ actions: [] }), { run: none.run })).toBeNull();
    expect(none.calls.map((call) => call.args[0])).toEqual(["-a"]);
  });

  test("a notification that cannot be shown at all is a known error without the command's output", async () => {
    const error = await notifyWithActions(options(), { supportsActions: true, run: runner(() => new Error("notify-send failed with code 1: secret-token")).run })
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe(NOTIFY_ERRORS.failed);
  });
});

describe("language", () => {
  test("the saved Studio language wins; auto keeps Portuguese for pt and C locales", () => {
    expect(notificationLanguage({ studio: { language: "en" } }, { LANG: "pt_BR.UTF-8" })).toBe("en");
    expect(notificationLanguage({ studio: { language: "pt-BR" } }, { LANG: "en_US.UTF-8" })).toBe("pt-BR");
    expect(notificationLanguage({ studio: { language: "auto" } }, { LANG: "pt_PT.UTF-8" })).toBe("pt-BR");
    expect(notificationLanguage({ studio: { language: "auto" } }, { LANG: "C.UTF-8" })).toBe("pt-BR");
    expect(notificationLanguage({ studio: { language: "auto" } }, {})).toBe("pt-BR");
    expect(notificationLanguage({ studio: { language: "auto" } }, { LANG: "de_DE.UTF-8" })).toBe("en");
    expect(notificationLanguage({ studio: { language: "auto" } }, { LANG: "pt_BR.UTF-8", LC_MESSAGES: "en_GB.UTF-8" })).toBe("en");
    expect(notificationLanguage({ studio: { language: "auto" } }, { LC_ALL: "pt_BR.UTF-8", LC_MESSAGES: "en_GB.UTF-8" })).toBe("pt-BR");
  });
});

describe("detached helpers", () => {
  test("a non-waiting transient unit per job or event runs `notify <kind>` with the same XDG directories", () => {
    const ready = buildDetachedNotifyArgs("ready", { job: JOB }, { launchCommand: ["/home/u/.local/bin/falatrace"], env: { PATH: "/usr/bin" } });
    expect(ready.slice(0, 6)).toEqual([
      "--user", "--quiet", "--collect", `--unit=recording-cli-ready-${JOB}`, "--property=RuntimeMaxSec=2400", "--setenv=PATH=/usr/bin"
    ]);
    expect(ready).not.toContain("--wait");
    expect(ready.slice(ready.indexOf("--"))).toEqual(["--", "/home/u/.local/bin/falatrace", "notify", "ready", "--job", JOB]);
    const options = ready.slice(0, ready.indexOf("--"));
    for (const name of XDG) expect(options.some((arg) => arg.startsWith(`--setenv=${name}=`))).toBe(true);
    const reminder = buildDetachedNotifyArgs("reminder", { event: EVENT }, { launchCommand: ["/usr/bin/bun", "/src/cli/index.ts"], env: {} });
    expect(reminder).toContain(`--unit=recording-cli-reminder-${EVENT}`);
    expect(reminder.slice(reminder.indexOf("--"))).toEqual(["--", "/usr/bin/bun", "/src/cli/index.ts", "notify", "reminder", "--event", EVENT]);
    expect(detachedNotifyUnitName("ready", { job: JOB })).toBe(`recording-cli-ready-${JOB}`);
  });

  test("dollar signs in the launcher stay literal; ids and launchers are validated", () => {
    const args = buildDetachedNotifyArgs("ready", { job: JOB }, { launchCommand: ["/opt/$HOME/falatrace"], env: {} });
    expect(args).toContain("/opt/$$HOME/falatrace");
    const bad: Array<[string, { job?: string; event?: string }]> = [
      ["ready", { job: JOB.toUpperCase() }], ["ready", { job: "3f2b8c1e-9a4d-1c7b-8e2f-1a2b3c4d5e6f" }], ["ready", { job: `${JOB};rm` }],
      ["ready", { event: EVENT }], ["ready", { job: JOB, event: EVENT }], ["reminder", { event: EVENT.slice(2) }], ["reminder", { event: `${EVENT}0` }],
      ["reminder", { job: JOB }], ["other", { job: JOB }]
    ];
    for (const [kind, target] of bad) expect(() => buildDetachedNotifyArgs(kind as never, target, { launchCommand: ["/x"], env: {} })).toThrow(NOTIFY_ERRORS.invalidCommand);
    expect(() => buildDetachedNotifyArgs("ready", { job: JOB }, { launchCommand: ["/x\n/evil"], env: {} })).toThrow(NOTIFY_ERRORS.invalidCommand);
    expect(() => buildDetachedNotifyArgs("ready", { job: JOB }, { launchCommand: [], env: {} })).toThrow(NOTIFY_ERRORS.invalidCommand);
  });

  test("starting a helper returns at once; a helper already waiting for the same id is not an error", async () => {
    const fake = runner(() => ({ stdout: "" }));
    expect(await spawnDetachedNotify("ready", { job: JOB }, { run: fake.run, launchCommand: ["/x"], env: {} })).toBe("started");
    expect(fake.calls[0].command).toBe(SYSTEMD_RUN);
    expect(fake.calls[0].timeoutMs).toBe(15_000);
    const exists = runner(() => new Error(`/usr/bin/systemd-run failed with code 1: Failed to start transient service unit: Unit recording-cli-ready-${JOB}.service was already loaded or has a fragment file.`));
    expect(await spawnDetachedNotify("ready", { job: JOB }, { run: exists.run, launchCommand: ["/x"], env: {} })).toBe("already-shown");
    const broken = runner(() => new Error("Failed to connect to bus: token=secret"));
    const error = await spawnDetachedNotify("reminder", { event: EVENT }, { run: broken.run, launchCommand: ["/x"], env: {} }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe(NOTIFY_ERRORS.spawnFailed);
  });

  test("the CLI arguments must be exactly `ready --job <uuid>` or `reminder --event <hash>`", () => {
    expect(parseNotifyCommand(["ready", "--job", JOB])).toEqual({ kind: "ready", job: JOB });
    expect(parseNotifyCommand(["reminder", "--event", EVENT])).toEqual({ kind: "reminder", event: EVENT });
    for (const bad of [
      [], ["ready"], ["ready", "--job"], ["ready", `--job=${JOB}`], ["ready", "--event", JOB], ["reminder", "--job", EVENT], ["ready", "--job", JOB, "--extra"],
      ["READY", "--job", JOB], ["ready", "--job", ` ${JOB}`], ["reminder", "--event", "falatrace://event/x"]
    ]) expect(() => parseNotifyCommand(bad)).toThrow(NOTIFY_ERRORS.invalidCommand);
  });
});

describe("summary-ready notification", () => {
  test("content in Portuguese and English, with a click opening the recording", () => {
    expect(readyNotificationContent("2026-10-25_14-00_Daily")).toEqual({
      title: "Resumo pronto", body: "2026-10-25_14-00_Daily: transcrição e resumo prontos.",
      actions: [{ id: "default", label: "Abrir" }, { id: "open", label: "Abrir no Studio" }]
    });
    expect(readyNotificationContent("Daily", "en").body).toBe("Daily: transcript and summary are ready.");
    expect(readyNotificationContent(" \u0000 ").body).toBe("Sua gravação: transcrição e resumo prontos.");
    expect(readyNotificationContent("x".repeat(500)).body.length).toBeLessThan(140);
  });

  test("a click (default or open) navigates to that recording; anything else does nothing", async () => {
    for (const [choice, expected] of [["default", true], ["open", true], [null, false], ["later", false]] as Array<[string | null, boolean]>) {
      const opened: string[] = [];
      const shown: NotifyWithActionsOptions[] = [];
      const result = await handleReadyNotification(JOB, {
        name: "Daily", notify: async (notification) => { shown.push(notification); return choice; }, open: async (uri) => { opened.push(uri); }
      });
      expect(result).toBe(choice);
      expect(opened).toEqual(expected ? [`falatrace://recording/${JOB}`] : []);
      expect(shown[0].timeoutMs).toBe(30 * 60_000);
      expect(shown[0].actions.map((action) => action.id)).toEqual(["default", "open"]);
    }
  });

  test("an invalid job id is refused before anything is shown", async () => {
    let shown = false;
    await expect(handleReadyNotification("../../x", { notify: async () => { shown = true; return null; } })).rejects.toThrow(NOTIFY_ERRORS.invalidCommand);
    expect(shown).toBe(false);
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(NOTIFY_KNOWN_ERRORS).toEqual(Object.values(NOTIFY_ERRORS));
    for (const message of NOTIFY_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
