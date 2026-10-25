import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { RecordingSession } from "../session";
import { captureHoldsDevices, readCaptureStatus, startCapture, stopCapture } from "../application";

test("starts the managed capture and opens the same manual time entry as the CLI", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.enabled = true;
  config.capture.audioSource = "none";
  const starts: Array<[string, string]> = [];
  const status = await startCapture(config, { title: "Reunião" }, {
    sessionStore: { read: async () => null },
    readLegacyState: async () => null,
    startRecording: async (_config, options) => {
      expect(options).toEqual({ title: "Reunião" });
      return { outputPath: "/tmp/capture.mkv" };
    },
    timeEntries: {
      startRecording: async (path, startedAt) => {
        starts.push([path, startedAt]);
        return {} as never;
      },
      finishRecording: async () => null,
      finishCall: async () => null
    },
    readAutomationState: async () => ({ version: 1, paused: false }),
    now: () => "2026-09-08T14:00:00.000Z"
  });

  expect(starts).toEqual([["/tmp/capture.mkv", "2026-09-08T14:00:00.000Z"]]);
  expect(status.active).toBe(false);
  expect(status.paused).toBe(false);
});

test("resolves the currently configured audio sources while capture is inactive", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.capture.audioSource = "both";
  config.capture.microphone = "default";
  config.capture.desktop = "default";
  const status = await readCaptureStatus(config, {
    sessionStore: { read: async () => null },
    readLegacyState: async () => null,
    createController: () => { throw new Error("controller should not be created"); },
    inspectAudioSources: async () => ({
      available: ["mic", "speakers.monitor"],
      selected: { microphone: "mic", desktop: "speakers.monitor" },
      warnings: ["A origem de áudio microphone (mic) está mutada."]
    }),
    readAutomationState: async () => ({ version: 1, paused: true })
  });

  expect(status).toEqual({
    session: null,
    active: false,
    audio: {
      configured: { audioSource: "both", microphone: "default", desktop: "default" },
      selected: { microphone: "mic", desktop: "speakers.monitor" }
    },
    paused: true,
    warning: "A origem de áudio microphone (mic) está mutada."
  });
});

test("reports audio warnings discovered while a managed capture is active", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.capture.audioSource = "microphone";
  const session: RecordingSession = {
    version: 1,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    owner: "manual",
    backend: "audio",
    phase: "recording",
    outputPath: "/tmp/live.mka",
    startedAt: "2026-09-08T12:00:00.000Z",
    audio: { microphone: "live-mic" }
  };
  const status = await readCaptureStatus(config, {
    sessionStore: { read: async () => session },
    readLegacyState: async () => null,
    createController: () => ({
      inspect: async () => ({ session, active: true }),
      health: async () => ({ active: true }),
      recover: async () => session,
      stop: async () => session,
      acknowledge: async () => undefined
    }),
    inspectAudioSources: async () => ({
      available: ["live-mic"],
      selected: { microphone: "live-mic" },
      warnings: ["A origem de áudio microphone (live-mic) está com volume zero."]
    }),
    readAutomationState: async () => ({ version: 1, paused: false })
  });

  expect(status.active).toBe(true);
  expect(status.audio.selected).toEqual(session.audio);
  expect(status.warning).toContain("volume zero");
});

test("a managed capture whose state cannot be read still counts as holding the devices", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.capture.audioSource = "none";
  const session: RecordingSession = {
    version: 1,
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    owner: "manual",
    backend: "audio",
    phase: "recording",
    outputPath: "/tmp/unknown.mka",
    startedAt: "2026-09-08T12:00:00.000Z"
  };
  const controller = {
    inspect: async () => { throw new Error("state unreadable"); },
    health: async () => ({ active: true }),
    recover: async () => session,
    stop: async () => session,
    acknowledge: async () => undefined
  };
  const status = await readCaptureStatus(config, {
    sessionStore: { read: async () => session },
    readLegacyState: async () => null,
    createController: () => controller,
    readAutomationState: async () => ({ version: 1, paused: false })
  });
  expect(status).toMatchObject({ session, active: false, unconfirmed: true, warning: expect.stringContaining("Não foi possível confirmar") });
  expect(captureHoldsDevices(status)).toBe(true);
  // A capture that is known to have ended frees the devices, as before.
  const ended = await readCaptureStatus(config, {
    sessionStore: { read: async () => session },
    readLegacyState: async () => null,
    createController: () => ({ ...controller, inspect: async () => ({ session, active: false }) }),
    readAutomationState: async () => ({ version: 1, paused: false })
  });
  expect(ended.unconfirmed).toBeUndefined();
  expect(captureHoldsDevices(ended)).toBe(false);
});

