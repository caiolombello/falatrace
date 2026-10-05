import { promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config/defaults";
import { JobStore } from "../jobs/store";
import { ArchiveStore, type ArchiveRecord } from "../archive/store";
import { invalidateAiContext } from "../knowledge/invalidation";
import { buildRemovalPlan, getRemovalRoots, type RemovalPlan } from "../lifecycle/removal-plan";
import {
  MEDIA_EXTENSIONS,
  type JobRecord,
  validateSummary
} from "../jobs/types";
import { readBoundedArtifact } from "../jobs/transcript-access";
import { formatSummaryMarkdown } from "../jobs/format";
import { summaryEvidenceMatches } from "../summary/evidence";
import { readCurrentReviewedSummary } from "../summary/reviewed";
import { assertCurrentJob, assertCurrentReviewedView, assertUnreviewedLegacyJob, formatReviewedTranscriptMarkdown,
  isUnreviewedLegacyAbsence, readCurrentReviewedView } from "../revisions/compat";
import type { ReviewedView } from "../revisions";

const MAX_LIBRARY_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_SUMMARY_METADATA_BYTES = 2 * 1024 * 1024;
const TITLE_CONCURRENCY = 8;
const GENERATED_MEDIA_NAMES = new Set(["audio_fast.mp3"]);

export type ArtifactKind = "transcript" | "summary";
export type ArtifactAvailability = Record<ArtifactKind, boolean>;

export type LibraryEntry = {
  sourcePath: string;
  relativePath: string;
  sourceExists: boolean;
  size: number;
  modifiedAt: number;
  jobs: JobRecord[];
  meetingTitle?: string;
  archive?: ArchiveRecord;
};

export type DeleteResult = {
  trashedPaths: string[];
  removedJobs: number;
  keptSharedArtifacts: boolean;
  /** Captured before Trash; no new-root candidate is executed by the legacy deletion path. */
  removalPlans: RemovalPlan[];
  scope: {
    local: "trash";
    remoteCopies: "preserved-not-contacted";
    archiveCatalog: "preserved";
    aiContext: "invalidated" | "not-found" | "failed";
    externalExports: "not-controlled";
    auxiliaryState: "preserved";
    revisions: "preserved";
    reviewedSummaries: "preserved";
    managedExports: "preserved";
    completeness: "legacy-local-only";
  };
};

const deletionScope = async (): Promise<DeleteResult["scope"]> => {
  // Publish invalidation before changing media or jobs. A failure leaves everything intact.
  const aiContext = await invalidateAiContext();
  if (aiContext === "failed") throw new Error("Cannot safely invalidate AI context; deletion cancelled");
  return { local: "trash", remoteCopies: "preserved-not-contacted", archiveCatalog: "preserved",
    aiContext, externalExports: "not-controlled", auxiliaryState: "preserved", revisions: "preserved", reviewedSummaries: "preserved", managedExports: "preserved", completeness: "legacy-local-only" };
};

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export const isPathInside = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
};

const assertManagedPath = (recordingsDir: string, path: string): void => {
  if (!isPathInside(recordingsDir, path) || resolve(path) === resolve(recordingsDir)) {
    throw new Error("Refusing to modify a path outside the recordings directory");
  }
};

