import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { JobRecord } from "../jobs/types";
import { readBoundedArtifact } from "../jobs/transcript-access";
import { readReviewedView, withRevisionLease, RevisionConflictError, type RevisionBase } from "../revisions/index";
import { renderExport } from "./format";
import { assertExportOptions, canonicalJson, digest, MAX_EXPORT_BYTES, MAX_PREVIEW_CHARACTERS, readExportSnapshot, type ExportOptions, type ExportSnapshot } from "./snapshot";

export { renderExport } from "./format";
export { snapshotReviewedView, readExportSnapshot, canonicalJson, type ExportFormat, type ExportTrack, type ExportOptions } from "./snapshot";
export const exportRoot = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "exports");
export type ExportPreview = ExportOptions & { revision: number; base: RevisionBase; available: boolean; error?: string; sha256?: string; snapshotSha256?: string; bytes: number; warnings: string[]; display: string; displayTruncated: boolean };
export type ExportSaveInput = ExportOptions & { expectedRevision: number; expectedBase: RevisionBase; expectedSnapshotSha256: string };
export type ExportReceipt = ExportOptions & { revision: number; base: RevisionBase; path: string; manifestPath: string; snapshotPath: string; sha256: string; snapshotSha256: string; bytes: number; warnings: string[]; reused: boolean };

const sameBase = (left: RevisionBase, right: RevisionBase): boolean => canonicalJson(left) === canonicalJson(right);
const assertExpected = (snapshot: ExportSnapshot, options: ExportSaveInput): void => {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || options.expectedRevision !== snapshot.revision.revision || !sameBase(options.expectedBase, snapshot.revision.base)) throw new RevisionConflictError("A revisão ou a origem mudou; releia a prévia antes de exportar", snapshot.revision.revision);
};
const boundedDisplay = (text: string): string => {
  let end = Math.min(text.length, MAX_PREVIEW_CHARACTERS);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
};

export const previewExport = async (job: JobRecord, options: ExportOptions): Promise<ExportPreview> => {
  assertExportOptions(options);
  return withRevisionLease(job.id, async () => {
    const snapshot = await readExportSnapshot(job, options.track);
    const base = { ...options, revision: snapshot.revision.revision, base: snapshot.revision.base };
    try {
      const result = renderExport(snapshot, options.format), display = boundedDisplay(result.content);
      return { ...base, available: true, sha256: result.sha256, snapshotSha256: result.snapshotSha256, bytes: result.bytes, warnings: result.warnings, display, displayTruncated: display.length < result.content.length };
    } catch (error) {
      return { ...base, available: false, error: error instanceof Error ? error.message : "Exportação indisponível", bytes: 0, warnings: snapshot.warnings, display: "", displayTruncated: false };
    }
  });
};

