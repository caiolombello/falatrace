import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeOverride, clearMeetingOverride, MEETING_OVERRIDES_FILE, type MeetingOverride, meetingOverridesPath, OVERRIDE_ERRORS, OVERRIDE_KNOWN_ERRORS,
  OVERRIDE_LIMITS, overrideCovers, pickActiveOverride, pruneMeetingOverrides, readMeetingOverrides, setMeetingOverride, validateMeetingOverridesFile
} from "../overrides";

const T0 = Date.parse("2026-10-25T14:00:00.000Z");
const at = (minutes: number): number => T0 + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();
const date = (minutes: number): Date => new Date(at(minutes));
const hash = (char: string): string => char.repeat(64);

const dirs: string[] = [];
const stateDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-overrides-"));
  dirs.push(dir);
  return join(dir, "state");
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const meeting = (char: string, start: number, end: number, decision: "skip" | "record" = "skip") =>
  ({ eventIdHash: hash(char), title: `Reunião ${char}`, startAt: iso(start), endAt: iso(end), decision });

describe("setting decisions", () => {
  test("saves a private file with the decision and its expiry 15 minutes after the end", async () => {
    const dir = await stateDir();
    const entry = await setMeetingOverride(meeting("a", 0, 60), { stateDir: dir, now: date(-5) });
    expect(entry).toEqual({
      eventIdHash: hash("a"), title: "Reunião a", startAt: iso(0), endAt: iso(60), decision: "skip", createdAt: iso(-5), expiresAt: iso(75)
    });
    const path = meetingOverridesPath(dir);
    expect(path.endsWith(MEETING_OVERRIDES_FILE)).toBe(true);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ version: 1, entries: [entry] });
    expect(await fs.readdir(dir)).toEqual([MEETING_OVERRIDES_FILE]);
  });

  test("a second decision for the same meeting replaces the first; other meetings are kept, soonest first", async () => {
    const dir = await stateDir();
    await setMeetingOverride(meeting("b", 120, 150, "record"), { stateDir: dir, now: date(-10) });
    await setMeetingOverride(meeting("a", 0, 60, "skip"), { stateDir: dir, now: date(-10) });
    await setMeetingOverride(meeting("a", 0, 60, "record"), { stateDir: dir, now: date(-9) });
    const { entries } = await readMeetingOverrides({ stateDir: dir, now: date(-8) });
    expect(entries.map((entry) => [entry.eventIdHash[0], entry.decision, entry.createdAt])).toEqual([["a", "record", iso(-9)], ["b", "record", iso(-10)]]);
  });

  test("titles are cleaned to one line; bad input is refused with known errors", async () => {
    const dir = await stateDir();
    const entry = await setMeetingOverride({ ...meeting("a", 0, 60), title: "  Revisão\u0007\nsemanal‮  " }, { stateDir: dir, now: date(-5) });
    expect(entry.title).toBe("Revisão semanal");
    const bad: Array<[unknown, string]> = [
      [{ ...meeting("a", 0, 60), decision: "maybe" }, OVERRIDE_ERRORS.invalidDecision],
      [{ ...meeting("a", 0, 60), eventIdHash: "A".repeat(64) }, OVERRIDE_ERRORS.invalidMeeting],
      [{ ...meeting("a", 0, 60), eventIdHash: "abc" }, OVERRIDE_ERRORS.invalidMeeting],
      [{ ...meeting("a", 0, 60), title: " \u0000 " }, OVERRIDE_ERRORS.invalidMeeting],
      [{ ...meeting("a", 0, 60), startAt: "amanhã" }, OVERRIDE_ERRORS.invalidMeeting],
      [{ ...meeting("a", 0, 60), startAt: "2026-10-25T14:00:00" }, OVERRIDE_ERRORS.invalidMeeting],
      [meeting("a", 60, 0), OVERRIDE_ERRORS.invalidMeeting],
      [meeting("a", 0, 25 * 60), OVERRIDE_ERRORS.invalidMeeting],
      [null, OVERRIDE_ERRORS.invalidMeeting]
    ];
    for (const [input, message] of bad) {
      await expect(setMeetingOverride(input as never, { stateDir: dir, now: date(-5) })).rejects.toThrow(message);
    }
  });

  test("refused once the meeting is over (end + 15 min) or when it is more than two weeks away", async () => {
    const dir = await stateDir();
    await expect(setMeetingOverride(meeting("a", 0, 60), { stateDir: dir, now: date(75.01) })).rejects.toThrow(OVERRIDE_ERRORS.ended);
    expect(await setMeetingOverride(meeting("a", 0, 60), { stateDir: dir, now: date(75) })).toBeTruthy();
    await expect(setMeetingOverride(meeting("b", 15 * 24 * 60, 15 * 24 * 60 + 30), { stateDir: dir, now: date(0) })).rejects.toThrow(OVERRIDE_ERRORS.tooFar);
  });

  test("the number of decisions is bounded; the meetings furthest away give way", async () => {
    const dir = await stateDir();
    const now = date(-60);
    const entries: MeetingOverride[] = Array.from({ length: OVERRIDE_LIMITS.maxEntries }, (_, index) => ({
      eventIdHash: index.toString(16).padStart(64, "0"), title: `M${index}`, startAt: iso(index * 60), endAt: iso(index * 60 + 30),
      decision: "skip", createdAt: iso(-60), expiresAt: iso(index * 60 + 45)
    }));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(meetingOverridesPath(dir), JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    await setMeetingOverride(meeting("f", 30, 45), { stateDir: dir, now });
    const { entries: kept } = await readMeetingOverrides({ stateDir: dir, now });
    expect(kept.length).toBe(OVERRIDE_LIMITS.maxEntries);
    expect(kept.some((entry) => entry.eventIdHash === hash("f"))).toBe(true);
    expect(kept.some((entry) => entry.title === `M${OVERRIDE_LIMITS.maxEntries - 1}`)).toBe(false);
  });

  test("concurrent writers from several windows all land (the lock serialises them)", async () => {
    const dir = await stateDir();
    const chars = ["a", "b", "c", "d", "e", "f"];
    await Promise.all(chars.map((char, index) => setMeetingOverride(meeting(char, index * 30, index * 30 + 20), { stateDir: dir, now: date(-5) })));
    const { entries } = await readMeetingOverrides({ stateDir: dir, now: date(-5) });
    expect(entries.map((entry) => entry.eventIdHash[0])).toEqual(chars);
  });
});

