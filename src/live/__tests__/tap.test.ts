import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { LIVE_MESSAGES } from "../store";
import { buildLiveTapCommand, clearChunkDir, parseSegmentList, readSegmentList, resolveLiveSources, spawnLiveProcess, stopLiveProcess } from "../tap";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "live-tap-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildLiveTapCommand", () => {
  test("two sources are mixed into one 16 kHz mono WAV per chunk, listed in a CSV", () => {
    expect(buildLiveTapCommand({ microphone: "alsa_input.mic", desktop: "alsa_output.speakers.monitor", chunkSeconds: 15, dir: "/run/live/chunks" })).toEqual({
      command: "ffmpeg",
      args: [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "pulse", "-i", "alsa_input.mic",
        "-f", "pulse", "-i", "alsa_output.speakers.monitor",
        "-filter_complex", "amix=inputs=2:duration=longest:normalize=0",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-f", "segment", "-segment_time", "15",
        "-segment_list", "/run/live/chunks/segments.csv", "-segment_list_type", "csv",
        "-reset_timestamps", "1",
        "/run/live/chunks/chunk-%05d.wav"
      ]
    });
  });

  test("one source needs no mixing", () => {
    const { args } = buildLiveTapCommand({ desktop: "@DEFAULT_MONITOR@", chunkSeconds: 10, dir: "/tmp/c" });
    expect(args.slice(0, 7)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "pulse", "-i"]);
    expect(args[7]).toBe("@DEFAULT_MONITOR@");
    expect(args).not.toContain("-filter_complex");
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
  });

  test("refuses unsafe or impossible options", () => {
    const base = { microphone: "mic", chunkSeconds: 15, dir: "/tmp/c" };
    expect(() => buildLiveTapCommand({ ...base, dir: "relative/dir" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, dir: "/tmp/a/../b" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, dir: "/tmp/100%" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, dir: "/tmp/a\nb" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, microphone: "-filter_complex" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, microphone: "mic\u0000x" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, microphone: "" })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, desktop: "x".repeat(257) })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, chunkSeconds: 0 })).toThrow();
    expect(() => buildLiveTapCommand({ ...base, chunkSeconds: 1.5 })).toThrow();
    expect(() => buildLiveTapCommand({ chunkSeconds: 15, dir: "/tmp/c" })).toThrow(LIVE_MESSAGES.noAudioSource);
  });
});

describe("resolveLiveSources", () => {
  const capture = structuredClone(DEFAULT_CONFIG).capture;

  test("prefers the devices the recorder resolved", () => {
    expect(resolveLiveSources({ startedAt: "2026-10-25T10:00:00.000Z", audio: { microphone: "alsa_input.usb", desktop: "alsa_output.hdmi.monitor" } }, capture))
      .toEqual({ microphone: "alsa_input.usb", desktop: "alsa_output.hdmi.monitor" });
    expect(resolveLiveSources({ startedAt: "2026-10-25T10:00:00.000Z", audio: { desktop: "alsa_output.hdmi.monitor" } }, capture))
      .toEqual({ desktop: "alsa_output.hdmi.monitor" });
  });

  test("falls back to the capture settings when the session recorded no device (OBS)", () => {
    const obs = { startedAt: "2026-10-25T10:00:00.000Z", backend: "obs" as const };
    expect(resolveLiveSources({ ...obs, audio: {} }, capture)).toEqual({ microphone: "default", desktop: "@DEFAULT_MONITOR@" });
    expect(resolveLiveSources(obs, { ...capture, audioSource: "microphone", microphone: "alsa_input.headset" }))
      .toEqual({ microphone: "alsa_input.headset" });
    expect(resolveLiveSources(obs, { ...capture, audioSource: "desktop", desktop: "sink.monitor" })).toEqual({ desktop: "sink.monitor" });
    expect(resolveLiveSources(obs, { ...capture, audioSource: "none" })).toEqual({});
  });

  test("a non-OBS capture without a recorded device was started without audio: nothing is tapped", () => {
    expect(capture.audioSource).toBe("both");
    for (const backend of ["audio", "gpu-screen-recorder", undefined] as const) {
      expect(resolveLiveSources({ startedAt: "2026-10-25T10:00:00.000Z", audio: {}, backend }, capture)).toEqual({});
      expect(resolveLiveSources({ startedAt: "2026-10-25T10:00:00.000Z", backend }, capture)).toEqual({});
    }
  });

  test("ignores recorded device names that could be read as options", () => {
    expect(resolveLiveSources({ startedAt: "2026-10-25T10:00:00.000Z", audio: { microphone: "-i", desktop: "ok.monitor" } }, capture)).toEqual({ desktop: "ok.monitor" });
  });
});