/** Reject existing symlinks before creating children; never chmod a user's parent. */
const ensurePrivateDirectory = async (path: string): Promise<void> => {
  if (!path.startsWith("/") || resolve(path) !== path) throw new Error("Diretório de exportação inválido");
  let current = "/";
  for (const component of path.slice(1).split("/")) {
    current = join(current, component);
    let stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Diretório de exportação inseguro; dados existentes preservados");
  }
  const final = await fs.lstat(path);
  if ((final.mode & 0o077) !== 0 || await fs.realpath(path) !== path) throw new Error("O diretório de exportação deve ser privado");
};
const writeExclusive = async (path: string, content: string): Promise<void> => {
  const handle = await fs.open(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
};
const extension = { json: "json", markdown: "md", srt: "srt", vtt: "vtt" } as const;

export const saveExport = async (job: JobRecord, options: ExportSaveInput): Promise<ExportReceipt> => {
  assertExportOptions(options);
  return withRevisionLease(job.id, async () => {
    const snapshot = await readExportSnapshot(job, options.track);
    assertExpected(snapshot, options);
    const result = renderExport(snapshot, options.format);
    if (typeof options.expectedSnapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(options.expectedSnapshotSha256) || result.snapshotSha256 !== options.expectedSnapshotSha256) throw new RevisionConflictError("O conteúdo da prévia mudou; releia antes de exportar", snapshot.revision.revision);
    const root = exportRoot();
    await ensurePrivateDirectory(root);
    const directory = join(root, digest(canonicalJson({ version: 1, format: options.format, snapshotSha256: result.snapshotSha256, sha256: result.sha256 })));
    const name = "export." + extension[options.format];
    const path = join(directory, name), manifestPath = join(directory, "manifest.json"), snapshotPath = join(directory, "snapshot.json");
    const manifest = canonicalJson({ version: 1, format: options.format, track: options.track, jobId: job.id, revision: snapshot.revision,
      provenance: snapshot.source, snapshotSha256: result.snapshotSha256, sha256: result.sha256, bytes: result.bytes,
      hashDefinitions: { sha256: "SHA-256 of exported content UTF-8 bytes", snapshotSha256: "SHA-256 of snapshot.json UTF-8 bytes including final LF",
        transcriptArtifactSha256: "SHA-256 of original transcript artifact UTF-8 bytes (receipt contract)",
        summarySupportTranscriptSha256: "SHA-256 of JSON.stringify(validated original Transcript,null,2) UTF-8 bytes, no final LF",
        diarizationTranscriptSha256: "SHA-256 of original canonical text UTF-8 bytes only" },
      encoding: "UTF-8", framing: "LF", timestampRounding: "nearest-millisecond", cueTimingOrigin: "original-source-interval", warnings: result.warnings,
      cues: result.cues, omitted: result.omitted, contentFile: name, snapshotFile: "snapshot.json" });
    const receipt: ExportReceipt = { format: options.format, track: options.track, revision: snapshot.revision.revision, base: snapshot.revision.base,
      path, manifestPath, snapshotPath, sha256: result.sha256, snapshotSha256: result.snapshotSha256, bytes: result.bytes, warnings: result.warnings, reused: false };
    const existing = await fs.lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) throw new Error("Exportação existente insegura; preservada");
      for (const artifact of [path, snapshotPath, manifestPath]) {
        const stat = await fs.lstat(artifact);
        if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Exportação existente deixou de ser privada; arquivos preservados");
      }
      const [content, storedSnapshot, storedManifest] = await Promise.all([readBoundedArtifact(path, MAX_EXPORT_BYTES), readBoundedArtifact(snapshotPath, MAX_EXPORT_BYTES), readBoundedArtifact(manifestPath, MAX_EXPORT_BYTES)]);
      if (content !== result.content || storedSnapshot !== canonicalJson(snapshot) || storedManifest !== manifest) throw new Error("Exportação existente diverge do snapshot; arquivos preservados");
      return { ...receipt, reused: true };
    }
    const staging = await fs.mkdtemp(join(root, ".export-"));
    let reserved = false, committed = false;
    try {
      await writeExclusive(join(staging, name), result.content);
      await writeExclusive(join(staging, "snapshot.json"), canonicalJson(snapshot));
      await writeExclusive(join(staging, "manifest.json"), manifest);
      // The shared revision lease freezes human edits. Check original source again.
      const latest = await readReviewedView(job);
      if (latest.revision.revision !== snapshot.revision.revision || !sameBase(latest.revision.base, snapshot.revision.base)) throw new RevisionConflictError("A revisão ou a origem mudou durante a exportação; releia a prévia", latest.revision.revision);
      // Exclusive reservation never replaces even an existing empty directory.
      await fs.mkdir(directory, { mode: 0o700 });
      reserved = true;
      await fs.link(join(staging, name), path);
      await fs.link(join(staging, "snapshot.json"), snapshotPath);
      // Manifest is the commit marker; consumers only receive committed bundles.
      await fs.link(join(staging, "manifest.json"), manifestPath);
      committed = true;
      return receipt;
    } finally {
      // Only this uniquely created private staging directory is disposable.
      await fs.rm(staging, { recursive: true, force: true });
      if (reserved && !committed) await fs.rm(directory, { recursive: true, force: true });
    }
  });
};
