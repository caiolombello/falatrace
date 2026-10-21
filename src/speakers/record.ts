import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../jobs/command";
import { acquireSingleton } from "../runtime/singleton";
import type { JobRecord, Transcript } from "../jobs/types";
import { DiarizationStore, transcriptChecksum, validateDiarizationResult, validSpeakerLabel, type DiarizationResult } from "../diarization/store";
import { analyzeMicrophone } from "./microphone";
import { SpeakerSuggestionStore, type MicrophoneRecord, type SpeakerSuggestionBinding } from "./store";
import { SPEAKER_MESSAGES } from "./messages";

// Kept free of the diarization service so that service can record the microphone
// right after a diarization without an import cycle.

export type DiarizationContext = { result: DiarizationResult; binding: SpeakerSuggestionBinding };

/** The current diarization of this job and the hash of its exact file, as revisions bind it. */
export const readDiarizationContext = async (job: JobRecord, canonical: Transcript, store = new DiarizationStore()): Promise<DiarizationContext | undefined> => {
  let raw: string;
  try {
    const path = store.resultPath(job.id);
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) return undefined;
    raw = await fs.readFile(path, "utf8");
  } catch { return undefined; }
  let result: DiarizationResult;
  try { result = validateDiarizationResult(JSON.parse(raw)); } catch { return undefined; }
  if (result.jobId !== job.id || result.mediaSha256 !== job.source.sha256 || result.transcriptSha256 !== transcriptChecksum(canonical.text)) return undefined;
  return { result, binding: { jobId: job.id, mediaSha256: job.source.sha256, transcriptSha256: result.transcriptSha256,
    diarizationSha256: createHash("sha256").update(raw).digest("hex") } };
};

/** Full name from the account (GECOS), used only as the suggested label for the owner. */
export const readSelfName = async (run: typeof runCommand = runCommand): Promise<string | undefined> => {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  try {
    const { stdout } = await run("getent", ["passwd", String(uid)], { timeoutMs: 5_000 });
    const name = (stdout.split("\n")[0]?.split(":")[4] || "").split(",")[0]!.trim();
    return validSpeakerLabel(name) ? name : undefined;
  } catch { return undefined; }
};

export type MicrophoneDependencies = { run?: typeof runCommand; selfName?: () => Promise<string | undefined>; signal?: AbortSignal };

/** Never throws: a failed analysis becomes a record the Studio can explain. */
export const buildMicrophoneRecord = async (
  mediaPath: string, turns: DiarizationResult["turns"], workRoot: string, dependencies: MicrophoneDependencies = {}
): Promise<MicrophoneRecord> => {
  const generatedAt = new Date().toISOString();
  let workDir: string | undefined;
  try {
    workDir = await fs.mkdtemp(join(workRoot, "speakers.work-"));
    await fs.chmod(workDir, 0o700);
    const analysis = await analyzeMicrophone(mediaPath, turns, workDir, { run: dependencies.run, signal: dependencies.signal });
    if (analysis.state === "unavailable") return { generatedAt, state: "unavailable", reason: analysis.reason };
    const selfName = analysis.selfSpeakers.length ? await (dependencies.selfName || readSelfName)() : undefined;
    return { generatedAt, state: "ready", layout: analysis.layout, selfSpeakers: analysis.selfSpeakers, speakers: analysis.speakers,
      ...(analysis.reason ? { reason: analysis.reason } : {}), ...(selfName ? { selfName } : {}) };
  } catch {
    return { generatedAt, state: "failed", message: SPEAKER_MESSAGES.microphoneFailed };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Replaces the microphone part and keeps a conversation result for the same diarization. */
export const saveMicrophoneRecord = async (binding: SpeakerSuggestionBinding, microphone: MicrophoneRecord, store = new SpeakerSuggestionStore()): Promise<void> => {
  const existing = await store.read(binding);
  await store.save({ version: 1, ...binding, microphone, ...(existing?.conversation ? { conversation: existing.conversation } : {}), ...(existing?.voice ? { voice: existing.voice } : {}) });
};

/** Best effort right after a diarization is saved: the result is already published, so
 * nothing here may fail it. Skips when a suggestion run holds the lock or the media changed. */
export const recordMicrophoneAfterDiarization = async (
  job: JobRecord, canonical: Transcript, mediaPath: string, expected: { size: number; mtimeMs: number; ino: number; dev: number },
  diarization: DiarizationStore, dependencies: MicrophoneDependencies = {}
): Promise<void> => {
  let lease: Awaited<ReturnType<typeof acquireSingleton>>;
  try { lease = await acquireSingleton(`speakers-${job.id}`); } catch { return; }
  try {
    const context = await readDiarizationContext(job, canonical, diarization);
    if (!context) return;
    const record = await buildMicrophoneRecord(mediaPath, context.result.turns, diarization.root, dependencies);
    const after = await fs.lstat(mediaPath);
    if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ino !== expected.ino || after.dev !== expected.dev) return;
    await saveMicrophoneRecord(context.binding, record, new SpeakerSuggestionStore(diarization));
  } catch { /* The diarization stays valid; the Studio can still ask for suggestions. */ }
  finally { await lease.release(); }
};
