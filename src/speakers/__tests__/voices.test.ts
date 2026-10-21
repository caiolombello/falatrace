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
import type { ReviewedView } from "../../revisions";
import { SPEAKER_MESSAGES } from "../messages";
import { readDiarizationContext } from "../record";
import { readSpeakerSuggestionView, suggestSpeakerNames } from "../service";
import { SpeakerSuggestionStore } from "../store";
import { VOICE_AUDIO_LIMITS, extractSpeakerAudio, planSpeakerAudio } from "../voice-audio";
import type { VoiceEmbedder } from "../voice-engine";
import {
  VOICE_PROFILE_LIMITS, VoiceProfileStore, VoiceRecordStore, computeVoiceRecord, decodeEmbedding, deleteVoicePeople, encodeEmbedding, learnVoices,
  listVoicePeople, matchVoices, reconcileVoiceProfiles, type VoiceProfiles, type VoiceRecord
} from "../voices";

const DIM = 16;
/** Deterministic stand-in for the model: one direction per dominant frequency (zero-crossing rate). */
const fakeEmbedder: VoiceEmbedder = {
  dim: DIM, modelSha256: "f".repeat(64),
  embed: (samples) => {
    let crossings = 0;
    for (let index = 1; index < samples.length; index++) if ((samples[index - 1]! < 0) !== (samples[index]! < 0)) crossings++;
    const hertz = crossings / 2 / (samples.length / 16_000);
    const vector = new Float32Array(DIM);
    vector[Math.min(DIM - 1, Math.round(hertz / 110))] = 1;
    return vector;
  }
};
const direction = (index: number, noise = 0): Float32Array => { const vector = new Float32Array(DIM).fill(noise); vector[index] = 1; return vector; };
const model = { id: "eres2net-base", sha256: "f".repeat(64), dim: DIM };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recordFor = (jobId: string, speakers: Record<string, Float32Array>): VoiceRecord => ({
  version: 1, jobId, mediaSha256: "a".repeat(64), transcriptSha256: "b".repeat(64), diarizationSha256: "c".repeat(64), generatedAt: "2026-10-21T10:00:00.000Z", model,
  speakers: Object.entries(speakers).map(([speakerId, vector]) => ({ speakerId, track: "desktop", seconds: 30, embedding: encodeEmbedding(vector) }))
});
const turns = (...entries: Array<[number, number, string]>) => entries.map(([start, end, speaker]) => ({ start, end, speaker }));

test("each speaker is represented by its longest clean turns, trimmed and capped", () => {
  const plans = planSpeakerAudio(turns(
    [0, 10, "S01"], [10, 20, "S02"], [19, 25, "S01"],   // S02 and the second S01 turn overlap: neither is used
    [30, 60, "S03"],                                     // a monologue contributes only its middle
    [61, 62, "S04"],                                     // too little clean audio
    ...Array.from({ length: 30 }, (_, index): [number, number, string] => [100 + index * 6, 105 + index * 6, "S05"])
  ), new Set(["S01"]), true);
  expect(plans.map((plan) => [plan.speakerId, plan.track, plan.seconds])).toEqual([["S01", "microphone", 9.6], ["S03", "desktop", 12], ["S05", "desktop", 40]]);
  expect(plans[0]!.segments).toEqual([[0.2, 9.8]]);
  expect(plans[1]!.segments).toEqual([[39, 51]]);
  expect(plans[2]!.segments.length).toBeLessThanOrEqual(VOICE_AUDIO_LIMITS.maxSegmentsPerSpeaker);
  // Without separate tracks everyone is read from the mix.
  expect(planSpeakerAudio(turns([0, 10, "S01"]), new Set(["S01"]), false)[0]!.track).toBe("mix");
});

const synthesize = async (path: string): Promise<void> => {
  // The owner speaks at 220 Hz on the microphone from 0 to 8 s; a remote voice at 440 Hz plays on the computer from 8 to 16 s.
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=16", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16",
    "-filter_complex", "[0:a]volume='if(lt(t,8),0.5,0)':eval=frame,asplit=2[m1][m2];[1:a]volume='if(gte(t,8),0.5,0)':eval=frame,asplit=2[d1][d2];[m1][d1]amix=inputs=2:normalize=0[mix]",
    "-map", "[mix]", "-map", "[m2]", "-map", "[d2]", "-metadata:s:a:0", "title=Mixed", "-metadata:s:a:1", "title=Microphone", "-metadata:s:a:2", "title=Desktop",
    "-c:a", "flac", "-f", "matroska", path], { timeoutMs: 60_000 });
};