describe("the active decision", () => {
  test("applies from 10 minutes before the start until 15 minutes after the end", async () => {
    const dir = await stateDir();
    await setMeetingOverride(meeting("a", 0, 60), { stateDir: dir, now: date(-30) });
    expect(await activeOverride(date(-11), { stateDir: dir })).toBeUndefined();
    expect((await activeOverride(date(-10), { stateDir: dir }))?.eventIdHash).toBe(hash("a"));
    expect((await activeOverride(date(30), { stateDir: dir }))?.decision).toBe("skip");
    expect((await activeOverride(date(75), { stateDir: dir }))?.eventIdHash).toBe(hash("a"));
    expect(await activeOverride(date(75.1), { stateDir: dir })).toBeUndefined();
  });

  test("no file means no decision", async () => {
    expect(await activeOverride(date(0), { stateDir: await stateDir() })).toBeUndefined();
  });

  test("with overlapping windows the meeting in progress wins, then the closest start, then the latest decision", () => {
    const entry = (char: string, start: number, end: number, decision: "skip" | "record", created = -60): MeetingOverride => ({
      eventIdHash: hash(char), title: char, startAt: iso(start), endAt: iso(end), decision, createdAt: iso(created), expiresAt: iso(end + 15)
    });
    const earlier = entry("a", -60, 0, "skip");
    const current = entry("b", 0, 60, "record");
    // 14:05: "a" ended 5 minutes ago (still in its window), "b" is in progress.
    expect(pickActiveOverride([earlier, current], at(5))?.eventIdHash).toBe(hash("b"));
    // 13:55: "a" in progress, "b" starts in 5 minutes.
    expect(pickActiveOverride([earlier, current], at(-5))?.eventIdHash).toBe(hash("a"));
    const soon = entry("c", 8, 30, "skip");
    const later = entry("d", 9, 30, "record");
    expect(pickActiveOverride([later, soon], at(0))?.eventIdHash).toBe(hash("c"));
    const twin = entry("e", 8, 30, "record", -1);
    expect(pickActiveOverride([soon, twin], at(0))?.eventIdHash).toBe(hash("e"));
    expect(pickActiveOverride([], at(0))).toBeUndefined();
    expect(overrideCovers(current, at(-10))).toBe(true);
    expect(overrideCovers(current, at(-10.01))).toBe(false);
  });
});