export const assertExistingManagedPath = async (
  config: AppConfig,
  path: string
): Promise<void> => {
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  assertManagedPath(recordingsDir, path);
  try {
    const [realRecordingsDir, realPath] = await Promise.all([
      fs.realpath(recordingsDir),
      fs.realpath(path)
    ]);
    if (!isPathInside(realRecordingsDir, realPath) || realPath === realRecordingsDir) {
      throw new Error("Refusing to follow a managed path outside the recordings directory");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

const isGeneratedMedia = (name: string): boolean =>
  GENERATED_MEDIA_NAMES.has(name.toLowerCase()) || /^chunk[_-]\d+\.mp3$/i.test(name);

const scanRecordings = async (recordingsDir: string): Promise<Map<string, LibraryEntry>> => {
  const entries = new Map<string, LibraryEntry>();
  const pending = [recordingsDir];
  let visited = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const child of children) {
      visited += 1;
      if (visited > MAX_LIBRARY_FILES) {
        throw new Error(`Recording library exceeds ${MAX_LIBRARY_FILES} entries`);
      }
      const childPath = join(directory, child.name);
      if (child.isDirectory()) {
        if (!child.name.endsWith(".recording")) pending.push(childPath);
        continue;
      }
      if (
        !child.isFile() ||
        !MEDIA_EXTENSIONS.has(extname(child.name).toLowerCase()) ||
        isGeneratedMedia(child.name)
      ) {
        continue;
      }
      const stat = await fs.lstat(childPath);
      entries.set(resolve(childPath), {
        sourcePath: resolve(childPath),
        relativePath: relative(recordingsDir, childPath),
        sourceExists: true,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        jobs: []
      });
    }
  }
  return entries;
};

export const buildLibrary = async (
  config: AppConfig,
  store = new JobStore(),
  archiveStore = new ArchiveStore()
): Promise<LibraryEntry[]> => {
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  const entries = await scanRecordings(recordingsDir);
  const jobs = await store.list();


  for (const job of jobs) {
    const sourcePath = resolve(job.sourcePath);
    let entry = entries.get(sourcePath);
    if (!entry) {
      let sourceExists = false;
      let size = job.source.size;
      let modifiedAt = new Date(job.createdAt).getTime();
      try {
        const stat = await fs.lstat(sourcePath);
        sourceExists = stat.isFile() && !stat.isSymbolicLink();
        if (sourceExists) {
          size = stat.size;
          modifiedAt = stat.mtimeMs;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      entry = {
        sourcePath,
        relativePath: isPathInside(recordingsDir, sourcePath)
          ? relative(recordingsDir, sourcePath)
          : sourcePath,
        sourceExists,
        size,
        modifiedAt,
        jobs: []
      };
      entries.set(sourcePath, entry);
    }
    entry.jobs.push(job);
  }

  if (config.archive.enabled) {
    for (const archive of await archiveStore.list()) {
      if (!isPathInside(recordingsDir, archive.sourcePath) && !entries.has(archive.sourcePath)) continue;
      let entry = entries.get(archive.sourcePath);
      if (!entry) {
        entry = { sourcePath: archive.sourcePath, relativePath: relative(recordingsDir, archive.sourcePath),
          sourceExists: false, size: archive.source.size, modifiedAt: Date.parse(archive.createdAt), jobs: [] };
        entries.set(archive.sourcePath, entry);
      }
      entry.archive = archive;
    }
  }

  // Title reads are independent per entry; bound concurrency instead of reading
  // hundreds of reviewed views one after another. Within an entry, the newest
  // completed job with a title still wins.
  const pending = [...entries.values()];
  const workers = Array.from({ length: Math.min(TITLE_CONCURRENCY, pending.length) }, async () => {
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
      entry.jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      for (const job of entry.jobs) {
        if (job.state !== "completed") continue;
        const title = await readMeetingTitle(job, store);
        if (title) {
          entry.meetingTitle = title;
          break;
        }
      }
    }
  });
  await Promise.all(workers);
  return [...entries.values()].sort(
    (left, right) => right.modifiedAt - left.modifiedAt || left.relativePath.localeCompare(right.relativePath)
  );
};

export const getArtifactPath = (job: JobRecord, kind: ArtifactKind): string =>
  join(job.artifactDir, `${kind}.md`);

const assertJobArtifactPath = (job: JobRecord, path: string): void => {
  const expectedArtifactDir = join(
    dirname(job.sourcePath),
    `${parse(job.sourcePath).name}.recording`,
    job.id
  );
  if (
    resolve(job.artifactDir) !== resolve(expectedArtifactDir) ||
    dirname(resolve(path)) !== resolve(job.artifactDir) ||
    !["transcript.md", "transcript.json", "transcript-receipt.json", "summary.md", "summary.json"].includes(basename(path))
  ) {
    throw new Error("Job artifact path does not match its recording");
  }
};

export const assertExistingJobArtifactPath = async (
  job: JobRecord,
  path: string
): Promise<Stats> => {
  assertJobArtifactPath(job, path);
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error("Job artifact must not be a symbolic link");
  }
  const [realSourceDir, realArtifactDir, realPath] = await Promise.all([
    fs.realpath(dirname(job.sourcePath)),
    fs.realpath(job.artifactDir),
    fs.realpath(path)
  ]);
  const expectedRealArtifactDir = join(
    realSourceDir,
    `${parse(job.sourcePath).name}.recording`,
    job.id
  );
  if (
    resolve(realArtifactDir) !== resolve(expectedRealArtifactDir) ||
    !isPathInside(realArtifactDir, realPath)
  ) {
    throw new Error("Job artifact path does not match its recording");
  }
  return stat;
};

export const getManagedArtifactPath = (
  job: JobRecord,
  kind: ArtifactKind
): string => {
  const path = getArtifactPath(job, kind);
  assertJobArtifactPath(job, path);
  return path;
};

export const readArtifact = async (
  job: JobRecord,
  kind: ArtifactKind,
  store: Pick<JobStore, "get"> = new JobStore()
): Promise<string> => {
  let view: ReviewedView | undefined;
  try { view = await readCurrentReviewedView(job, store); }
  catch (error) {
    if (!await isUnreviewedLegacyAbsence(job, error)) {
      if (job.state !== "completed") { await assertCurrentJob(job, store); return kind === "summary" ? "Resumo ainda não disponível." : "Transcrição ainda não disponível."; }
      throw error;
    }
    await assertUnreviewedLegacyJob(job, store);
  }
  const unavailable = kind === "transcript" ? "Transcrição ainda não disponível." : "Resumo ainda não disponível.";
  if (kind === "summary" && view) {
    const summary = await readCurrentReviewedSummary(job, view);
    await assertCurrentReviewedView(job, view, store);
    if (summary) return `Revisão de entrada: ${summary.revision.revision}. Autoria: modelo; resumo regenerado sobre a transcrição revisada.\n\n${formatSummaryMarkdown(summary.summary)}`;
    if (job.state !== "completed") return unavailable;
    if (view.revision.humanReviewed) return "Resumo anterior à revisão humana; regenere o resumo para a revisão atual.";
  }
  if (kind === "summary" && job.state !== "completed") return unavailable;
  if (kind === "summary") {
    // Legacy Markdown-only/no-support publications remain compatible. Explicit
    // support that no longer matches cannot advertise the original as current.
    try {
      const metadata = join(job.artifactDir, "summary.json");
      await assertExistingJobArtifactPath(job, metadata);
      const original = validateSummary(JSON.parse(await readBoundedArtifact(metadata, MAX_SUMMARY_METADATA_BYTES)), job.summary.provider, job.summary.model);
      if (original.support && (!view || !summaryEvidenceMatches(original, job.source.sha256, view.original.transcript))) {
        if (view) await assertCurrentReviewedView(job, view, store);
        else await assertUnreviewedLegacyJob(job, store);
        return "Resumo sem vínculo com a transcrição atual; regenere o resumo.";
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (kind === "transcript" && view?.revision.humanReviewed) {
    await assertCurrentReviewedView(job, view, store);
    const markdown = formatReviewedTranscriptMarkdown(view);
    if (Buffer.byteLength(markdown) > MAX_ARTIFACT_BYTES) throw new Error("Reviewed transcript exceeds the 10 MiB display limit");
    return markdown;
  }
  if (job.state !== "completed") {
    if (view) await assertCurrentReviewedView(job, view, store);
    return view?.transcript.text || unavailable;
  }
  const path = getArtifactPath(job, kind);
  try {
    const stat = await assertExistingJobArtifactPath(job, path);
    if (!stat.isFile()) {
      throw new Error(`${kind}.md is not a regular file`);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`${kind}.md exceeds the 10 MiB display limit`);
    }
    const raw = await readBoundedArtifact(path, MAX_ARTIFACT_BYTES);
    if (view) await assertCurrentReviewedView(job, view, store);
    else await assertUnreviewedLegacyJob(job, store);
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (view) await assertCurrentReviewedView(job, view, store);
      else await assertUnreviewedLegacyJob(job, store);
      return kind === "transcript" ? view?.transcript.text || unavailable : unavailable;
    }
    throw err;
  }
};

export const getArtifactAvailability = async (
  job: JobRecord,
  store: Pick<JobStore, "get"> = new JobStore()
): Promise<ArtifactAvailability> => {
  const available = async (kind: ArtifactKind): Promise<boolean> => {
    try {
      const content = await readArtifact(job, kind, store);
      return content !== "Transcrição ainda não disponível." && content !== "Resumo ainda não disponível." &&
        content !== "Resumo anterior à revisão humana; regenere o resumo para a revisão atual." &&
        content !== "Resumo sem vínculo com a transcrição atual; regenere o resumo.";
    } catch { return false; }
  };
  const [transcript, summary] = await Promise.all([available("transcript"), available("summary")]);
  return { transcript, summary };
};

export const readMeetingTitle = async (
  job: JobRecord,
  store: Pick<JobStore, "get"> = new JobStore()
): Promise<string | undefined> => {
  const path = join(job.artifactDir, "summary.json");
  try {
    let view: ReviewedView | undefined;
    try { view = await readCurrentReviewedView(job, store); }
    catch (error) {
      if (!await isUnreviewedLegacyAbsence(job, error)) throw error;
      await assertUnreviewedLegacyJob(job, store);
    }
    if (view) {
      const current = await readCurrentReviewedSummary(job, view);
      if (current || view.revision.humanReviewed) {
        await assertCurrentReviewedView(job, view, store);
        return current?.summary.title;
      }
      // Falling through, the final check below covers this whole read window.
    }
    if (job.state !== "completed") return undefined;
    const stat = await assertExistingJobArtifactPath(job, path);
    if (!stat.isFile() || stat.size > MAX_SUMMARY_METADATA_BYTES) {
      return undefined;
    }
    const raw = await readBoundedArtifact(path, MAX_SUMMARY_METADATA_BYTES);
    if (Buffer.byteLength(raw) > MAX_SUMMARY_METADATA_BYTES) return undefined;
    const original = validateSummary(
      JSON.parse(raw),
      job.summary.provider,
      job.summary.model
    );
    if (original.support && (!view || !summaryEvidenceMatches(original, job.source.sha256, view.original.transcript))) return undefined;
    if (view) await assertCurrentReviewedView(job, view, store);
    else await assertUnreviewedLegacyJob(job, store);
    return original.title;
  } catch {
    return undefined;
  }
};

const getTrashRoot = (): string =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash");

const encodeTrashPath = (path: string): string =>
  path.split("/").map((part) => encodeURIComponent(part)).join("/");

const formatDeletionDate = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};

export const moveToTrash = async (
  source: string,
  trashRoot = getTrashRoot()
): Promise<string | null> => {
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error("Only regular files and directories can be moved to Trash");
  }

  const filesDir = join(trashRoot, "files");
  const infoDir = join(trashRoot, "info");
  await fs.mkdir(filesDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(infoDir, { recursive: true, mode: 0o700 });
  const originalName = basename(source) || "recording";
  let trashName = originalName;
  for (let suffix = 1; await pathExists(join(filesDir, trashName)) || await pathExists(join(infoDir, `${trashName}.trashinfo`)); suffix += 1) {
    trashName = `${originalName}.${suffix}`;
  }
  const destination = join(filesDir, trashName);
  const infoPath = join(infoDir, `${trashName}.trashinfo`);
  await fs.writeFile(
    infoPath,
    `[Trash Info]\nPath=${encodeTrashPath(resolve(source))}\nDeletionDate=${formatDeletionDate(new Date())}\n`,
    { mode: 0o600, flag: "wx" }
  );

  try {
    await fs.rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      await fs.rm(infoPath, { force: true });
      throw err;
    }
    try {
      if (stat.isDirectory()) {
        await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      } else {
        await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      }
      await fs.rm(source, { recursive: stat.isDirectory(), force: false });
    } catch (copyError) {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rm(infoPath, { force: true });
      throw copyError;
    }
  }
  return destination;
};

