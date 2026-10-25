import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_KNOWN_ERRORS,
  LIVE_MESSAGES,
  LIVE_PAGE_MAX,
  LIVE_TRANSCRIPT_MAX_BYTES,
  type LiveLine,
  type LiveStatus,
  LiveStore,
  readLiveTranscript,
  validateLiveLine,
  validateLiveSessionId,
  validateLiveStatus
} from "../store";

let root: string;
let store: LiveStore;
let id: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "live-store-"));
  store = new LiveStore(join(root, "state", "recording-cli", "live"));
  id = randomUUID();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const line = (seq: number, text = `linha ${seq}`): LiveLine => ({ seq, start: seq * 2, end: seq * 2 + 1.5, text, provider: "whisper-cpp" });

const status = (overrides: Partial<LiveStatus> = {}): LiveStatus => ({
  version: 1,
  sessionId: id,
  state: "running",
  rtf: 0.4,
  lastSeq: 3,
  provider: "groq",
  startedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:30.000Z",
  chunkSeconds: 15,
  chunksDone: 2,
  chunksSkipped: 1,
  chunksDropped: 0,
  backlog: 0,
  ...overrides
});

test("known errors are fixed Portuguese strings without duplicates", () => {
  expect(LIVE_KNOWN_ERRORS.length).toBe(new Set(LIVE_KNOWN_ERRORS).size);
  expect(LIVE_KNOWN_ERRORS).toContain(LIVE_MESSAGES.alreadyRunning);
  for (const message of LIVE_KNOWN_ERRORS) expect(message).toMatch(/^[A-ZÀ-Ú].*\.$/);
});

test("session ids must be lowercase UUID v4", () => {
  expect(validateLiveSessionId(id)).toBe(id);
  for (const bad of ["", "../etc", id.toUpperCase(), "00000000-0000-1000-8000-000000000000", `${id}/x`, 42]) {
    expect(() => validateLiveSessionId(bad)).toThrow(LIVE_MESSAGES.invalidSession);
  }
  expect(() => store.sessionDir("../../etc")).toThrow(LIVE_MESSAGES.invalidSession);
});

describe("folders and files", () => {
  test("prepare creates private folders and fixes loose modes of its own folders", async () => {
    const chunks = await store.prepare(id);
    expect(chunks).toBe(join(store.root, id, "chunks"));
    for (const path of [store.root, store.sessionDir(id), chunks]) expect((await stat(path)).mode & 0o777).toBe(0o700);
    await chmod(store.sessionDir(id), 0o755);
    await store.prepare(id);
    expect((await stat(store.sessionDir(id))).mode & 0o777).toBe(0o700);
  });

  test("a symlinked live folder is refused", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(root, "state", "recording-cli"), { recursive: true });
    await symlink(elsewhere, store.root);
    await expect(store.prepare(id)).rejects.toThrow(LIVE_MESSAGES.unsafeDirectory);
  });

  test("transcript and status files are 0600", async () => {
    await store.prepare(id);
    await store.append(id, [line(1)]);
    await store.writeStatus(id, status());
    expect((await stat(store.transcriptPath(id))).mode & 0o777).toBe(0o600);
    expect((await stat(store.statusPath(id))).mode & 0o777).toBe(0o600);
  });
});

