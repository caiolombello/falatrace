import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpcomingEvent } from "../../calendar/upcoming";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import {
  alreadyReminded, buildReminderNotification, effectiveRecordingMode, effectiveReminderMode, findSentReminder, nextReminderAt, planReminders,
  recordSentReminder, REMINDER_ERRORS, REMINDER_KNOWN_ERRORS, REMINDER_LIMITS, REMINDER_TIMING, type Reminder, reminderActions,
  type ReminderErrorStage, type ReminderLoopDeps, reminderRecordingMode, remindersSentPath, readSentReminders, runReminderLoop, type SentReminder,
  validateRemindersSentFile
} from "../scheduler";

const T0 = Date.parse("2026-10-25T13:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number): number => T0 + minutes * MIN;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();
const hashOf = (id: string): string => createHash("sha256").update(id).digest("hex");

const event = (id: string, start: number, end: number, extra: Partial<UpcomingEvent> = {}): UpcomingEvent => ({
  source: "google-calendar", eventIdHash: hashOf(id), title: `Reunião ${id}`, startAt: iso(start), endAt: iso(end), recurring: false, attendees: [], ...extra
});

const makeConfig = (options: {
  reminders?: "auto" | "on" | "off"; detection?: "disabled" | "notify-only" | "record" | "obs"; dryRun?: boolean; lead?: number; brief?: boolean;
} = {}): AppConfig => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.reminders = { mode: options.reminders ?? "on", leadMinutes: options.lead ?? 2, brief: options.brief ?? true };
  const detection = options.detection ?? "disabled";
  config.callDetection.enabled = detection !== "disabled";
  config.callDetection.mode = detection === "disabled" ? "notify-only" : detection;
  config.callDetection.dryRun = options.dryRun === true;
  config.studio.language = "pt-BR";
  return config;
};

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-reminders-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("modes", () => {
  test("the recording mode in effect follows call detection (off when disabled or in dry run)", () => {
    expect(effectiveRecordingMode(makeConfig({ detection: "disabled" }))).toBe("off");
    expect(effectiveRecordingMode(makeConfig({ detection: "notify-only" }))).toBe("notify-only");
    expect(effectiveRecordingMode(makeConfig({ detection: "record" }))).toBe("record");
    expect(effectiveRecordingMode(makeConfig({ detection: "obs" }))).toBe("obs");
    expect(effectiveRecordingMode(makeConfig({ detection: "record", dryRun: true }))).toBe("off");
  });

  test("reminders: auto is on unless meetings are recorded automatically; on and off are explicit", () => {
    const table: Array<[ "auto" | "on" | "off", "disabled" | "notify-only" | "record" | "obs", "on" | "off"]> = [
      ["auto", "disabled", "on"], ["auto", "notify-only", "on"], ["auto", "record", "off"], ["auto", "obs", "off"],
      ["on", "disabled", "on"], ["on", "notify-only", "on"], ["on", "record", "on"], ["on", "obs", "on"],
      ["off", "disabled", "off"], ["off", "notify-only", "off"], ["off", "record", "off"], ["off", "obs", "off"]
    ];
    for (const [reminders, detection, expected] of table) {
      expect([reminders, detection, effectiveReminderMode(makeConfig({ reminders, detection }))]).toEqual([reminders, detection, expected]);
    }
    expect(effectiveReminderMode(makeConfig({ reminders: "auto", detection: "record", dryRun: true }))).toBe("on");
  });

  test("paused automation turns record/obs into 'paused' only", () => {
    expect(reminderRecordingMode(makeConfig({ detection: "record" }), true)).toBe("paused");
    expect(reminderRecordingMode(makeConfig({ detection: "obs" }), true)).toBe("paused");
    expect(reminderRecordingMode(makeConfig({ detection: "obs" }), false)).toBe("obs");
    expect(reminderRecordingMode(makeConfig({ detection: "notify-only" }), true)).toBe("notify-only");
    expect(reminderRecordingMode(makeConfig({ detection: "disabled" }), true)).toBe("off");
  });

  test("buttons depend on what happens to the recording", () => {
    const ids = (mode: Parameters<typeof reminderActions>[0], brief = false) => reminderActions(mode, { brief }).map((action) => action.id);
    expect(ids("off")).toEqual(["record", "later"]);
    expect(ids("notify-only", true)).toEqual(["record", "later", "brief"]);
    expect(ids("paused")).toEqual(["record", "later"]);
    expect(ids("record")).toEqual(["skip", "ok"]);
    expect(ids("obs", true)).toEqual(["skip", "ok", "brief"]);
    expect(reminderActions("notify-only", { brief: true })).toEqual([
      { id: "record", label: "Gravar" }, { id: "later", label: "Agora não" }, { id: "brief", label: "Ver resumo anterior" }
    ]);
    expect(reminderActions("record", { language: "en" })).toEqual([{ id: "skip", label: "Skip this recording" }, { id: "ok", label: "OK" }]);
  });
});

