import { expect, test } from "bun:test";
import type { UpcomingEvent } from "../../calendar/upcoming";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import { OPEN_REQUEST_ERRORS } from "../../desktop/open-request";
import type { LiveTranscriptView } from "../../live";
import type { MediaRemovalPlan, MediaRetentionPassItem, MediaRetentionPlan, MediaRetentionResult } from "../../media-retention";
import { NOTIFY_ERRORS } from "../../notify/actions";
import { REMINDERS_UNIT_ERRORS } from "../../reminders";
import type { LibraryEntry } from "../../tui/library";
import { type AssistantCliDeps, runAssistantCli } from "../assistant";
import { runLibraryCli } from "../library";
import { type LiveCliDeps, runLiveCli } from "../live";
import { type MediaCliDeps, runMediaCli } from "../media";
import { runNotifyCli } from "../notify";
import { type RemindersCliDeps, runRemindersCli } from "../reminders";
import { CLI_MESSAGES, CLI_USAGE } from "../shared";
import { runStudioCli } from "../studio";
import { captureIO, fakeJobs, manualInterrupt } from "./cli-helpers";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT = "c".repeat(64);
const config = (change: (value: AppConfig) => void = () => undefined): AppConfig => { const value = structuredClone(DEFAULT_CONFIG); change(value); return value; };

const remindersDeps = (overrides: Partial<RemindersCliDeps> = {}) => {
  const capture = captureIO();
  const interrupt = manualInterrupt();
  const deps: RemindersCliDeps = {
    io: capture.io, loadConfig: async () => config((value) => { value.calendar.enabled = true; }),
    runService: async () => ({ ran: true }), install: async () => "/units/recording-cli-reminders.service", uninstall: async () => "/units/recording-cli-reminders.service",
    serviceStatus: async () => ({ installed: true, enabled: true, active: true, outdated: false, staleConfig: false }),
    listEvents: async () => [], brief: () => undefined, automationPaused: async () => false, now: () => Date.parse("2026-10-25T12:00:00.000Z"),
    interrupt: interrupt.interrupt, ...overrides
  };
  return { deps, capture, interrupt };
};

test("reminders status, install and uninstall", async () => {
  const status = remindersDeps();
  await runRemindersCli(["reminders", "status"], status.deps);
  expect(JSON.parse(status.capture.out())).toMatchObject({ mode: "auto", effective: "on", calendars: ["gnome-calendar"], problem: null, service: { active: true } });
  const unknown = remindersDeps({ serviceStatus: async () => { throw new Error("bus"); }, loadConfig: async () => config() });
  await runRemindersCli(["reminders", "status"], unknown.deps);
  expect(JSON.parse(unknown.capture.out())).toMatchObject({ service: null, serviceError: CLI_MESSAGES.unitsUnavailable, problem: REMINDERS_UNIT_ERRORS.noCalendar });
  const install = remindersDeps();
  await runRemindersCli(["reminders", "install-service"], install.deps);
  expect(install.capture.out()).toBe("/units/recording-cli-reminders.service\n");
  // Removing the service never needs a readable configuration.
  const uninstall = remindersDeps({ loadConfig: async () => { throw new Error("broken config"); } });
  await runRemindersCli(["reminders", "uninstall-service"], uninstall.deps);
  expect(uninstall.capture.out()).toBe("/units/recording-cli-reminders.service\n");
  await expect(runRemindersCli(["reminders", "start"], status.deps)).rejects.toThrow(CLI_USAGE.reminders);
});

