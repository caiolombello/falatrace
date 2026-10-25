import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import type { runCommandDirect } from "../../jobs/command";
import { LIVE_MESSAGES, LiveError, type LiveLine, LiveStore, readLiveTranscript } from "../store";
import type { LiveSessionInput } from "../tap";
import type { LiveChunkInput, LiveSegment } from "../transcribe";
import { LiveTranscribeError } from "../transcribe";
import { type LiveWorkerDeps, type LiveWorkerResult, runLiveWorker } from "../worker";
import { type FakeChunk, fakeTap, sleep, waitFor } from "./helpers";

let root: string;
let store: LiveStore;
let config: AppConfig;
let sessionId: string;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
const MEDIA_START = Date.parse("2026-10-25T10:00:00.000Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "live-worker-"));
  store = new LiveStore(join(root, "live"));
  config = structuredClone(DEFAULT_CONFIG);
  config.live.enabled = true;
  sessionId = randomUUID();
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const session = (overrides: Partial<LiveSessionInput> = {}): LiveSessionInput => ({
  startedAt: "2026-10-25T09:59:58.000Z",
  mediaStartedAt: "2026-10-25T10:00:00.000Z",
  audio: { microphone: "alsa_input.mic", desktop: "alsa_output.speakers.monitor" },
  ...overrides
});

const speech = (seconds = 15, afterMs = 5): FakeChunk => ({ kind: "speech", seconds, afterMs });
const quiet = (seconds = 15, afterMs = 5): FakeChunk => ({ kind: "silent", seconds, afterMs });

/** Echo transcriber: one segment per chunk naming the chunk, 1 s to 4 s into it. */
const echo = (calls: LiveChunkInput[] = []) => async (input: LiveChunkInput): Promise<LiveSegment[]> => {
  calls.push(input);
  return [{ start: 1, end: 4, text: `fala ${input.wavPath.slice(-9, -4)}` }];
};

const start = (deps: LiveWorkerDeps, overrides: { session?: LiveSessionInput; signal?: AbortSignal } = {}) => {
  const controller = new AbortController();
  const logs: Array<Record<string, unknown>> = [];
  const promise = runLiveWorker({
    config,
    sessionId,
    session: overrides.session ?? session(),
    signal: overrides.signal ?? controller.signal,
    deps: {
      store,
      pollMs: 5,
      stopGraceMs: 50,
      tapRestartDelayMs: 5,
      fileExists: async () => true,
      log: (event) => logs.push(event),
      // A fixed clock unless a test drives it: results never depend on the wall clock.
      now: () => MEDIA_START + 5_000,
      ...deps
    }
  });
  return { controller, promise, logs };
};

const lines = async (): Promise<LiveLine[]> => (await store.read(sessionId, 0, 2_000)).lines;

const chunkFiles = async (): Promise<string[]> =>
  readdir(store.chunkDir(sessionId)).then((names) => names.filter((name) => name.endsWith(".wav")), () => []);

describe("happy path", () => {
  test("transcribes finished chunks, skips silent ones, offsets by chunk start and tap start, deletes WAVs", async () => {
    const tap = fakeTap([{ chunks: [speech(), quiet(), speech(15, 20)] }]);
    const calls: LiveChunkInput[] = [];
    // Tap starts 2.5 s after the first media byte.
    const { controller, promise, logs } = start({ spawn: tap.spawn, transcribe: echo(calls), now: () => MEDIA_START + 2_500 });
    await waitFor(async () => (await lines()).length === 2);
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksSkipped === 1);
    controller.abort();
    const result = await promise;

    expect(result).toEqual({ state: "stopped", lastSeq: 2, chunksDone: 2, chunksSkipped: 1, chunksDropped: 0, rtf: 0 });
    expect(await lines()).toEqual([
      { seq: 1, start: 3.5, end: 6.5, text: "fala 00000", provider: "whisper-cpp" },
      { seq: 2, start: 33.5, end: 36.5, text: "fala 00002", provider: "whisper-cpp" }
    ]);
    expect(calls.map((call) => call.durationSeconds)).toEqual([15, 15]);
    expect(calls[1].previousText).toBe("fala 00000");
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);

    expect(tap.calls).toHaveLength(1);
    expect(tap.calls[0].command).toBe("ffmpeg");
    expect(tap.calls[0].args).toContain("amix=inputs=2:duration=longest:normalize=0");
    expect(tap.calls[0].args[tap.calls[0].args.indexOf("-segment_time") + 1]).toBe("15");
    expect(tap.calls[0].dir).toBe(store.chunkDir(sessionId));
    expect(tap.calls[0].killed).toEqual(["SIGTERM"]);

    const status = await store.readStatus(sessionId);
    expect(status).toMatchObject({ state: "stopped", lastSeq: 2, provider: "whisper-cpp", chunkSeconds: 15, chunksDone: 2, chunksSkipped: 1, backlog: 0 });
    expect(status?.error).toBeUndefined();
    expect(await stat(store.chunkDir(sessionId)).then(() => true, () => false)).toBe(false);
    expect(logs.some((event) => event.event === "tap-started" && event.offset === 2.5)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("fala 0000");
  });

  test("falls back to startedAt when the session has no mediaStartedAt; a tap before media clamps at zero", async () => {
    const tap = fakeTap([{ chunks: [speech()] }]);
    const { controller, promise } = start(
      { spawn: tap.spawn, transcribe: async () => [{ start: 0, end: 0.5, text: "cedo" }, { start: 2, end: 3, text: "depois" }], now: () => MEDIA_START - 1_000 },
      { session: session({ mediaStartedAt: undefined, startedAt: "2026-10-25T10:00:00.000Z" }) }
    );
    await waitFor(async () => (await lines()).length === 2);
    controller.abort();
    await promise;
    expect((await lines()).map((line) => [line.start, line.end])).toEqual([[0, 0], [1, 2]]);
  });

  test("whisper-cpp end to end: whisper-cli through the injected runner, never heavy admission", async () => {
    const tap = fakeTap([{ chunks: [speech(10)] }]);
    const commands: string[] = [];
    const run = (async (command: string, args: string[]) => {
      commands.push(command);
      await writeFile(`${args[args.indexOf("-of") + 1]}.json`, JSON.stringify({ transcription: [{ offsets: { from: 500, to: 1500 }, text: " Olá, pessoal." }] }));
      return { stdout: "", stderr: "" };
    }) as typeof runCommandDirect;
    const { controller, promise } = start({ spawn: tap.spawn, transcribeDeps: { run }, now: () => MEDIA_START });
    await waitFor(async () => (await lines()).length === 1);
    controller.abort();
    await promise;
    expect(await lines()).toEqual([{ seq: 1, start: 0.5, end: 1.5, text: "Olá, pessoal.", provider: "whisper-cpp" }]);
    expect(commands).toEqual(["whisper-cli"]);
  });

  test("groq: chunks of at least 10 s, key from secrets, fake server", async () => {
    config.live.provider = "groq";
    config.live.chunkSeconds = 5;
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        received.push(request.headers.get("authorization") ?? "");
        await request.formData();
        return Response.json({ segments: [{ start: 1, end: 2, text: " Oi." }] });
      }
    });
    servers.push(server);
    const tap = fakeTap([{ chunks: [speech(10)] }]);
    const { controller, promise } = start({
      spawn: tap.spawn,
      transcribeDeps: { endpoints: { groq: `http://127.0.0.1:${server.port}/openai/v1` } },
      readSecret: async (name) => (name === "GROQ_API_KEY" ? "gsk_live" : undefined),
      now: () => MEDIA_START
    });
    await waitFor(async () => (await lines()).length === 1);
    controller.abort();
    await promise;
    expect(tap.calls[0].args[tap.calls[0].args.indexOf("-segment_time") + 1]).toBe("10");
    expect(received).toEqual(["Bearer gsk_live"]);
    expect((await lines())[0]).toEqual({ seq: 1, start: 1, end: 2, text: "Oi.", provider: "groq" });
    expect((await store.readStatus(sessionId))?.chunkSeconds).toBe(10);
  });

  test("openai via fake server", async () => {
    config.live.provider = "openai";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ text: "Texto do trecho." }) });
    servers.push(server);
    const tap = fakeTap([{ chunks: [speech(15)] }]);
    const { controller, promise } = start({
      spawn: tap.spawn,
      transcribeDeps: { endpoints: { openai: `http://127.0.0.1:${server.port}/v1` } },
      readSecret: async (name) => (name === "OPENAI_API_KEY" ? "sk-live" : undefined),
      now: () => MEDIA_START + 1_000
    });
    await waitFor(async () => (await lines()).length === 1);
    controller.abort();
    await promise;
    expect((await lines())[0]).toEqual({ seq: 1, start: 1, end: 16, text: "Texto do trecho.", provider: "openai" });
  });

  test("continues the seq of an earlier run and clears its leftover chunks", async () => {
    await store.prepare(sessionId);
    await store.append(sessionId, [{ seq: 5, start: 1, end: 2, text: "antes", provider: "whisper-cpp" }]);
    await writeFile(join(store.chunkDir(sessionId), "chunk-00042.wav"), "stale");
    await writeFile(join(store.chunkDir(sessionId), "segments.csv"), "chunk-00042.wav,0,15\n");
    const tap = fakeTap([{ chunks: [speech(15, 30)] }]);
    const calls: LiveChunkInput[] = [];
    const { controller, promise } = start({ spawn: tap.spawn, transcribe: echo(calls), now: () => MEDIA_START });
    await waitFor(async () => (await lines()).length === 2);
    controller.abort();
    await promise;
    expect((await lines()).map((line) => line.seq)).toEqual([5, 6]);
    expect(calls.map((call) => call.wavPath.slice(-15))).toEqual(["chunk-00000.wav"]);
  });

  test("readLiveTranscript pages what the worker wrote", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech(), speech(), speech()] }]);
    const { controller, promise } = start({ spawn: tap.spawn, transcribe: echo(), now: () => MEDIA_START });
    await waitFor(async () => (await lines()).length === 4);
    const first = await readLiveTranscript(sessionId, 0, { store, limit: 3, now: MEDIA_START });
    expect(first.lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);
    expect(first.status?.state).toBe("running");
    const rest = await readLiveTranscript(sessionId, 3, { store, limit: 3, now: MEDIA_START });
    expect(rest.lines.map((line) => line.seq)).toEqual([4]);
    controller.abort();
    await promise;
    expect((await readLiveTranscript(sessionId, 4, { store })).status?.state).toBe("stopped");
  });
});

