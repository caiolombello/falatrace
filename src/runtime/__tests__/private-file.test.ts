import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrivateFile, ensurePrivateDirectory, isIsoTime, isRecord, parseJson, PrivateFileError, readPrivateFile, recordingStateDir,
  removePrivateFile, singleLine, withPrivateLock, writePrivateFile
} from "../private-file";
import type { SingletonLease } from "../singleton";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-private-file-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const problemOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => "none", (error: unknown) => (error instanceof PrivateFileError ? error.problem : `other: ${String(error)}`));

describe("paths and directories", () => {
  test("the state directory follows XDG_STATE_HOME, else ~/.local/state", () => {
    expect(recordingStateDir({ XDG_STATE_HOME: "/x/state" }, "/home/ana")).toBe("/x/state/recording-cli");
    expect(recordingStateDir({}, "/home/ana")).toBe("/home/ana/.local/state/recording-cli");
  });

  test("directories are created 0700 and must be real directories", async () => {
    const root = await tempDir();
    const nested = join(root, "a", "b");
    await ensurePrivateDirectory(nested);
    expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
    const open = join(root, "open");
    await fs.mkdir(open, { mode: 0o755 });
    await fs.chmod(open, 0o755);
    await ensurePrivateDirectory(open);
    expect((await fs.stat(open)).mode & 0o777).toBe(0o755);
    await ensurePrivateDirectory(open, { tighten: true });
    expect((await fs.stat(open)).mode & 0o777).toBe(0o700);
    const link = join(root, "link");
    await fs.symlink(nested, link);
    expect(await problemOf(ensurePrivateDirectory(link))).toBe("unsafe");
    const file = join(root, "file");
    await fs.writeFile(file, "x");
    expect(await problemOf(ensurePrivateDirectory(file))).not.toBe("none");
  });
});

describe("reading", () => {
  test("missing is undefined; content is read up to the cap", async () => {
    const root = await tempDir();
    expect(await readPrivateFile(join(root, "missing"), 10)).toBeUndefined();
    await fs.writeFile(join(root, "ok"), "olá");
    expect(await readPrivateFile(join(root, "ok"), 10)).toBe("olá");
    await fs.writeFile(join(root, "big"), "x".repeat(11));
    expect(await problemOf(readPrivateFile(join(root, "big"), 10))).toBe("too-large");
  });

  test("symlinks, directories, FIFOs and invalid UTF-8 are refused", async () => {
    const root = await tempDir();
    await fs.writeFile(join(root, "target"), "secret");
    await fs.symlink(join(root, "target"), join(root, "link"));
    expect(await problemOf(readPrivateFile(join(root, "link"), 100))).toBe("unsafe");
    await fs.mkdir(join(root, "dir"));
    expect(await problemOf(readPrivateFile(join(root, "dir"), 100))).toBe("unsafe");
    execFileSync("mkfifo", [join(root, "fifo")]);
    expect(await problemOf(readPrivateFile(join(root, "fifo"), 100))).toBe("unsafe");
    await fs.writeFile(join(root, "latin1"), Buffer.from([0x6f, 0x6c, 0xe1]));
    expect(await problemOf(readPrivateFile(join(root, "latin1"), 100))).toBe("invalid-text");
  });
});