test("reminders test shows what the next three hours would bring, with briefs, and sends nothing", async () => {
  const event: UpcomingEvent = {
    source: "gnome-calendar", eventIdHash: EVENT, title: "Revisão semanal", startAt: "2026-10-25T12:30:00.000Z", endAt: "2026-10-25T13:00:00.000Z",
    recurring: true, attendees: []
  };
  const windows: Array<[string, string]> = [];
  const { deps, capture } = remindersDeps({
    listEvents: async (_config, from, to) => { windows.push([from.toISOString(), to.toISOString()]); return [event, { ...event, eventIdHash: "e".repeat(64), endAt: "2026-10-25T11:00:00.000Z", startAt: "2026-10-25T10:00:00.000Z" }]; },
    brief: () => async () => ["Última: decidimos lançar"]
  });
  await runRemindersCli(["reminders", "test"], deps);
  expect(windows).toEqual([["2026-10-25T12:00:00.000Z", "2026-10-25T15:00:00.000Z"]]);
  const value = JSON.parse(capture.out());
  expect(value.reminders).toHaveLength(1);
  expect(value.reminders[0]).toMatchObject({ title: "Revisão semanal", fireAt: "2026-10-25T12:28:00.000Z", notification: { title: "Revisão semanal em 2 min" } });
  expect(value.reminders[0].notification.body).toContain("Última: decidimos lançar");
  expect(value.reminders[0].notification.actions).toContain("Gravar");
});

test("reminders run hands the service a stop signal, logs problems as JSON lines and exits quietly when not needed", async () => {
  const seen: AbortSignal[] = [];
  const { deps, capture, interrupt } = remindersDeps({
    runService: async ({ signal, deps: serviceDeps }) => {
      seen.push(signal);
      serviceDeps?.onError?.("calendar", new Error("calendário indisponível"));
      return { ran: false, reason: REMINDERS_UNIT_ERRORS.off };
    }
  });
  await runRemindersCli(["reminders", "run"], deps);
  expect(seen).toHaveLength(1);
  expect(capture.out()).toBe(`${REMINDERS_UNIT_ERRORS.off}\n`);
  expect(JSON.parse(capture.err())).toEqual({ event: "reminders.error", stage: "calendar", error: "calendário indisponível" });
  expect(interrupt.disposed()).toBe(1);
});

const view = (lines: LiveTranscriptView["lines"], state: "running" | "stopped" | "failed" | null, extra: Partial<LiveTranscriptView> = {}): LiveTranscriptView => ({
  lines, lastSeq: lines.length ? lines[lines.length - 1]!.seq : 0, hasMore: false, invalidLines: 0, stale: false,
  status: state ? { version: 1, sessionId: SESSION, state, rtf: 0.4, lastSeq: 0, provider: "whisper-cpp", startedAt: "2026-10-25T12:00:00.000Z", updatedAt: "2026-10-25T12:00:10.000Z", chunkSeconds: 15, chunksDone: 1, chunksSkipped: 0, chunksDropped: 0, backlog: 0, ...(state === "failed" ? { error: "O provedor recusou a chave." } : {}) } : null,
  ...extra
});
const line = (seq: number, start: number, text: string) => ({ seq, start, end: start + 3, text, provider: "whisper-cpp" as const });

test("live show prints the lines so far; --follow waits until the worker stops", async () => {
  const capture = captureIO();
  const reads: number[] = [];
  const pages = [view([line(1, 5, "Bom dia")], "running"), view([line(2, 65, "Vamos começar")], "stopped")];
  const deps: LiveCliDeps = {
    io: capture.io, loadConfig: async () => config(), runSession: async () => { throw new Error("unused"); },
    read: async (_id, since) => { reads.push(since); return pages.shift() ?? view([], "stopped"); }, sleep: async () => undefined, interrupt: manualInterrupt().interrupt
  };
  await runLiveCli(["live", "show", SESSION, "--follow"], deps);
  expect(capture.out()).toBe("[00:05] Bom dia\n[01:05] Vamos começar\n");
  expect(capture.err()).toBe(`${CLI_MESSAGES.liveStopped}\n`);
  expect(reads).toEqual([0, 1]);
  const json = captureIO();
  await runLiveCli(["live", "show", SESSION, "--json"], { ...deps, io: json.io, read: async () => view([line(1, 5, "Bom dia")], "running") });
  expect(JSON.parse(json.out())).toMatchObject({ lines: [{ seq: 1, text: "Bom dia" }], status: { state: "running" } });
  await expect(runLiveCli(["live", "show", SESSION, "--follow"], { ...deps, read: async () => view([], "failed") })).rejects.toThrow("O provedor recusou a chave.");
  // A worker that failed without saying why is reported as failed, not as stale.
  const failedQuietly = view([], "failed");
  delete failedQuietly.status!.error;
  await expect(runLiveCli(["live", "show", SESSION, "--follow"], { ...deps, read: async () => failedQuietly })).rejects.toThrow(CLI_MESSAGES.liveFailed);
  await expect(runLiveCli(["live", "show"], deps)).rejects.toThrow(CLI_MESSAGES.liveSessionRequired);
});