describe("planning", () => {
  const meeting = event("a", 30, 60);

  test("due from start − lead until 5 minutes after the start, never after the end", () => {
    expect(planReminders([meeting], at(27.9), 2, [])).toEqual([]);
    expect(planReminders([meeting], at(28), 2, [])).toEqual([{ event: meeting, fireAt: iso(28), startsInMs: 2 * MIN }]);
    expect(planReminders([meeting], at(35), 2, []).length).toBe(1);
    expect(planReminders([meeting], at(35.01), 2, [])).toEqual([]);
    const short = event("short", 30, 33);
    expect(planReminders([short], at(33), 2, [])).toEqual([]);
    expect(planReminders([meeting], at(25), 5, []).length).toBe(1);
    expect(planReminders([meeting], at(24.9), 5, [])).toEqual([]);
  });

  test("a reminder already sent is not due again, even if the meeting moved a little", () => {
    expect(planReminders([meeting], at(29), 2, [{ eventIdHash: meeting.eventIdHash, startAt: iso(30) }])).toEqual([]);
    const moved = event("a", 35, 60);
    expect(planReminders([moved], at(34), 2, [{ eventIdHash: meeting.eventIdHash, startAt: iso(30) }])).toEqual([]);
    const movedFar = event("a", 45, 70);
    expect(planReminders([movedFar], at(43), 2, [{ eventIdHash: meeting.eventIdHash, startAt: iso(30) }]).length).toBe(1);
    expect(alreadyReminded({ eventIdHash: meeting.eventIdHash, startAt: iso(39.9) }, [{ eventIdHash: meeting.eventIdHash, startAt: iso(30) }])).toBe(true);
    expect(alreadyReminded({ eventIdHash: meeting.eventIdHash, startAt: iso(40) }, [{ eventIdHash: meeting.eventIdHash, startAt: iso(30) }])).toBe(false);
    expect(alreadyReminded(meeting, [{ eventIdHash: hashOf("other"), startAt: iso(30) }])).toBe(false);
  });

  test("several meetings come soonest first; repeats and broken entries are ignored", () => {
    const b = event("b", 31, 40);
    const due = planReminders([b, meeting, meeting, { ...meeting, eventIdHash: hashOf("bad"), startAt: "never" }], at(29.5), 2, []);
    expect(due.map((item) => item.event.title)).toEqual(["Reunião a", "Reunião b"]);
  });

  test("the next reminder time skips sent and past ones", () => {
    const b = event("b", 90, 120);
    expect(nextReminderAt([meeting, b], at(0), 2, [])).toBe(at(28));
    expect(nextReminderAt([meeting, b], at(0), 2, [{ eventIdHash: meeting.eventIdHash, startAt: meeting.startAt }])).toBe(at(88));
    expect(nextReminderAt([meeting, b], at(28), 2, [])).toBe(at(88));
    expect(nextReminderAt([], at(0), 2, [])).toBeNull();
  });

  test("an invalid lead time is refused", () => {
    expect(() => planReminders([meeting], at(0), Number.NaN, [])).toThrow(REMINDER_ERRORS.invalidLead);
    expect(() => nextReminderAt([meeting], at(0), -1, [])).toThrow(REMINDER_ERRORS.invalidLead);
  });
});

