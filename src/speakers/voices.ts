import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { loadConfig } from "../config/load";
import { JobStore, writeJsonAtomic } from "../jobs/store";
import { runCommand } from "../jobs/command";
import { type JobRecord, type Transcript, validateJobId } from "../jobs/types";
import { DiarizationStore, validSpeakerLabel } from "../diarization/store";
import { VOICE_PACKAGE, readVoiceInstallation, type VoiceInstallation } from "../models/voice";
import { readReviewedView, type ReviewedView } from "../revisions";
import { acquireSingleton } from "../runtime/singleton";
import { probeAudioStreams, resolveTrackLayout } from "./microphone";
import { readDiarizationContext, type DiarizationContext } from "./record";
import { SpeakerSuggestionStore, type MicrophoneRecord, type SpeakerSuggestionBinding } from "./store";
import { VOICE_AUDIO_LIMITS, extractSpeakerAudio, planSpeakerAudio, type TrackIndexes, type VoiceTrack } from "./voice-audio";
import { VOICE_SAMPLE_RATE, loadVoiceEmbedder, type VoiceEmbedder } from "./voice-engine";

// Voice signatures: 512 numbers per diarized speaker, computed locally. A recording
// keeps one signature per speaker beside its diarization; a person's profile keeps
// signatures only from recordings where a human gave that speaker this name. The
// audio itself is never stored.

const SHA256 = /^[a-f0-9]{64}$/;
const SPEAKER = /^S\d{2,4}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 32 * 1024 * 1024;

export const VOICE_MATCH = {
  /** Cosine similarity with the closest confirmed sample of a person. */
  minimumScore: 0.55,
  /** Lead over the next person, so two similar voices never get a confident name. */
  minimumMargin: 0.12
} as const;
export const VOICE_PROFILE_LIMITS = { maxPeople: 500, maxSamplesPerPerson: 20 } as const;

export type VoiceModelInfo = { id: string; sha256: string; dim: number };
export type VoiceRecordSpeaker = { speakerId: string; track: VoiceTrack; seconds: number; embedding: string };
export type VoiceRecord = SpeakerSuggestionBinding & { version: 1; generatedAt: string; model: VoiceModelInfo; speakers: VoiceRecordSpeaker[] };
export type VoiceSample = { recordingId: string; speakerId: string; seconds: number; createdAt: string; embedding: string };
export type VoicePerson = { id: string; name: string; createdAt: string; updatedAt: string; samples: VoiceSample[] };
export type VoiceProfiles = { version: 1; model: VoiceModelInfo; people: VoicePerson[] };
export type VoiceMatch = { speakerId: string; personId: string; name: string; score: number; margin: number };

export const encodeEmbedding = (vector: Float32Array): string => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
export const decodeEmbedding = (value: unknown, dim: number): Float32Array | undefined => {
  if (typeof value !== "string" || value.length > 64 * 1024) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== dim * 4) return undefined;
  const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return vector.every((item) => Number.isFinite(item)) ? vector : undefined;
};
const date = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const validModel = (value: unknown): value is VoiceModelInfo => {
  const model = value as VoiceModelInfo | null;
  return !!model && typeof model.id === "string" && /^[a-z0-9-]{1,40}$/.test(model.id) && SHA256.test(model.sha256) && Number.isSafeInteger(model.dim) && model.dim >= 16 && model.dim <= 4096;
};

export const validateVoiceRecord = (value: unknown): VoiceRecord => {
  const record = value as VoiceRecord;
  if (!record || typeof record !== "object" || record.version !== 1 || !date(record.generatedAt) || !validModel(record.model) ||
    ![record.mediaSha256, record.transcriptSha256, record.diarizationSha256].every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
    !Array.isArray(record.speakers) || record.speakers.length > 100) throw new Error("Vozes da gravação inválidas");
  validateJobId(record.jobId);
  for (const speaker of record.speakers) {
    if (!speaker || typeof speaker.speakerId !== "string" || !SPEAKER.test(speaker.speakerId) || !["microphone", "desktop", "mix"].includes(speaker.track) ||
      typeof speaker.seconds !== "number" || !(speaker.seconds > 0 && speaker.seconds <= 600) || !decodeEmbedding(speaker.embedding, record.model.dim)) throw new Error("Vozes da gravação inválidas");
  }
  return record;
};