describe("CSV robustness", () => {
  test("malformed segment list lines are ignored; valid ones still processed", async () => {
    const tap = fakeTap([{
      chunks: [
        { kind: "speech", seconds: 15, afterMs: 5, garbageBefore: "garbage line\n../../etc/passwd,0,15\nchunk-00099.wav,9,1\n" },
        { kind: "speech", seconds: 15, afterMs: 5, garbageBefore: "\"quoted\",0,1\n" }
      ]
    }]);
    const { controller, promise } = start({ spawn: tap.spawn, transcribe: echo(), now: () => MEDIA_START });
    await waitFor(async () => (await lines()).length === 2);
    controller.abort();
    await promise;
    expect((await lines()).map((line) => line.text)).toEqual(["fala 00000", "fala 00001"]);
  });

  test("an unreadable chunk is skipped, a zero-length chunk is skipped", async () => {
    const tap = fakeTap([{ chunks: [{ kind: "speech", seconds: 0, afterMs: 5 }, speech()] }]);
    let measured = 0;
    const { controller, promise } = start({
      spawn: tap.spawn,
      transcribe: echo(),
      now: () => MEDIA_START,
      measureLevel: async () => {
        measured += 1;
        throw new Error("corrupt");
      }
    });
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksSkipped === 2);
    controller.abort();
    const result = await promise;
    expect(measured).toBe(1);
    expect(result.chunksDone).toBe(0);
    expect(await lines()).toEqual([]);
  });
});

