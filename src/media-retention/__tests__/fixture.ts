import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import type { ArchiveRecord } from "../../archive/store";
import { DIARIZATION_MODEL } from "../../diarization/openai";
import { DiarizationStore, transcriptChecksum, type DiarizationResult } from "../../diarization/store";
import { JobStore } from "../../jobs/store";
import { transcriptionIdentity } from "../../jobs/transcript-access";
import { type JobRecord, type Transcript, validateSummary } from "../../jobs/types";
import type { ProtonBackupRecord } from "../../proton/backup";
import type { RecordingSession } from "../../recording/session";
import { SpeakerSuggestionStore } from "../../speakers/store";
import { attachSummarySupport, buildSummaryEvidence } from "../../summary/evidence";
import type { CommandRunner, MediaRetentionDeps, MediaRetentionEntry } from "../plan";
import { MediaRetentionStore, recordingRootOf } from "../store";

export const DAY = 86_400_000;
export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export type FakeStream = { title?: string; channels: number; codec: string };
export type FakeMedia = { audio: FakeStream[]; video: number; duration: string };
export const THREE_TRACKS: FakeStream[] = [
  { title: "Mixed", channels: 2, codec: "opus" },
  { title: "Microphone", channels: 1, codec: "opus" },
  { title: "Desktop", channels: 2, codec: "opus" }
];

const probeJson = (media: FakeMedia): string => JSON.stringify({
  streams: [
    ...Array.from({ length: media.video }, (_, index) => ({ index, codec_type: "video", codec_name: "h264", disposition: { attached_pic: 0 } })),
    ...media.audio.map((stream, index) => ({ index: media.video + index, codec_type: "audio", codec_name: stream.codec, channels: stream.channels,
      ...(stream.title ? { tags: { title: stream.title } } : {}) }))
  ],
  format: { duration: media.duration }
});

/** ffmpeg/ffprobe stand-in: probes answer from fixtures, ffmpeg writes the last argument. */
export const fakeRunner = (options: { source?: FakeMedia; output?: FakeMedia; ffmpegFails?: boolean; ffprobeFails?: boolean } = {}) => {
  const source = options.source ?? { audio: THREE_TRACKS, video: 1, duration: "120.000000" };
  const output = options.output ?? { audio: source.audio, video: 0, duration: "119.980000" };
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const target = args[args.length - 1]!;
    if (command === "ffprobe") {
      if (options.ffprobeFails) throw new Error("ffprobe failed");
      return { stdout: probeJson(target.includes(".retained-audio-") ? output : source), stderr: "" };
    }
    if (command === "ffmpeg") {
      if (options.ffmpegFails) throw new Error("ffmpeg failed with code 1: synthetic");
      await fs.writeFile(target, "retained-audio-bytes:" + source.audio.map((stream) => stream.title ?? "").join(","), { flag: "wx" });
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { run, calls };
};

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

const writeFile = async (path: string, content: string | Buffer, mode = 0o600): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, content, { mode });
};

