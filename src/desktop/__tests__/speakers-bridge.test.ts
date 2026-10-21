import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobRecord, Transcript } from "../../jobs/types";
import { alignCanonicalTranscript } from "../../diarization/alignment";
import { DIARIZATION_MODEL } from "../../diarization/openai";
import { DiarizationStore, transcriptChecksum } from "../../diarization/store";
import { conversationDestination, destinationKey } from "../../speakers/conversation";
import { SPEAKER_MESSAGES } from "../../speakers/messages";
import { readDiarizationContext } from "../../speakers/record";
import { SpeakerSuggestionStore } from "../../speakers/store";
import { VoiceProfileStore, encodeEmbedding, reconcileVoiceProfiles } from "../../speakers/voices";

assertQaIsolation();
const repo = join(import.meta.dir, "../../..");
const id = "55555555-5555-4555-8555-555555555555";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Reply = { id: number; ok: boolean; result?: any; error?: string };

const fixture = async () => {
  const root = await fs.mkdtemp(join(process.env.TMPDIR!, "speakers-bridge-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const [key, name] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_STATE_HOME", "state"], ["XDG_DATA_HOME", "data"], ["XDG_RUNTIME_DIR", "runtime"], ["XDG_CACHE_HOME", "cache"], ["TMPDIR", "tmp"]] as const) {
    env[key] = join(root, name);
    await fs.mkdir(env[key]!, { mode: 0o700 });
  }
  assertQaIsolation(env);
  const recordings = join(root, "home", "recordings");
  const media = join(recordings, "call.mkv");
  const artifactDir = join(recordings, "call.recording", id);
  await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(media, "synthetic-media", { mode: 0o600 });
  await fs.mkdir(join(env.XDG_CONFIG_HOME!, "recording-cli"), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(env.XDG_CONFIG_HOME!, "recording-cli/config.json"), `${JSON.stringify({ recordingsDir: recordings })}\n`, { mode: 0o600 });
  const job: JobRecord = { version: 1, id, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
    source: { originalName: "call.mkv", mediaFile: "source.mkv", size: 15, sha256: digest("synthetic-media") },
    transcription: { provider: "whisper-cpp", model: "synthetic-local", language: "pt" }, summary: { provider: "ollama", model: "qwen3.5:9b" },
    sourcePath: media, artifactDir, target: "local", state: "completed" };
  await fs.mkdir(join(env.XDG_STATE_HOME!, "recording-cli/jobs"), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(env.XDG_STATE_HOME!, "recording-cli/jobs", `${id}.json`), JSON.stringify(job), { mode: 0o600 });
  const text = "Bom dia. Aqui é a Ana.";
  const canonical: Transcript = { version: 1, provider: "whisper-cpp", model: "synthetic-local", language: "pt", text, segments: [{ start: 0, end: 8, text }] };
  await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify(canonical), { mode: 0o600 });
  const turns = [{ start: 0, end: 4, text: "Bom dia.", speaker: "S01" }, { start: 4, end: 8, text: "Aqui é a Ana.", speaker: "S02" }];
  const diarization = new DiarizationStore(join(env.XDG_DATA_HOME!, "recording-cli", "diarization"));
  await diarization.save({ version: 1, jobId: id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(text), provider: "openai", model: DIARIZATION_MODEL,
    generatedAt: "2026-10-20T00:10:00Z", duration: 8, labels: { S01: "Falante 1", S02: "Falante 2" }, acousticValidation: "pending", turns, alignment: alignCanonicalTranscript(canonical, turns) });
  const context = (await readDiarizationContext(job, canonical, diarization))!;
  const store = new SpeakerSuggestionStore(diarization);
  await store.save({ version: 1, ...context.binding,
    microphone: { generatedAt: "2026-10-20T00:11:00Z", state: "ready", layout: "titled", selfSpeakers: ["S01"], selfName: "Pessoa Dona", speakers: [
      { speakerId: "S01", localSeconds: 4, remoteSeconds: 0, localShare: 1 }, { speakerId: "S02", localSeconds: 0, remoteSeconds: 4, localShare: 0 }] },
    conversation: { generatedAt: "2026-10-20T00:12:00Z", provider: "ollama", model: "qwen3.5:9b", endpoint: "http://127.0.0.1:11434", external: false, state: "ready",
      partial: false, sentTurns: 2, totalTurns: 2, inputBytes: 200, suggestions: [{ speakerId: "S02", name: "Ana", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }] } });
  return { root, env, media, store, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
};

const bridge = async (env: NodeJS.ProcessEnv, request: unknown): Promise<Reply> => {
  assertQaIsolation(env);
  const child = Bun.spawn(["/usr/bin/python3", "-I", join(repo, "scripts/qa-run.py"), process.execPath, "run", "--preload", join(repo, "scripts/offline-network.ts"), join(repo, "src/desktop/bridge.ts")],
    { cwd: repo, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(request) + "\n");
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout.trim());
};