describe("real-time factor", () => {
  test("a transcriber slower than real time marks the worker behind; a fast one keeps it running", async () => {
    let clock = MEDIA_START;
    const tap = fakeTap([{ chunks: [speech(10), speech(10, 40)] }]);
    const { controller, promise } = start({
      spawn: tap.spawn,
      now: () => clock,
      transcribe: async (input) => {
        clock += input.durationSeconds * 1_500;
        return [{ start: 0, end: 1, text: "lento" }];
      }
    });
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksDone === 2);
    const status = await store.readStatus(sessionId);
    expect(status?.state).toBe("behind");
    expect(status?.rtf).toBe(1.5);
    controller.abort();
    const result = await promise;
    expect(result.rtf).toBe(1.5);

    sessionId = randomUUID();
    clock = MEDIA_START;
    const fastTap = fakeTap([{ chunks: [speech(10)] }]);
    const fast = start({
      spawn: fastTap.spawn,
      now: () => clock,
      transcribe: async (input) => {
        clock += input.durationSeconds * 300;
        return [{ start: 0, end: 1, text: "rápido" }];
      }
    });
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksDone === 1);
    expect(await store.readStatus(sessionId)).toMatchObject({ state: "running", rtf: 0.3 });
    fast.controller.abort();
    await fast.promise;
  });

  test("a growing backlog drops the oldest chunks to stay close to real time", async () => {
    // The first chunk arrives alone; the other seven pile up while it is being transcribed.
    const tap = fakeTap([{ chunks: [speech(15, 5), speech(15, 80), ...Array.from({ length: 6 }, () => speech(15, 1))] }]);
    const transcribed: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, promise } = start({
      spawn: tap.spawn,
      maxBacklogChunks: 2,
      now: () => MEDIA_START,
      transcribe: async (input) => {
        transcribed.push(input.wavPath.slice(-15));
        if (transcribed.length === 1) await gate;
        return [{ start: 0, end: 1, text: "ok" }];
      }
    });
    await waitFor(() => transcribed.length === 1);
    // Let every other chunk land while the first one is stuck.
    await waitFor(async () => (await readdir(store.chunkDir(sessionId))).filter((name) => name.endsWith(".wav")).length >= 7);
    await sleep(20);
    release();
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksDone === 3);
    controller.abort();
    const result = await promise;
    expect(result.chunksDropped).toBe(5);
    expect(transcribed).toEqual(["chunk-00000.wav", "chunk-00006.wav", "chunk-00007.wav"]);
  });
});

