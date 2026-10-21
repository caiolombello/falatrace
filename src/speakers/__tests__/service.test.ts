import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { runCommand } from "../../jobs/command";
import type { JobRecord, Transcript } from "../../jobs/types";
import { alignCanonicalTranscript } from "../../diarization/alignment";
import { DIARIZATION_MODEL } from "../../diarization/openai";
import { DiarizationStore, transcriptChecksum, type DiarizationResult } from "../../diarization/store";
import { conversationDestination, destinationKey } from "../conversation";
import { SPEAKER_MESSAGES } from "../messages";
import { recordMicrophoneAfterDiarization } from "../record";
import { queueSpeakerSuggestions, readSpeakerSuggestionView, suggestSpeakerNames, type SpeakerSuggestionDependencies } from "../service";
import { SpeakerSuggestionStore } from "../store";
import { GOOGLE_TOKEN_URL, GoogleTokenStore } from "../../google/oauth";

const id = "123e4567-e89b-42d3-a456-426614174042";
const text = "Bom dia. Ana, pode começar? Aqui é a Ana.\n";
const canonical: Transcript = { version: 1, provider: "openai", model: "gpt-transcribe", language: "pt", text, segments: [{ start: 0, end: 16, text }] };
const job: JobRecord = {
  version: 1, id, createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z",
  source: { originalName: "call.mkv", mediaFile: "call.mkv", size: 10, sha256: "a".repeat(64) },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
  summary: { provider: "openai", model: "gpt-6-luna" }, sourcePath: "/tmp/call.mkv", artifactDir: `/tmp/call.recording/${id}`,
  target: "local", state: "completed"
};
const turns = [
  { start: 0.2, end: 7.8, text: "Bom dia. Ana, pode começar?", speaker: "S01" },
  { start: 8.2, end: 15.8, text: "Aqui é a Ana.", speaker: "S02" }
];
const diarization = (generatedAt = "2026-10-20T12:30:00.000Z"): DiarizationResult => ({
  version: 1, jobId: id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(text), provider: "openai", model: DIARIZATION_MODEL,
  generatedAt, duration: 16, labels: { S01: "Falante 1", S02: "Falante 2" }, acousticValidation: "pending", turns, alignment: alignCanonicalTranscript(canonical, turns)
});
const openaiConfig = (): AppConfig => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.provider = "openai";
  config.summary.openaiModel = "gpt-6-luna";
  return config;
};
const anaReply = JSON.stringify({ suggestions: [{ speakerId: "S02", name: "Ana", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }] });

const synthesize = async (path: string): Promise<void> => {
  // The owner speaks from 0 to 8 s on the microphone; the remote voice plays on the computer from 8 to 16 s.
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=16", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16",
    "-filter_complex", "[0:a]volume='if(lt(t,8),0.5,0)':eval=frame,asplit=2[m1][m2];[1:a]volume='if(gte(t,8),0.5,0)':eval=frame,asplit=2[d1][d2];[m1][d1]amix=inputs=2:normalize=0[mix]",
    "-map", "[mix]", "-map", "[m2]", "-map", "[d2]", "-metadata:s:a:0", "title=Mixed", "-metadata:s:a:1", "title=Microphone", "-metadata:s:a:2", "title=Desktop",
    "-c:a", "flac", "-f", "matroska", path], { timeoutMs: 60_000 });
};

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-speakers-service-"));
  const diarizationStore = new DiarizationStore(join(root, "diarization"));
  await diarizationStore.save(diarization());
  const store = new SpeakerSuggestionStore(diarizationStore);
  const media = join(root, "call.mkv");
  await synthesize(media);
  const calls = { media: 0, complete: 0, run: [] as string[][] };
  const dependencies = (overrides: Partial<SpeakerSuggestionDependencies> = {}): SpeakerSuggestionDependencies => ({
    getJob: async () => job, readCanonical: async () => canonical, store,
    mediaPath: async () => { calls.media++; return media; },
    microphone: { selfName: async () => "Caio Barbieri" },
    complete: async () => { calls.complete++; return anaReply; },
    unitActive: async () => false,
    run: async (_command, args) => { calls.run.push(args); return { stdout: "", stderr: "" }; },
    ...overrides
  });
  return { root, diarizationStore, store, media, calls, dependencies, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
};