const pathsOverlap = (left: string, right: string): boolean =>
  resolve(left) === resolve(right) || isPathInside(left, right) || isPathInside(right, left);

export const deleteJobArtifacts = async (
  config: AppConfig,
  entry: LibraryEntry,
  job: JobRecord,
  store = new JobStore(),
  trashRoot?: string
): Promise<DeleteResult> => {
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  if (!entry.jobs.some((candidate) => candidate.id === job.id)) {
    throw new Error("Selected job does not belong to this recording");
  }
  if (resolve(entry.sourcePath) !== resolve(job.sourcePath)) {
    throw new Error("Selected job source does not match this recording");
  }
  assertManagedPath(recordingsDir, job.artifactDir);
  await assertExistingManagedPath(config, job.artifactDir);
  const artifactRoot = join(dirname(entry.sourcePath), `${parse(entry.sourcePath).name}.recording`);
  if (!isPathInside(artifactRoot, job.artifactDir) && resolve(job.artifactDir) !== resolve(artifactRoot)) {
    throw new Error("Job artifact path does not match the selected recording");
  }
  const overlapsAnotherJob = entry.jobs.some(
    (candidate) => candidate.id !== job.id && pathsOverlap(candidate.artifactDir, job.artifactDir)
  );
  const currentJob = await store.get(job.id);
  if (currentJob.sourcePath !== job.sourcePath || currentJob.artifactDir !== job.artifactDir || currentJob.source.sha256 !== job.source.sha256) throw new Error("Selected job changed; refresh the library before deletion");
  const removalPlans = [await buildRemovalPlan({ job: currentJob, roots: getRemovalRoots(recordingsDir, store), reason: "manual" })];
  const scope = await deletionScope();
  const trashedPaths: string[] = [];
  if (!overlapsAnotherJob) {
    const destination = await moveToTrash(job.artifactDir, trashRoot);
    if (destination) trashedPaths.push(destination);
  }
  await store.remove(job.id);
  return { trashedPaths, removedJobs: 1, keptSharedArtifacts: overlapsAnotherJob, removalPlans, scope };
};