describe("stopping", () => {
  test("abort mid-chunk: tap killed at once, the chunk may not outlive the grace period", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech(15, 500)] }]);
    let sawAbort = false;
    let transcribing = false;
    const { controller, promise } = start({
      spawn: tap.spawn,
      now: () => MEDIA_START,
      stopGraceMs: 30,
      transcribe: (input) =>
        new Promise((_resolve, reject) => {
          transcribing = true;
          input.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new LiveTranscribeError("aborted", LIVE_MESSAGES.chunkFailed));
          });
        })
    });
    await waitFor(() => transcribing);
    controller.abort();
    await waitFor(() => tap.calls[0].killed.length === 1, 500);
    const result = await promise;
    expect(sawAbort).toBe(true);
    expect(result.state).toBe("stopped");
    expect(await lines()).toEqual([]);
    expect((await store.readStatus(sessionId))?.state).toBe("stopped");
    expect(await chunkFiles()).toEqual([]);
  });

  test("abort mid-chunk: a chunk that finishes within the grace period is kept, nothing new starts", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech(15, 1)] }]);
    const started: string[] = [];
    const { controller, promise } = start({
      spawn: tap.spawn,
      now: () => MEDIA_START,
      stopGraceMs: 1_000,
      transcribe: async (input) => {
        started.push(input.wavPath.slice(-15));
        await sleep(80);
        return [{ start: 0, end: 1, text: "terminou" }];
      }
    });
    await waitFor(() => started.length === 1);
    controller.abort();
    const result = await promise;
    expect(result).toMatchObject({ state: "stopped", chunksDone: 1, lastSeq: 1 });
    expect(started).toEqual(["chunk-00000.wav"]);
    expect((await lines()).map((line) => line.text)).toEqual(["terminou"]);
  });

  test("stops when the recording ends", async () => {
    const tap = fakeTap([{ chunks: [speech()] }]);
    let active = true;
    const { promise, logs } = start({ spawn: tap.spawn, transcribe: echo(), continueCheckMs: 0, shouldContinue: async () => active });
    await waitFor(async () => (await lines()).length === 1);
    active = false;
    const result = await promise;
    expect(result.state).toBe("stopped");
    expect(tap.calls[0].killed).toEqual(["SIGTERM"]);
    expect(logs.some((event) => event.event === "recording-ended")).toBe(true);
  });

  test("stops when the recording ends even while new chunks keep it busy", async () => {
    // Chunks arrive faster than they are transcribed, so the worker never finds itself idle.
    const tap = fakeTap([{ chunks: Array.from({ length: 300 }, () => speech(15, 5)) }]);
    let active = true;
    let transcribed = 0;
    const { promise, logs } = start({
      spawn: tap.spawn,
      continueCheckMs: 0,
      shouldContinue: async () => active,
      transcribe: async () => {
        transcribed += 1;
        await sleep(15);
        // The recording ends while the second chunk is transcribed; more chunks are already waiting.
        if (transcribed === 2) active = false;
        return [{ start: 0, end: 1, text: "ocupado" }];
      }
    });
    const result = await promise;
    expect(result.state).toBe("stopped");
    expect(transcribed).toBe(2);
    expect(result.chunksDone).toBe(2);
    expect(logs.some((event) => event.event === "recording-ended")).toBe(true);
    expect(tap.calls[0].killed).toEqual(["SIGTERM"]);
  });

  test("status.json keeps its heartbeat during a slow chunk, and the final state is written last", async () => {
    const tap = fakeTap([{ chunks: [speech()] }]);
    const states: string[] = [];
    const write = store.writeStatus.bind(store);
    store.writeStatus = async (target, value) => {
      states.push(value.state);
      // Slow disk for everything but the final state: an unordered heartbeat would land after it.
      if (value.state !== "stopped") await sleep(20);
      return write(target, value);
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transcribing = false;
    const { controller, promise } = start({
      spawn: tap.spawn,
      heartbeatMs: 10,
      transcribe: async () => {
        transcribing = true;
        await gate;
        return [{ start: 0, end: 1, text: "devagar" }];
      }
    });
    await waitFor(() => transcribing);
    const before = states.length;
    await waitFor(() => states.length >= before + 3);
    expect(states.slice(before).every((state) => state === "running")).toBe(true);
    release();
    await waitFor(async () => (await lines()).length === 1);
    controller.abort();
    expect((await promise).state).toBe("stopped");
    expect(states[states.length - 1]).toBe("stopped");
    expect((await store.readStatus(sessionId))?.state).toBe("stopped");
  });

  test("an absurdly slow chunk is reported at the highest rtf status.json accepts", async () => {
    let clock = MEDIA_START;
    const tap = fakeTap([{ chunks: [speech(0.5)] }]);
    const { controller, promise } = start({
      spawn: tap.spawn,
      now: () => clock,
      measureLevel: async () => ({ peakDb: -10, rmsDb: -20, activeSeconds: 0.5, durationSeconds: 0.5 }),
      transcribe: async () => {
        clock += 3_600_000;
        return [{ start: 0, end: 0.4, text: "lento demais" }];
      }
    });
    await waitFor(async () => (await store.readStatus(sessionId))?.chunksDone === 1);
    expect(await store.readStatus(sessionId)).toMatchObject({ state: "behind", rtf: 1_000 });
    controller.abort();
    expect((await promise).rtf).toBe(1_000);
  });

  test("an already aborted signal stops before starting the tap", async () => {
    const controller = new AbortController();
    controller.abort();
    const tap = fakeTap([{ chunks: [speech()] }]);
    const { promise } = start({ spawn: tap.spawn, transcribe: echo() }, { signal: controller.signal });
    expect((await promise).state).toBe("stopped");
    expect(tap.calls).toHaveLength(0);
  });
});

