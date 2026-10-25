import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpcomingEvent } from "../../calendar/upcoming";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import type { NotifyWithActionsOptions } from "../../notify/actions";
import type { SingletonLease } from "../../runtime/singleton";
import {
  activeOverride, handleReminderNotification, OVERRIDE_KNOWN_ERRORS, recordSentReminder, REMINDER_KNOWN_ERRORS, REMINDERS_KNOWN_ERRORS,
  REMINDERS_SERVICE_ERRORS, REMINDERS_UNIT_ERRORS, REMINDERS_UNIT_KNOWN_ERRORS, type ReminderActionId, type ReminderRecordingMode, runRemindersService, type SentReminder
} from "../index";

const T0 = Date.parse("2026-10-25T13:00:00.000Z");
const at = (minutes: number): number => T0 + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();
const HASH = createHash("sha256").update("event-1").digest("hex");

const config = (options: { gnome?: boolean; reminders?: "auto" | "on" | "off" } = {}): AppConfig => {
  const value = structuredClone(DEFAULT_CONFIG);
  value.calendar.enabled = options.gnome ?? true;
  value.reminders.mode = options.reminders ?? "on";
  return value;
};

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-reminders-index-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const lease = (events: string[]): ((name: string) => Promise<SingletonLease>) => async (name) => {
  events.push(`lock ${name}`);
  return { release: async () => { events.push("release"); } };
};

describe("runRemindersService", () => {
  test("does not start without anything to do", async () => {
    const events: string[] = [];
    expect(await runRemindersService({ config: config({ gnome: false }), signal: new AbortController().signal, deps: { lock: lease(events) } }))
      .toEqual({ ran: false, reason: REMINDERS_UNIT_ERRORS.noCalendar });
    expect(await runRemindersService({ config: config({ reminders: "off" }), signal: new AbortController().signal, deps: { lock: lease(events) } }))
      .toEqual({ ran: false, reason: REMINDERS_UNIT_ERRORS.off });
    expect(events).toEqual([]);
  });

  test("one loop per user: a second service is refused with a known error", async () => {
    const busy = async (): Promise<never> => { throw new Error("reminders is already running"); };
    await expect(runRemindersService({ config: config(), signal: new AbortController().signal, deps: { lock: busy } }))
      .rejects.toThrow(REMINDERS_SERVICE_ERRORS.alreadyRunning);
    const other = async (): Promise<never> => { throw new Error("EPERM"); };
    await expect(runRemindersService({ config: config(), signal: new AbortController().signal, deps: { lock: other } })).rejects.toThrow("EPERM");
  });

  test("runs the loop with the given dependencies and releases the lock when stopped", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let clock = at(0);
    const upcoming: UpcomingEvent = {
      source: "gnome-calendar", eventIdHash: HASH, title: "Daily", startAt: iso(1), endAt: iso(15), recurring: true, attendees: []
    };
    const notified: string[] = [];
    const result = await runRemindersService({
      config: config(),
      signal: controller.signal,
      deps: {
        lock: lease(events),
        stateDir: await tempDir(),
        now: () => clock,
        sleep: async (ms) => { clock += ms; controller.abort(); },
        listEvents: async () => [upcoming],
        automationPaused: async () => false,
        notify: async (reminder) => { notified.push(reminder.event.title); }
      }
    });
    expect(result).toEqual({ ran: true });
    expect(notified).toEqual(["Daily"]);
    expect(events).toEqual(["lock reminders", "release"]);
  });
});

const sent = (mode: ReminderRecordingMode, actions: Array<[string, string]>, extra: Partial<SentReminder> = {}): SentReminder => ({
  eventIdHash: HASH, startAt: iso(30), endAt: iso(60), title: "Revisão semanal", source: "google-calendar", recurring: true, sentAt: iso(28),
  recordingMode: mode,
  notification: { title: "Em 2 min: Revisão semanal", body: "13:30–14:00\nTexto.", actions: actions.map(([id, label]) => ({ id, label })) },
  ...extra
});

const RECORD_LATER: Array<[string, string]> = [["record", "Gravar"], ["later", "Agora não"], ["brief", "Ver resumo anterior"]];
const SKIP_OK: Array<[string, string]> = [["skip", "Pular esta gravação"], ["ok", "OK"]];