describe("notification content", () => {
  const meeting = event("a", 30, 60, { title: "Revisão <b>semanal</b>" });

  test("title says how soon; body has the time, what happens to the recording and up to three brief lines", () => {
    const content = buildReminderNotification({
      event: meeting, now: at(28), mode: "notify-only", briefLines: ["Ações abertas: 2", "", "Última decisão: X", "L3", "L4"], language: "pt-BR", timeZone: "America/Sao_Paulo"
    });
    expect(content.title).toBe("Revisão <b>semanal</b> em 2 min");
    expect(content.body.split("\n")).toEqual(["10:30–11:00", "Esta reunião não será gravada automaticamente.", "Ações abertas: 2", "Última decisão: X", "L3"]);
    expect(content.actions.map((action) => action.id)).toEqual(["record", "later", "brief"]);
  });

  test("starting now, already started, other modes and English", () => {
    const now = buildReminderNotification({ event: meeting, now: at(29.6), mode: "record", timeZone: "UTC" });
    expect(now.title).toBe("Revisão <b>semanal</b> começa agora");
    expect(now.body.split("\n")).toEqual(["13:30–14:00", "Esta reunião será gravada automaticamente."]);
    expect(now.actions.map((action) => action.id)).toEqual(["skip", "ok"]);
    expect(buildReminderNotification({ event: meeting, now: at(33), mode: "paused", timeZone: "UTC" }).title).toBe("Revisão <b>semanal</b> já começou");
    expect(buildReminderNotification({ event: meeting, now: at(33), mode: "paused", timeZone: "UTC" }).body).toContain("pausada");
    const english = buildReminderNotification({ event: meeting, now: at(25), mode: "off", language: "en", timeZone: "UTC" });
    expect(english.title).toBe("Revisão <b>semanal</b> in 5 min");
    expect(english.body).toContain("Automatic recording is off.");
    expect(english.body).not.toMatch(/[  ]/);
    expect(english.actions.map((action) => action.label)).toEqual(["Record", "Not now"]);
    // An unknown time zone falls back to the system one instead of failing.
    expect(buildReminderNotification({ event: meeting, now: at(25), mode: "off", timeZone: "Mars/Olympus" }).body.split("\n")[1]).toBe("A gravação automática está desligada.");
  });
});

const sentEntry = (id: string, start: number, sentAt: number, extra: Partial<SentReminder> = {}): SentReminder => ({
  eventIdHash: hashOf(id), startAt: iso(start), endAt: iso(start + 30), title: `Reunião ${id}`, source: "google-calendar", recurring: false,
  sentAt: iso(sentAt), recordingMode: "notify-only",
  notification: { title: `Reunião ${id} em 2 min`, body: "13:30–14:00\nEsta reunião não será gravada automaticamente.", actions: [{ id: "record", label: "Gravar" }, { id: "later", label: "Agora não" }] },
  ...extra
});

