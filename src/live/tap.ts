import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config/defaults";
import type { RecordingSession } from "../recording/session";
import { LIVE_MESSAGES, LiveError, readOwnedFile } from "./store";

/**
 * The audio tap: a separate ffmpeg that reads the same PulseAudio/PipeWire sources as the recorder
 * and cuts them into 16 kHz mono WAV chunks, listing each finished chunk in segments.csv. It is never
 * a second output of the recorder, so a slow or crashed tap cannot stall or break the recording.
 */

export type LiveTapOptions = {
  microphone?: string;
  desktop?: string;
  chunkSeconds: number;
  dir: string;
};

export type LiveTapCommand = { command: "ffmpeg"; args: string[] };

export const LIVE_SEGMENT_LIST = "segments.csv";
export const LIVE_CHUNK_PATTERN = /^chunk-(\d{5,9})\.wav$/;
const SEGMENT_LIST_MAX_BYTES = 2 * 1024 * 1024;
const SEGMENT_LIST_MAX_ENTRIES = 50_000;
const MAX_TIMELINE_SECONDS = 7 * 24 * 3600;

const validDevice = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("-") &&
  !/\p{Cc}/u.test(value);

/** ffmpeg argv for the tap. `dir` must be an absolute, normalized path without `%` (the segment pattern). */
export const buildLiveTapCommand = (options: LiveTapOptions): LiveTapCommand => {
  const { microphone, desktop, chunkSeconds, dir } = options;
  if (!Number.isSafeInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 600) {
    throw new Error("Live tap chunkSeconds must be an integer between 1 and 600");
  }
  if (typeof dir !== "string" || !dir.startsWith("/") || resolve(dir) !== dir || /[%\p{Cc}]/u.test(dir)) {
    throw new Error("Live tap directory must be an absolute path without % or control characters");
  }
  if (microphone !== undefined && !validDevice(microphone)) throw new Error("Invalid live tap microphone source");
  if (desktop !== undefined && !validDevice(desktop)) throw new Error("Invalid live tap desktop source");
  const devices = [microphone, desktop].filter((device): device is string => device !== undefined);
  if (devices.length === 0) throw new LiveError(LIVE_MESSAGES.noAudioSource);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", ...devices.flatMap((device) => ["-f", "pulse", "-i", device])];
  if (devices.length === 2) args.push("-filter_complex", "amix=inputs=2:duration=longest:normalize=0");
  args.push(
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-f", "segment", "-segment_time", String(chunkSeconds),
    "-segment_list", join(dir, LIVE_SEGMENT_LIST), "-segment_list_type", "csv",
    "-reset_timestamps", "1",
    join(dir, "chunk-%05d.wav")
  );
  return { command: "ffmpeg", args };
};

/** The subset of a recording session the live worker needs. `RecordingSession` satisfies it. */
export type LiveSessionInput = {
  startedAt: string;
  /** When the first media byte was written (Stage C adds it to the session); falls back to startedAt. */
  mediaStartedAt?: string;
  audio?: { microphone?: string; desktop?: string };
  /** The capture backend; only "obs" may fall back to the capture settings for its sources. */
  backend?: RecordingSession["backend"];
};

/**
 * Sources to tap: the exact devices the recorder resolved, else (OBS sessions, which record no device
 * names) the capture settings, where "default" means the default input or the default output's monitor.
 * Any other capture without a recorded device was started without audio: nothing is tapped, so the live
 * text never captures (or sends to a provider) a source the user left out of this recording.
 */
export const resolveLiveSources = (
  session: LiveSessionInput,
  capture: AppConfig["capture"]
): { microphone?: string; desktop?: string } => {
  const recorded = {
    ...(validDevice(session.audio?.microphone) ? { microphone: session.audio?.microphone } : {}),
    ...(validDevice(session.audio?.desktop) ? { desktop: session.audio?.desktop } : {})
  };
  if (recorded.microphone || recorded.desktop) return recorded;
  if (session.backend !== "obs") return {};
  const wantsMicrophone = capture.audioSource === "both" || capture.audioSource === "microphone";
  const wantsDesktop = capture.audioSource === "both" || capture.audioSource === "desktop";
  const microphone = capture.microphone === "default" || !capture.microphone ? "default" : capture.microphone;
  const desktop = capture.desktop === "default" || !capture.desktop ? "@DEFAULT_MONITOR@" : capture.desktop;
  return {
    ...(wantsMicrophone && validDevice(microphone) ? { microphone } : {}),
    ...(wantsDesktop && validDevice(desktop) ? { desktop } : {})
  };
};

