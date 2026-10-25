import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SingletonLease } from "../../runtime/singleton";
import { launchRecordingStudio } from "../../tray/runtime";
import {
  FALATRACE_URI_MAX_LENGTH, falatraceUri, holdStudioPresence, OPEN_REQUEST_ERRORS, OPEN_REQUEST_KNOWN_ERRORS, openInStudio, parseFalatraceUri,
  queueStudioOpen, STUDIO_INBOX_LIMITS, studioInboxDir, studioIsRunning, takeStudioOpens
} from "../open-request";

const JOB = "3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f";
const EVENT = "0123456789abcdef".repeat(4);
const RECORDING_URI = `falatrace://recording/${JOB}`;
const EVENT_URI = `falatrace://event/${EVENT}`;
const T0 = Date.parse("2026-10-25T14:00:00.000Z");

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-open-request-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("falatrace:// links", () => {
  test("the three exact forms parse to navigation targets", () => {
    expect(parseFalatraceUri(RECORDING_URI)).toEqual({ kind: "recording", jobId: JOB });
    expect(parseFalatraceUri(EVENT_URI)).toEqual({ kind: "event", eventIdHash: EVENT });
    expect(parseFalatraceUri("falatrace://capture")).toEqual({ kind: "capture" });
    expect(EVENT_URI.length).toBeLessThanOrEqual(FALATRACE_URI_MAX_LENGTH);
  });

  test("anything else is refused: extra segments, queries, case tricks, unicode, other schemes, huge or odd input", () => {
    const hostile: unknown[] = [
      `${RECORDING_URI}/`, `${RECORDING_URI}/delete`, `${RECORDING_URI}?export=1`, `${RECORDING_URI}#x`, `falatrace://recording//${JOB}`,
      `falatrace://recording/${JOB.toUpperCase()}`, `FALATRACE://recording/${JOB}`, `Falatrace://recording/${JOB}`, `falatrace://RECORDING/${JOB}`,
      `falatrace://recording/3f2b8c1e-9a4d-1c7b-8e2f-1a2b3c4d5e6f`, `falatrace://recording/${JOB.slice(1)}`, `falatrace://recording/${JOB}0`,
      `falatrace://recording/../../${JOB}`, `falatrace://recording/%33f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f`, `falatrace:recording/${JOB}`,
      `falatrace:///recording/${JOB}`, `falatrace://user@recording/${JOB}`, `falatrace://recording:80/${JOB}`,
      ` ${RECORDING_URI}`, `${RECORDING_URI} `, `${RECORDING_URI}\n`, `${RECORDING_URI}\u0000`, `‮${RECORDING_URI}`,
      `falatrace://recording/${JOB.replace("a", "а")}`, `ｆａｌａｔｒａｃｅ://capture`, "falatrace://capturе", "falatrace://cаpture",
      `falatrace://event/${EVENT.slice(1)}`, `falatrace://event/${EVENT}0`, `falatrace://event/${EVENT.toUpperCase()}`, `falatrace://event/${"g".repeat(64)}`,
      "falatrace://capture/", "falatrace://capture?start=1", "falatrace://capture#now", "falatrace://Capture", "falatrace://capture/record",
      `falatrace://export/${JOB}`, `falatrace://delete/${JOB}`, "falatrace://", "falatrace:", "", "javascript:alert(1)",
      `javascript://recording/${JOB}`, `https://recording/${JOB}`, `file:///tmp/${JOB}`, `${RECORDING_URI}${"a".repeat(10_000)}`,
      "x".repeat(1_000_000), null, undefined, 42, {}, [RECORDING_URI], { toString: () => RECORDING_URI }, new String(RECORDING_URI)
    ];
    for (const value of hostile) expect([typeof value === "string" ? value.slice(0, 80) : value, parseFalatraceUri(value)]).toEqual([typeof value === "string" ? value.slice(0, 80) : value, null]);
  });

  test("links are built back from targets, and only valid ones", () => {
    expect(falatraceUri({ kind: "recording", jobId: JOB })).toBe(RECORDING_URI);
    expect(falatraceUri({ kind: "event", eventIdHash: EVENT })).toBe(EVENT_URI);
    expect(falatraceUri({ kind: "capture" })).toBe("falatrace://capture");
    expect(() => falatraceUri({ kind: "recording", jobId: "../x" })).toThrow(OPEN_REQUEST_ERRORS.invalidUri);
    expect(() => falatraceUri({ kind: "other" } as never)).toThrow(OPEN_REQUEST_ERRORS.invalidUri);
  });
});

