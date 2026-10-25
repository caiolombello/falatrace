import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_RUN_ERRORS, FIRST_RUN_KNOWN_ERRORS, firstRunPath, firstSummaryDelayMs, markFirstRun, readFirstRun, timeToFirstSummary,
  validateFirstRunMetrics
} from "../first-run";

const T0 = Date.parse("2026-10-25T14:00:00.000Z");
const date = (minutes: number): Date => new Date(T0 + minutes * 60_000);

const dirs: string[] = [];
const stateDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-first-run-"));
  dirs.push(dir);
  return join(dir, "state");
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("first-run milestones", () => {
  test("nothing recorded yet reads as an empty record", async () => {
    const dir = await stateDir();
    expect(await readFirstRun({ stateDir: dir })).toEqual({ version: 1 });
    expect(await timeToFirstSummary({ stateDir: dir })).toBeNull();
  });

  test("each milestone is written once, privately; later marks keep the first time", async () => {
    const dir = await stateDir();
    await markFirstRun("wizardOpened", date(0), { stateDir: dir });
    await markFirstRun("wizardFinished", date(3), { stateDir: dir });
    await markFirstRun("firstRecording", date(10), { stateDir: dir });
    await markFirstRun("wizardOpened", date(100), { stateDir: dir });
    const metrics = await markFirstRun("firstSummary", date(42), { stateDir: dir });
    expect(metrics).toEqual({
      version: 1, wizardOpenedAt: date(0).toISOString(), wizardFinishedAt: date(3).toISOString(),
      firstRecordingAt: date(10).toISOString(), firstSummaryAt: date(42).toISOString()
    });
    expect(await markFirstRun("firstSummary", date(50), { stateDir: dir })).toEqual(metrics);
    expect(await readFirstRun({ stateDir: dir })).toEqual(metrics);
    expect((await fs.stat(firstRunPath(dir))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(dir)).toEqual(["first-run.json"]);
    expect(await timeToFirstSummary({ stateDir: dir })).toBe(42 * 60_000);
    expect(await timeToFirstSummary({ metrics: { version: 1, wizardOpenedAt: date(0).toISOString(), firstSummaryAt: date(1).toISOString() } })).toBe(60_000);
  });

  test("windows reporting at the same time keep a single first value", async () => {
    const dir = await stateDir();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => markFirstRun("firstRecording", date(index), { stateDir: dir })));
    const stored = (await readFirstRun({ stateDir: dir })).firstRecordingAt;
    expect(stored).toBeDefined();
    for (const result of results) expect(result.firstRecordingAt).toBe(stored as string);
  });

  test("time to first summary needs both ends, in order", () => {
    expect(firstSummaryDelayMs({ version: 1, firstSummaryAt: date(5).toISOString() })).toBeNull();
    expect(firstSummaryDelayMs({ version: 1, wizardOpenedAt: date(5).toISOString() })).toBeNull();
    expect(firstSummaryDelayMs({ version: 1, wizardOpenedAt: date(5).toISOString(), firstSummaryAt: date(4).toISOString() })).toBeNull();
    expect(firstSummaryDelayMs({ version: 1, wizardOpenedAt: date(5).toISOString(), firstSummaryAt: date(5).toISOString() })).toBe(0);
  });

  test("bad events and times are refused", async () => {
    const dir = await stateDir();
    await expect(markFirstRun("firstExport" as never, date(0), { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.invalidEvent);
    await expect(markFirstRun("toString" as never, date(0), { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.invalidEvent);
    await expect(markFirstRun("wizardOpened", new Date(Number.NaN), { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.invalidTime);
    await expect(markFirstRun("wizardOpened", new Date("1999-12-31T00:00:00Z"), { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.invalidTime);
    await expect(markFirstRun("wizardOpened", "2026-10-25" as never, { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.invalidTime);
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});

describe("damaged or unsafe files", () => {
  test("the validator keeps valid milestones and drops anything else", () => {
    expect(validateFirstRunMetrics({ version: 1, wizardOpenedAt: date(0).toISOString(), firstSummaryAt: "soon", extra: 1, firstRecordingAt: 5 }))
      .toEqual({ version: 1, wizardOpenedAt: date(0).toISOString() });
    expect(validateFirstRunMetrics({ version: 2, wizardOpenedAt: date(0).toISOString() })).toEqual({ version: 1 });
    expect(validateFirstRunMetrics(null)).toEqual({ version: 1 });
    expect(validateFirstRunMetrics({ version: 1, wizardOpenedAt: "2026-10-25T14:00:00" })).toEqual({ version: 1 });
  });

  test("a damaged file reads as empty and is replaced on the next mark (metrics never block the app)", async () => {
    const dir = await stateDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(firstRunPath(dir), "{not json", { mode: 0o600 });
    expect(await readFirstRun({ stateDir: dir })).toEqual({ version: 1 });
    await markFirstRun("wizardOpened", date(0), { stateDir: dir });
    expect(await readFirstRun({ stateDir: dir })).toEqual({ version: 1, wizardOpenedAt: date(0).toISOString() });
    await fs.writeFile(firstRunPath(dir), "x".repeat(10_000), { mode: 0o600 });
    expect(await readFirstRun({ stateDir: dir })).toEqual({ version: 1 });
  });

  test("a symlink in place of the file is refused and its target left alone", async () => {
    const dir = await stateDir();
    await fs.mkdir(dir, { recursive: true });
    const target = join(dir, "..", "elsewhere.json");
    await fs.writeFile(target, "keep");
    await fs.symlink(target, firstRunPath(dir));
    await expect(readFirstRun({ stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.unsafeFile);
    await expect(markFirstRun("wizardOpened", date(0), { stateDir: dir })).rejects.toThrow(FIRST_RUN_ERRORS.unsafeFile);
    expect(await fs.readFile(target, "utf8")).toBe("keep");
  });

  test("a busy lock gives a known error", async () => {
    const busy = async (): Promise<never> => { throw new Error("first-run-metrics is already running"); };
    await expect(markFirstRun("wizardOpened", date(0), { stateDir: await stateDir(), lockOptions: { lock: busy, attempts: 2, sleep: async () => undefined } }))
      .rejects.toThrow(FIRST_RUN_ERRORS.busy);
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(FIRST_RUN_KNOWN_ERRORS).toEqual(Object.values(FIRST_RUN_ERRORS));
    for (const message of FIRST_RUN_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
