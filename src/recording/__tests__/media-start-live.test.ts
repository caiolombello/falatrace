import { afterAll, beforeAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import { defaultLiveDir, LIVE_TRANSCRIPT_RETENTION_DAYS } from "../../live/store";
import { notesCaptureReference } from "../../notes/capture";
import { NotesStore } from "../../notes/store";
import { readActivity } from "../../runtime/heavy-admission";
import { defaultLiveTranscriptUnits, type LiveTranscriptUnits, RecordingController } from "../controller";
import { captureMediaStartedAt, RecordingSessionStore } from "../session";

const sources = JSON.stringify([
  { name: "mic", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } },
  { name: "speaker.monitor", mute: false, volume: { "front-left": { value: 65536, value_percent: "100%" } } }
]);

let fixtureDir = "";
let fixture = "";
beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(join(tmpdir(), "media-start-fixture-"));
  fixture = join(fixtureDir, "tone.mka");
  await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "flac", "-f", "matroska", fixture]);
});
afterAll(async () => { await fs.rm(fixtureDir, { recursive: true, force: true }); });

/** A capture whose unit writes media at once and stops on `systemctl stop`; every command is recorded. */
const fakeCapture = (log: string[]) => {
  let active = false;
  const run: typeof runCommand = async (command, args) => {
    if (command === "systemd-run") {
      log.push("capture-start");
      await fs.copyFile(fixture, args[args.length - 1]);
      active = true;
    }
    if (command === "systemctl") {
      if (args.includes("stop")) {
        log.push("capture-stop");
        active = false;
      }
      return { stdout: `ActiveState=${active ? "active" : "inactive"}`, stderr: "" };
    }
    return { stdout: args[0]?.includes("format=json") ? sources : args[0] === "get-default-source" ? "mic" : "speaker", stderr: "" };
  };
  return run;
};

const fakeLive = (log: string[], options: { failStart?: boolean; failStop?: boolean; used?: boolean } = {}, store?: RecordingSessionStore): LiveTranscriptUnits => ({
  start: async (id) => {
    log.push(`live-start:${(await store?.read())?.phase}:${id}`);
    if (options.failStart) throw new Error("systemd-run failed");
  },
  stop: async (id) => {
    log.push(`live-stop:${id}`);
    if (options.failStop) throw new Error("systemctl failed");
  },
  used: async () => options.used === true
});