describe("ledger", () => {
  test("records privately, finds the latest entry for an event and replaces the same occurrence", async () => {
    const stateDir = join(await tempDir(), "state");
    await recordSentReminder(sentEntry("a", 30, 28), { stateDir, now: at(28) });
    await recordSentReminder(sentEntry("b", 60, 58), { stateDir, now: at(58) });
    await recordSentReminder(sentEntry("a", 30, 29, { recordingMode: "record" }), { stateDir, now: at(29) });
    expect((await fs.stat(remindersSentPath(stateDir))).mode & 0o777).toBe(0o600);
    const entries = await readSentReminders({ stateDir, now: at(60) });
    expect(entries.map((entry) => [entry.title, entry.recordingMode])).toEqual([["Reunião a", "record"], ["Reunião b", "notify-only"]]);
    expect((await findSentReminder(hashOf("a"), { stateDir, now: at(60) }))?.sentAt).toBe(iso(29));
    expect(await findSentReminder(hashOf("zzz"), { stateDir, now: at(60) })).toBeUndefined();
    expect(await findSentReminder("not-a-hash", { stateDir, now: at(60) })).toBeUndefined();
    expect(await readSentReminders({ stateDir: join(await tempDir(), "none") })).toEqual([]);
  });

  test("entries for meetings older than a day are pruned and the ledger is bounded", async () => {
    const stateDir = await tempDir();
    await recordSentReminder(sentEntry("old", 0, -2), { stateDir, now: at(0) });
    expect((await readSentReminders({ stateDir, now: at(24 * 60 + 1) })).length).toBe(0);
    await recordSentReminder(sentEntry("new", 24 * 60 + 30, 24 * 60 + 28), { stateDir, now: at(24 * 60 + 28) });
    const file = JSON.parse(await fs.readFile(remindersSentPath(stateDir), "utf8"));
    expect(file.entries.map((entry: SentReminder) => entry.title)).toEqual(["Reunião new"]);
    for (let index = 0; index < REMINDER_LIMITS.maxEntries + 5; index++) {
      await recordSentReminder(sentEntry(`m${index}`, 100, index / 100), { stateDir, now: at(100) });
    }
    const bounded = await readSentReminders({ stateDir, now: at(100) });
    expect(bounded.length).toBe(REMINDER_LIMITS.maxEntries);
    expect(bounded.some((entry) => entry.title === "Reunião m0")).toBe(false);
  }, 30_000);

  test("a damaged ledger fails reads with a known error and is replaced by the next record", async () => {
    const stateDir = await tempDir();
    await fs.writeFile(remindersSentPath(stateDir), "{\"version\":1,\"entries\":[{\"title\":1}]}", { mode: 0o600 });
    await expect(readSentReminders({ stateDir })).rejects.toThrow(REMINDER_ERRORS.invalidLedger);
    await recordSentReminder(sentEntry("a", 30, 28), { stateDir, now: at(28) });
    expect((await readSentReminders({ stateDir, now: at(28) })).length).toBe(1);
    await expect(recordSentReminder({ ...sentEntry("a", 30, 28), eventIdHash: "x" }, { stateDir })).rejects.toThrow(REMINDER_ERRORS.invalidLedger);
  });

  test("a symlinked ledger is refused for reading and writing", async () => {
    const stateDir = await tempDir();
    const target = join(stateDir, "target.json");
    await fs.writeFile(target, JSON.stringify({ version: 1, entries: [] }));
    await fs.symlink(target, remindersSentPath(stateDir));
    await expect(readSentReminders({ stateDir })).rejects.toThrow(REMINDER_ERRORS.unsafeLedger);
    await expect(recordSentReminder(sentEntry("a", 30, 28), { stateDir, now: at(28) })).rejects.toThrow(REMINDER_ERRORS.unsafeLedger);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ version: 1, entries: [] });
  });

  test("the validator rebuilds entries and refuses anything off-contract", () => {
    const valid = sentEntry("a", 30, 28, { seriesIdHash: hashOf("series") });
    expect(validateRemindersSentFile({ version: 1, entries: [{ ...valid, extra: true }] })).toEqual({ version: 1, entries: [valid] });
    const broken: unknown[] = [
      { ...valid, recordingMode: "maybe" }, { ...valid, source: "outlook" }, { ...valid, seriesIdHash: "x" }, { ...valid, endAt: iso(0) },
      { ...valid, title: "a\nb" }, { ...valid, notification: { ...valid.notification, actions: [{ id: "delete", label: "Apagar" }] } },
      { ...valid, notification: { ...valid.notification, actions: [{ id: "ok", label: "OK" }, { id: "ok", label: "OK" }] } },
      { ...valid, notification: { ...valid.notification, body: "a\u0007" } }, { ...valid, notification: null }, { ...valid, recurring: "no" }
    ];
    for (const entry of broken) expect(() => validateRemindersSentFile({ version: 1, entries: [entry] })).toThrow(REMINDER_ERRORS.invalidLedger);
    expect(() => validateRemindersSentFile({ version: 2, entries: [] })).toThrow(REMINDER_ERRORS.invalidLedger);
  });
});

