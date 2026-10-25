import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import type { runCommandDirect } from "../../jobs/command";
import type { RecordingSession } from "../../recording/session";
import { liveSessionFromRecording, runLiveSession } from "../index";
import { LIVE_MESSAGES, LiveStore } from "../store";
import { buildLiveUnitArgs, liveUnitActive, liveUnitName, startLiveUnit, stopLiveUnit } from "../unit";
import { fakeTap, waitFor } from "./helpers";

const id = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

describe("transient unit", () => {
  test("name", () => {
    expect(liveUnitName(id)).toBe(`recording-cli-live-${id}.service`);
    expect(() => liveUnitName("x; rm -rf ~")).toThrow(LIVE_MESSAGES.invalidSession);
  });

  test("arguments: low priority, bounded memory and runtime, the worker command after --", () => {
    const args = buildLiveUnitArgs({
      sessionId: id,
      launch: ["/home/u/.local/bin/falatrace"],
      env: { PATH: "/usr/bin:/bin", XDG_STATE_HOME: "/home/u/state", PULSE_SERVER: "unix:/run/user/1000/pulse/native" },
      home: "/home/u"
    });
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1)).toEqual(["/home/u/.local/bin/falatrace", "live", "run", "--session", id]);
    const options = args.slice(0, separator);
    for (const expected of [
      "--user",
      "--collect",
      `--unit=recording-cli-live-${id}.service`,
      "--property=Nice=10",
      "--property=CPUWeight=20",
      "--property=MemoryMax=1G",
      "--property=UMask=0077",
      "--property=KillMode=mixed",
      "--property=TimeoutStopSec=30",
      "--property=RuntimeMaxSec=86400",
      "--setenv=PATH=/usr/bin:/bin",
      "--setenv=XDG_STATE_HOME=/home/u/state",
      "--setenv=PULSE_SERVER=unix:/run/user/1000/pulse/native"
    ]) {
      expect(options).toContain(expected);
    }
  });

  test("dollar signs in the command stay literal; control characters are refused", () => {
    const args = buildLiveUnitArgs({ sessionId: id, launch: ["/opt/$HOME/bun", "/src/cli/index.ts"], env: { PATH: "/usr/bin" }, home: "/home/u" });
    expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3)).toEqual(["/opt/$$HOME/bun", "/src/cli/index.ts"]);
    expect(() => buildLiveUnitArgs({ sessionId: id, launch: ["/bin/fala\ntrace"], env: {} })).toThrow();
    expect(() => buildLiveUnitArgs({ sessionId: id, launch: [], env: {} })).toThrow();
    expect(buildLiveUnitArgs({ sessionId: id, launch: ["/bin/x"], env: { PULSE_SERVER: "a\nb" } }).some((arg) => arg.startsWith("--setenv=PULSE_SERVER"))).toBe(false);
    expect(() => buildLiveUnitArgs({ sessionId: "bad", launch: ["/bin/x"], env: {} })).toThrow(LIVE_MESSAGES.invalidSession);
  });

  test("start, stop and active go through the injected runner", async () => {
    const calls: Array<[string, string[]]> = [];
    const ok = (async (command: string, args: string[]) => {
      calls.push([command, args]);
      return { stdout: command === "systemctl" && args[1] === "show" ? "ActiveState=active\n" : "", stderr: "" };
    }) as typeof runCommandDirect;
    expect(await startLiveUnit(id, { run: ok, launch: ["/bin/falatrace"], env: { PATH: "/usr/bin" } })).toBe(liveUnitName(id));
    expect(calls[0][0]).toBe("systemd-run");
    expect(calls[0][1].slice(-5)).toEqual(["/bin/falatrace", "live", "run", "--session", id]);
    expect(await stopLiveUnit(id, { run: ok })).toBe(true);
    expect(calls[1]).toEqual(["systemctl", ["--user", "stop", liveUnitName(id)]]);
    expect(await liveUnitActive(id, { run: ok })).toBe(true);

    const failing = (async () => {
      throw new Error("Failed to start transient service unit: Unit already exists");
    }) as typeof runCommandDirect;
    await expect(startLiveUnit(id, { run: failing, launch: ["/bin/falatrace"], env: {} })).rejects.toThrow(LIVE_MESSAGES.unitStartFailed);
    await expect(stopLiveUnit(id, { run: failing })).rejects.toThrow(LIVE_MESSAGES.unitStopFailed);
    expect(await liveUnitActive(id, { run: failing })).toBe(false);

    const missing = (async () => {
      throw new Error(`systemctl failed with code 5: Failed to stop ${liveUnitName(id)}: Unit ${liveUnitName(id)} not loaded.`);
    }) as typeof runCommandDirect;
    expect(await stopLiveUnit(id, { run: missing })).toBe(false);

    const inactive = (async () => ({ stdout: "ActiveState=inactive\n", stderr: "" })) as typeof runCommandDirect;
    expect(await liveUnitActive(id, { run: inactive })).toBe(false);
  });
});