describe("failures", () => {
  const expectFailed = async (result: LiveWorkerResult, message: string): Promise<void> => {
    expect(result.state).toBe("failed");
    expect(result.error).toBe(message);
    const status = await store.readStatus(sessionId);
    expect(status).toMatchObject({ state: "failed", error: message });
  };

  test("a refused key stops the worker and the tap", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech()] }]);
    const { promise } = start({
      spawn: tap.spawn,
      transcribe: async () => {
        throw new LiveTranscribeError("auth", LIVE_MESSAGES.providerAuth);
      }
    });
    await expectFailed(await promise, LIVE_MESSAGES.providerAuth);
    expect(tap.calls[0].killed).toEqual(["SIGTERM"]);
    expect(await chunkFiles()).toEqual([]);
  });

  test("a single transient failure is reported and cleared by the next success", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech(15, 150)] }]);
    let count = 0;
    const { controller, promise } = start({
      spawn: tap.spawn,
      transcribe: async () => {
        count += 1;
        if (count === 1) throw new LiveTranscribeError("rate", LIVE_MESSAGES.providerRateLimited);
        return [{ start: 0, end: 1, text: "voltou" }];
      }
    });
    await waitFor(async () => (await store.readStatus(sessionId))?.error === LIVE_MESSAGES.providerRateLimited);
    await waitFor(async () => (await lines()).length === 1);
    expect((await store.readStatus(sessionId))?.error).toBeUndefined();
    controller.abort();
    expect((await promise).state).toBe("stopped");
  });

  test("too many failures in a row stop the worker", async () => {
    const tap = fakeTap([{ chunks: [speech(), speech(), speech()] }]);
    const { promise } = start({
      spawn: tap.spawn,
      maxConsecutiveFailures: 2,
      transcribe: async () => {
        throw new Error("boom");
      }
    });
    await expectFailed(await promise, LIVE_MESSAGES.tooManyFailures);
  });

  test("a tap that dies is restarted with a fresh offset, then given up on", async () => {
    let clock = MEDIA_START;
    const tap = fakeTap([
      { chunks: [speech()], exitWhenDone: true },
      { chunks: [speech()], exitWhenDone: true }
    ]);
    const { promise, logs } = start({
      spawn: tap.spawn,
      maxTapRestarts: 1,
      now: () => clock,
      transcribe: async (input) => {
        clock += 1_000;
        return echo()(input);
      }
    });
    const result = await promise;
    await expectFailed(result, LIVE_MESSAGES.tapStopped);
    expect(tap.calls).toHaveLength(2);
    // Second tap started 1 s later (the first chunk's processing), so its lines shift by 1 s.
    expect((await lines()).map((line) => line.start)).toEqual([1, 2]);
    expect(logs.filter((event) => event.event === "tap-exited")).toHaveLength(2);
  });

  test("a tap that ran for a while before dying does not use up the restart limit", async () => {
    let clock = MEDIA_START;
    const dying = { chunks: [speech()], exitWhenDone: true };
    const tap = fakeTap([dying, dying, dying, { chunks: [speech()] }]);
    const { controller, promise } = start({
      spawn: tap.spawn,
      maxTapRestarts: 1,
      now: () => clock,
      transcribe: async (input) => {
        clock += 61_000;
        return echo()(input);
      }
    });
    await waitFor(async () => (await lines()).length === 4);
    controller.abort();
    expect((await promise).state).toBe("stopped");
    expect(tap.calls).toHaveLength(4);
  });

  test("missing ffmpeg is reported as such", async () => {
    const tap = fakeTap([{ chunks: [], spawnError: "not-found" }]);
    await expectFailed(await start({ spawn: tap.spawn, transcribe: echo() }).promise, LIVE_MESSAGES.ffmpegMissing);
  });

  test("preflight: no audio source, missing whisper model, missing API keys", async () => {
    // A screen capture started without audio: the configured microphone must not be tapped instead.
    const silentCapture = fakeTap([{ chunks: [speech()] }]);
    await expectFailed(
      await start({ spawn: silentCapture.spawn, transcribe: echo() }, { session: session({ audio: {}, backend: "gpu-screen-recorder" }) }).promise,
      LIVE_MESSAGES.noAudioSource
    );
    expect(silentCapture.calls).toHaveLength(0);

    sessionId = randomUUID();
    config.capture.audioSource = "none";
    await expectFailed(await start({ spawn: fakeTap([{ chunks: [] }]).spawn }, { session: session({ audio: {}, backend: "obs" }) }).promise, LIVE_MESSAGES.noAudioSource);

    config = structuredClone(DEFAULT_CONFIG);
    config.live.enabled = true;
    sessionId = randomUUID();
    await expectFailed(await start({ spawn: fakeTap([{ chunks: [] }]).spawn, fileExists: async () => false }).promise, LIVE_MESSAGES.whisperModelMissing);

    config.live.provider = "openai";
    sessionId = randomUUID();
    await expectFailed(await start({ spawn: fakeTap([{ chunks: [] }]).spawn, readSecret: async () => undefined }).promise, LIVE_MESSAGES.openaiKeyMissing);

    config.live.provider = "groq";
    sessionId = randomUUID();
    const tap = fakeTap([{ chunks: [] }]);
    await expectFailed(await start({ spawn: tap.spawn, readSecret: async () => undefined }).promise, LIVE_MESSAGES.groqKeyMissing);
    expect(tap.calls).toHaveLength(0);
  });

  test("the transcript size limit stops the worker", async () => {
    class FullStore extends LiveStore {
      override async append(): Promise<void> {
        throw new LiveError(LIVE_MESSAGES.sizeLimit);
      }
    }
    store = new FullStore(join(root, "live"));
    const tap = fakeTap([{ chunks: [speech()] }]);
    await expectFailed(await start({ spawn: tap.spawn, transcribe: echo() }).promise, LIVE_MESSAGES.sizeLimit);
  });
});