type Harness = {
  notified: Array<Reminder & { at: number }>;
  errors: Array<[ReminderErrorStage, string]>;
  lists: number[];
  sleeps: number[];
  run: (until: number) => Promise<void>;
  clock: () => number;
};

/**
 * A fake clock: `sleep` advances time instead of waiting, and the loop is aborted once the clock
 * passes `until`. `calendar(time)` gives the events the calendar returns at that time.
 */
const harness = (options: {
  config?: AppConfig; stateDir: string; start: number; calendar: (time: number) => UpcomingEvent[] | Error;
  deps?: Partial<ReminderLoopDeps>;
}): Harness => {
  let clock = options.start;
  const notified: Harness["notified"] = [];
  const errors: Harness["errors"] = [];
  const lists: number[] = [];
  const sleeps: number[] = [];
  return {
    notified, errors, lists, sleeps, clock: () => clock,
    run: async (until: number) => {
      const controller = new AbortController();
      await runReminderLoop({
        config: options.config ?? makeConfig(),
        signal: controller.signal,
        deps: {
          stateDir: options.stateDir,
          timeZone: "UTC",
          now: () => clock,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
            if (clock > until) controller.abort();
          },
          listEvents: async (from, to) => {
            lists.push(clock);
            expect(to.getTime() - from.getTime()).toBe(REMINDER_TIMING.horizonMs);
            const result = options.calendar(clock);
            if (result instanceof Error) throw result;
            return result;
          },
          notify: async (reminder) => { notified.push({ ...reminder, at: clock }); },
          onError: (stage, error) => { errors.push([stage, error instanceof Error ? error.message : String(error)]); },
          ...options.deps
        }
      });
    }
  };
};