describe("runLiveSession", () => {
  let root: string;
  let config: AppConfig;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "live-session-"));
    config = structuredClone(DEFAULT_CONFIG);
    config.live.enabled = true;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const recording = (sessionId: string, overrides: Partial<RecordingSession> = {}): RecordingSession => ({
    version: 1,
    id: sessionId,
    owner: "call",
    backend: "audio",
    phase: "recording",
    outputPath: "/home/u/Videos/Recordings/x/recording.mka",
    startedAt: "2026-10-25T10:00:00.000Z",
    audio: { microphone: "alsa_input.mic" },
    ...overrides
  });

  test("maps the recording session, including mediaStartedAt once it exists", () => {
    const sessionId = randomUUID();
    expect(liveSessionFromRecording(recording(sessionId))).toEqual({ startedAt: "2026-10-25T10:00:00.000Z", audio: { microphone: "alsa_input.mic" }, backend: "audio" });
    expect(liveSessionFromRecording(recording(sessionId, { backend: "obs", audio: {} }))).toEqual({ startedAt: "2026-10-25T10:00:00.000Z", audio: {}, backend: "obs" });
    expect(liveSessionFromRecording({ ...recording(sessionId), mediaStartedAt: "2026-10-25T10:00:01.500Z" } as RecordingSession).mediaStartedAt).toBe("2026-10-25T10:00:01.500Z");
    expect(liveSessionFromRecording({ ...recording(sessionId), mediaStartedAt: "nope" } as RecordingSession).mediaStartedAt).toBeUndefined();
  });

  test("refuses when the capture is another one, stopped, or gone", async () => {
    const sessionId = randomUUID();
    for (const current of [null, recording(randomUUID()), recording(sessionId, { phase: "stopped" })]) {
      await expect(runLiveSession({ config, sessionId, sessions: { read: async () => current } })).rejects.toThrow(LIVE_MESSAGES.sessionEnded);
    }
  });

  test("runs until the capture session disappears", async () => {
    const sessionId = randomUUID();
    let current: RecordingSession | null = recording(sessionId);
    const store = new LiveStore(join(root, "live"));
    const tap = fakeTap([{ chunks: [{ kind: "speech", seconds: 15 }] }]);
    const promise = runLiveSession({
      config,
      sessionId,
      sessions: { read: async () => current },
      deps: {
        store,
        spawn: tap.spawn,
        pollMs: 5,
        continueCheckMs: 0,
        now: () => Date.parse("2026-10-25T10:00:03.000Z"),
        fileExists: async () => true,
        log: () => undefined,
        transcribe: async () => [{ start: 0, end: 1, text: "oi" }]
      }
    });
    await waitFor(async () => (await store.read(sessionId)).lines.length === 1);
    current = null;
    const result = await promise;
    expect(result.state).toBe("stopped");
    expect((await store.read(sessionId)).lines[0]).toMatchObject({ start: 3, end: 4, text: "oi" });
    expect(tap.calls[0].args).toContain("alsa_input.mic");
  });
});
