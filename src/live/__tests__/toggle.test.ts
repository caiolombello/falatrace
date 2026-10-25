import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { runCommandDirect } from "../../jobs/command";
import type { RecordingSession } from "../../recording/session";
import { setLiveForSession } from "../index";
import { LIVE_MESSAGES } from "../store";
import { stopLiveUnit } from "../unit";

const id = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

const session = (phase: RecordingSession["phase"], sessionId = id): RecordingSession => ({
  version: 1, id: sessionId, owner: "manual", backend: "audio", phase, outputPath: "/tmp/x/recording.mka", startedAt: "2026-10-25T10:00:00.000Z"
});

const runner = (active: boolean) => {
  const calls: string[][] = [];
  const run: typeof runCommandDirect = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl" && args.includes("show")) return { stdout: `ActiveState=${active ? "active" : "inactive"}\n`, stderr: "" };
    if (command === "systemctl" && args.includes("stop") && !active) throw new Error(`Failed to stop ${args[args.length - 1]}: Unit not loaded.`);
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
};

const config = (enabled: boolean) => {
  const value = structuredClone(DEFAULT_CONFIG);
  value.live.enabled = enabled;
  return value;
};

test("turning the live transcript on starts its unit for the running capture, once", async () => {
  const idle = runner(false);
  const sessions = { read: async () => session("recording") };
  expect(await setLiveForSession(id, true, { config: config(true), sessions, run: idle.run, launch: ["/bin/falatrace"], env: { PATH: "/usr/bin" }, home: "/home/u" }))
    .toEqual({ sessionId: id, active: true, changed: true });
  const start = idle.calls.find((call) => call[0] === "systemd-run");
  expect(start?.slice(-5)).toEqual(["/bin/falatrace", "live", "run", "--session", id]);
  const running = runner(true);
  expect(await setLiveForSession(id, true, { config: config(true), sessions, run: running.run, launch: ["/bin/falatrace"] }))
    .toEqual({ sessionId: id, active: true, changed: false });
  expect(running.calls.some((call) => call[0] === "systemd-run")).toBe(false);
});

test("it needs the live setting on and this capture still recording", async () => {
  const { run, calls } = runner(false);
  await expect(setLiveForSession(id, true, { config: config(false), sessions: { read: async () => session("recording") }, run })).rejects.toThrow(LIVE_MESSAGES.disabled);
  for (const current of [null, session("stopped"), session("recording", "4f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b")]) {
    await expect(setLiveForSession(id, true, { config: config(true), sessions: { read: async () => current }, run })).rejects.toThrow(LIVE_MESSAGES.sessionEnded);
  }
  await expect(setLiveForSession("../etc", true, { config: config(true), run })).rejects.toThrow(LIVE_MESSAGES.invalidSession);
  expect(calls.some((call) => call[0] === "systemd-run")).toBe(false);
});

test("turning it off queues the stop without waiting, and says when nothing was running", async () => {
  const running = runner(true);
  expect(await setLiveForSession(id, false, { config: config(false), run: running.run })).toEqual({ sessionId: id, active: false, changed: true });
  expect(running.calls).toEqual([["systemctl", "--user", "stop", "--no-block", `recording-cli-live-${id}.service`]]);
  const idle = runner(false);
  expect(await setLiveForSession(id, false, { config: config(true), run: idle.run })).toEqual({ sessionId: id, active: false, changed: false });
  // The blocking form stays the default.
  const blocking = runner(true);
  await stopLiveUnit(id, { run: blocking.run });
  expect(blocking.calls).toEqual([["systemctl", "--user", "stop", `recording-cli-live-${id}.service`]]);
});