describe("the reminder loop", () => {
  test("fires once at start − lead, polling every 5 minutes and waking exactly for the reminder", async () => {
    const stateDir = await tempDir();
    const loop = harness({ stateDir, start: at(0), calendar: () => [event("a", 30, 60)] });
    await loop.run(at(90));
    expect(loop.notified.map((reminder) => [reminder.at, reminder.event.title, reminder.recordingMode])).toEqual([[at(28), "Reunião a", "off"]]);
    expect(loop.notified[0].notification.title).toBe("Reunião a em 2 min");
    expect(loop.notified[0].notification.actions.map((action) => action.id)).toEqual(["record", "later"]);
    expect(loop.lists.slice(0, 7)).toEqual([at(0), at(5), at(10), at(15), at(20), at(25), at(28)]);
    expect(Math.max(...loop.sleeps)).toBeLessThanOrEqual(REMINDER_TIMING.pollMs);
    expect(loop.errors).toEqual([]);
    expect((await findSentReminder(hashOf("a"), { stateDir, now: at(30) }))?.notification.title).toBe("Reunião a em 2 min");
  });

  test("a restart never repeats a reminder that was already shown", async () => {
    const stateDir = await tempDir();
    const first = harness({ stateDir, start: at(0), calendar: () => [event("a", 30, 60)] });
    await first.run(at(29));
    expect(first.notified.length).toBe(1);
    const second = harness({ stateDir, start: at(29), calendar: () => [event("a", 30, 60)] });
    await second.run(at(40));
    expect(second.notified).toEqual([]);
  });

  test("a meeting starting within the lead time when the service starts is announced at once", async () => {
    const loop = harness({ stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)] });
    await loop.run(at(10));
    expect(loop.notified.map((reminder) => [reminder.at, reminder.notification.title])).toEqual([[at(0), "Reunião a em 1 min"]]);
  });

  test("a meeting that started up to 5 minutes before the service started is still announced; older ones are not", async () => {
    const loop = harness({ stateDir: await tempDir(), start: at(0), calendar: () => [event("recent", -3, 30), event("old", -6, 30)] });
    await loop.run(at(10));
    expect(loop.notified.map((reminder) => [reminder.event.title, reminder.notification.title])).toEqual([["Reunião recent", "Reunião recent já começou"]]);
  });

  test("a meeting moved before its reminder is announced at the new time only", async () => {
    const loop = harness({ stateDir: await tempDir(), start: at(0), calendar: (time) => [time < at(27) ? event("a", 30, 60) : event("a", 60, 90)] });
    await loop.run(at(100));
    expect(loop.notified.map((reminder) => [reminder.at, reminder.event.startAt])).toEqual([[at(58), iso(60)]]);
    // Woke for the old time, read the calendar again and saw the move.
    expect(loop.lists).toContain(at(28));
  });

  test("a meeting moved far after its reminder gets a new one; a small move does not", async () => {
    const loop = harness({
      stateDir: await tempDir(), start: at(0),
      calendar: (time) => [time < at(31) ? event("a", 30, 60) : time < at(40) ? event("a", 35, 60) : event("a", 90, 120)]
    });
    await loop.run(at(120));
    expect(loop.notified.map((reminder) => [reminder.at, reminder.event.startAt])).toEqual([[at(28), iso(30)], [at(88), iso(90)]]);
  });

  test("a meeting cancelled before its reminder is not announced", async () => {
    const loop = harness({ stateDir: await tempDir(), start: at(0), calendar: (time) => (time < at(27) ? [event("a", 30, 60)] : []) });
    await loop.run(at(60));
    expect(loop.notified).toEqual([]);
    expect(loop.lists).toContain(at(28));
  });

  test("while the calendar cannot be read, retries back off and recent events still fire", async () => {
    const loop = harness({
      stateDir: await tempDir(), start: at(0),
      calendar: (time) => (time < at(20) ? [event("a", 30, 60)] : new Error("offline"))
    });
    await loop.run(at(40));
    expect(loop.notified.map((reminder) => reminder.at)).toEqual([at(28)]);
    expect(loop.errors.every(([stage, message]) => stage === "calendar" && message === "offline")).toBe(true);
    // 20 → 20.5 → 21.5 → 23.5 → 27.5 → 28 (the reminder) → … the retry delay doubles up to the poll interval.
    expect(loop.lists.slice(4, 10)).toEqual([at(20), at(20.5), at(21.5), at(23.5), at(27.5), at(28)]);
  });

  test("events older than the stale limit are not used once the calendar keeps failing", async () => {
    const loop = harness({
      stateDir: await tempDir(), start: at(0), calendar: (time) => (time < at(1) ? [event("a", 30, 60)] : new Error("offline"))
    });
    await loop.run(at(40));
    expect(loop.notified).toEqual([]);
  });

  test("off for this configuration: returns at once without reading the calendar", async () => {
    const loop = harness({ config: makeConfig({ reminders: "auto", detection: "record" }), stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)] });
    await loop.run(at(60));
    expect(loop.lists).toEqual([]);
    expect(loop.notified).toEqual([]);
  });

  test("brief lines are added when enabled and a brief exists; failures and slowness are tolerated", async () => {
    const asked: string[] = [];
    const withBrief = harness({
      stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30), event("b", 1.5, 30), event("c", 1.8, 30)],
      deps: {
        brief: async (item) => {
          asked.push(item.title);
          if (item.title === "Reunião b") throw new Error("index unavailable");
          if (item.title === "Reunião c") return null;
          return ["Ações abertas: 2", "Última decisão: migrar"];
        }
      }
    });
    await withBrief.run(at(5));
    expect(asked).toEqual(["Reunião a", "Reunião b", "Reunião c"]);
    const [a, b, c] = withBrief.notified;
    expect(a.briefLines).toEqual(["Ações abertas: 2", "Última decisão: migrar"]);
    expect(a.notification.body.split("\n").slice(2)).toEqual(["Ações abertas: 2", "Última decisão: migrar"]);
    expect(a.notification.actions.map((action) => action.id)).toEqual(["record", "later", "brief"]);
    expect(b.briefLines).toEqual([]);
    expect(c.notification.actions.map((action) => action.id)).toEqual(["record", "later"]);
    expect(withBrief.errors).toEqual([["brief", "index unavailable"]]);

    let called = false;
    const disabled = harness({
      config: makeConfig({ brief: false }), stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)],
      deps: { brief: async () => { called = true; return ["x"]; } }
    });
    await disabled.run(at(5));
    expect(called).toBe(false);
    expect(disabled.notified.length).toBe(1);
  });

  test("a brief that never answers is given up on, and the reminder still goes out", async () => {
    const loop = harness({
      stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)],
      deps: { brief: () => new Promise(() => undefined), briefTimeoutMs: 20 }
    });
    await loop.run(at(1));
    expect(loop.notified.length).toBe(1);
    expect(loop.notified[0].briefLines).toEqual([]);
  });

  test("record mode offers skip; paused automation offers record and says so; an unreadable pause state counts as paused", async () => {
    const config = makeConfig({ detection: "record" });
    const running = harness({ config, stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)], deps: { automationPaused: async () => false } });
    await running.run(at(1));
    expect(running.notified[0].recordingMode).toBe("record");
    expect(running.notified[0].notification.actions.map((action) => action.id)).toEqual(["skip", "ok"]);
    const paused = harness({ config, stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)], deps: { automationPaused: async () => true } });
    await paused.run(at(1));
    expect(paused.notified[0].recordingMode).toBe("paused");
    expect(paused.notified[0].notification.body).toContain("A gravação automática está pausada.");
    const broken = harness({
      config, stateDir: await tempDir(), start: at(0), calendar: () => [event("a", 1, 30)],
      deps: { automationPaused: async () => { throw new Error("Estado da automação inválido"); } }
    });
    await broken.run(at(1));
    expect(broken.notified[0].recordingMode).toBe("paused");
    expect(broken.errors.map(([stage]) => stage)).toEqual(["automation"]);
  });

  test("a failing notification is reported, recorded and not retried", async () => {
    const stateDir = await tempDir();
    let attempts = 0;
    const loop = harness({
      stateDir, start: at(0), calendar: () => [event("a", 1, 30)],
      deps: { notify: async () => { attempts++; throw new Error("systemd-run missing"); } }
    });
    await loop.run(at(20));
    expect(attempts).toBe(1);
    expect(loop.errors).toEqual([["notify", "systemd-run missing"]]);
    expect((await readSentReminders({ stateDir, now: at(20) })).length).toBe(1);
  });

  test("an unwritable ledger is reported but the reminder is still shown once", async () => {
    const stateDir = await tempDir();
    await fs.mkdir(remindersSentPath(stateDir));
    const loop = harness({ stateDir, start: at(0), calendar: () => [event("a", 1, 30)] });
    await loop.run(at(20));
    expect(loop.notified.length).toBe(1);
    expect(loop.errors.some(([stage]) => stage === "ledger")).toBe(true);
  });

  test("invalid events from the calendar are dropped", async () => {
    const loop = harness({
      stateDir: await tempDir(), start: at(0),
      calendar: () => [{ ...event("a", 1, 30), eventIdHash: "not-a-hash" }, { ...event("b", 1, 30), title: "" }, null as unknown as UpcomingEvent, event("c", 1, 30)]
    });
    await loop.run(at(1));
    expect(loop.notified.map((reminder) => reminder.event.title)).toEqual(["Reunião c"]);
  });

  test("stops promptly when aborted while sleeping, with the real timer", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const done = runReminderLoop({
      config: makeConfig(), signal: controller.signal,
      deps: { stateDir: await tempDir(), listEvents: async () => [], notify: async () => undefined }
    });
    setTimeout(() => controller.abort(), 30);
    await done;
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(REMINDER_KNOWN_ERRORS).toEqual(Object.values(REMINDER_ERRORS));
    for (const message of REMINDER_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