describe("handleReminderNotification", () => {
  const setup = async (entry: SentReminder, choice: string | null, now = at(28)) => {
    const stateDir = await tempDir();
    await recordSentReminder(entry, { stateDir, now: at(28) });
    const shown: NotifyWithActionsOptions[] = [];
    const opened: string[] = [];
    const result = await handleReminderNotification(HASH, {
      stateDir,
      now: () => now,
      notify: async (options) => { shown.push(options); return choice; },
      open: async (uri) => { opened.push(uri); }
    });
    return { stateDir, shown, opened, result };
  };

  test("shows exactly the recorded notification, waiting until 10 minutes after the start", async () => {
    const { shown, result } = await setup(sent("notify-only", RECORD_LATER), null);
    expect(result).toEqual({ shown: true, choice: null });
    expect(shown).toEqual([{
      title: "Em 2 min: Revisão semanal", body: "13:30–14:00\nTexto.",
      actions: [{ id: "record", label: "Gravar" }, { id: "later", label: "Agora não" }, { id: "brief", label: "Ver resumo anterior" }],
      timeoutMs: 12 * 60_000, signal: undefined
    }]);
  });

  test("the wait is at least a minute and at most 30 minutes", async () => {
    expect((await setup(sent("notify-only", RECORD_LATER), null, at(45))).shown[0].timeoutMs).toBe(60_000);
    expect((await setup(sent("notify-only", RECORD_LATER, { startAt: iso(100), endAt: iso(130) }), null, at(28))).shown[0].timeoutMs).toBe(30 * 60_000);
  });

  test("record saves a 'record' decision for this meeting", async () => {
    const { stateDir, result, opened } = await setup(sent("notify-only", RECORD_LATER), "record");
    expect(result.choice).toBe("record");
    expect(result.override).toMatchObject({ eventIdHash: HASH, decision: "record", startAt: iso(30), endAt: iso(60), title: "Revisão semanal" });
    expect((await activeOverride(new Date(at(31)), { stateDir }))?.decision).toBe("record");
    expect(opened).toEqual([]);
  });

  test("skip saves a 'skip' decision", async () => {
    const { stateDir, result } = await setup(sent("record", SKIP_OK), "skip");
    expect(result.override?.decision).toBe("skip");
    expect((await activeOverride(new Date(at(31)), { stateDir }))?.decision).toBe("skip");
  });

  test("with call detection off, record opens the capture page instead (nothing would act on a decision)", async () => {
    const { stateDir, result, opened } = await setup(sent("off", RECORD_LATER), "record");
    expect(result).toEqual({ shown: true, choice: "record", opened: "falatrace://capture" });
    expect(opened).toEqual(["falatrace://capture"]);
    expect(await activeOverride(new Date(at(31)), { stateDir })).toBeUndefined();
  });

  test("brief opens the event in the Studio; later, ok and unknown answers do nothing", async () => {
    const brief = await setup(sent("notify-only", RECORD_LATER), "brief");
    expect(brief.opened).toEqual([`falatrace://event/${HASH}`]);
    expect(brief.result.opened).toBe(`falatrace://event/${HASH}`);
    for (const [entry, choice, expected] of [
      [sent("notify-only", RECORD_LATER), "later", "later"], [sent("record", SKIP_OK), "ok", "ok"],
      // An id the notification did not offer is ignored, even a real action name.
      [sent("record", SKIP_OK), "record", null], [sent("notify-only", RECORD_LATER), "delete", null]
    ] as Array<[SentReminder, string, ReminderActionId | null]>) {
      const run = await setup(entry, choice);
      expect(run.result).toEqual({ shown: true, choice: expected });
      expect(run.opened).toEqual([]);
      expect(await activeOverride(new Date(at(31)), { stateDir: run.stateDir })).toBeUndefined();
    }
  });

  test("nothing is shown for an unknown event or a meeting that already ended", async () => {
    let shown = 0;
    const notify = async () => { shown++; return null; };
    expect(await handleReminderNotification(HASH, { stateDir: await tempDir(), notify })).toEqual({ shown: false, choice: null });
    const stateDir = await tempDir();
    await recordSentReminder(sent("notify-only", RECORD_LATER), { stateDir, now: at(28) });
    expect(await handleReminderNotification(HASH, { stateDir, now: () => at(60), notify })).toEqual({ shown: false, choice: null });
    expect(shown).toBe(0);
  });

  test("a malformed event id is refused before anything is read", async () => {
    for (const bad of ["", "A".repeat(64), "../../etc/passwd", `${HASH}\n`, HASH.slice(1)]) {
      await expect(handleReminderNotification(bad, { notify: async () => null })).rejects.toThrow(REMINDERS_SERVICE_ERRORS.invalidEvent);
    }
  });
});

test("the module's known errors cover overrides, ledger, unit and service, without repeats", () => {
  for (const message of [...OVERRIDE_KNOWN_ERRORS, ...REMINDER_KNOWN_ERRORS, ...REMINDERS_UNIT_KNOWN_ERRORS, ...Object.values(REMINDERS_SERVICE_ERRORS)]) {
    expect(REMINDERS_KNOWN_ERRORS).toContain(message);
  }
  expect(new Set(REMINDERS_KNOWN_ERRORS).size).toBe(REMINDERS_KNOWN_ERRORS.length);
});
