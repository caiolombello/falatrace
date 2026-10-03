import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { JobStore } from "./store";
import { type JobManifest, type JobRecord, type Transcript, validateTranscript } from "./types";
import { assertExistingJobArtifactPath } from "../tui/library";

export const artifactDigest = (raw: string): string => createHash("sha256").update(raw).digest("hex");
export const transcriptionIdentity = (job: JobManifest): string => artifactDigest(JSON.stringify({ media: job.source.sha256, transcription: job.transcription }));
export type TranscriptProvenance = {
  origin: "published" | "work";
  receipt: "verified" | "legacy-unverified";
  mediaSha256: string;
  transcriptSha256: string;
  receiptSha256?: string;
};
export type TranscriptArtifact = { transcript: Transcript; raw: string; path: string; provenance: TranscriptProvenance };

/** Bounded, no-follow read; detect changes while reading and reject unsafe files. */
export const readBoundedArtifact = async (path: string, maximum: number): Promise<string> => {
  const existing = await fs.lstat(path);
  if (existing.isSymbolicLink()) throw new Error("Artifact must not be a symbolic link");
  if (!existing.isFile() || existing.size > maximum) throw new Error("Unsafe or oversized artifact");
  const handle = await fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Unsafe or oversized artifact");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Artifact changed during reading");
    return buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
};

const assertWorkDirectory = async (store: JobStore, job: JobRecord): Promise<string> => {
  const path = store.getWorkDir(job.id);
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe transcript work directory");
  if (resolve(await fs.realpath(path)) !== join(await fs.realpath(store.dataDir), job.id)) throw new Error("Transcript work directory escaped job store");
  return path;
};

/** A transcript can be ready even when the overall job failed later in summary.
 * Work checkpoints require a verified receipt. Existing completed publications
 * without receipts remain readable with explicit legacy provenance. No writes. */
export const readTranscriptArtifact = async (job: JobRecord, store = new JobStore()): Promise<TranscriptArtifact> => {
  type Selection = { origin: TranscriptProvenance["origin"]; directory: string; path: string };
  const published: Selection = { origin: "published", directory: job.artifactDir, path: join(job.artifactDir, "transcript.json") };
  const selectWork = async (): Promise<Selection> => {
    const directory = await assertWorkDirectory(store, job);
    const path = join(directory, "transcript.json");
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe transcript work artifact");
    return { directory, path, origin: "work" };
  };
  let selected: Selection;
  // A failed publication can leave transcript.json without its receipt. The
  // checkpoint is the committed transcript for incomplete local jobs.
  if (job.target === "local" && job.state !== "completed") {
    try { selected = await selectWork(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await assertExistingJobArtifactPath(job, published.path);
      selected = published;
    }
  } else {
    try { await assertExistingJobArtifactPath(job, published.path); selected = published; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || job.target !== "local") throw error;
      selected = await selectWork();
    }
  }
  const { origin, directory, path } = selected;
  const raw = await readBoundedArtifact(path, 12 * 1024 * 1024);
  const transcript = validateTranscript(JSON.parse(raw));
  if (!transcript.text.trim() && !transcript.segments.some(segment => segment.text.trim())) throw new Error("A gravação ainda não possui uma transcrição utilizável");
  const receiptPath = join(directory, "transcript-receipt.json");
  let receiptRaw: string | undefined;
  try {
    if (origin === "published") await assertExistingJobArtifactPath(job, receiptPath);
    receiptRaw = await readBoundedArtifact(receiptPath, 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || origin === "work" || job.state !== "completed") throw error;
  }
  const transcriptSha256 = artifactDigest(raw);
  if (receiptRaw) {
  if (transcript.provider !== job.transcription.provider || transcript.model !== job.transcription.model || transcript.language !== job.transcription.language) throw new Error("Transcript settings mismatch");
    const receipt = JSON.parse(receiptRaw);
    if (receipt.version !== 1 || receipt.identity !== transcriptionIdentity(job) || receipt.transcriptSha256 !== transcriptSha256) throw new Error("Transcript receipt identity/hash mismatch");
  }
  return { transcript, raw, path, provenance: { origin, receipt: receiptRaw ? "verified" : "legacy-unverified", mediaSha256: job.source.sha256, transcriptSha256, ...(receiptRaw ? { receiptSha256: artifactDigest(receiptRaw) } : {}) } };
};

export const readArtifactStates = async (job: JobRecord, store = new JobStore()) => {
  const transcript = await readTranscriptArtifact(job, store).catch(() => undefined);
  let summaryReady = false;
  if (job.state === "completed") {
    try {
      const path = join(job.artifactDir, "summary.json");
      await assertExistingJobArtifactPath(job, path);
      const { validateSummary } = await import("./types");
      const summary=validateSummary(JSON.parse(await readBoundedArtifact(path, 2 * 1024 * 1024)), job.summary.provider, job.summary.model);
      const { summaryEvidenceMatches }=await import("../summary/evidence");
      const { hasSavedRevision }=await import("../revisions/service");
      if(await hasSavedRevision(job.id)||(summary.support&&(!transcript||!summaryEvidenceMatches(summary,job.source.sha256,transcript.transcript))))throw new Error("Summary evidence is stale or unavailable");
      summaryReady = true;
    } catch { /* do not advertise an unavailable artifact */ }
  }
  const current=await import("../summary/reviewed").then(module=>module.readReviewedSummary(job)).catch(()=>undefined);
  if(current)summaryReady=true;
  return { transcript: { state: transcript ? "ready" : "unavailable", ...(transcript ? { path: transcript.path, provenance: transcript.provenance } : {}) }, summary: { state: summaryReady ? "ready" : job.state === "failed" && transcript ? "failed" : "unavailable" } };
};