test("suggests the owner from the microphone and a quoted name from the conversation, bound to the exact diarization", async () => {
  const context = await fixture();
  try {
    const config = openaiConfig();
    const record = await suggestSpeakerNames(config, id, { conversation: true, consentKey: destinationKey(conversationDestination(config)) }, context.dependencies());
    expect(record.microphone).toMatchObject({ state: "ready", layout: "titled", selfSpeakers: ["S01"], selfName: "Caio Barbieri" });
    expect(record.conversation).toMatchObject({ state: "ready", provider: "openai", model: "gpt-6-luna", external: true, partial: false, sentTurns: 2, totalTurns: 2,
      suggestions: [{ speakerId: "S02", name: "Ana", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }] });
    const view = await readSpeakerSuggestionView(config, job, canonical, { store: context.store, unitActive: async () => false });
    expect(view.state).toBe("ready");
    expect(view.message).toBe(SPEAKER_MESSAGES.ready);
    expect(view.items).toEqual([
      { speakerId: "S01", source: "microphone", self: true, name: "Caio Barbieri", localShare: 1 },
      { speakerId: "S02", source: "conversation", self: false, name: "Ana", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }
    ]);
    expect(view.destination).toEqual({ provider: "openai", model: "gpt-6-luna", endpoint: "https://api.openai.com", external: true, consentKey: destinationKey(conversationDestination(config)) });
    expect((await fs.stat(context.store.path(id))).mode & 0o777).toBe(0o600);
    // Asking again without the conversation reuses the microphone result and keeps the conversation one.
    const again = await suggestSpeakerNames(config, id, {}, context.dependencies());
    expect(context.calls).toMatchObject({ media: 1, complete: 1 });
    expect(again.conversation?.state).toBe("ready");
    // A new diarization of the same recording makes these suggestions stale.
    await context.diarizationStore.save(diarization("2026-10-20T13:00:00.000Z"));
    expect(await readSpeakerSuggestionView(config, job, canonical, { store: context.store })).toMatchObject({ state: "idle", items: [] });
  } finally { await context.cleanup(); }
}, 60_000);

test("a changed destination, a provider failure and a missing diarization are explained without applying anything", async () => {
  const context = await fixture();
  try {
    const config = openaiConfig();
    await expect(suggestSpeakerNames(config, id, { conversation: true, consentKey: "b".repeat(64) }, context.dependencies())).rejects.toThrow(SPEAKER_MESSAGES.destinationChanged);
    expect(await context.store.readOperation(id)).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.destinationChanged });
    expect(context.calls.complete).toBe(0);
    const record = await suggestSpeakerNames(config, id, { conversation: true }, context.dependencies({ complete: async () => { throw new Error("connect ECONNREFUSED sk-secret"); } }));
    // The microphone result is kept; the provider error is replaced by a fixed message.
    expect(record.microphone?.state).toBe("ready");
    expect(record.conversation).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.failed });
    expect(await context.store.readOperation(id)).toBeUndefined();
    const view = await readSpeakerSuggestionView(config, job, canonical, { store: context.store });
    expect(view.items.map((item) => item.source)).toEqual(["microphone"]);
    expect(view.conversation).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.failed });
    await fs.rm(context.diarizationStore.resultPath(id));
    await expect(suggestSpeakerNames(config, id, {}, context.dependencies())).rejects.toThrow(SPEAKER_MESSAGES.needsDiarization);
    expect((await readSpeakerSuggestionView(config, job, canonical, { store: context.store })).state).toBe("unavailable");
  } finally { await context.cleanup(); }
}, 60_000);