test("live run runs the worker for the session and fails when the worker failed", async () => {
  const capture = captureIO();
  const sessions: string[] = [];
  const deps: LiveCliDeps = {
    io: capture.io, loadConfig: async () => config(), read: async () => view([], null), sleep: async () => undefined, interrupt: manualInterrupt().interrupt,
    runSession: async ({ sessionId }) => { sessions.push(sessionId); return { state: "stopped", lastSeq: 3, chunksDone: 3, chunksSkipped: 0, chunksDropped: 0, rtf: 0.3 }; }
  };
  await runLiveCli(["live", "run", "--session", SESSION], deps);
  expect(sessions).toEqual([SESSION]);
  expect(JSON.parse(capture.out())).toMatchObject({ state: "stopped", lastSeq: 3 });
  await expect(runLiveCli(["live", "run", "--session", SESSION], { ...deps, runSession: async () => ({ state: "failed", lastSeq: 0, chunksDone: 0, chunksSkipped: 0, chunksDropped: 0, rtf: null }) }))
    .rejects.toThrow(CLI_MESSAGES.liveFailed);
});

const entry: LibraryEntry = {
  sourcePath: "/recordings/meeting.mkv", relativePath: "meeting.mkv", sourceExists: true, size: 12 * 1024 * 1024, modifiedAt: 0,
  jobs: [{ id: JOB, sourcePath: "/recordings/meeting.mkv" } as never],
  media: { state: "present", copies: { vaio: false, proton: false }, features: { playback: true, frames: true, diarize: true, speakersMic: true, voices: true, subtitles: true, reprocess: true } }
};

const removalPlan = (eligible = true): MediaRemovalPlan => ({
  key: entry.sourcePath, eligible, reasons: eligible ? [] : ["A transcrição ainda não foi verificada."], scope: "total", legacyTranscript: false, consentKey: "a".repeat(64),
  options: [
    { mode: "transcript-only", eligible, bytesFreed: 12 * 1024 * 1024, reasons: eligible ? [] : ["A transcrição ainda não foi verificada."], blockers: [] },
    { mode: "audio-only", eligible, bytesFreed: null, reasons: [], blockers: [] }
  ]
});

const mediaDeps = (overrides: Partial<MediaCliDeps> = {}) => {
  const capture = captureIO();
  const calls: unknown[][] = [];
  const deps: MediaCliDeps = {
    io: capture.io, loadConfig: async () => config(), jobs: () => fakeJobs([{ id: JOB, sourcePath: entry.sourcePath }]), library: async () => [entry],
    plan: async () => ({ sourcePath: entry.sourcePath, jobs: [{ id: JOB }], action: "remove", mode: "keep", blockers: [{ code: "mode-keep", message: "A política é manter a mídia." }], media: { size: 10 } } as unknown as MediaRetentionPlan),
    pass: async () => [],
    planRemoval: async () => removalPlan(),
    remove: async (_entry, mode, key) => {
      calls.push(["remove", mode, key]);
      return { status: "removed", sourcePath: entry.sourcePath, mode, bytesFreed: 12 * 1024 * 1024, purged: [], scope: { copiesElsewhere: "none" },
        ...(mode === "audio-only" ? { retainedAudio: { path: "/r/retained-audio.mka", size: 1024, sha256: "b".repeat(64) } } : {}) } as unknown as MediaRetentionResult;
    },
    state: async () => entry.media!,
    refreshIndex: async (_config, jobId) => { calls.push(["refresh", jobId]); },
    ...overrides
  };
  return { deps, capture, calls };
};

