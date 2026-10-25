import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest, transcriptionIdentity } from "../../jobs/transcript-access";
import type { JobRecord, MeetingContext, RecordingSummary } from "../../jobs/types";
import type { MeetingArtifacts } from "../../knowledge/meetings";

/** Synthetic library on disk: job records, transcript.json and summary.json in a temporary XDG tree. */

export type FixtureSegment = { start: number; end: number; text: string; speaker?: string };
export type FixtureSummary = Omit<RecordingSummary, "version" | "provider" | "model">;

export type FixtureRoot = {
  root: string;
  stateDir: string;
  dataDir: string;
  mediaDir: string;
  restore: () => Promise<void>;
};

/** Points XDG_STATE_HOME / XDG_DATA_HOME at a fresh private temp tree (the readers resolve paths from them). */
export const makeRoot = async (): Promise<FixtureRoot> => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-index-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  const stateDir = join(root, "state"), dataDir = join(root, "data"), mediaDir = join(root, "media");
  await fs.mkdir(join(stateDir, "recording-cli", "jobs"), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(dataDir, "recording-cli"), { recursive: true, mode: 0o700 });
  await fs.mkdir(mediaDir, { recursive: true });
  process.env.XDG_STATE_HOME = stateDir;
  process.env.XDG_DATA_HOME = dataDir;
  return {
    root, stateDir, dataDir, mediaDir,
    restore: async () => {
      if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
      if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
      await fs.rm(root, { recursive: true, force: true });
    }
  };
};

export const transcriptOf = (segments: ReadonlyArray<FixtureSegment>) => ({
  version: 1, provider: "openai", model: "gpt-transcribe", language: "pt",
  text: segments.map((segment) => segment.text).join(" "),
  segments: segments.map((segment) => ({ ...segment }))
});

/** Writes a completed (by default) job with its artifacts. */
export const writeJob = async (fixture: FixtureRoot, input: {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  state?: JobRecord["state"];
  target?: JobRecord["target"];
  segments: FixtureSegment[];
  summary?: FixtureSummary | null;
  meeting?: MeetingContext;
}): Promise<JobRecord> => {
  const id = input.id ?? randomUUID();
  const name = input.name ?? `meeting-${id.slice(0, 8)}`;
  const sourcePath = join(fixture.mediaDir, `${name}.mkv`);
  const artifactDir = join(fixture.mediaDir, `${name}.recording`, id);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(sourcePath, "media");
  const createdAt = input.createdAt ?? "2026-10-01T13:00:00.000Z";
  const job: JobRecord = {
    version: 1, id, createdAt, updatedAt: input.updatedAt ?? createdAt,
    source: { originalName: `${name}.mkv`, mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) },
    transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
    summary: { provider: "openai", model: "gpt-4o-mini", ...(input.meeting ? { context: { meeting: input.meeting } } : {}) },
    sourcePath, artifactDir, target: input.target ?? "local", state: input.state ?? "completed"
  };
  await fs.writeFile(join(fixture.stateDir, "recording-cli", "jobs", `${id}.json`), JSON.stringify(job));
  await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify(transcriptOf(input.segments)));
  if (input.summary) await writeSummary(job, input.summary);
  return job;
};

/** The receipt that commits a transcript of a job still in progress (the readers require it). */
export const writeTranscriptReceipt = async (job: JobRecord): Promise<void> => {
  const raw = await fs.readFile(join(job.artifactDir, "transcript.json"), "utf8");
  await fs.writeFile(join(job.artifactDir, "transcript-receipt.json"),
    JSON.stringify({ version: 1, identity: transcriptionIdentity(job), transcriptSha256: artifactDigest(raw) }));
};

export const writeSummary = async (job: JobRecord, summary: FixtureSummary): Promise<void> => {
  await fs.writeFile(join(job.artifactDir, "summary.json"), JSON.stringify({ version: 1, provider: "openai", model: "gpt-4o-mini", ...summary }));
};

/** Rewrites the job record (e.g. a new updatedAt) without touching artifacts. */
export const touchJob = async (fixture: FixtureRoot, job: JobRecord, changes: Partial<JobRecord>): Promise<JobRecord> => {
  const updated = { ...job, ...changes };
  await fs.writeFile(join(fixture.stateDir, "recording-cli", "jobs", `${job.id}.json`), JSON.stringify(updated));
  return updated;
};

export const deleteJob = async (fixture: FixtureRoot, job: JobRecord): Promise<void> => {
  await fs.rm(join(fixture.stateDir, "recording-cli", "jobs", `${job.id}.json`), { force: true });
  await fs.rm(job.artifactDir, { recursive: true, force: true });
};

/** In-memory artifacts for unit tests of the builder (only the fields it reads). */
export const fakeArtifacts = (input: {
  segments: Array<FixtureSegment & { humanSpeakerEdited?: boolean }>;
  summary?: RecordingSummary | null;
  labels?: Record<string, string>;
  revision?: number;
}): MeetingArtifacts => {
  const transcript = transcriptOf(input.segments);
  const view = {
    original: { transcript, raw: JSON.stringify(transcript), path: "/x/transcript.json", provenance: {} },
    transcript,
    segments: input.segments.map((segment, index) => ({ id: `s${String(index).padStart(6, "0")}`, canonicalId: `x:${index}`, originalText: segment.text,
      text: segment.text, start: segment.start, end: segment.end, speakerId: segment.speaker, humanEdited: false, humanSpeakerEdited: Boolean(segment.humanSpeakerEdited) })),
    ...(input.labels ? { diarization: { original: { labels: input.labels }, turns: [], labels: input.labels } } : {}),
    revision: { version: 1, revision: input.revision ?? 0, base: { jobId: "x", mediaSha256: "a".repeat(64), transcriptArtifactSha256: "b".repeat(64),
      ...(input.labels ? { diarizationSha256: "c".repeat(64) } : {}) }, humanReviewed: false },
    notes: [], derivedStale: false, canUndo: false
  };
  return {
    summary: input.summary ?? null, transcript, view, summaryRaw: input.summary ? JSON.stringify(input.summary) : null, summaryPath: null,
    summaryProvenance: { state: input.summary ? "ready" : "unavailable", verification: input.summary ? "legacy-unverified" : "unavailable" },
    transcriptRaw: JSON.stringify(transcript), transcriptPath: "/x/transcript.json", transcriptProvenance: {}
  } as unknown as MeetingArtifacts;
};

export const summaryOf = (summary: FixtureSummary): RecordingSummary => ({ version: 1, provider: "openai", model: "gpt-4o-mini", ...summary });

/** Several plausible pt-BR meeting lines, so chunks reach their target size. */
export const filler = (topic: string, count: number, start = 0): FixtureSegment[] =>
  Array.from({ length: count }, (_value, index) => ({
    start: start + index * 10, end: start + index * 10 + 9,
    text: `Comentário ${index + 1} sobre ${topic}: seguimos alinhando os detalhes com calma e registrando os pontos combinados na reunião.`,
    speaker: index % 2 ? "S2" : "S1"
  }));