test("finalizes a managed call before acknowledging its persisted capture session", async () => {
  const session: RecordingSession = {
    version: 1,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    owner: "call",
    backend: "audio",
    phase: "recording",
    outputPath: "/tmp/capture.mka",
    startedAt: "2026-09-08T12:00:00.000Z",
    app: "slack"
  };
  const stopped: RecordingSession = {
    ...session,
    phase: "stopped",
    outputPath: "/tmp/final.mka",
    endedAt: "2026-09-08T13:00:00.000Z"
  };
  const events: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.enabled = true;
  const result = await stopCapture(config, {}, {
    sessionStore: { read: async () => session },
    readLegacyState: async () => null,
    createController: () => ({
      inspect: async () => ({ session, active: true }),
      health: async () => ({ active: true }),
      recover: async () => { events.push("recover"); return session; },
      stop: async () => { events.push("stop"); return stopped; },
      acknowledge: async () => { events.push("acknowledge"); }
    }),
    timeEntries: {
      startRecording: async () => { throw new Error("unexpected start"); },
      finishRecording: async () => { throw new Error("unexpected manual finish"); },
      finishCall: async () => { events.push("finish-call"); return null; }
    },
    enqueueRecording: async (_config, path, options) => {
      events.push("enqueue");
      expect(path).toBe(stopped.outputPath);
      expect(options).toEqual({
        recordingId: stopped.id,
        startedAt: stopped.startedAt,
        endedAt: stopped.endedAt,
        app: stopped.app
      });
      return null;
    }
  });

  expect(result).toEqual({ state: "stopped", sourcePath: stopped.outputPath, session: stopped });
  expect(events).toEqual(["recover", "stop", "finish-call", "enqueue", "acknowledge"]);
});

test("keeps the managed session when enqueueing the finalized recording fails", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.enabled = false;
  const session: RecordingSession = {
    version: 1,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    owner: "manual",
    backend: "audio",
    phase: "recording",
    outputPath: "/tmp/capture.mka",
    startedAt: "2026-09-08T12:00:00.000Z"
  };
  const stopped: RecordingSession = {
    ...session,
    phase: "stopped",
    endedAt: "2026-09-08T13:00:00.000Z"
  };
  let acknowledged = false;

  await expect(stopCapture(config, {}, {
    sessionStore: { read: async () => session },
    readLegacyState: async () => null,
    createController: () => ({
      inspect: async () => ({ session, active: true }),
      health: async () => ({ active: true }),
      recover: async () => session,
      stop: async () => stopped,
      acknowledge: async () => { acknowledged = true; }
    }),
    enqueueRecording: async () => { throw new Error("provider details"); }
  })).rejects.toThrow("O estado foi preservado para nova tentativa");

  expect(acknowledged).toBe(false);
});

test("a legacy capture is reported as active and the Studio can stop it", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const legacyState = { backend: "gnome" as const, outputPath: "/tmp/legacy.webm", startedAt: "2026-10-05T10:00:00.000Z" };
  const status = await readCaptureStatus(config, {
    sessionStore: { read: async () => null },
    readLegacyState: async () => legacyState,
    readAutomationState: async () => ({ version: 1, paused: false })
  });
  expect(status).toMatchObject({ active: true, legacy: { backend: "gnome", outputPath: "/tmp/legacy.webm" }, paused: false });
  expect(status.audio.error).toBeUndefined();
  expect(status.warning).toContain("backend legado");

  let stopped = 0;
  const result = await stopCapture(config, {}, {
    sessionStore: { read: async () => null },
    readLegacyState: async () => legacyState,
    stopLegacy: async () => { stopped += 1; return { state: legacyState as never, videoPath: "/tmp/legacy.webm", endedAt: "x", job: null }; }
  });
  expect(stopped).toBe(1);
  expect(result).toEqual({ state: "stopped", sourcePath: "/tmp/legacy.webm" });
  // A stop the legacy backend could not confirm reaches the Studio instead of a plain success.
  const warned = await stopCapture(config, {}, {
    sessionStore: { read: async () => null },
    readLegacyState: async () => legacyState,
    stopLegacy: async () => ({ state: legacyState as never, videoPath: "/tmp/legacy.webm", endedAt: "x", job: null, warning: "O GNOME informou falha ao parar; o estado foi limpo." })
  });
  expect(warned).toEqual({ state: "stopped", sourcePath: "/tmp/legacy.webm", warning: "O GNOME informou falha ao parar; o estado foi limpo." });
  expect(await stopCapture(config, {}, { sessionStore: { read: async () => null }, readLegacyState: async () => null })).toEqual({ state: "idle" });
});