export const deleteRecording = async (
  config: AppConfig,
  entry: LibraryEntry,
  store = new JobStore(),
  trashRoot?: string
): Promise<DeleteResult> => {
  const recordingsDir = resolve(expandHome(config.recordingsDir));
  assertManagedPath(recordingsDir, entry.sourcePath);
  await assertExistingManagedPath(config, entry.sourcePath);
  const artifactRoot = join(dirname(entry.sourcePath), `${parse(entry.sourcePath).name}.recording`);
  assertManagedPath(recordingsDir, artifactRoot);
  for (const job of entry.jobs) {
    if (!isPathInside(artifactRoot, job.artifactDir) && resolve(job.artifactDir) !== resolve(artifactRoot)) {
      throw new Error("Job artifact path does not match the selected recording");
    }
  }

  const selectedJobIds = new Set(entry.jobs.map((job) => job.id));
  const otherJobs = (await store.list()).filter(
    (job) => !selectedJobIds.has(job.id) && pathsOverlap(artifactRoot, job.artifactDir)
  );
  const removalPlans: RemovalPlan[] = [];
  for (const job of entry.jobs) {
    const currentJob = await store.get(job.id);
    if (currentJob.sourcePath !== job.sourcePath || currentJob.artifactDir !== job.artifactDir || currentJob.source.sha256 !== job.source.sha256) throw new Error("Selected job changed; refresh the library before deletion");
    removalPlans.push(await buildRemovalPlan({ job: currentJob, roots: getRemovalRoots(recordingsDir, store), reason: "manual" }));
  }
  const scope = await deletionScope();
  const trashedPaths: string[] = [];
  const sourceDestination = await moveToTrash(entry.sourcePath, trashRoot);
  if (sourceDestination) trashedPaths.push(sourceDestination);
  let keptSharedArtifacts = otherJobs.length > 0;
  if (!keptSharedArtifacts) {
    await assertExistingManagedPath(config, artifactRoot);
    const artifactDestination = await moveToTrash(artifactRoot, trashRoot);
    if (artifactDestination) trashedPaths.push(artifactDestination);
  } else {
    for (const job of entry.jobs) {
      if (otherJobs.some((candidate) => pathsOverlap(candidate.artifactDir, job.artifactDir))) {
        continue;
      }
      await assertExistingManagedPath(config, job.artifactDir);
      const destination = await moveToTrash(job.artifactDir, trashRoot);
      if (destination) trashedPaths.push(destination);
    }
  }
  for (const job of entry.jobs) await store.remove(job.id);
  return { trashedPaths, removedJobs: entry.jobs.length, keptSharedArtifacts, removalPlans, scope };
};