test("the production bridge shows stored suggestions and refuses a stale destination or an unavailable background service", async () => {
  const context = await fixture();
  try {
    const detail = await bridge(context.env, { id: 1, op: "detail", key: context.media });
    expect(detail.ok).toBe(true);
    const key = destinationKey(conversationDestination(structuredClone(DEFAULT_CONFIG)));
    expect(detail.result.speakerSuggestions).toMatchObject({
      state: "ready", message: SPEAKER_MESSAGES.ready,
      items: [
        { speakerId: "S01", source: "microphone", self: true, name: "Pessoa Dona", localShare: 1 },
        { speakerId: "S02", source: "conversation", self: false, name: "Ana", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana" }] }
      ],
      destination: { provider: "ollama", model: "qwen3.5:9b", external: false, consentKey: key }
    });
    // Labels are untouched until a revision applies a suggestion.
    expect(detail.result.review.speakerLabels).toEqual({ S01: "Falante 1", S02: "Falante 2" });
    const stale = await bridge(context.env, { id: 2, op: "speakers-suggest", key: id, payload: { conversation: true, consent: true, consentKey: "b".repeat(64) } });
    expect(stale).toEqual({ id: 2, ok: false, error: SPEAKER_MESSAGES.destinationChanged });
    expect(await context.store.readOperation(id)).toBeUndefined();
    // systemd-run is blocked in the QA environment: the start failure is explained and recorded.
    const local = await bridge(context.env, { id: 3, op: "speakers-suggest", key: id, payload: { conversation: false } });
    expect(local).toEqual({ id: 3, ok: false, error: SPEAKER_MESSAGES.startFailed });
    const after = await bridge(context.env, { id: 4, op: "detail", key: context.media });
    expect(after.result.speakerSuggestions).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.startFailed });
    expect(after.result.speakerSuggestions.items).toHaveLength(2);
  } finally { await context.cleanup(); }
}, 30_000);

test("the production bridge lists known voices and forgets exactly the person named, never the signatures themselves", async () => {
  const context = await fixture();
  try {
    const profiles = new VoiceProfileStore(join(context.env.XDG_DATA_HOME!, "recording-cli", "voices"));
    const vector = (index: number) => { const value = new Float32Array(16); value[index] = 1; return encodeEmbedding(value); };
    const record = { version: 1 as const, jobId: id, mediaSha256: "a".repeat(64), transcriptSha256: "b".repeat(64), diarizationSha256: "c".repeat(64), generatedAt: "2026-10-21T00:00:00Z",
      model: { id: "eres2net-base", sha256: "f".repeat(64), dim: 16 }, speakers: [{ speakerId: "S01", track: "microphone" as const, seconds: 20, embedding: vector(1) }, { speakerId: "S02", track: "desktop" as const, seconds: 20, embedding: vector(2) }] };
    let next = 0;
    await profiles.update((current) => reconcileVoiceProfiles(current, record, { S01: "Pessoa Dona", S02: "Ana" }, "2026-10-21T00:00:00.000Z", () => `00000000-0000-4000-8000-00000000000${++next}`));
    const listed = await bridge(context.env, { id: 1, op: "settings-voices-list" });
    expect(listed.result.people.map((person: { name: string; samples: number }) => [person.name, person.samples])).toEqual([["Ana", 1], ["Pessoa Dona", 1]]);
    // Only names and counts leave the bridge.
    expect(JSON.stringify(listed)).not.toContain(vector(1));
    for (const payload of [{}, { all: false }, { personId: "nope" }, { all: true, personId: "00000000-0000-4000-8000-000000000001" }]) {
      expect(await bridge(context.env, { id: 2, op: "settings-voices-delete", payload })).toMatchObject({ ok: false });
    }
    const deleted = await bridge(context.env, { id: 3, op: "settings-voices-delete", payload: { personId: "00000000-0000-4000-8000-000000000002" } });
    expect(deleted.result.removed).toBe(1);
    expect(deleted.result.people.map((person: { name: string }) => person.name)).toEqual(["Pessoa Dona"]);
    expect((await bridge(context.env, { id: 4, op: "settings-voices-delete", payload: { all: true } })).result).toEqual({ people: [], removed: 1 });
  } finally { await context.cleanup(); }
}, 30_000);

test("the production bridge reports the Google connection and needs a saved client ID to start a sign-in", async () => {
  const context = await fixture();
  try {
    expect(await bridge(context.env, { id: 1, op: "settings-google-status" })).toEqual({ id: 1, ok: true, result: { connected: false, clientConfigured: false, calendar: false, flow: "idle" } });
    expect(await bridge(context.env, { id: 2, op: "settings-google-connect" })).toEqual({ id: 2, ok: false, error: "Informe o ID do cliente OAuth do Google (app para computador) em Integrações." });
    expect((await bridge(context.env, { id: 3, op: "settings-google-connect", payload: { url: "x" } })).ok).toBe(false);
    // With a client ID saved, the bridge answers with Google's consent URL and still exits when the Studio closes.
    const config = join(context.env.XDG_CONFIG_HOME!, "recording-cli/config.json");
    const current = JSON.parse(await fs.readFile(config, "utf8"));
    await fs.writeFile(config, JSON.stringify({ ...current, google: { clientId: "123456789012-abcdefghij0123456789.apps.googleusercontent.com", calendar: true } }), { mode: 0o600 });
    const started = await bridge(context.env, { id: 4, op: "settings-google-connect" });
    expect(started.ok).toBe(true);
    const url = new URL(started.result.url);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.result).toMatchObject({ connected: false, clientConfigured: true, calendar: true, flow: "waiting" });
    expect((await bridge(context.env, { id: 5, op: "settings-google-disconnect" })).result).toMatchObject({ revoked: false, connected: false, flow: "idle" });
  } finally { await context.cleanup(); }
}, 30_000);