describe("transcript", () => {
  test("pages by sinceSeq", async () => {
    await store.prepare(id);
    await store.append(id, Array.from({ length: 10 }, (_, index) => line(index + 1)));
    const first = await store.read(id, 0, 4);
    expect(first.lines.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(first).toMatchObject({ lastSeq: 10, hasMore: true, invalidLines: 0 });
    const second = await store.read(id, 4, 4);
    expect(second.lines.map((entry) => entry.seq)).toEqual([5, 6, 7, 8]);
    const last = await store.read(id, 8, 4);
    expect(last.lines.map((entry) => entry.seq)).toEqual([9, 10]);
    expect(last.hasMore).toBe(false);
    expect((await store.read(id, 10)).lines).toEqual([]);
    expect((await store.read(id, 999)).lines).toEqual([]);
    expect(await store.lastSeq(id)).toBe(10);
  });

  test("an unknown session reads as empty", async () => {
    expect(await store.read(id)).toEqual({ lines: [], lastSeq: 0, hasMore: false, invalidLines: 0 });
  });

  test("rejects a bad cursor and clamps the page size", async () => {
    await store.prepare(id);
    await store.append(id, [line(1)]);
    await expect(store.read(id, -1)).rejects.toThrow(LIVE_MESSAGES.invalidCursor);
    await expect(store.read(id, 1.5)).rejects.toThrow(LIVE_MESSAGES.invalidCursor);
    expect((await store.read(id, 0, 0)).lines).toHaveLength(1);
    expect((await store.read(id, 0, LIVE_PAGE_MAX * 10)).lines).toHaveLength(1);
  });

  test("picks up appended lines incrementally and waits for a half-written line", async () => {
    await store.prepare(id);
    await store.append(id, [line(1), line(2)]);
    expect((await store.read(id)).lastSeq).toBe(2);
    await store.append(id, [line(3)]);
    const partial = JSON.stringify(line(4));
    await appendFile(store.transcriptPath(id), partial.slice(0, 10));
    const view = await store.read(id, 2);
    expect(view.lines.map((entry) => entry.seq)).toEqual([3]);
    await appendFile(store.transcriptPath(id), `${partial.slice(10)}\n`);
    expect((await store.read(id, 3)).lines.map((entry) => entry.seq)).toEqual([4]);
  });

  test("concurrent polls of a growing transcript neither count lines twice nor lose later lines", async () => {
    await store.prepare(id);
    await store.append(id, [line(1), line(2)]);
    await store.read(id);
    await store.append(id, [line(3), line(4)]);
    const views = await Promise.all([store.read(id), store.read(id), store.read(id, 2)]);
    for (const view of views) expect(view).toMatchObject({ lastSeq: 4, invalidLines: 0 });
    expect(views[2].lines.map((entry) => entry.seq)).toEqual([3, 4]);
    await store.append(id, [5, 6, 7, 8, 9, 10].map((seq) => line(seq)));
    const after = await store.read(id);
    expect(after.lines.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(after.invalidLines).toBe(0);
  });

  test("an append after a writer died mid-line ends the fragment first, so the new line survives", async () => {
    await store.prepare(id);
    await store.append(id, [line(1)]);
    await appendFile(store.transcriptPath(id), JSON.stringify(line(2)).slice(0, 12));
    await store.append(id, [line(2), line(3)]);
    const view = await store.read(id);
    expect(view.lines.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(view.invalidLines).toBe(1);
    expect((await readFile(store.transcriptPath(id), "utf8")).endsWith(`${JSON.stringify(line(3))}\n`)).toBe(true);
  });

  test("skips and counts malformed lines, out-of-order seqs and unsafe text", async () => {
    await store.prepare(id);
    const raw = [
      JSON.stringify(line(1)),
      "{not json",
      JSON.stringify({ ...line(2), provider: "elsewhere" }),
      JSON.stringify({ ...line(3), text: "tab\there" }),
      JSON.stringify({ ...line(4), end: 1 }),
      JSON.stringify({ ...line(5), text: "" }),
      JSON.stringify(line(6)),
      JSON.stringify(line(6, "duplicada")),
      JSON.stringify(line(2, "voltou")),
      JSON.stringify([1, 2]),
      JSON.stringify(line(7))
    ].join("\n");
    await writeFile(store.transcriptPath(id), `${raw}\n`, { mode: 0o600 });
    const view = await store.read(id);
    expect(view.lines.map((entry) => entry.seq)).toEqual([1, 6, 7]);
    expect(view.invalidLines).toBe(8);
  });

  test("starts over when the file is replaced or truncated", async () => {
    await store.prepare(id);
    await store.append(id, [line(1), line(2), line(3)]);
    expect((await store.read(id)).lastSeq).toBe(3);
    const replacement = join(store.sessionDir(id), "new.jsonl");
    await writeFile(replacement, `${JSON.stringify(line(1, "nova"))}\n`, { mode: 0o600 });
    await rename(replacement, store.transcriptPath(id));
    const view = await store.read(id);
    expect(view.lines.map((entry) => entry.text)).toEqual(["nova"]);
    await truncate(store.transcriptPath(id), 0);
    expect((await store.read(id)).lines).toEqual([]);
  });

  test("refuses a symlinked transcript, for reading and appending", async () => {
    await store.prepare(id);
    const target = join(root, "target.jsonl");
    await writeFile(target, `${JSON.stringify(line(1))}\n`);
    await symlink(target, store.transcriptPath(id));
    await expect(store.read(id)).rejects.toThrow(LIVE_MESSAGES.unsafeDirectory);
    await expect(store.append(id, [line(2)])).rejects.toThrow(LIVE_MESSAGES.unsafeDirectory);
    expect(await readFile(target, "utf8")).toBe(`${JSON.stringify(line(1))}\n`);
  });

  test("append validates every line and keeps seqs increasing within a batch", async () => {
    await store.prepare(id);
    await expect(store.append(id, [line(2), line(1)])).rejects.toThrow(LIVE_MESSAGES.invalidFile);
    await expect(store.append(id, [{ ...line(1), text: "a\u0007b" }])).rejects.toThrow(LIVE_MESSAGES.invalidFile);
    await expect(store.append(id, [{ ...line(1), start: Number.NaN }])).rejects.toThrow(LIVE_MESSAGES.invalidFile);
    await store.append(id, []);
    expect((await lstat(store.transcriptPath(id)).catch(() => null))).toBeNull();
  });

  test("the transcript never grows past its bound", async () => {
    await store.prepare(id);
    await writeFile(store.transcriptPath(id), "", { mode: 0o600 });
    await truncate(store.transcriptPath(id), LIVE_TRANSCRIPT_MAX_BYTES - 10);
    await expect(store.append(id, [line(1)])).rejects.toThrow(LIVE_MESSAGES.sizeLimit);
    expect((await stat(store.transcriptPath(id))).size).toBe(LIVE_TRANSCRIPT_MAX_BYTES - 10);
  });
});

describe("status", () => {
  test("round-trips and is rebuilt field by field", async () => {
    await store.prepare(id);
    await store.writeStatus(id, { ...status({ error: LIVE_MESSAGES.chunkFailed }), extra: "dropped" } as LiveStatus);
    const read = await store.readStatus(id);
    expect(read).toEqual(status({ error: LIVE_MESSAGES.chunkFailed }));
    expect(JSON.parse(await readFile(store.statusPath(id), "utf8")).extra).toBeUndefined();
  });

  test("strict validation", () => {
    expect(() => validateLiveStatus({ ...status(), version: 2 })).toThrow(LIVE_MESSAGES.invalidFile);
    expect(() => validateLiveStatus({ ...status(), state: "paused" })).toThrow();
    expect(() => validateLiveStatus({ ...status(), rtf: -1 })).toThrow();
    expect(() => validateLiveStatus({ ...status(), rtf: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => validateLiveStatus({ ...status(), error: "a\nb" })).toThrow();
    expect(() => validateLiveStatus({ ...status(), error: "x".repeat(301) })).toThrow();
    expect(() => validateLiveStatus({ ...status(), lastSeq: 1.5 })).toThrow();
    expect(() => validateLiveStatus({ ...status(), updatedAt: "yesterday" })).toThrow();
    expect(() => validateLiveStatus({ ...status(), sessionId: "x" })).toThrow();
    expect(validateLiveStatus({ ...status(), rtf: null }).rtf).toBeNull();
    expect(() => validateLiveLine({ ...line(1), seq: 0 })).toThrow();
  });

  test("refuses to write another session's status, and a status file for another session reads as invalid", async () => {
    await store.prepare(id);
    await expect(store.writeStatus(id, status({ sessionId: randomUUID() }))).rejects.toThrow(LIVE_MESSAGES.invalidSession);
    await writeFile(store.statusPath(id), JSON.stringify(status({ sessionId: randomUUID() })), { mode: 0o600 });
    await expect(store.readStatus(id)).rejects.toThrow(LIVE_MESSAGES.invalidFile);
  });

  test("writing replaces a planted symlink instead of following it", async () => {
    await store.prepare(id);
    const target = join(root, "victim.json");
    await writeFile(target, "victim");
    await symlink(target, store.statusPath(id));
    await expect(store.readStatus(id)).rejects.toThrow(LIVE_MESSAGES.unsafeDirectory);
    await store.writeStatus(id, status());
    expect(await readFile(target, "utf8")).toBe("victim");
    expect((await lstat(store.statusPath(id))).isSymbolicLink()).toBe(false);
  });
});

describe("readLiveTranscript", () => {
  test("returns lines after sinceSeq with the worker status", async () => {
    await store.prepare(id);
    await store.append(id, [line(1), line(2), line(3)]);
    await store.writeStatus(id, status());
    const view = await readLiveTranscript(id, 1, { store, now: Date.parse("2026-10-25T10:00:40.000Z") });
    expect(view.lines.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(view.status?.state).toBe("running");
    expect(view.stale).toBe(false);
  });

  test("flags a running status the worker stopped updating", async () => {
    await store.prepare(id);
    await store.writeStatus(id, status({ state: "behind" }));
    const view = await readLiveTranscript(id, 0, { store, now: Date.parse("2026-10-25T10:05:00.000Z") });
    expect(view.stale).toBe(true);
    await store.writeStatus(id, status({ state: "stopped" }));
    expect((await readLiveTranscript(id, 0, { store, now: Date.parse("2026-10-25T10:05:00.000Z") })).stale).toBe(false);
  });

  test("an invalid status reads as null; bad input is refused", async () => {
    await store.prepare(id);
    await writeFile(store.statusPath(id), "{", { mode: 0o600 });
    expect((await readLiveTranscript(id, 0, { store })).status).toBeNull();
    await expect(readLiveTranscript("nope", 0, { store })).rejects.toThrow(LIVE_MESSAGES.invalidSession);
    await expect(readLiveTranscript(id, -3, { store })).rejects.toThrow(LIVE_MESSAGES.invalidCursor);
  });

  test("uses XDG_STATE_HOME by default", async () => {
    const state = process.env.XDG_STATE_HOME as string;
    const defaultStore = new LiveStore();
    expect(defaultStore.root).toBe(join(state, "recording-cli", "live"));
    await defaultStore.prepare(id);
    await defaultStore.append(id, [line(1)]);
    expect((await readLiveTranscript(id)).lines).toHaveLength(1);
    await defaultStore.remove(id);
  });
});

describe("remove and prune", () => {
  test("remove deletes the whole session folder", async () => {
    await store.prepare(id);
    await store.append(id, [line(1)]);
    expect(await store.remove(id)).toBe(true);
    expect(await store.remove(id)).toBe(false);
    expect((await store.read(id)).lines).toEqual([]);
  });

  test("prune keeps running and recent sessions", async () => {
    const now = Date.parse("2026-10-30T10:00:00.000Z");
    const old = randomUUID();
    const running = randomUUID();
    const recent = randomUUID();
    const stale = randomUUID();
    for (const [session, value] of [
      [old, { state: "stopped", updatedAt: "2026-10-20T10:00:00.000Z" }],
      [running, { state: "running", updatedAt: "2026-10-30T09:59:50.000Z" }],
      [recent, { state: "stopped", updatedAt: "2026-10-30T09:00:00.000Z" }],
      [stale, { state: "running", updatedAt: "2026-10-21T10:00:00.000Z" }]
    ] as const) {
      await store.prepare(session);
      await store.writeStatus(session, { ...status(), sessionId: session, ...value });
    }
    await mkdir(join(store.root, "not-a-session"));
    // A bad age must not turn into "remove everything that is stopped".
    for (const maxAgeMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(store.prune({ now, maxAgeMs })).rejects.toThrow();
    }
    expect(await store.readStatus(recent)).not.toBeNull();
    const removed = await store.prune({ now, maxAgeMs: 2 * 24 * 3600 * 1000 });
    expect(removed.sort()).toEqual([old, stale].sort());
    expect(await stat(join(store.root, "not-a-session")).then(() => true)).toBe(true);
    expect(await store.readStatus(running)).not.toBeNull();
  });
});