export const createFixture = async (options: { extension?: string; receipt?: boolean; summary?: "valid" | "stale" | "none"; transcriptText?: string } = {}) => {
  const root = await fs.mkdtemp(join(tmpdir(), "media-retention-"));
  const recordingsDir = join(root, "recordings");
  await fs.mkdir(recordingsDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(recordingsDir, `2026-10-01_10-00_Reuniao${options.extension ?? ".mkv"}`);
  await writeFile(sourcePath, Buffer.from("synthetic-video-".repeat(4096)), 0o644);
  const config: AppConfig = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = recordingsDir;
  config.media.retention = "transcript-only";
  config.media.graceDays = 1;
  const jobStore = new JobStore(join(root, "state/jobs"), join(root, "data/jobs"));
  const created = await jobStore.enqueue(config, sourcePath);
  const job = await jobStore.update(created.id, "completed");
  const transcript: Transcript = {
    version: 1, provider: job.transcription.provider, model: job.transcription.model, language: job.transcription.language,
    text: options.transcriptText ?? "Bom dia. Vamos revisar o projeto.",
    segments: options.transcriptText === "" ? [] : [{ start: 0, end: 2, text: "Bom dia." }, { start: 2, end: 5, text: "Vamos revisar o projeto." }]
  };
  const transcriptRaw = JSON.stringify(transcript, null, 2);
  await writeFile(join(job.artifactDir, "transcript.json"), transcriptRaw);
  await writeFile(join(job.artifactDir, "transcript.md"), "# Transcrição\n\nBom dia.\n");
  if (options.receipt !== false) {
    await writeFile(join(job.artifactDir, "transcript-receipt.json"), JSON.stringify({ version: 1, identity: transcriptionIdentity(job), transcriptSha256: sha(transcriptRaw) }));
  }
  if (options.summary !== "none") {
    const summary = attachSummarySupport(validateSummary({ title: "Reunião", overview: "Revisão do projeto.", topics: ["Projeto"], decisions: [], actionItems: [] },
      job.summary.provider, job.summary.model), buildSummaryEvidence(transcript, options.summary === "stale" ? sha("other-media") : job.source.sha256));
    await writeFile(join(job.artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(join(job.artifactDir, "summary.md"), "## Resumo\n\nRevisão do projeto.\n");
  }
  // Text-only state that retention must never touch.
  await writeFile(join(root, "data/revisions", `${job.id}.json`), JSON.stringify({ version: 1, synthetic: "revision journal" }));
  await writeFile(join(root, "data/exports", sha("bundle"), "manifest.json"), JSON.stringify({ version: 1, jobId: job.id }));
  await writeFile(join(root, "data/jobs", job.id, "transcript.json"), transcriptRaw);
  await writeFile(join(root, "data/jobs", job.id, "transcript-receipt.json"), "{}");

  const archives: ArchiveRecord[] = [];
  const protonBackups = new Map<string, ProtonBackupRecord>();
  const held = new Set<string>();
  const unitsActive = new Set<string>();
  let session: RecordingSession | null = null;
  let sessionError = false;
  let voiceInstalled = false;
  let now = Date.parse(job.updatedAt) + 3 * DAY;
  const runner = fakeRunner();
  const diarization = new DiarizationStore(join(root, "data/diarization"));
  const deps: MediaRetentionDeps = {
    jobStore,
    sessions: { read: async () => { if (sessionError) throw new Error("Invalid recording session"); return session; } },
    diarization,
    speakers: new SpeakerSuggestionStore(diarization),
    archives: { list: async () => archives },
    protonBackups: { get: async (id: string) => protonBackups.get(id) ?? null },
    reviewedSummaryRoot: join(root, "data/reviewed-summaries"),
    visualSessionsRoot: join(root, "state/visual-review/sessions"),
    archiveDataDir: join(root, "data/media-archive"),
    unitActive: async (unit: string) => unitsActive.has(unit),
    leaseHeld: async (name: string) => held.has(name),
    voiceInstalled: async () => voiceInstalled,
    run: (command, args, options) => runner.run(command, args, options),
    store: new MediaRetentionStore(),
    now: () => now
  };
  const entry: MediaRetentionEntry = { sourcePath, jobs: [job] };
  return {
    root, recordingsDir, sourcePath, recordingRoot: recordingRootOf(sourcePath), config, jobStore, job, transcript, transcriptRaw, deps, entry,
    archives, protonBackups, held, unitsActive, runner,
    setRunner(next: ReturnType<typeof fakeRunner>) { runner.run = next.run; runner.calls = next.calls; },
    setSession(value: RecordingSession | null) { session = value; },
    failSessions() { sessionError = true; },
    setVoiceInstalled(value: boolean) { voiceInstalled = value; },
    setNow(value: number) { now = value; },
    get now() { return now; },
    async cleanup() { await fs.rm(root, { recursive: true, force: true }); }
  };
};

export const archiveRecord = (fixture: Fixture, overrides: Partial<ArchiveRecord> = {}): ArchiveRecord => ({
  version: 1, id: "3f7c1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e", createdAt: "2026-10-01T10:00:00.000Z", sourcePath: fixture.sourcePath,
  source: { fileName: "source.mkv", size: fixture.job.source.size, mtimeMs: 1, sha256: fixture.job.source.sha256 },
  vaio: { state: "completed", path: "/srv/media/source.mkv", verifiedAt: "2026-10-01T11:00:00.000Z" },
  proton: { state: "completed", path: "/my-files/media/source.mkv", verifiedAt: "2026-10-01T12:00:00.000Z" },
  ...overrides
});

/** A diarization bound to this job's media and transcript, plus a microphone record for it. */
export const writeSpeakerWork = async (fixture: Fixture, microphone: "ready" | "failed" | "none" = "ready"): Promise<string> => {
  const text = fixture.transcript.text;
  const result: DiarizationResult = {
    version: 1, jobId: fixture.job.id, mediaSha256: fixture.job.source.sha256, transcriptSha256: transcriptChecksum(text), provider: "openai",
    model: DIARIZATION_MODEL, generatedAt: "2026-10-01T12:00:00.000Z", duration: 5, labels: { S01: "Falante 1" }, acousticValidation: "pending",
    turns: [{ start: 0, end: 5, text, speaker: "S01" }],
    alignment: { text, matchedTokenRatio: 1, unassignedTokenCount: 0, segments: [{ start: 0, end: 5, charStart: 0, charEnd: text.length, text, speaker: "S01" }] }
  };
  const store = new DiarizationStore(join(fixture.root, "data/diarization"));
  await store.save(result);
  const raw = await fs.readFile(store.resultPath(fixture.job.id), "utf8");
  const binding = { jobId: fixture.job.id, mediaSha256: fixture.job.source.sha256, transcriptSha256: result.transcriptSha256, diarizationSha256: sha(raw) };
  if (microphone !== "none") {
    await new SpeakerSuggestionStore(store).save({ version: 1, ...binding,
      microphone: microphone === "ready" ? { generatedAt: "2026-10-01T12:01:00.000Z", state: "unavailable", reason: "no-separate-tracks" }
        : { generatedAt: "2026-10-01T12:01:00.000Z", state: "failed", message: "Falhou" } });
  }
  return binding.diarizationSha256;
};

/** Derived copies retention must purge: Proton restore cache, visual frames and temporary audio. */
export const writeDerivedCopies = async (fixture: Fixture, archiveId = "3f7c1c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"): Promise<{ restored: string; frames: string; ledger: string; workAudio: string[]; otherFrames: string }> => {
  const restored = join(fixture.root, "data/media-archive/restored", archiveId);
  await writeFile(join(restored, "source.mkv"), "full-restored-copy");
  const key = sha("visual-session");
  const sessionDir = join(fixture.root, "state/visual-review/sessions", key);
  const ledger = join(sessionDir, ".visual-session.json");
  await writeFile(ledger, JSON.stringify({ ledger: { version: 1, key, mediaSha256: fixture.job.source.sha256 }, sha256: "x" }));
  const frames = join(sessionDir, "frames");
  await writeFile(join(frames, sha("plan"), "frame-0.jpg"), "jpeg");
  const otherKey = sha("other-session");
  const otherDir = join(fixture.root, "state/visual-review/sessions", otherKey);
  await writeFile(join(otherDir, ".visual-session.json"), JSON.stringify({ ledger: { version: 1, key: otherKey, mediaSha256: sha("another") }, sha256: "x" }));
  const otherFrames = join(otherDir, "frames");
  await writeFile(join(otherFrames, sha("plan"), "frame-0.jpg"), "other-jpeg");
  const work = join(fixture.root, "data/jobs", fixture.job.id);
  const workAudio = [join(work, "audio.mp3"), join(work, "audio.wav"), join(work, "chunk-0.mp3"), join(work, ".transcription-abc123", "audio.wav")];
  for (const path of workAudio) await writeFile(path, "temporary-audio");
  return { restored, frames, ledger, workAudio, otherFrames };
};

/** sha256 of every file under root (symlinks by target), for byte-identity checks. */
export const treeHashes = async (root: string, skip: (path: string) => boolean = () => false): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = join(directory, name);
      if (skip(path)) continue;
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) result[path] = `link:${await fs.readlink(path)}`;
      else if (stat.isDirectory()) await visit(path);
      else result[path] = `${sha(await fs.readFile(path))}:${(stat.mode & 0o777).toString(8)}`;
    }
  };
  await visit(root);
  return result;
};

export const jobRecordRaw = async (fixture: Fixture, job: JobRecord = fixture.job): Promise<string> =>
  fs.readFile(join(fixture.root, "state/jobs", `${job.id}.json`), "utf8");