test("media status and the retention preview and pass", async () => {
  const status = mediaDeps();
  await runMediaCli(["media", "status", JOB], status.deps);
  expect(JSON.parse(status.capture.out())).toMatchObject({ jobId: JOB, file: entry.sourcePath, state: "present" });
  const preview = mediaDeps();
  await runMediaCli(["media", "retention"], preview.deps);
  expect(JSON.parse(preview.capture.out())).toMatchObject({ policy: "keep", items: [{ file: entry.sourcePath, jobs: [JOB], ready: false, blockers: [{ code: "mode-keep" }] }] });
  const passItems: MediaRetentionPassItem[] = [{ sourcePath: entry.sourcePath, outcome: "finalized", result: { mode: "transcript-only", bytesFreed: 0 } as never }];
  const limits: unknown[] = [];
  const apply = mediaDeps({ pass: async (_config, options) => { limits.push(options); return passItems; } });
  await runMediaCli(["media", "retention", "--apply", "--limit", "2"], apply.deps);
  expect(limits).toEqual([{ limit: 2 }]);
  expect(JSON.parse(apply.capture.out())).toMatchObject({ items: [{ outcome: "finalized", bytesFreed: 0 }], counts: { finalized: 1 } });
  const failing = mediaDeps({ pass: async () => [{ sourcePath: entry.sourcePath, outcome: "failed", error: "falhou" }] });
  await expect(runMediaCli(["media", "retention", "--apply"], failing.deps)).rejects.toThrow(CLI_MESSAGES.mediaPassFailed);
  expect(JSON.parse(failing.capture.out()).counts.failed).toBe(1);
  await expect(runMediaCli(["media", "retention", "--apply", "--dry-run"], apply.deps)).rejects.toThrow(CLI_MESSAGES.mediaModeConflict);
  // Under "keep" the planner stops before listing jobs; the preview still names the recording's jobs.
  const keep = mediaDeps({ plan: async () => ({ sourcePath: entry.sourcePath, jobs: [], action: "none", mode: "keep", blockers: [{ code: "mode-keep", message: "manter" }], media: {} } as unknown as MediaRetentionPlan) });
  await runMediaCli(["media", "retention", "--dry-run"], keep.deps);
  expect(JSON.parse(keep.capture.out()).items).toEqual([{ file: entry.sourcePath, jobs: [JOB], action: "none", mode: "keep", ready: false, blockers: [{ code: "mode-keep", message: "manter" }] }]);
});

test("media remove of an interrupted removal says what that removal keeps, whatever --keep-audio says", async () => {
  // A "removing" tombstone has one way forward: finishing it, in the mode it was started with.
  const finishing = mediaDeps({
    planRemoval: async () => ({ ...removalPlan(), options: [{ mode: "audio-only", eligible: true, bytesFreed: 0, reasons: [], blockers: [] }] }),
    library: async () => [{ ...entry, sourcePath: "/recordings/reunião\u001b[2J‮.mkv" }]
  });
  await runMediaCli(["media", "remove", JOB, "--yes"], finishing.deps);
  const err = finishing.capture.err();
  expect(err).toContain("mantém a transcrição e o áudio; espaço liberado: 0.0 MiB");
  for (const unsafe of ["\u001b", "‮"]) expect(err).not.toContain(unsafe);
  expect(finishing.calls[0]).toEqual(["remove", "transcript-only", "a".repeat(64)]);
});

test("media remove shows the plan, needs --yes, removes with the plan's consent key and refreshes the index", async () => {
  const refused = mediaDeps();
  await expect(runMediaCli(["media", "remove", JOB], refused.deps)).rejects.toThrow(CLI_MESSAGES.confirmRequired);
  expect(refused.capture.err()).toContain("espaço liberado: 12.0 MiB");
  expect(refused.calls).toEqual([]);
  const removed = mediaDeps();
  await runMediaCli(["media", "remove", JOB, "--yes"], removed.deps);
  expect(removed.calls).toEqual([["remove", "transcript-only", "a".repeat(64)], ["refresh", JOB]]);
  expect(removed.capture.out()).toBe("Mídia removida: meeting.mkv. Espaço liberado: 12.0 MiB.\n");
  const audio = mediaDeps();
  await runMediaCli(["media", "remove", JOB, "--keep-audio", "--yes"], audio.deps);
  expect(audio.capture.err()).toContain("espaço liberado: desconhecido");
  expect(audio.capture.out()).toBe("Mídia removida: meeting.mkv. Espaço liberado: desconhecido.\n");
  const json = mediaDeps();
  await runMediaCli(["media", "remove", JOB, "--keep-audio", "--yes", "--json"], json.deps);
  expect(JSON.parse(json.capture.out())).toMatchObject({ mode: "audio-only", bytesFreed: 12 * 1024 * 1024, retainedAudioBytes: 1024 });
  const blocked = mediaDeps({ planRemoval: async () => removalPlan(false) });
  await expect(runMediaCli(["media", "remove", JOB, "--yes"], blocked.deps)).rejects.toThrow("A transcrição ainda não foi verificada.");
  expect(blocked.calls).toEqual([]);
});