describe("writing", () => {
  test("atomic replace leaves a 0600 file and no temporary files", async () => {
    const root = await tempDir();
    const path = join(root, "state.json");
    await writePrivateFile(path, "one", 100);
    await writePrivateFile(path, "two", 100);
    expect(await fs.readFile(path, "utf8")).toBe("two");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(root)).toEqual(["state.json"]);
  });

  test("oversized text and a symlink or directory at the target are refused, untouched", async () => {
    const root = await tempDir();
    const path = join(root, "state.json");
    expect(await problemOf(writePrivateFile(path, "x".repeat(101), 100))).toBe("too-large");
    await fs.writeFile(join(root, "elsewhere"), "keep");
    await fs.symlink(join(root, "elsewhere"), path);
    expect(await problemOf(writePrivateFile(path, "new", 100))).toBe("unsafe");
    expect(await fs.readFile(join(root, "elsewhere"), "utf8")).toBe("keep");
    await fs.rm(path);
    await fs.mkdir(path);
    expect(await problemOf(writePrivateFile(path, "new", 100))).toBe("unsafe");
    expect((await fs.readdir(root)).sort()).toEqual(["elsewhere", "state.json"]);
  });

  test("create-if-absent: the first writer wins and the file is complete", async () => {
    const root = await tempDir();
    const path = join(root, "salt");
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => createPrivateFile(path, `writer-${index}`, 100)));
    expect(results.filter(Boolean).length).toBe(1);
    expect(await fs.readFile(path, "utf8")).toBe(`writer-${results.indexOf(true)}`);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(root)).toEqual(["salt"]);
  });

  test("remove deletes regular files only", async () => {
    const root = await tempDir();
    expect(await removePrivateFile(join(root, "missing"))).toBe(false);
    await fs.writeFile(join(root, "file"), "x");
    expect(await removePrivateFile(join(root, "file"))).toBe(true);
    await fs.mkdir(join(root, "dir"));
    expect(await problemOf(removePrivateFile(join(root, "dir")))).toBe("unsafe");
  });
});

describe("locking", () => {
  test("runs the task under the lock and releases it, even when the task throws", async () => {
    const events: string[] = [];
    const lock = async (name: string): Promise<SingletonLease> => {
      events.push(`lock ${name}`);
      return { release: async () => { events.push("release"); } };
    };
    expect(await withPrivateLock("demo", "busy", async () => "done", { lock })).toBe("done");
    await expect(withPrivateLock("demo", "busy", async () => { throw new Error("boom"); }, { lock })).rejects.toThrow("boom");
    expect(events).toEqual(["lock demo", "release", "lock demo", "release"]);
  });

  test("retries while another process holds the lock, then gives up with the busy message", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const busyLock = async (): Promise<SingletonLease> => { attempts++; throw new Error("demo is already running"); };
    await expect(withPrivateLock("demo", "Ocupado.", async () => "never", { lock: busyLock, attempts: 3, delayMs: 7, sleep: async (ms) => { sleeps.push(ms); } }))
      .rejects.toThrow("Ocupado.");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([7, 7]);
    let calls = 0;
    const eventually = async (): Promise<SingletonLease> => {
      if (++calls < 3) throw new Error("demo is already running");
      return { release: async () => undefined };
    };
    expect(await withPrivateLock("demo", "busy", async () => calls, { lock: eventually, sleep: async () => undefined })).toBe(3);
    await expect(withPrivateLock("demo", "busy", async () => 1, { lock: async () => { throw new Error("EACCES"); } })).rejects.toThrow("EACCES");
  });

  test("the real abstract-socket lock serialises two writers in one process", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withPrivateLock("private-file-test", "busy", async () => { order.push("first"); await held; order.push("first done"); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withPrivateLock("private-file-test", "busy", async () => { order.push("second"); }, { delayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first done", "second"]);
  });
});

describe("text helpers", () => {
  test("parseJson and isRecord", () => {
    expect(parseJson("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJson("{nope")).toBeUndefined();
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test("isIsoTime wants a full date-time with a zone", () => {
    expect(isIsoTime("2026-10-25T12:00:00.000Z")).toBe(true);
    expect(isIsoTime("2026-10-25T09:00:00-03:00")).toBe(true);
    for (const bad of ["2026-10-25", "2026-10-25T12:00:00", "2026-13-45T12:00:00Z", 1, null, `2026-10-25T12:00:00.${"1".repeat(40)}Z`]) {
      expect(isIsoTime(bad)).toBe(false);
    }
  });

  test("singleLine strips controls and direction overrides, collapses spaces and cuts safely", () => {
    expect(singleLine("  a\u0007b\nc‮ d e​f  ", 100)).toBe("a b c d e f");
    expect(singleLine("abcdef", 3)).toBe("abc");
    // A cut never leaves half of a surrogate pair.
    expect(singleLine("ab😀", 3)).toBe("ab");
  });
});