const setup = async (live: boolean) => {
  const root = await fs.mkdtemp(join(tmpdir(), "media-start-"));
  const store = new RecordingSessionStore(join(root, "session.json"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = "audio";
  config.recordingsDir = root;
  config.archive.enabled = false;
  config.live.enabled = live;
  return { root, store, config };
};

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("a capture records when its media began and starts the live transcript right after it is recording", async () => {
  const { root, store, config } = await setup(true);
  const log: string[] = [];
  try {
    const recorder = new RecordingController(config, "manual", store, fakeCapture(log), fakeLive(log, {}, store));
    const before = Date.now();
    expect(await recorder.start({ sessionId: ID })).toBe("started");
    const session = await store.read();
    expect(session?.phase).toBe("recording");
    if (!session?.mediaStartedAt) throw new Error("the session has no media start");
    const media = Date.parse(session.mediaStartedAt);
    expect(media).toBeGreaterThanOrEqual(Date.parse(session.startedAt));
    expect(media).toBeGreaterThanOrEqual(before - 1);
    expect(captureMediaStartedAt(session)).toBe(session.mediaStartedAt);
    expect(log).toEqual(["capture-start", `live-start:recording:${ID}`]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the live worker is stopped after the capture, and its failures never fail the capture", async () => {
  const { root, store, config } = await setup(true);
  const log: string[] = [];
  try {
    const recorder = new RecordingController(config, "manual", store, fakeCapture(log), fakeLive(log, { failStart: true, failStop: true }, store));
    expect(await recorder.start({ sessionId: ID })).toBe("started");
    const stopped = await recorder.stop(ID);
    expect(stopped?.phase).toBe("stopped");
    expect(stopped?.mediaStartedAt).toBeDefined();
    expect(log).toEqual(["capture-start", `live-start:recording:${ID}`, "capture-stop", `live-stop:${ID}`]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("with the live setting off, nothing starts; a stop is sent only when a worker ran for this capture", async () => {
  for (const used of [false, true]) {
    const { root, store, config } = await setup(false);
    const log: string[] = [];
    try {
      const recorder = new RecordingController(config, "manual", store, fakeCapture(log), fakeLive(log, { used }, store));
      expect(await recorder.start({ sessionId: ID })).toBe("started");
      await recorder.stop(ID);
      expect(log).toEqual(used ? ["capture-start", "capture-stop", `live-stop:${ID}`] : ["capture-start", "capture-stop"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("every capture start, live on or off, removes old live transcripts but its own; a failure never fails the capture", async () => {
  for (const live of [true, false]) {
    const { root, store, config } = await setup(live);
    const log: string[] = [];
    try {
      const pruning: LiveTranscriptUnits = { ...fakeLive(log, {}, store), prune: async (keep) => { log.push(`live-prune:${keep}`); throw new Error("prune failed"); } };
      const recorder = new RecordingController(config, "manual", store, fakeCapture(log), pruning);
      expect(await recorder.start({ sessionId: ID })).toBe("started");
      expect(log).toEqual(live ? ["capture-start", `live-start:recording:${ID}`, `live-prune:${ID}`] : ["capture-start", `live-prune:${ID}`]);
      expect((await store.read())?.phase).toBe("recording");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test("the default prune removes stopped live transcripts older than the retention, and keeps recent ones and the current capture", async () => {
  const dir = defaultLiveDir();
  const old = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", recent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const past = new Date(Date.now() - (LIVE_TRANSCRIPT_RETENTION_DAYS + 1) * 86_400_000);
  try {
    for (const id of [old, recent, ID]) {
      await fs.mkdir(join(dir, id), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(dir, id, "live.jsonl"), "", { mode: 0o600 });
    }
    for (const id of [old, ID]) await fs.utimes(join(dir, id), past, past);
    await defaultLiveTranscriptUnits.prune?.(ID);
    await expect(fs.stat(join(dir, old))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(join(dir, recent))).isDirectory()).toBe(true);
    expect((await fs.stat(join(dir, ID))).isDirectory()).toBe(true);
  } finally {
    for (const id of [old, recent, ID]) await fs.rm(join(dir, id), { recursive: true, force: true });
  }
});

test("a cancelled start never starts the live transcript", async () => {
  const { root, store, config } = await setup(true);
  const log: string[] = [];
  try {
    let calls = 0;
    const recorder = new RecordingController(config, "call", store, fakeCapture(log), fakeLive(log, {}, store));
    expect(await recorder.start({ sessionId: ID, shouldContinue: async () => ++calls < 3 })).toBe("cancelled");
    expect(log.some((entry) => entry.startsWith("live-start"))).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the session store and the admission detector refuse an invalid media start and accept older sessions without one", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "media-start-store-"));
  try {
    const store = new RecordingSessionStore(join(root, "recording-session.json"));
    const base = { version: 1 as const, id: ID, owner: "manual" as const, backend: "audio" as const, phase: "recording" as const,
      outputPath: join(root, "recording.mka"), startedAt: "2026-10-25T10:00:00.000Z" };
    await fs.writeFile(store.path, JSON.stringify(base));
    expect(await store.read()).toEqual(base);
    expect(captureMediaStartedAt(base)).toBe(base.startedAt);
    expect((await readActivity(root, Date.now(), { callMonitorExpected: false })).recording).toBe("active");
    await fs.writeFile(store.path, JSON.stringify({ ...base, mediaStartedAt: "2026-10-25T10:00:03.000Z" }));
    expect((await store.read())?.mediaStartedAt).toBe("2026-10-25T10:00:03.000Z");
    for (const bad of ["yesterday", 42, ""]) {
      await fs.writeFile(store.path, JSON.stringify({ ...base, mediaStartedAt: bad }));
      await expect(store.read()).rejects.toThrow("Invalid recording session");
      expect((await readActivity(root, Date.now(), { callMonitorExpected: false })).recording).toBe("unknown");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("notes typed during a capture use its media start, and its end once stopped", () => {
  const session = { id: ID, startedAt: "2026-10-25T10:00:00.000Z", mediaStartedAt: "2026-10-25T10:00:04.000Z", phase: "recording" as const,
    outputPath: "/home/u/Videos/Recordings/x-aaaaaaaa/recording.mka", endedAt: undefined };
  expect(notesCaptureReference(session)).toEqual({ id: ID, mediaStartedAt: "2026-10-25T10:00:04.000Z", sourcePath: session.outputPath });
  expect(notesCaptureReference({ ...session, mediaStartedAt: undefined })).toEqual({ id: ID, mediaStartedAt: session.startedAt, sourcePath: session.outputPath });
  expect(notesCaptureReference({ ...session, phase: "stopped", endedAt: "2026-10-25T11:00:00.000Z" }).mediaEndedAt).toBe("2026-10-25T11:00:00.000Z");
});

test("stopping a capture stores where its media ends on its notes, so a line typed long after it is untimed", async () => {
  const { root, store, config } = await setup(false);
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  try {
    const recorder = new RecordingController(config, "manual", store, fakeCapture([]), fakeLive([]));
    expect(await recorder.start({ sessionId: id })).toBe("started");
    const notes = new NotesStore();
    const reference = notesCaptureReference((await store.read())!);
    // Typed during the capture (as the Studio saves it, with the capture's reference).
    await notes.save(id, { text: "durante a reunião", expectedRev: 0, mediaStartedAt: reference.mediaStartedAt, sourcePath: reference.sourcePath });
    const stopped = await recorder.stop(id);
    await recorder.acknowledge(id);
    expect(await store.read()).toBeNull();
    const stored = await notes.read(id);
    expect(stored?.mediaEndedAt).toBe(stopped!.endedAt);
    expect(stored?.rev).toBe(1);
    // Ten minutes later, from the meeting page: the session is gone, so the save carries no reference.
    const later = await notes.save(id, { text: "durante a reunião\nlembrei depois", expectedRev: 1, now: new Date(Date.parse(stopped!.endedAt!) + 10 * 60_000) });
    expect(later.entries[0]!.offsetSeconds).not.toBeNull();
    expect(later.entries[1]!.offsetSeconds).toBeNull();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