export const validateVoiceProfiles = (value: unknown): VoiceProfiles => {
  const profiles = value as VoiceProfiles;
  if (!profiles || typeof profiles !== "object" || profiles.version !== 1 || !validModel(profiles.model) || !Array.isArray(profiles.people) ||
    profiles.people.length > VOICE_PROFILE_LIMITS.maxPeople) throw new Error("Arquivo de vozes inválido");
  const ids = new Set<string>();
  for (const person of profiles.people) {
    if (!person || typeof person.id !== "string" || !UUID.test(person.id) || ids.has(person.id) || !validSpeakerLabel(person.name) || !date(person.createdAt) || !date(person.updatedAt) ||
      !Array.isArray(person.samples) || !person.samples.length || person.samples.length > VOICE_PROFILE_LIMITS.maxSamplesPerPerson) throw new Error("Arquivo de vozes inválido");
    ids.add(person.id);
    for (const sample of person.samples) {
      if (!sample || typeof sample.recordingId !== "string" || !UUID.test(sample.recordingId) || typeof sample.speakerId !== "string" || !SPEAKER.test(sample.speakerId) ||
        typeof sample.seconds !== "number" || !(sample.seconds > 0 && sample.seconds <= 600) || !date(sample.createdAt) ||
        !decodeEmbedding(sample.embedding, profiles.model.dim)) throw new Error("Arquivo de vozes inválido");
    }
  }
  return profiles;
};

const readBounded = async (path: string, max: number): Promise<string | undefined> => {
  const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("Arquivo de vozes inválido");
  return fs.readFile(path, "utf8");
};

/** One signature per speaker, beside the diarization it was computed from. */
export class VoiceRecordStore {
  constructor(readonly diarization = new DiarizationStore()) {}
  path(id: string): string { return join(this.diarization.root, `${validateJobId(id)}.voices.json`); }
  async read(binding: SpeakerSuggestionBinding): Promise<VoiceRecord | undefined> {
    try {
      const raw = await readBounded(this.path(binding.jobId), MAX_RECORD_BYTES);
      if (!raw) return undefined;
      const record = validateVoiceRecord(JSON.parse(raw));
      return record.jobId === binding.jobId && record.mediaSha256 === binding.mediaSha256 && record.transcriptSha256 === binding.transcriptSha256 &&
        record.diarizationSha256 === binding.diarizationSha256 ? record : undefined;
    } catch { return undefined; }
  }
  async save(record: VoiceRecord): Promise<void> {
    validateVoiceRecord(record);
    await this.diarization.ensureRoot();
    await writeJsonAtomic(this.path(record.jobId), record);
  }
}

export const voiceProfilesDir = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "recording-cli", "voices");

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// The Studio reads profiles on every detail refresh: parse and validate a file only when it changed.
let profileCache: { key: string; profiles: VoiceProfiles } | undefined;

/** The people FalaTrace can recognize. A damaged file is kept and refused, never replaced.
 * Returned profiles are shared and must be treated as read-only (changes go through update). */