describe("guards", () => {
  test("disabled setting, invalid session and absurd media times are refused", async () => {
    config.live.enabled = false;
    await expect(start({}).promise).rejects.toThrow(LIVE_MESSAGES.disabled);
    config.live.enabled = true;
    sessionId = "../../etc";
    await expect(start({}).promise).rejects.toThrow(LIVE_MESSAGES.invalidSession);
    sessionId = randomUUID();
    await expect(start({ now: () => MEDIA_START }, { session: session({ mediaStartedAt: "2026-10-26T10:00:00.000Z" }) }).promise).rejects.toThrow(LIVE_MESSAGES.invalidSession);
    await expect(start({ now: () => MEDIA_START }, { session: session({ mediaStartedAt: "never", startedAt: "never" }) }).promise).rejects.toThrow(LIVE_MESSAGES.invalidSession);
  });

  test("one worker per session", async () => {
    const tap = fakeTap([{ chunks: [speech(15, 200)] }]);
    const first = start({ spawn: tap.spawn, transcribe: echo() });
    await waitFor(() => tap.calls.length === 1);
    await expect(start({ spawn: tap.spawn, transcribe: echo() }).promise).rejects.toThrow(LIVE_MESSAGES.alreadyRunning);
    first.controller.abort();
    expect((await first.promise).state).toBe("stopped");
    // The lease is released: a new worker for the same session may start.
    const again = start({ spawn: fakeTap([{ chunks: [] }]).spawn, transcribe: echo() });
    await sleep(20);
    again.controller.abort();
    expect((await again.promise).state).toBe("stopped");
  });
});