describe("the Studio inbox", () => {
  test("lives in the runtime directory, else in the state directory", () => {
    expect(studioInboxDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/ana")).toBe("/run/user/1000/recording-cli/studio-inbox");
    expect(studioInboxDir({ XDG_STATE_HOME: "/s" }, "/home/ana")).toBe("/s/recording-cli/studio-inbox");
    expect(studioInboxDir({ XDG_RUNTIME_DIR: "relative" }, "/home/ana")).toBe("/home/ana/.local/state/recording-cli/studio-inbox");
    expect(studioInboxDir({ XDG_RUNTIME_DIR: "/run/\nx" }, "/home/ana")).toBe("/home/ana/.local/state/recording-cli/studio-inbox");
  });

  test("queued links are private files taken once, oldest first", async () => {
    const dir = join(await tempDir(), "runtime", "recording-cli", "studio-inbox");
    let clock = T0;
    const now = () => clock++;
    expect(await queueStudioOpen(RECORDING_URI, { dir, now })).toEqual({ kind: "recording", jobId: JOB });
    await queueStudioOpen("falatrace://capture", { dir, now });
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const files = await fs.readdir(dir);
    expect(files.length).toBe(2);
    for (const file of files) {
      expect(file).toMatch(/^\d{13}-[0-9a-f-]{36}\.json$/);
      expect((await fs.stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    const taken = await takeStudioOpens({ dir, now: () => T0 + 1_000 });
    expect(taken).toEqual([
      { target: { kind: "recording", jobId: JOB }, uri: RECORDING_URI, queuedAt: new Date(T0).toISOString() },
      { target: { kind: "capture" }, uri: "falatrace://capture", queuedAt: new Date(T0 + 1).toISOString() }
    ]);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await takeStudioOpens({ dir, now: () => T0 + 2_000 })).toEqual([]);
  });

  test("an existing inbox with loose permissions is tightened", async () => {
    const dir = join(await tempDir(), "inbox");
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    await queueStudioOpen(RECORDING_URI, { dir });
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("invalid links are refused without writing anything", async () => {
    const dir = join(await tempDir(), "inbox");
    for (const bad of ["javascript:alert(1)", `${RECORDING_URI}?x`, "falatrace://capture/"]) {
      await expect(queueStudioOpen(bad, { dir })).rejects.toThrow(OPEN_REQUEST_ERRORS.invalidUri);
    }
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  test("stale, future-dated, damaged and forged requests are dropped and deleted", async () => {
    const dir = join(await tempDir(), "inbox");
    await queueStudioOpen(RECORDING_URI, { dir, now: () => T0 - STUDIO_INBOX_LIMITS.maxAgeMs - 1 });
    await queueStudioOpen(EVENT_URI, { dir, now: () => T0 + STUDIO_INBOX_LIMITS.maxFutureMs + 1 });
    await queueStudioOpen("falatrace://capture", { dir, now: () => T0 - 1_000 });
    const name = (offset: number, id: string) => `${T0 + offset}-${id}.json`;
    await fs.writeFile(join(dir, name(1, "00000000-0000-4000-8000-000000000001")), "{broken", { mode: 0o600 });
    await fs.writeFile(join(dir, name(2, "00000000-0000-4000-8000-000000000002")),
      JSON.stringify({ version: 1, uri: "falatrace://recording/x/delete", queuedAt: new Date(T0).toISOString() }), { mode: 0o600 });
    await fs.writeFile(join(dir, name(3, "00000000-0000-4000-8000-000000000003")),
      JSON.stringify({ version: 2, uri: RECORDING_URI, queuedAt: new Date(T0).toISOString() }), { mode: 0o600 });
    await fs.writeFile(join(dir, name(4, "00000000-0000-4000-8000-000000000004")), "x".repeat(STUDIO_INBOX_LIMITS.maxFileBytes + 1), { mode: 0o600 });
    // A symlink named like a request must not be followed.
    const outside = join(dir, "..", "outside.json");
    await fs.writeFile(outside, JSON.stringify({ version: 1, uri: RECORDING_URI, queuedAt: new Date(T0).toISOString() }));
    await fs.symlink(outside, join(dir, name(5, "00000000-0000-4000-8000-000000000005")));
    await fs.writeFile(join(dir, "notes.txt"), "not a request");
    const taken = await takeStudioOpens({ dir, now: () => T0 });
    expect(taken.map((request) => request.uri)).toEqual(["falatrace://capture"]);
    expect(await fs.readdir(dir)).toEqual(["notes.txt"]);
    expect(JSON.parse(await fs.readFile(outside, "utf8")).uri).toBe(RECORDING_URI);
  });

  test("at most 20 requests wait; repeats of a link fold into the latest", async () => {
    const dir = join(await tempDir(), "inbox");
    let clock = T0;
    for (let index = 0; index < 25; index++) await queueStudioOpen(index % 2 ? RECORDING_URI : "falatrace://capture", { dir, now: () => clock++ });
    expect((await fs.readdir(dir)).length).toBe(STUDIO_INBOX_LIMITS.maxPending);
    const taken = await takeStudioOpens({ dir, now: () => clock });
    // The last capture request (index 24) came after the last recording request (index 23).
    expect(taken.map((request) => request.uri)).toEqual([RECORDING_URI, "falatrace://capture"]);
    expect(taken.map((request) => request.queuedAt)).toEqual([new Date(T0 + 23).toISOString(), new Date(T0 + 24).toISOString()]);
  });

  test("hand-placed floods are bounded to 20 per take", async () => {
    const dir = join(await tempDir(), "inbox");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 30; index++) {
      const uri = `falatrace://recording/${JOB.slice(0, -2)}${index.toString(16).padStart(2, "0")}`;
      await fs.writeFile(join(dir, `${T0 + index}-00000000-0000-4000-8000-${index.toString().padStart(12, "0")}.json`),
        JSON.stringify({ version: 1, uri, queuedAt: new Date(T0 + index).toISOString() }), { mode: 0o600 });
    }
    const taken = await takeStudioOpens({ dir, now: () => T0 + 100 });
    expect(taken.length).toBe(STUDIO_INBOX_LIMITS.maxTake);
    expect(taken[taken.length - 1].uri.endsWith("1d")).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("two readers taking at once never get the same request", async () => {
    const dir = join(await tempDir(), "inbox");
    let clock = T0;
    const uris = Array.from({ length: 12 }, (_, index) => `falatrace://recording/${JOB.slice(0, -2)}${index.toString(16).padStart(2, "0")}`);
    for (const uri of uris) await queueStudioOpen(uri, { dir, now: () => clock++ });
    const [a, b] = await Promise.all([takeStudioOpens({ dir, now: () => clock }), takeStudioOpens({ dir, now: () => clock })]);
    const all = [...a, ...b].map((request) => request.uri);
    expect(all.sort()).toEqual([...uris].sort());
  });

  test("leftover temporary files are swept once old; a missing inbox is empty; an unsafe inbox is refused", async () => {
    const root = await tempDir();
    const dir = join(root, "inbox");
    expect(await takeStudioOpens({ dir })).toEqual([]);
    await fs.mkdir(dir, { mode: 0o700 });
    const leftover = join(dir, `.${T0}-00000000-0000-4000-8000-000000000001.json.taking-12-00000000-0000-4000-8000-000000000002`);
    await fs.writeFile(leftover, "{}");
    await takeStudioOpens({ dir, now: () => Date.now() });
    expect(await fs.readdir(dir)).toEqual([leftover.slice(dir.length + 1)]);
    await takeStudioOpens({ dir, now: () => Date.now() + STUDIO_INBOX_LIMITS.maxAgeMs + 1_000 });
    expect(await fs.readdir(dir)).toEqual([]);

    const real = join(root, "real");
    await fs.mkdir(real, { mode: 0o700 });
    const linked = join(root, "linked");
    await fs.symlink(real, linked);
    await expect(takeStudioOpens({ dir: linked })).rejects.toThrow(OPEN_REQUEST_ERRORS.unsafeInbox);
    await expect(queueStudioOpen(RECORDING_URI, { dir: linked })).rejects.toThrow(OPEN_REQUEST_ERRORS.unsafeInbox);
    expect(await fs.readdir(real)).toEqual([]);
  });
});

describe("Studio presence", () => {
  test("the bridge's lock makes the Studio count as running; a second holder gets null", async () => {
    expect(await studioIsRunning()).toBe(false);
    const lease = await holdStudioPresence();
    expect(lease).not.toBeNull();
    try {
      expect(await studioIsRunning()).toBe(true);
      expect(await holdStudioPresence()).toBeNull();
    } finally {
      await lease?.release();
    }
    expect(await studioIsRunning()).toBe(false);
  });

  test("a lock held only for a moment (another process checking presence) does not cost the bridge its presence", async () => {
    let calls = 0;
    const slept: number[] = [];
    const lease: SingletonLease = { release: async () => undefined };
    const checkedOnce = async (): Promise<SingletonLease> => {
      calls++;
      if (calls === 1) throw new Error("desktop-studio is already running");
      return lease;
    };
    expect(await holdStudioPresence({ lock: checkedOnce, sleep: async (ms) => { slept.push(ms); } })).toBe(lease);
    expect([calls, slept]).toEqual([2, [100]]);
    // Held for good by another Studio: a few tries, then null.
    let tries = 0;
    const held = async (): Promise<SingletonLease> => { tries++; throw new Error("desktop-studio is already running"); };
    expect(await holdStudioPresence({ lock: held, sleep: async () => undefined })).toBeNull();
    expect(tries).toBe(4);
  });

  test("lock failures other than 'held' mean not running, and are not hidden from the holder", async () => {
    const broken = async (): Promise<SingletonLease> => { throw new Error("EACCES"); };
    expect(await studioIsRunning({ lock: broken })).toBe(false);
    await expect(holdStudioPresence({ lock: broken })).rejects.toThrow("EACCES");
  });
});

describe("opening a link in the Studio", () => {
  test("a running Studio gets the link through its inbox and nothing is launched", async () => {
    const dir = join(await tempDir(), "inbox");
    const launched: string[][] = [];
    expect(await openInStudio(RECORDING_URI, { dir, isRunning: async () => true, launch: async (args) => { launched.push(args); } })).toBe("queued");
    expect(launched).toEqual([]);
    expect((await takeStudioOpens({ dir })).map((request) => request.uri)).toEqual([RECORDING_URI]);
  });

  test("otherwise the Studio is launched with the link as its argument, and the link also waits in the inbox", async () => {
    const dir = join(await tempDir(), "inbox");
    const launched: string[][] = [];
    expect(await openInStudio(EVENT_URI, { dir, isRunning: async () => false, launch: async (args) => { launched.push(args); } })).toBe("launched");
    expect(launched).toEqual([[EVENT_URI]]);
    expect((await takeStudioOpens({ dir })).map((request) => request.uri)).toEqual([EVENT_URI]);
    const quiet = join(await tempDir(), "quiet");
    await openInStudio("falatrace://capture", { dir: quiet, isRunning: async () => false, queueOnLaunch: false, launch: async () => undefined });
    expect(await takeStudioOpens({ dir: quiet })).toEqual([]);
  });

  test("an inbox that cannot be written does not stop the launch", async () => {
    const root = await tempDir();
    await fs.writeFile(join(root, "inbox"), "file in the way");
    const launched: string[][] = [];
    expect(await openInStudio(RECORDING_URI, { dir: join(root, "inbox"), isRunning: async () => false, launch: async (args) => { launched.push(args); } })).toBe("launched");
    expect(launched).toEqual([[RECORDING_URI]]);
  });

  test("invalid links never reach the inbox or the launcher", async () => {
    const dir = join(await tempDir(), "inbox");
    let touched = false;
    for (const bad of ["javascript:alert(1)", `${RECORDING_URI}/export`, `FALATRACE://capture`]) {
      await expect(openInStudio(bad, {
        dir, isRunning: async () => { touched = true; return false; }, launch: async () => { touched = true; }
      })).rejects.toThrow(OPEN_REQUEST_ERRORS.invalidUri);
    }
    expect(touched).toBe(false);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  test("launchRecordingStudio passes extra arguments after the launcher; without them the command is unchanged", async () => {
    const seen: string[][] = [];
    const runner = async (_executable: string, args: string[]) => { seen.push(args); return undefined; };
    await launchRecordingStudio(process.execPath, runner, [RECORDING_URI]);
    await launchRecordingStudio(process.execPath, runner);
    expect(seen[0].slice(seen[0].indexOf("--"))).toEqual(["--", process.execPath, RECORDING_URI]);
    expect(seen[1].slice(seen[1].indexOf("--"))).toEqual(["--", process.execPath]);
  });

  test("known errors are the fixed Portuguese messages", () => {
    expect(OPEN_REQUEST_KNOWN_ERRORS).toEqual(Object.values(OPEN_REQUEST_ERRORS));
    for (const message of OPEN_REQUEST_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
  });
});