test("the first capture started is a first-run milestone; a failed start is not, and the marker never breaks a start", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.enabled = false;
  config.capture.audioSource = "none";
  const marks: string[] = [];
  const base = {
    sessionStore: { read: async () => null }, readLegacyState: async () => null,
    readAutomationState: async () => ({ version: 1 as const, paused: false })
  };
  await startCapture(config, {}, { ...base, startRecording: async () => ({ outputPath: "/tmp/capture.mkv" }), markFirstRun: async (event) => { marks.push(event); } });
  expect(marks).toEqual(["firstRecording"]);
  await expect(startCapture(config, {}, { ...base, startRecording: async () => { throw new Error("no backend"); }, markFirstRun: async (event) => { marks.push(event); } }))
    .rejects.toThrow("Não foi possível iniciar a captura");
  expect(marks).toEqual(["firstRecording"]);
  await startCapture(config, {}, { ...base, startRecording: async () => ({ outputPath: "/tmp/capture.mkv" }), markFirstRun: async () => { throw new Error("unsafe first-run.json"); } });
});

test("record stop on the fast path starts processing the new job right away, after the stop completed", async () => {
  const session: RecordingSession = {
    version: 1, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner: "manual", backend: "audio", phase: "recording",
    outputPath: "/tmp/capture.mka", startedAt: "2026-09-08T12:00:00.000Z"
  };
  const stopped: RecordingSession = { ...session, phase: "stopped", endedAt: "2026-09-08T13:00:00.000Z" };
  const fast = structuredClone(DEFAULT_CONFIG);
  fast.timesheet.enabled = false;
  fast.processing.fastPath = true;
  fast.transcription.provider = "whisper-cpp";
  fast.summary.provider = "ollama";
  fast.summary.ollamaUrl = "http://127.0.0.1:11434";
  const run = async (config: typeof fast, options: { queueFastPath?: boolean }, queue: (id: string) => Promise<{ status: "queued" | "active" | "completed" }>) => {
    const events: string[] = [];
    const result = await stopCapture(config, options, {
      sessionStore: { read: async () => session },
      readLegacyState: async () => null,
      createController: () => ({
        inspect: async () => ({ session, active: true }), health: async () => ({ active: true }),
        recover: async () => session, stop: async () => stopped, acknowledge: async () => { events.push("acknowledge"); }
      }),
      enqueueRecording: async () => ({ id: session.id }) as never,
      queueJob: async (id) => { events.push(`queue:${id}`); return queue(id); }
    });
    return { result, events };
  };
  const queued = await run(fast, { queueFastPath: true }, async () => ({ status: "queued" }));
  expect(queued.result.queued).toBe("queued");
  expect(queued.events).toEqual(["acknowledge", `queue:${session.id}`]);
  // The Studio queues the job itself: without the option nothing is queued here.
  const studio = await run(fast, {}, async () => ({ status: "queued" }));
  expect(studio.result.queued).toBeUndefined();
  expect(studio.events).toEqual(["acknowledge"]);
  // Off the fast path, or when queueing fails, the job stays pending and the stop still succeeds.
  const slow = structuredClone(fast);
  slow.processing.fastPath = false;
  expect((await run(slow, { queueFastPath: true }, async () => ({ status: "queued" }))).result).toMatchObject({ state: "stopped", queued: null });
  expect((await run(fast, { queueFastPath: true }, async () => { throw new Error("systemd-run failed"); })).result).toMatchObject({ state: "stopped", queued: null });
});