test("studio open validates the link before anything starts; notify runs the detached helpers", async () => {
  const opened: string[] = [];
  const studio = captureIO();
  const studioDeps = { io: studio.io, open: async (uri: string) => { opened.push(uri); return "queued" as const; } };
  await runStudioCli(["studio", "open", `falatrace://recording/${JOB}`], studioDeps);
  expect(JSON.parse(studio.out())).toEqual({ uri: `falatrace://recording/${JOB}`, target: { kind: "recording", jobId: JOB }, result: "queued" });
  await expect(runStudioCli(["studio", "open", "https://example.com"], studioDeps)).rejects.toThrow(OPEN_REQUEST_ERRORS.invalidUri);
  await expect(runStudioCli(["studio", "open"], studioDeps)).rejects.toThrow(CLI_MESSAGES.uriRequired);
  expect(opened).toEqual([`falatrace://recording/${JOB}`]);
  const notify = captureIO();
  const handled: string[] = [];
  const notifyDeps = {
    io: notify.io, loadConfig: async () => { throw new Error("broken"); },
    ready: async (job: string, current: AppConfig | undefined) => { handled.push(`ready:${job}:${current === undefined}`); return "default"; },
    reminder: async (event: string) => { handled.push(`reminder:${event}`); return { shown: true, choice: "skip" as const }; }
  };
  await runNotifyCli(["notify", "ready", "--job", JOB], notifyDeps);
  await runNotifyCli(["notify", "reminder", "--event", EVENT], notifyDeps);
  expect(handled).toEqual([`ready:${JOB}:true`, `reminder:${EVENT}`]);
  expect(notify.out()).toContain('"choice": "default"');
  await expect(runNotifyCli(["notify", "ready", "--job", "x"], notifyDeps)).rejects.toThrow(NOTIFY_ERRORS.invalidCommand);
});