export class VoiceProfileStore {
  constructor(readonly root = voiceProfilesDir()) {}
  get path(): string { return join(this.root, "profiles.json"); }
  async read(): Promise<VoiceProfiles | undefined> {
    const stat = await fs.lstat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat) return undefined;
    const key = `${this.path}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
    if (profileCache?.key === key) return profileCache.profiles;
    const raw = await readBounded(this.path, MAX_PROFILE_BYTES);
    if (raw === undefined) return undefined;
    const profiles = validateVoiceProfiles(JSON.parse(raw));
    profileCache = { key, profiles };
    return profiles;
  }
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Diretório de vozes inseguro");
  }
  /** Read-modify-write under one lock shared by the Studio, the CLI and background units. */
  async update(change: (current: VoiceProfiles | undefined) => VoiceProfiles | undefined): Promise<VoiceProfiles | undefined> {
    let lease: Awaited<ReturnType<typeof acquireSingleton>> | undefined;
    for (let attempt = 0; !lease; attempt++) {
      try { lease = await acquireSingleton("voice-profiles"); }
      catch (error) { if (attempt >= 100) throw error; await sleep(50); }
    }
    try {
      const current = await this.read();
      const next = change(current);
      if (next === current) return current;
      if (!next || !next.people.length) { await fs.rm(this.path, { force: true }); return undefined; }
      validateVoiceProfiles(next);
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PROFILE_BYTES) throw new Error("O arquivo de vozes excedeu o limite permitido");
      await this.ensureRoot();
      await writeJsonAtomic(this.path, next);
      return next;
    } finally { await lease.release(); }
  }
}

const unit = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
};
const dot = (a: Float32Array, b: Float32Array): number => { let sum = 0; for (let index = 0; index < a.length; index++) sum += a[index]! * b[index]!; return sum; };

/** Suggests a known person for each speaker; samples learned from this same recording are ignored. */
export const matchVoices = (record: VoiceRecord, profiles: VoiceProfiles | undefined): VoiceMatch[] => {
  if (!profiles || profiles.model.sha256 !== record.model.sha256 || profiles.model.dim !== record.model.dim) return [];
  const people = profiles.people.map((person) => ({
    person, samples: person.samples.filter((sample) => sample.recordingId !== record.jobId)
      .map((sample) => decodeEmbedding(sample.embedding, profiles.model.dim)).filter((vector): vector is Float32Array => !!vector).map(unit)
  })).filter((entry) => entry.samples.length);
  const matches: VoiceMatch[] = [];
  for (const speaker of record.speakers) {
    const vector = decodeEmbedding(speaker.embedding, record.model.dim);
    if (!vector) continue;
    const query = unit(vector);
    const scores = people.map((entry) => ({ person: entry.person, score: Math.max(...entry.samples.map((sample) => dot(query, sample))) })).sort((a, b) => b.score - a.score);
    const best = scores[0], second = scores[1]?.score ?? 0;
    if (best && best.score >= VOICE_MATCH.minimumScore && best.score - second >= VOICE_MATCH.minimumMargin) {
      matches.push({ speakerId: speaker.speakerId, personId: best.person.id, name: best.person.name, score: Number(best.score.toFixed(3)), margin: Number((best.score - second).toFixed(3)) });
    }
  }
  return matches;
};

/** A name a person gave on purpose: never the diarizer's default "Falante N". */
export const learnableVoiceLabel = (label: unknown): label is string => typeof label === "string" && validSpeakerLabel(label.trim()) && !/^Falante \d+$/u.test(label.trim());
const personKey = (name: string): string => name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");

/** Makes the profiles agree with this recording's current human labels: its samples are
 * replaced, so renaming or undoing a name moves or removes what was learned from it. */
export const reconcileVoiceProfiles = (
  current: VoiceProfiles | undefined, record: VoiceRecord, labels: Readonly<Record<string, string>>, now: string, newId: () => string = randomUUID
): VoiceProfiles | undefined => {
  if (current && (current.model.sha256 !== record.model.sha256 || current.model.dim !== record.model.dim)) return current;
  const profiles: VoiceProfiles = current ? structuredClone(current) : { version: 1, model: record.model, people: [] };
  const touched = new Set<string>();
  for (const person of profiles.people) {
    const kept = person.samples.filter((sample) => sample.recordingId !== record.jobId);
    if (kept.length !== person.samples.length) { person.samples = kept; touched.add(person.id); }
  }
  for (const speaker of record.speakers) {
    const label = labels[speaker.speakerId];
    if (!learnableVoiceLabel(label)) continue;
    const name = label.trim().replace(/\s+/g, " ");
    let person = profiles.people.find((candidate) => personKey(candidate.name) === personKey(name));
    if (!person) {
      if (profiles.people.length >= VOICE_PROFILE_LIMITS.maxPeople) continue;
      person = { id: newId(), name, createdAt: now, updatedAt: now, samples: [] };
      profiles.people.push(person);
    }
    person.samples.push({ recordingId: record.jobId, speakerId: speaker.speakerId, seconds: speaker.seconds, createdAt: now, embedding: speaker.embedding });
    person.samples = person.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-VOICE_PROFILE_LIMITS.maxSamplesPerPerson);
    touched.add(person.id);
  }
  for (const person of profiles.people) if (touched.has(person.id)) person.updatedAt = now;
  profiles.people = profiles.people.filter((person) => person.samples.length);
  return touched.size || !current ? profiles : current;
};

export type VoiceDependencies = { records?: VoiceRecordStore; profiles?: VoiceProfileStore; now?: () => string };

/** After any human change of speaker names: learn only while voice recognition is on. */
export const learnVoices = async (config: AppConfig, job: JobRecord, view?: ReviewedView, dependencies: VoiceDependencies = {}): Promise<boolean> => {
  if (!config.speakers.voices) return false;
  const reviewed = view || await readReviewedView(job);
  const diarizationSha256 = reviewed.revision.base.diarizationSha256;
  if (!reviewed.diarization || !diarizationSha256) return false;
  const record = await (dependencies.records || new VoiceRecordStore()).read({
    jobId: job.id, mediaSha256: job.source.sha256, transcriptSha256: reviewed.diarization.original.transcriptSha256, diarizationSha256
  });
  if (!record) return false;
  const labels = reviewed.diarization.labels;
  const now = (dependencies.now || (() => new Date().toISOString()))();
  await (dependencies.profiles || new VoiceProfileStore()).update((current) => reconcileVoiceProfiles(current, record, labels, now));
  return true;
};

/** For every place that changes speaker names: best effort, never fails the change itself. */
export const learnVoicesAfterChange = async (jobId: string): Promise<void> => {
  try {
    const { config } = await loadConfig();
    if (config.speakers.voices) await learnVoices(config, await new JobStore().get(jobId));
  } catch { /* The names were saved; the voices catch up on the next change or suggestion. */ }
};

export type VoiceComputeDependencies = { run?: typeof runCommand; embedder?: VoiceEmbedder; signal?: AbortSignal };

/** Cuts each speaker's clean audio and computes its signature. Needs the verified voice runtime. */
export const computeVoiceRecord = async (
  mediaPath: string, context: DiarizationContext, microphone: MicrophoneRecord | undefined, installation: VoiceInstallation,
  workRoot: string, dependencies: VoiceComputeDependencies = {}
): Promise<VoiceRecord> => {
  const separate = microphone?.state === "ready";
  const plans = planSpeakerAudio(context.result.turns, new Set(separate ? microphone.selfSpeakers : []), separate);
  const tracks: TrackIndexes = { mix: 0 };
  if (separate && plans.length) {
    const layout = resolveTrackLayout(await probeAudioStreams(mediaPath, dependencies.run, dependencies.signal));
    if (!layout) throw new Error("As faixas de áudio mudaram desde a análise do microfone.");
    tracks.microphone = layout.microphone;
    tracks.desktop = layout.desktop;
  }
  const embedder = dependencies.embedder || loadVoiceEmbedder(installation);
  const workDir = await fs.mkdtemp(join(workRoot, "voices.work-"));
  try {
    await fs.chmod(workDir, 0o700);
    const audio = plans.length ? await extractSpeakerAudio(mediaPath, plans, tracks, workDir, dependencies) : new Map<string, Float32Array>();
    const speakers: VoiceRecordSpeaker[] = [];
    let failures = 0;
    for (const plan of plans) {
      const samples = audio.get(plan.speakerId);
      if (!samples || samples.length < VOICE_SAMPLE_RATE * VOICE_AUDIO_LIMITS.minSpeakerSeconds) continue;
      try { speakers.push({ speakerId: plan.speakerId, track: plan.track, seconds: Number((samples.length / VOICE_SAMPLE_RATE).toFixed(1)), embedding: encodeEmbedding(embedder.embed(samples)) }); }
      catch { failures++; /* One unusable speaker never hides the others. */ }
    }
    // A model that fails for every speaker is broken, not a recording without voices.
    if (failures && !speakers.length) throw new Error("O modelo de voz não calculou nenhuma voz.");
    return { version: 1, ...context.binding, generatedAt: new Date().toISOString(), model: { id: VOICE_PACKAGE.id, sha256: embedder.modelSha256, dim: embedder.dim }, speakers };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Best effort right after a diarization, like the microphone analysis: never fails it. */
export const recordVoicesAfterDiarization = async (
  config: AppConfig, job: JobRecord, canonical: Transcript, mediaPath: string, expected: { size: number; mtimeMs: number; ino: number; dev: number },
  diarization: DiarizationStore, dependencies: VoiceComputeDependencies & { installation?: VoiceInstallation } = {}
): Promise<void> => {
  if (!config.speakers.voices) return;
  const installation = dependencies.installation || await readVoiceInstallation();
  if (!installation) return;
  let lease: Awaited<ReturnType<typeof acquireSingleton>>;
  try { lease = await acquireSingleton(`speakers-${job.id}`); } catch { return; }
  try {
    const context = await readDiarizationContext(job, canonical, diarization);
    if (!context) return;
    const microphone = (await new SpeakerSuggestionStore(diarization).read(context.binding))?.microphone;
    const record = await computeVoiceRecord(mediaPath, context, microphone, installation, diarization.root, dependencies);
    const after = await fs.lstat(mediaPath);
    if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ino !== expected.ino || after.dev !== expected.dev) return;
    await new VoiceRecordStore(diarization).save(record);
    await learnVoices(config, job, undefined, { records: new VoiceRecordStore(diarization) });
  } catch { /* The Studio can recompute voices with "Sugerir nomes…". */ }
  finally { await lease.release(); }
};

export type VoicePersonSummary = { id: string; name: string; samples: number; recordings: number; updatedAt: string };

export const listVoicePeople = async (store = new VoiceProfileStore()): Promise<VoicePersonSummary[]> => {
  const profiles = await store.read();
  return (profiles?.people || []).map((person) => ({
    id: person.id, name: person.name, samples: person.samples.length,
    recordings: new Set(person.samples.map((sample) => sample.recordingId)).size, updatedAt: person.updatedAt
  })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
};

/** Removes one person (or everyone) and every signature learned for them. */
export const deleteVoicePeople = async (target: { personId: string } | { all: true }, store = new VoiceProfileStore()): Promise<number> => {
  let removed = 0;
  await store.update((current) => {
    if (!current) return current;
    const people = "all" in target ? [] : current.people.filter((person) => person.id !== target.personId);
    removed = current.people.length - people.length;
    return removed ? { ...current, people } : current;
  });
  return removed;
};