test("cuts each speaker's segments from its own track with one ffmpeg pass per track", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-voice-audio-"));
  try {
    const media = join(root, "call.mkv");
    await synthesize(media);
    const plans = planSpeakerAudio(turns([0, 8, "S01"], [8, 16, "S02"]), new Set(["S01"]), true);
    const calls: string[][] = [];
    const audio = await extractSpeakerAudio(media, plans, { mix: 0, microphone: 1, desktop: 2 }, root, {
      run: (command, args, options) => { calls.push(args); return runCommand(command, args, options); }
    });
    expect(calls).toHaveLength(2);
    for (const [speakerId, hertz] of [["S01", 220], ["S02", 440]] as const) {
      const samples = audio.get(speakerId)!;
      expect(Math.abs(samples.length / 16_000 - 7.6)).toBeLessThan(0.05);
      expect(fakeEmbedder.embed(samples)[Math.round(hertz / 110)]).toBe(1);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);

test("matching needs a confident lead over the next person and ignores what this recording taught", () => {
  const profiles: VoiceProfiles = { version: 1, model, people: [
    { id: uuid(1), name: "Ana", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", samples: [{ recordingId: uuid(90), speakerId: "S02", seconds: 30, createdAt: "2026-10-01T00:00:00.000Z", embedding: encodeEmbedding(direction(3)) }] },
    { id: uuid(2), name: "Bruno", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", samples: [{ recordingId: uuid(91), speakerId: "S01", seconds: 30, createdAt: "2026-10-01T00:00:00.000Z", embedding: encodeEmbedding(direction(5)) }] }
  ] };
  const record = recordFor(uuid(50), { S01: direction(3, 0.05), S02: direction(5), S03: direction(9) });
  expect(matchVoices(record, profiles).map(({ speakerId, name }) => [speakerId, name])).toEqual([["S01", "Ana"], ["S02", "Bruno"]]);
  // Two voices too close to each other: no confident name.
  const similar = structuredClone(profiles);
  similar.people[1]!.samples[0]!.embedding = encodeEmbedding(direction(3, 0.05));
  expect(matchVoices(recordFor(uuid(50), { S01: direction(3) }), similar)).toEqual([]);
  // A recording never recognizes itself from samples it taught.
  expect(matchVoices(recordFor(uuid(90), { S02: direction(3) }), profiles)).toEqual([]);
  // Another model's signatures are never compared.
  expect(matchVoices(record, { ...profiles, model: { ...model, sha256: "e".repeat(64) } })).toEqual([]);
  expect(decodeEmbedding(encodeEmbedding(direction(2)), DIM)).toEqual(direction(2));
  expect(decodeEmbedding("abc", DIM)).toBeUndefined();
});

test("profiles follow the human labels of each recording: learn, rename, undo and cap", () => {
  let ids = 0;
  const newId = () => uuid(++ids);
  const recording = uuid(70);
  const record = recordFor(recording, { S01: direction(3), S02: direction(5) });
  const learned = reconcileVoiceProfiles(undefined, record, { S01: "Caio Barbieri", S02: "Falante 2" }, "2026-10-21T10:00:00.000Z", newId)!;
  expect(learned.people.map((person) => [person.name, person.samples.length])).toEqual([["Caio Barbieri", 1]]);
  // The diarizer's default label is never learned; a rename moves the sample to the new name.
  const renamed = reconcileVoiceProfiles(learned, record, { S01: "Caio", S02: "Falante 2" }, "2026-10-21T11:00:00.000Z", newId)!;
  expect(renamed.people.map((person) => [person.name, person.samples.map((sample) => sample.speakerId)])).toEqual([["Caio", ["S01"]]]);
  // Undoing the name removes what it taught, and a person without samples is forgotten.
  expect(reconcileVoiceProfiles(renamed, record, { S01: "Falante 1", S02: "Falante 2" }, "2026-10-21T12:00:00.000Z", newId)!.people).toEqual([]);
  // Same person across recordings, case and spacing aside; at most 20 samples, newest kept.
  let many: VoiceProfiles | undefined;
  for (let index = 0; index < VOICE_PROFILE_LIMITS.maxSamplesPerPerson + 5; index++) {
    many = reconcileVoiceProfiles(many, recordFor(uuid(100 + index), { S01: direction(3) }), { S01: index % 2 ? "ana  souza" : "Ana Souza" }, `2026-10-21T10:${String(index).padStart(2, "0")}:00.000Z`, newId);
  }
  expect(many!.people).toHaveLength(1);
  expect(many!.people[0]!.samples).toHaveLength(VOICE_PROFILE_LIMITS.maxSamplesPerPerson);
  expect(many!.people[0]!.samples[0]!.recordingId).toBe(uuid(105));
  // Profiles of another model are left as they are.
  const other = { ...learned, model: { ...model, sha256: "e".repeat(64) } };
  expect(reconcileVoiceProfiles(other, record, { S01: "Outro" }, "2026-10-21T13:00:00.000Z", newId)).toBe(other);
});

test("the profile file is private, a damaged one is kept, and people can be listed and forgotten", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-voice-profiles-"));
  try {
    const store = new VoiceProfileStore(join(root, "voices"));
    const record = recordFor(uuid(70), { S01: direction(3), S02: direction(5) });
    let ids = 0;
    await store.update((current) => reconcileVoiceProfiles(current, record, { S01: "Caio", S02: "Ana" }, "2026-10-21T10:00:00.000Z", () => uuid(++ids)));
    expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await listVoicePeople(store)).map(({ name, samples, recordings }) => [name, samples, recordings])).toEqual([["Ana", 1, 1], ["Caio", 1, 1]]);
    expect(await deleteVoicePeople({ personId: uuid(1) }, store)).toBe(1);
    expect((await listVoicePeople(store)).map((person) => person.name)).toEqual(["Ana"]);
    expect(await deleteVoicePeople({ all: true }, store)).toBe(1);
    await expect(fs.lstat(store.path)).rejects.toThrow();
    await fs.writeFile(store.path, "{damaged", { mode: 0o600 });
    await expect(store.update((current) => reconcileVoiceProfiles(current, record, { S01: "Caio" }, "2026-10-21T10:00:00.000Z"))).rejects.toThrow();
    expect(await fs.readFile(store.path, "utf8")).toBe("{damaged");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ---- Through the suggestion service, with the synthetic call above ----

const id = "123e4567-e89b-42d3-a456-426614174077";
const text = "Bom dia, aqui é o dono. Olá, aqui é a Ana.\n";
const canonical: Transcript = { version: 1, provider: "openai", model: "gpt-transcribe", language: "pt", text, segments: [{ start: 0, end: 16, text }] };
const job: JobRecord = {
  version: 1, id, createdAt: "2026-10-21T12:00:00.000Z", updatedAt: "2026-10-21T12:00:00.000Z",
  source: { originalName: "call.mkv", mediaFile: "call.mkv", size: 10, sha256: "a".repeat(64) },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" }, summary: { provider: "openai", model: "gpt-6-luna" },
  sourcePath: "/tmp/call.mkv", artifactDir: `/tmp/call.recording/${id}`, target: "local", state: "completed"
};
const diarizedTurns = [
  { start: 0.2, end: 7.8, text: "Bom dia, aqui é o dono.", speaker: "S01" },
  { start: 8.2, end: 15.8, text: "Olá, aqui é a Ana.", speaker: "S02" }
];
const diarization = (): DiarizationResult => ({
  version: 1, jobId: id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(text), provider: "openai", model: DIARIZATION_MODEL,
  generatedAt: "2026-10-21T12:30:00.000Z", duration: 16, labels: { S01: "Falante 1", S02: "Falante 2" }, acousticValidation: "pending", turns: diarizedTurns,
  alignment: alignCanonicalTranscript(canonical, diarizedTurns)
});
const voicesOn = (): AppConfig => { const config = structuredClone(DEFAULT_CONFIG); config.speakers.voices = true; return config; };
const installation = { runtimeDir: "/nonexistent/runtime", modelPath: "/nonexistent/model.onnx", modelSha256: "f".repeat(64) };

test("with voices on, a suggestion run computes signatures and later recognizes a person confirmed elsewhere", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-voice-service-"));
  try {
    const diarizationStore = new DiarizationStore(join(root, "diarization"));
    await diarizationStore.save(diarization());
    const store = new SpeakerSuggestionStore(diarizationStore);
    const voiceRecords = new VoiceRecordStore(diarizationStore);
    const voiceProfiles = new VoiceProfileStore(join(root, "voices"));
    const media = join(root, "call.mkv");
    await synthesize(media);
    const dependencies = { getJob: async () => job, readCanonical: async () => canonical, store, mediaPath: async () => media,
      microphone: { selfName: async () => "Dono da Gravação" }, voiceInstallation: async () => installation, voice: { embedder: fakeEmbedder }, voiceRecords, voiceProfiles,
      unitActive: async () => false };
    const view = (config: AppConfig, installed = true) => readSpeakerSuggestionView(config, job, canonical, { store, voiceRecords, voiceProfiles, unitActive: async () => false,
      voiceInstallation: async () => installed ? installation : undefined });
    // Off by default: nothing about voices is computed or shown.
    await suggestSpeakerNames(structuredClone(DEFAULT_CONFIG), id, {}, dependencies);
    const binding = (await readDiarizationContext(job, canonical, diarizationStore))!.binding;
    expect(await voiceRecords.read(binding)).toBeUndefined();
    expect((await view(structuredClone(DEFAULT_CONFIG))).voice).toBeUndefined();
    expect((await view(voicesOn(), false)).voice).toEqual({ state: "not-installed", message: SPEAKER_MESSAGES.voiceNotInstalled });
    expect((await view(voicesOn())).voice).toEqual({ state: "missing", message: SPEAKER_MESSAGES.voiceMissing });
    const record = await suggestSpeakerNames(voicesOn(), id, {}, dependencies);
    expect(record.voice?.state).toBe("ready");
    const voices = (await voiceRecords.read(binding))!;
    expect(voices.speakers.map(({ speakerId, track }) => [speakerId, track])).toEqual([["S01", "microphone"], ["S02", "desktop"]]);
    expect((await view(voicesOn())).voice).toEqual({ state: "empty", message: SPEAKER_MESSAGES.voiceEmpty });
    // Ana was confirmed in another recording with the same voice: she is suggested here.
    await voiceProfiles.update((current) => reconcileVoiceProfiles(current, { ...voices, jobId: uuid(5) }, { S02: "Ana" }, "2026-10-21T13:00:00.000Z"));
    const suggested = await view(voicesOn());
    expect(suggested.voice).toEqual({ state: "ready" });
    expect(suggested.items.filter((item) => item.source === "voice")).toEqual([{ speakerId: "S02", source: "voice", self: false, name: "Ana", score: 1 }]);
    // Naming the owner here teaches the voice from this recording, with voices on only.
    const reviewed = { revision: { base: { diarizationSha256: binding.diarizationSha256 } }, diarization: { original: { transcriptSha256: binding.transcriptSha256 }, labels: { S01: "Dono da Gravação", S02: "Falante 2" } } } as unknown as ReviewedView;
    expect(await learnVoices(structuredClone(DEFAULT_CONFIG), job, reviewed, { records: voiceRecords, profiles: voiceProfiles })).toBe(false);
    expect(await learnVoices(voicesOn(), job, reviewed, { records: voiceRecords, profiles: voiceProfiles })).toBe(true);
    expect((await listVoicePeople(voiceProfiles)).map((person) => person.name)).toEqual(["Ana", "Dono da Gravação"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);

test("signatures come from the right tracks and a failing model is recorded, not thrown", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-voice-compute-"));
  try {
    const diarizationStore = new DiarizationStore(join(root, "diarization"));
    await diarizationStore.save(diarization());
    const media = join(root, "call.mkv");
    await synthesize(media);
    const context = (await readDiarizationContext(job, canonical, diarizationStore))!;
    const microphone = { generatedAt: "2026-10-21T12:31:00.000Z", state: "ready" as const, layout: "titled" as const, selfSpeakers: ["S01"], speakers: [] };
    const record = await computeVoiceRecord(media, context, microphone, installation, root, { embedder: fakeEmbedder });
    expect(record.speakers.map((speaker) => [speaker.speakerId, speaker.track, decodeEmbedding(speaker.embedding, DIM)!.indexOf(1)])).toEqual([["S01", "microphone", 2], ["S02", "desktop", 4]]);
    expect((await fs.readdir(root)).sort()).toEqual(["call.mkv", "diarization"]);
    const store = new SpeakerSuggestionStore(diarizationStore);
    const failing = { ...fakeEmbedder, embed: () => { throw new Error("model crashed"); } };
    const result = await suggestSpeakerNames(voicesOn(), id, {}, { getJob: async () => job, readCanonical: async () => canonical, store, mediaPath: async () => media,
      microphone: { selfName: async () => undefined }, voiceInstallation: async () => installation, voice: { embedder: failing },
      voiceRecords: new VoiceRecordStore(diarizationStore), voiceProfiles: new VoiceProfileStore(join(root, "voices")) });
    // The model failed for every speaker: that is recorded and explained, and nothing is saved as a signature.
    expect(result.voice).toMatchObject({ state: "failed", message: SPEAKER_MESSAGES.voiceFailed });
    expect(await new VoiceRecordStore(diarizationStore).read(context.binding)).toBeUndefined();
    expect((await readSpeakerSuggestionView(voicesOn(), job, canonical, { store, voiceInstallation: async () => installation })).voice).toEqual({ state: "failed", message: SPEAKER_MESSAGES.voiceFailed });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
