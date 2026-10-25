import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BriefEvent, PreMeetingBrief } from "../../brief/build";
import type { UpcomingEvent } from "../../calendar/upcoming";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import type { NotifyWithActionsOptions } from "../../notify/actions";
import type { SingletonLease } from "../../runtime/singleton";
import {
  activeOverride, createReminderBrief, handleReminderNotification, OVERRIDE_KNOWN_ERRORS, recordSentReminder, REMINDER_KNOWN_ERRORS, REMINDERS_KNOWN_ERRORS,
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

describe("createReminderBrief", () => {
  const event: UpcomingEvent = {
    source: "google-calendar", eventIdHash: HASH, seriesIdHash: "b".repeat(64), title: "Revisão semanal", startAt: iso(30), endAt: iso(60), recurring: true,
    attendees: [{ name: "Ana Souza", self: false }, { name: "Eu", self: true }]
  };
  const brief = { title: "Revisão semanal", startAt: iso(30), endAt: iso(60), matchedBy: ["series"], people: [], clientCodes: [], recentMeetings: [], openActions: [], recentDecisions: [] } as PreMeetingBrief;

  test("builds the brief from the library index, refreshing it at most every 30 minutes", async () => {
    let clock = at(0);
    let refreshes = 0;
    const events: BriefEvent[] = [];
    const index = { listFacts: async () => [], getFacts: async () => undefined, search: async () => [], refresh: async () => { refreshes++; } };
    const make = createReminderBrief(config(), {
      index, now: () => clock, language: "en",
      build: async (_reader, value) => { events.push(value); return brief; },
      lines: (_brief, language) => [`lines in ${language}`]
    });
    expect(await make(event)).toEqual(["lines in en"]);
    expect(events).toEqual([{
      title: "Revisão semanal", startAt: iso(30), endAt: iso(60), recurring: true, attendees: [{ name: "Ana Souza", self: false }, { name: "Eu", self: true }],
      seriesIdHash: "b".repeat(64), eventIdHash: HASH
    }]);
    clock = at(10);
    await make(event);
    expect(refreshes).toBe(1);
    clock = at(31);
    await make(event);
    expect(refreshes).toBe(2);
  });

  test("a slow or failing refresh never holds the brief back; nothing relevant means no lines", async () => {
    const errors: unknown[] = [];
    const stuck = { listFacts: async () => [], getFacts: async () => undefined, search: async () => [], refresh: () => new Promise<never>(() => {}) };
    const started = Date.now();
    const slow = createReminderBrief(config(), { index: stuck, refreshTimeoutMs: 50, build: async () => null, onError: (error) => errors.push(error) });
    expect(await slow(event)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    const failing = { ...stuck, refresh: async () => { throw new Error("unsafe index folder"); } };
    const make = createReminderBrief(config(), { index: failing, build: async () => brief, lines: () => ["a", "b"], onError: (error) => errors.push(error) });
    expect(await make(event)).toEqual(["a", "b"]);
    expect(errors.map((error) => (error as Error).message)).toEqual(["unsafe index folder"]);
  });
});

const sent = (mode: ReminderRecordingMode, actions: Array<[string, string]>, extra: Partial<SentReminder> = {}): SentReminder => ({
  eventIdHash: HASH, startAt: iso(30), endAt: iso(60), title: "Revisão semanal", source: "google-calendar", recurring: true, sentAt: iso(28),
  recordingMode: mode,
  notification: { title: "Revisão semanal em 2 min", body: "13:30–14:00\nTexto.", actions: actions.map(([id, label]) => ({ id, label })) },
  ...extra
});

const RECORD_LATER: Array<[string, string]> = [["record", "Gravar"], ["later", "Agora não"], ["brief", "Ver resumo anterior"]];
const SKIP_OK: Array<[string, string]> = [["skip", "Pular esta gravação"], ["ok", "OK"]];

/** No call detection, with a capture backend that runs in its own unit (the helper may start it). */
const managed = (backend: AppConfig["backend"] = "audio"): AppConfig => {
  const value = config();
  value.backend = backend;
  return value;
};

/** The configuration when the button is pressed: a call monitor watching calls, or no call detection. */
const monitored = (mode: "notify-only" | "record" = "notify-only", backend: AppConfig["backend"] = "audio"): AppConfig => {
  const value = managed(backend);
  value.callDetection.enabled = true;
  value.callDetection.mode = mode;
  return value;
};

describe("handleReminderNotification", () => {
  const setup = async (entry: SentReminder, choice: string | null, now = at(28), extra: Partial<Parameters<typeof handleReminderNotification>[1]> = {}) => {
    const stateDir = await tempDir();
    await recordSentReminder(entry, { stateDir, now: at(28) });
    const shown: NotifyWithActionsOptions[] = [];
    const opened: string[] = [];
    const captures: Array<{ title: string; config: AppConfig }> = [];
    const result = await handleReminderNotification(HASH, {
      stateDir,
      now: () => now,
      config: entry.recordingMode === "off" ? managed() : monitored(entry.recordingMode === "record" ? "record" : "notify-only"),
      notify: async (options) => { shown.push(options); return options.actions.length ? choice : null; },
      open: async (uri) => { opened.push(uri); },
      startCapture: async (current, title) => { captures.push({ title, config: current }); },
      ...extra
    });
    return { stateDir, shown, opened, captures, result };
  };

  test("shows exactly the recorded notification, waiting until 10 minutes after the start", async () => {
    const { shown, result } = await setup(sent("notify-only", RECORD_LATER), null);
    expect(result).toEqual({ shown: true, choice: null });
    expect(shown).toEqual([{
      title: "Revisão semanal em 2 min", body: "13:30–14:00\nTexto.",
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

  test("with call detection off, record starts a capture named after the meeting and opens it in the Studio", async () => {
    // Nothing would act on a decision without a call monitor, so the recording starts now.
    const { stateDir, result, opened, captures } = await setup(sent("off", RECORD_LATER), "record");
    expect(result).toEqual({ shown: true, choice: "record", capture: "started", opened: "falatrace://capture" });
    expect(captures.map((capture) => capture.title)).toEqual(["Revisão semanal"]);
    expect(opened).toEqual(["falatrace://capture"]);
    expect(await activeOverride(new Date(at(31)), { stateDir })).toBeUndefined();
  });

  test("a legacy backend, whose capture would die with the helper's unit, only opens the Studio's capture page", async () => {
    // "simple" without OBS picks the GNOME screencast or wf-recorder: children of the caller, not units of their own.
    for (const current of [config(), managed("gnome"), managed("wf-recorder"), managed("hybrid"), managed("ffmpeg-only")]) {
      const { stateDir, result, opened, captures } = await setup(sent("off", RECORD_LATER), "record", at(28), { config: current });
      expect(result).toEqual({ shown: true, choice: "record", opened: "falatrace://capture" });
      expect(captures).toEqual([]);
      expect(opened).toEqual(["falatrace://capture"]);
      expect(await activeOverride(new Date(at(31)), { stateDir })).toBeUndefined();
    }
    // Managed captures (audio, GPU Screen Recorder, OBS, and "simple" with OBS on) start from the helper.
    const withObs = config();
    withObs.obs.enabled = true;
    for (const current of [managed("gpu-screen-recorder"), managed("obs"), managed("obs-ws"), withObs]) {
      const { result, captures } = await setup(sent("off", RECORD_LATER), "record", at(28), { config: current });
      expect(result).toMatchObject({ choice: "record", capture: "started" });
      expect(captures.map((capture) => capture.title)).toEqual(["Revisão semanal"]);
    }
  });

  test("the configuration at click time decides: a monitor enabled since the reminder gets a decision", async () => {
    const { stateDir, result, captures } = await setup(sent("off", RECORD_LATER), "record", at(28), { config: monitored() });
    expect(result.override?.decision).toBe("record");
    expect(captures).toEqual([]);
    expect((await activeOverride(new Date(at(31)), { stateDir }))?.decision).toBe("record");
  });

  test("a monitor that cannot record gets no decision: the capture starts here or in the Studio instead", async () => {
    // "simple" means OBS for the call monitor; with OBS off a decision would only end in "recorder unavailable".
    const simple = await setup(sent("notify-only", RECORD_LATER), "record", at(28), { config: monitored("notify-only", "simple") });
    expect(simple.result).toEqual({ shown: true, choice: "record", opened: "falatrace://capture" });
    expect(await activeOverride(new Date(at(31)), { stateDir: simple.stateDir })).toBeUndefined();
    const gnome = await setup(sent("notify-only", RECORD_LATER), "record", at(28), { config: monitored("notify-only", "gnome") });
    expect(gnome.result.override).toBeUndefined();
    expect(gnome.opened).toEqual(["falatrace://capture"]);
    // A dry-run monitor never records: the capture starts from the helper.
    const dryRun = monitored();
    dryRun.callDetection.dryRun = true;
    const tested = await setup(sent("notify-only", RECORD_LATER), "record", at(28), { config: dryRun });
    expect(tested.result).toMatchObject({ capture: "started" });
    expect(await activeOverride(new Date(at(31)), { stateDir: tested.stateDir })).toBeUndefined();
    // With OBS on, "simple" records through OBS: the decision is saved.
    const obs = monitored("notify-only", "simple");
    obs.obs.enabled = true;
    const decided = await setup(sent("notify-only", RECORD_LATER), "record", at(28), { config: obs });
    expect(decided.result.override?.decision).toBe("record");
    expect(decided.captures).toEqual([]);
  });

  test("a capture that cannot start is told in a plain notification; an unreadable configuration opens the capture page", async () => {
    const failed = await setup(sent("off", RECORD_LATER), "record", at(28), {
      startCapture: async () => { throw new Error("Já existe uma captura gerenciada. Finalize-a antes de iniciar outra."); }
    });
    expect(failed.result).toMatchObject({ shown: true, choice: "record", capture: "failed", error: "Já existe uma captura gerenciada. Finalize-a antes de iniciar outra." });
    expect(failed.shown[1]).toMatchObject({ title: "Gravação não iniciada", body: REMINDERS_SERVICE_ERRORS.captureFailed, actions: [] });
    expect(failed.opened).toEqual([]);
    const unreadable = await setup(sent("off", RECORD_LATER), "record", at(28), { config: undefined, loadConfig: async () => { throw new Error("invalid config"); } });
    expect(unreadable.result).toEqual({ shown: true, choice: "record", opened: "falatrace://capture" });
    expect(unreadable.captures).toEqual([]);
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