test("assistant status, models, detect, login and logout", async () => {
  const destination = { kind: "local" as const, id: "ollama", label: "Ollama · qwen3.5:9b", endpoint: "http://127.0.0.1:11434", model: "qwen3.5:9b", external: false };
  const capture = captureIO();
  const opened: string[] = [];
  let loggedOut = false;
  const deps: AssistantCliDeps = {
    io: capture.io, loadConfig: async () => config(),
    provider: () => ({ destination, check: async () => ({ ready: true }), run: async () => { throw new Error("unused"); } }),
    detect: async () => ({ acp: [], cli: [{ tool: "claude", command: "claude", found: true, signedIn: false }] }),
    chatgptStatus: async () => ({ signedIn: !loggedOut, planUsage: !loggedOut, registered: true, scopes: [] }),
    login: async (openUrl) => { openUrl("https://auth.example.test/authorize"); return { url: "https://auth.example.test/authorize", redirectUri: "http://127.0.0.1:1455/auth/callback", done: Promise.resolve({ signedIn: true, planUsage: true, registered: true, scopes: [] }), cancel: async () => undefined }; },
    logout: async () => { loggedOut = true; },
    chatgptModels: async () => [{ id: "synthetic-model", label: "Synthetic" }],
    ollamaModels: async () => ["qwen3.5:9b", "llama-synthetic"],
    openUrl: async (url) => { opened.push(url); },
    interrupt: manualInterrupt().interrupt
  };
  const run = async (...args: string[]) => { const before = capture.out().length; await runAssistantCli(["assistant", ...args], deps); return capture.out().slice(before); };
  expect(JSON.parse(await run("status"))).toEqual({ provider: "local", destination, readiness: { ready: true } });
  expect(JSON.parse(await run("models"))).toEqual({ provider: "local", current: "qwen3.5:9b", models: ["qwen3.5:9b", "llama-synthetic"] });
  expect(JSON.parse(await run("detect")).cli[0]).toMatchObject({ tool: "claude", signedIn: false });
  const login = await run("login-chatgpt");
  expect(login.split("\n")[1]).toBe("https://auth.example.test/authorize");
  expect(opened).toEqual(["https://auth.example.test/authorize"]);
  expect(JSON.parse(login.slice(login.indexOf("{")))).toMatchObject({ signedIn: true });
  expect(JSON.parse(await run("logout-chatgpt"))).toMatchObject({ signedIn: false });
  const chatgpt = { ...deps, loadConfig: async () => config((value) => { value.assistant.provider = "chatgpt"; }) };
  const viaChatgpt = captureIO();
  await runAssistantCli(["assistant", "models"], { ...chatgpt, io: viaChatgpt.io });
  expect(JSON.parse(viaChatgpt.out())).toMatchObject({ provider: "chatgpt", models: [{ id: "synthetic-model" }] });
  const api = captureIO();
  await runAssistantCli(["assistant", "models"], { ...deps, io: api.io, loadConfig: async () => config((value) => { value.assistant.provider = "api"; value.assistant.apiPreset = "groq"; }) });
  expect(JSON.parse(api.out())).toMatchObject({ provider: "api", preset: "groq", current: "openai/gpt-oss-120b" });
  await expect(run("upgrade")).rejects.toThrow(CLI_USAGE.assistant);
  // A missing or unknown subcommand is a usage error even when the configuration cannot be read.
  const broken = { ...deps, loadConfig: async (): Promise<AppConfig> => { throw new Error("configuração quebrada"); } };
  await expect(runAssistantCli(["assistant"], broken)).rejects.toThrow(CLI_USAGE.assistant);
  await expect(runAssistantCli(["assistant", "upgrade"], broken)).rejects.toThrow(CLI_USAGE.assistant);
});

test("library refresh and search (JSON marked as untrusted meeting data)", async () => {
  const refreshes: number[] = [];
  const index = {
    refresh: async () => { refreshes.push(1); return { indexed: 1, rebuilt: 1, unchanged: 0, removed: 0, skipped: 0, failed: 0, embedded: 0, embeddings: "off" as const }; },
    search: async (_query: string, options?: { limit?: number }) => [{ chunk: { chunkId: `${JOB}:s000001-s000002`, jobId: JOB, kind: "segments" as const, segmentIds: ["s000001", "s000002"], start: 5, end: 9, text: "Vamos lançar em março." }, score: 1.23456 }].slice(0, options?.limit),
    getFacts: async () => ({ title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z" }) as never
  };
  const capture = captureIO();
  const deps = { io: capture.io, loadConfig: async () => config(), index: () => index };
  await runLibraryCli(["library", "refresh"], deps);
  expect(JSON.parse(capture.out())).toMatchObject({ indexed: 1, embeddings: "off" });
  const search = captureIO();
  await runLibraryCli(["library", "search", "lançar", "março", "--limit", "5"], { ...deps, io: search.io });
  expect(JSON.parse(search.out())).toEqual({
    trust: "untrusted-meeting-data", query: "lançar março", limit: 5,
    items: [{ jobId: JOB, title: "Revisão semanal", date: "2026-10-25", kind: "segments", segmentIds: ["s000001", "s000002"], start: 5, end: 9, score: 1.2346, text: "Vamos lançar em março." }]
  });
  expect(refreshes).toHaveLength(2);
  await runLibraryCli(["library", "search", "x", "--no-refresh"], { ...deps, io: captureIO().io });
  expect(refreshes).toHaveLength(2);
  await expect(runLibraryCli(["library", "search"], deps)).rejects.toThrow(CLI_MESSAGES.queryRequired);
  await expect(runLibraryCli(["library", "search", "x", "--limit", "500"], deps)).rejects.toThrow(CLI_MESSAGES.limitInvalid);
});