describe("pruning and clearing", () => {
  test("expired decisions disappear from reads and are removed on the next write or prune", async () => {
    const dir = await stateDir();
    await setMeetingOverride(meeting("a", 0, 30), { stateDir: dir, now: date(-5) });
    await setMeetingOverride(meeting("b", 60, 90), { stateDir: dir, now: date(-5) });
    expect((await readMeetingOverrides({ stateDir: dir, now: date(50) })).entries.map((entry) => entry.eventIdHash[0])).toEqual(["b"]);
    // Reading does not rewrite.
    expect(JSON.parse(await fs.readFile(meetingOverridesPath(dir), "utf8")).entries.length).toBe(2);
    expect(await pruneMeetingOverrides({ stateDir: dir, now: date(50) })).toBe(1);
    expect(JSON.parse(await fs.readFile(meetingOverridesPath(dir), "utf8")).entries.length).toBe(1);
    expect(await pruneMeetingOverrides({ stateDir: dir, now: date(50) })).toBe(0);
    expect(await pruneMeetingOverrides({ stateDir: await stateDir(), now: date(50) })).toBe(0);
    await setMeetingOverride(meeting("c", 200, 230), { stateDir: dir, now: date(200) });
    expect((await readMeetingOverrides({ stateDir: dir, now: date(200) })).entries.map((entry) => entry.eventIdHash[0])).toEqual(["c"]);
    expect(JSON.parse(await fs.readFile(meetingOverridesPath(dir), "utf8")).entries.length).toBe(1);
  });

  test("clearing removes one meeting's decision", async () => {
    const dir = await stateDir();
    await setMeetingOverride(meeting("a", 0, 30), { stateDir: dir, now: date(-5) });
    expect(await clearMeetingOverride(hash("a"), { stateDir: dir, now: date(-4) })).toBe(true);
    expect(await clearMeetingOverride(hash("a"), { stateDir: dir, now: date(-4) })).toBe(false);
    expect(await activeOverride(date(0), { stateDir: dir })).toBeUndefined();
    await expect(clearMeetingOverride("nope", { stateDir: dir })).rejects.toThrow(OVERRIDE_ERRORS.invalidMeeting);
  });
});

describe("damaged or unsafe files", () => {
  const valid = {
    eventIdHash: hash("a"), title: "Daily", startAt: iso(0), endAt: iso(15), decision: "skip", createdAt: iso(-5), expiresAt: iso(30)
  };

  test("the validator rebuilds valid files and refuses anything off-contract", () => {
    expect(validateMeetingOverridesFile({ version: 1, entries: [{ ...valid, extra: "dropped" }] })).toEqual({ version: 1, entries: [valid as MeetingOverride] });
    for (const bad of [
      null, [], { version: 2, entries: [] }, { version: 1 }, { version: 1, entries: {} },
      { version: 1, entries: [{ ...valid, decision: "maybe" }] }, { version: 1, entries: [{ ...valid, eventIdHash: "x" }] },
      { version: 1, entries: [{ ...valid, title: "a\nb" }] }, { version: 1, entries: [{ ...valid, title: "" }] },
      { version: 1, entries: [{ ...valid, startAt: "soon" }] }, { version: 1, entries: [{ ...valid, endAt: iso(0) }] },
      { version: 1, entries: [{ ...valid, expiresAt: iso(10) }] }, { version: 1, entries: [valid, valid] },
      { version: 1, entries: Array.from({ length: OVERRIDE_LIMITS.maxEntries + 1 }, () => valid) }
    ]) expect(() => validateMeetingOverridesFile(bad)).toThrow(OVERRIDE_ERRORS.invalidFile);
  });

  test("a damaged file is reported and never overwritten", async () => {
    const dir = await stateDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(meetingOverridesPath(dir), "{not json", { mode: 0o600 });
    await expect(activeOverride(date(0), { stateDir: dir })).rejects.toThrow(OVERRIDE_ERRORS.invalidFile);
    await expect(setMeetingOverride(meeting("a", 0, 30), { stateDir: dir, now: date(-5) })).rejects.toThrow(OVERRIDE_ERRORS.invalidFile);
    expect(await fs.readFile(meetingOverridesPath(dir), "utf8")).toBe("{not json");
    await fs.writeFile(meetingOverridesPath(dir), "x".repeat(OVERRIDE_LIMITS.maxBytes + 1), { mode: 0o600 });
    await expect(activeOverride(date(0), { stateDir: dir })).rejects.toThrow(OVERRIDE_ERRORS.invalidFile);
  });

  test("a symlink in place of the file is refused and its target left alone", async () => {
    const dir = await stateDir();
    await fs.mkdir(dir, { recursive: true });
    const target = join(dir, "..", "elsewhere.json");
    await fs.writeFile(target, JSON.stringify({ version: 1, entries: [] }));
    await fs.symlink(target, meetingOverridesPath(dir));
    await expect(activeOverride(date(0), { stateDir: dir })).rejects.toThrow(OVERRIDE_ERRORS.unsafeFile);
    await expect(setMeetingOverride(meeting("a", 0, 30), { stateDir: dir, now: date(-5) })).rejects.toThrow(OVERRIDE_ERRORS.unsafeFile);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ version: 1, entries: [] });
  });

  test("a busy lock gives a known error", async () => {
    const busy = async (): Promise<never> => { throw new Error("meeting-overrides is already running"); };
    await expect(setMeetingOverride(meeting("a", 0, 30), {
      stateDir: await stateDir(), now: date(-5), lockOptions: { lock: busy, attempts: 2, sleep: async () => undefined }
    })).rejects.toThrow(OVERRIDE_ERRORS.busy);
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(OVERRIDE_KNOWN_ERRORS).toEqual(Object.values(OVERRIDE_ERRORS));
    for (const message of OVERRIDE_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