describe("parseSegmentList", () => {
  test("reads complete lines and ignores the one still being written", () => {
    const parsed = parseSegmentList("chunk-00000.wav,0.000000,15.000000\nchunk-00001.wav,15.000000,30.021000\nchunk-00002.wav,30.0");
    expect(parsed).toEqual({
      entries: [
        { file: "chunk-00000.wav", index: 0, start: 0, end: 15 },
        { file: "chunk-00001.wav", index: 1, start: 15, end: 30.021 }
      ],
      malformed: 0
    });
  });

  test("accepts CRLF and sorts by segment index", () => {
    expect(parseSegmentList("chunk-00001.wav,15,30\r\nchunk-00000.wav,0,15\r\n").entries.map((entry) => entry.index)).toEqual([0, 1]);
  });

  test("counts and skips malformed lines", () => {
    const text = [
      "chunk-00000.wav,0.000000,15.000000",
      "../escape.wav,0,15",
      "/abs/chunk-00001.wav,0,15",
      "\"chunk-00002.wav\",0,15",
      "chunk-00003.wav,-1,15",
      "chunk-00004.wav,20,10",
      "chunk-00005.wav,0,15,extra",
      "chunk-00006.wav,NaN,15",
      "chunk-00007.wav,1e3,2e3",
      "chunk-00000.wav,0,15",
      "chunk-0008.wav,0,15",
      "chunk-00009.mp3,0,15",
      "chunk-00010.wav,0,99999999",
      "garbage",
      "",
      "chunk-00011.wav,30,45",
      ""
    ].join("\n");
    const parsed = parseSegmentList(text);
    expect(parsed.entries.map((entry) => entry.file)).toEqual(["chunk-00000.wav", "chunk-00011.wav"]);
    expect(parsed.malformed).toBe(13);
  });

  test("readSegmentList: missing list is empty, a symlinked list is refused", async () => {
    expect(await readSegmentList(dir)).toEqual({ entries: [], malformed: 0 });
    await writeFile(join(dir, "elsewhere.csv"), "chunk-00000.wav,0,15\n");
    await symlink(join(dir, "elsewhere.csv"), join(dir, "segments.csv"));
    await expect(readSegmentList(dir)).rejects.toThrow(LIVE_MESSAGES.unsafeDirectory);
  });
});

test("clearChunkDir removes only what the tap writes and never follows links", async () => {
  const outside = await mkdtemp(join(tmpdir(), "live-outside-"));
  try {
    await writeFile(join(outside, "precious.wav"), "keep");
    await writeFile(join(dir, "chunk-00000.wav"), "a");
    await writeFile(join(dir, "chunk-00001.wav"), "b");
    await writeFile(join(dir, "segments.csv"), "x");
    await writeFile(join(dir, "notes.txt"), "keep");
    await symlink(join(outside, "precious.wav"), join(dir, "chunk-00002.wav"));
    await clearChunkDir(dir);
    expect((await readdir(dir)).sort()).toEqual(["notes.txt"]);
    expect(await readFile(join(outside, "precious.wav"), "utf8")).toBe("keep");
    await clearChunkDir(join(dir, "missing"));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

describe("spawnLiveProcess / stopLiveProcess", () => {
  test("reports the exit code and the stderr tail", async () => {
    const child = spawnLiveProcess("/bin/sh", ["-c", "echo device-error >&2; exit 3"]);
    const exit = await child.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain("device-error");
    expect(exit.spawnError).toBeUndefined();
  });

  test("a missing binary is reported as not found, not thrown", async () => {
    const exit = await spawnLiveProcess(join(dir, "no-such-ffmpeg"), []).exited;
    expect(exit.spawnError).toBe("not-found");
  });

  test("stops with SIGTERM, then SIGKILL when the process ignores it", async () => {
    const polite = spawnLiveProcess("/bin/sh", ["-c", "exec sleep 30"]);
    const politeExit = await stopLiveProcess(polite, 2_000);
    expect(politeExit?.signal).toBe("SIGTERM");

    const stubborn = spawnLiveProcess("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"]);
    await Bun.sleep(50);
    const stubbornExit = await stopLiveProcess(stubborn, 100);
    expect(stubbornExit?.signal).toBe("SIGKILL");
  });
});