test("queues a background unit; the conversation needs consent bound to the configured destination", async () => {
  const context = await fixture();
  try {
    const config = openaiConfig();
    const key = destinationKey(conversationDestination(config));
    await expect(queueSpeakerSuggestions(config, id, { conversation: true }, context.dependencies())).rejects.toThrow(SPEAKER_MESSAGES.consentRequired);
    await expect(queueSpeakerSuggestions(config, id, { conversation: true, consentKey: "c".repeat(64) }, context.dependencies())).rejects.toThrow(SPEAKER_MESSAGES.destinationChanged);
    expect(context.calls.run).toEqual([]);
    const queued = await queueSpeakerSuggestions(config, id, { conversation: true, consentKey: key }, context.dependencies());
    expect(queued).toEqual({ id, status: "queued", unit: `recording-cli-speakers-${id}.service` });
    expect(context.calls.run).toHaveLength(1);
    expect(context.calls.run[0]!.slice(-6)).toEqual(["speakers", "suggest", id, "--conversation", "--consent-key", key]);
    expect(context.calls.run[0]).toContain("--property=UMask=0077");
    expect(await context.store.readOperation(id)).toMatchObject({ state: "running", conversation: true });
    // Running while the unit is active; interrupted when it is gone without a result.
    expect(await readSpeakerSuggestionView(config, job, canonical, { store: context.store, unitActive: async () => true })).toMatchObject({ state: "running", message: SPEAKER_MESSAGES.running });
    expect(await readSpeakerSuggestionView(config, job, canonical, { store: context.store, unitActive: async () => false })).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.interrupted });
    // An active unit is not started twice; microphone-only needs no consent.
    await queueSpeakerSuggestions(config, id, {}, context.dependencies({ unitActive: async () => true }));
    expect(context.calls.run).toHaveLength(1);
    await queueSpeakerSuggestions(config, id, {}, context.dependencies({ run: async () => { throw new Error("no systemd"); } })).catch((error: Error) => expect(error.message).toBe(SPEAKER_MESSAGES.startFailed));
    expect(await context.store.readOperation(id)).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.startFailed });
  } finally { await context.cleanup(); }
}, 60_000);

test("right after a diarization the microphone is recorded, unless the media changed", async () => {
  const context = await fixture();
  try {
    const stat = await fs.lstat(context.media);
    const expected = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
    await recordMicrophoneAfterDiarization(job, canonical, context.media, { ...expected, size: expected.size + 1 }, context.diarizationStore, { selfName: async () => "Caio Barbieri" });
    expect(await fs.readdir(join(context.root, "diarization"))).toEqual([`${id}.json`]);
    await recordMicrophoneAfterDiarization(job, canonical, context.media, expected, context.diarizationStore, { selfName: async () => undefined });
    const view = await readSpeakerSuggestionView(openaiConfig(), job, canonical, { store: context.store });
    // Without a full name on the account the Studio shows "Você".
    expect(view.items).toEqual([{ speakerId: "S01", source: "microphone", self: true, localShare: 1 }]);
    expect((await fs.readdir(join(context.root, "diarization"))).sort()).toEqual([`${id}.json`, `${id}.speakers.json`]);
  } finally { await context.cleanup(); }
}, 60_000);

test("with the Google Calendar on, the conversation request carries the invited names and full names can be suggested", async () => {
  const context = await fixture();
  try {
    const config = openaiConfig();
    config.google = { clientId: "123456789012-abcdefghij0123456789.apps.googleusercontent.com", calendar: true };
    const store = new GoogleTokenStore(join(context.root, "google"));
    await store.save({ version: 1, clientId: config.google.clientId, refreshToken: "long-lived", scopes: [], connectedAt: "2026-10-21T00:00:00.000Z" });
    // A 30-minute recording that ends at the job's creation time (no local media file): the event covers it.
    await context.diarizationStore.save({ ...diarization(), duration: 1800 });
    const end = Date.parse(job.createdAt);
    const calendarFetch = (async (input: RequestInfo | URL) => String(input) === GOOGLE_TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 })
      : new Response(JSON.stringify({ items: [{ id: "e", status: "confirmed", summary: "Revisão", start: { dateTime: new Date(end - 31 * 60_000).toISOString() }, end: { dateTime: new Date(end + 60_000).toISOString() },
        attendees: [{ email: "ana.souza@example.com" }, { email: "caio@example.com", displayName: "Caio Barbieri", self: true }] }] }), { status: 200 })) as typeof fetch;
    const requests: string[] = [];
    const record = await suggestSpeakerNames(config, id, { conversation: true }, context.dependencies({
      calendar: { store, fetch: calendarFetch, clientSecret: async () => "secret" },
      complete: async ({ user }) => { requests.push(user); return JSON.stringify({ suggestions: [{ speakerId: "S02", name: "Ana Souza", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }] }); }
    }));
    expect(JSON.parse(requests[0]!).participants).toEqual(["Ana Souza", "Caio Barbieri"]);
    expect(record.conversation).toMatchObject({ state: "ready", participants: 2, suggestions: [{ speakerId: "S02", name: "Ana Souza" }] });
    const view = await readSpeakerSuggestionView(config, job, canonical, { store: context.store });
    expect(view.calendar).toBe(true);
    expect(view.conversation).toMatchObject({ participants: 2 });
  } finally { await context.cleanup(); }
}, 60_000);
