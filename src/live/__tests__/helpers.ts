import { appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LiveProcessExit, LiveSpawn } from "../tap";

/** 16-bit PCM WAV like the tap writes, optionally with a LIST chunk or a streamed (unknown) data size. */
export const makeWav = (
  samples: Int16Array,
  options: { rate?: number; channels?: number; list?: boolean; dataSize?: number; extensible?: boolean; bits?: number } = {}
): Buffer => {
  const rate = options.rate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const fmtSize = options.extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtSize);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(fmtSize, 4);
  fmt.writeUInt16LE(options.extensible ? 0xfffe : 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  if (options.extensible) {
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(bits, 26);
    fmt.writeUInt32LE(channels === 1 ? 4 : 3, 28);
    fmt.writeUInt16LE(1, 32);
  }
  const list = options.list ? Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.from([13, 0, 0, 0]), Buffer.from("INFOISFT\u0001\u0000\u0000\u0000x", "latin1"), Buffer.from([0])]) : Buffer.alloc(0);
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "latin1");
  dataHeader.writeUInt32LE(options.dataSize ?? pcm.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), fmt, list, dataHeader, pcm]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
};

export const sine = (seconds: number, dbfs = -20, rate = 16_000): Int16Array => {
  const amplitude = 32_767 * 10 ** (dbfs / 20);
  const samples = new Int16Array(Math.round(seconds * rate));
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / rate));
  return samples;
};

export const silence = (seconds: number, rate = 16_000): Int16Array => new Int16Array(Math.round(seconds * rate));

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
};

export type FakeChunk = {
  kind: "speech" | "silent";
  /** Duration written to segments.csv (the WAV itself stays short to keep tests fast). */
  seconds: number;
  afterMs?: number;
  /** Raw text appended to segments.csv before this chunk's line. */
  garbageBefore?: string;
};

export type FakeTapCall = { command: string; args: string[]; dir: string; killed: string[] };

/** A tap that writes chunk WAVs and segments.csv lines over time, like ffmpeg's segment muxer. */
export const fakeTap = (plans: Array<{ chunks: FakeChunk[]; exitWhenDone?: boolean; spawnError?: "not-found" | "failed" }>) => {
  const calls: FakeTapCall[] = [];
  const spawn: LiveSpawn = (command, args) => {
    const plan = plans[Math.min(calls.length, plans.length - 1)];
    const listPath = args[args.indexOf("-segment_list") + 1];
    const dir = dirname(listPath);
    const call: FakeTapCall = { command, args, dir, killed: [] };
    calls.push(call);
    let resolveExit: (exit: LiveProcessExit) => void = () => undefined;
    const exited = new Promise<LiveProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    let stopped = false;
    if (plan.spawnError) {
      queueMicrotask(() => resolveExit({ code: null, signal: null, spawnError: plan.spawnError, stderr: "" }));
      return { kill: () => undefined, exited };
    }
    void (async () => {
      let start = 0;
      for (const [index, chunk] of plan.chunks.entries()) {
        await sleep(chunk.afterMs ?? 5);
        if (stopped) return;
        const file = `chunk-${String(index).padStart(5, "0")}.wav`;
        await writeFile(join(dir, file), makeWav(chunk.kind === "speech" ? sine(0.5) : silence(0.5)));
        await appendFile(listPath, `${chunk.garbageBefore ?? ""}${file},${start.toFixed(6)},${(start + chunk.seconds).toFixed(6)}\n`);
        start += chunk.seconds;
      }
      if (plan.exitWhenDone && !stopped) {
        stopped = true;
        resolveExit({ code: 1, signal: null, stderr: "device went away" });
      }
    })();
    return {
      pid: 4242,
      kill: (signal) => {
        call.killed.push(signal ?? "SIGTERM");
        if (!stopped) {
          stopped = true;
          resolveExit({ code: 255, signal: null, stderr: "" });
        }
      },
      exited
    };
  };
  return { spawn, calls };
};