export type SegmentListEntry = {
  file: string;
  /** The number in the chunk name: ffmpeg's segment index. */
  index: number;
  /** Seconds on the tap's own timeline. */
  start: number;
  end: number;
};

const SEGMENT_LINE = /^(chunk-(\d{5,9})\.wav),(\d{1,9}(?:\.\d{1,9})?),(\d{1,9}(?:\.\d{1,9})?)$/;

/**
 * Parse ffmpeg's CSV segment list (`file,start,end`). A trailing line without a newline is still being
 * written and is ignored; anything unexpected is counted as malformed and skipped.
 */
export const parseSegmentList = (text: string): { entries: SegmentListEntry[]; malformed: number } => {
  const lines = text.split("\n");
  lines.pop();
  const entries: SegmentListEntry[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    const match = SEGMENT_LINE.exec(line);
    const start = match ? Number(match[3]) : Number.NaN;
    const end = match ? Number(match[4]) : Number.NaN;
    if (
      !match || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end > MAX_TIMELINE_SECONDS ||
      seen.has(match[1]) || entries.length >= SEGMENT_LIST_MAX_ENTRIES
    ) {
      malformed += 1;
      continue;
    }
    seen.add(match[1]);
    entries.push({ file: match[1], index: Number(match[2]), start, end });
  }
  entries.sort((left, right) => left.index - right.index);
  return { entries, malformed };
};

export const readSegmentList = async (dir: string): Promise<{ entries: SegmentListEntry[]; malformed: number }> => {
  const read = await readOwnedFile(join(dir, LIVE_SEGMENT_LIST), SEGMENT_LIST_MAX_BYTES);
  return read ? parseSegmentList(read.data.toString("utf8")) : { entries: [], malformed: 0 };
};

/** Remove leftover chunks and the segment list (only names the tap writes; symlinks are unlinked, never followed). */
export const clearChunkDir = async (dir: string): Promise<void> => {
  const names = await fs.readdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names.slice(0, 100_000)) {
    if (name !== LIVE_SEGMENT_LIST && !LIVE_CHUNK_PATTERN.test(name)) continue;
    await fs.unlink(join(dir, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
};

export type LiveProcessExit = {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started at all. */
  spawnError?: "not-found" | "failed";
  /** Last few kilobytes of stderr, for logs only. */
  stderr: string;
};

export type LiveProcess = {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<LiveProcessExit>;
};

export type LiveSpawn = (command: string, args: string[]) => LiveProcess;

/** Spawn without a shell, stdin closed, stderr tail kept for the journal. */
export const spawnLiveProcess: LiveSpawn = (command, args) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
  });
  const exited = new Promise<LiveProcessExit>((resolveExit) => {
    let settled = false;
    const finish = (exit: LiveProcessExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, signal: null, spawnError: error.code === "ENOENT" ? "not-found" : "failed", stderr }));
    child.once("close", (code, signal) => finish({ code, signal, stderr }));
  });
  return {
    pid: child.pid,
    kill: (signal = "SIGTERM") => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
    exited
  };
};

/** SIGTERM (ffmpeg closes the current chunk), then SIGKILL after `graceMs`. */
export const stopLiveProcess = async (child: LiveProcess, graceMs = 3_000): Promise<LiveProcessExit | undefined> => {
  const timeout = <T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<T>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(value), ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  };
  child.kill("SIGTERM");
  const first = timeout(graceMs, undefined);
  const exit = await Promise.race([child.exited, first.promise]);
  first.cancel();
  if (exit) return exit;
  child.kill("SIGKILL");
  const second = timeout(2_000, undefined);
  const killed = await Promise.race([child.exited, second.promise]);
  second.cancel();
  return killed;
};
