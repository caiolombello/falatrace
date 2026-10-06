import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "../config/defaults";
import { JobStore, hashFile } from "../jobs/store";
import { runCommand } from "../jobs/command";
import { type JobRecord, type Transcript, validateJobId, validateTranscript } from "../jobs/types";
import { assertExistingJobArtifactPath, buildLibrary } from "../tui/library";
import { playLibraryEntry } from "../tui/media";
import { acquireSingleton } from "../runtime/singleton";
import { alignCanonicalTranscript } from "./alignment";
import { DIARIZATION_MODEL, DIARIZATION_AUDIO_ENCODING, diarizeAudioWithOpenAI, prepareDiarizationAudio, normalizeDiarizationResponse } from "./openai";
import { DiarizationStore, transcriptChecksum, validSpeakerLabel, type DiarizationResult, type DiarizationStatus } from "./store";
import { readReviewedView, saveRevision, type RevisionBase, type RevisionHead } from "../revisions";
import { getServiceLaunchCommand } from "../runtime/launcher";

export const readCanonicalTranscript = async (job: JobRecord): Promise<Transcript> => {
  if (job.state !== "completed") throw new Error("Aguarde a transcrição terminar antes de identificar os falantes");
  const path = join(job.artifactDir, "transcript.json");
  const stat = await assertExistingJobArtifactPath(job, path);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("A transcrição original é inválida");
  const transcript = validateTranscript(JSON.parse(await fs.readFile(path, "utf8")));
  if (!transcript.text.trim()) throw new Error("A gravação ainda não possui uma transcrição utilizável");
  return transcript;
};

export const resultStatus = (result: DiarizationResult): DiarizationStatus => ({
  // Generated is not acoustically validated. Lexical coverage is a diagnostic,
  // never a confidence score or evidence of a correct speaker assignment.
  state: "review", speakerCount: Object.keys(result.labels).length,
  matchedTokenRatio: result.alignment.matchedTokenRatio,
  message: "Identificação automática; revise as trocas de voz. A transcrição original foi preservada." + (result.ignoredZeroDurationTurns ? ` ${result.ignoredZeroDurationTurns} trechos sem duração foram omitidos da linha do tempo.` : "") + (result.ignoredEmptyTextTurns ? ` ${result.ignoredEmptyTextTurns} trechos sem texto foram omitidos.` : "")
});

const unitName = (id: string): string => `recording-cli-diarization-${validateJobId(id)}.service`;
const unitActive = async (id: string): Promise<boolean> => {
  const result = await runCommand("systemctl", ["--user", "show", unitName(id), "--property=ActiveState"], { timeoutMs: 5000 }).catch(() => ({ stdout: "" }));
  return /^ActiveState=(active|activating)$/m.test(result.stdout);
};
export const readDiarizationStatus = async (job: JobRecord, canonical: Transcript, store = new DiarizationStore()): Promise<DiarizationStatus> => {
  const result = await store.read(job.id, job.source.sha256, canonical.text);
  if (result) return resultStatus(result);
  const operation = await store.readOperation(job.id);
  if (!operation) return { state: "idle" };
  if (await unitActive(job.id)) return { state: "running", message: "Identificando falantes em segundo plano" };
  return { state: "failed", message: operation.state === "failed" ? operation.message : "A identificação foi interrompida. Tente novamente." };
};

export type QueueDiarizationDependencies = {
  getJob?: (id: string) => Promise<JobRecord>;
  readCanonical?: (job: JobRecord) => Promise<Transcript>;
  store?: Pick<DiarizationStore, "read" | "writeOperation">;
  unitActive?: (id: string) => Promise<boolean>;
  run?: typeof runCommand;
};

export const queueDiarization = async (id: string, dependencies: QueueDiarizationDependencies = {}): Promise<{ id: string; status: "queued" | "review"; unit?: string }> => {
  validateJobId(id);
  const lease = await acquireSingleton(`diarization-queue-${id}`);
  try {
    const job = await (dependencies.getJob || ((jobId) => new JobStore().get(jobId)))(id);
    const canonical = await (dependencies.readCanonical || readCanonicalTranscript)(job);
    const store = dependencies.store || new DiarizationStore();
    if (await store.read(id, job.source.sha256, canonical.text)) return { id, status: "review" };
    if (await (dependencies.unitActive || unitActive)(id)) return { id, status: "queued", unit: unitName(id) };
    await store.writeOperation({ version: 1, jobId: id, state: "running", startedAt: new Date().toISOString() });
    const command = getServiceLaunchCommand();
    try {
      await (dependencies.run || runCommand)("systemd-run", ["--user", `--unit=${unitName(id)}`, "--collect", "--property=Type=exec", "--property=Nice=10",
        "--property=RuntimeMaxSec=5400", "--property=TimeoutStopSec=30", "--property=UMask=0077", "--property=MemoryMax=1G",
        `--property=EnvironmentFile=-${join(homedir(), ".config/recording-cli/worker.env")}`,
        `--setenv=PATH=${process.env.PATH || ""}`, "--description=Identify recording speakers", "--", ...command, "diarization", "create", id], { timeoutMs: 15_000 });
    } catch {
      await store.writeOperation({ version: 1, jobId: id, state: "failed", startedAt: new Date().toISOString(), message: "Não foi possível iniciar a identificação de falantes" });
      throw new Error("Não foi possível iniciar a identificação de falantes");
    }
    return { id, status: "queued", unit: unitName(id) };
  } finally { await lease.release(); }
};

const createDiarizationOwned = async (
  config: AppConfig, id: string, dependencies: { diarize?: typeof diarizeAudioWithOpenAI } = {}
): Promise<DiarizationResult> => {
  validateJobId(id);
  const lease = await acquireSingleton(`diarization-create-${id}`);
  const store = new DiarizationStore();
  const startedAt = new Date().toISOString();
  let workDir: string | undefined;
  try {
    const job = await new JobStore().get(id);
    const canonical = await readCanonicalTranscript(job);
    const cached = await store.read(id, job.source.sha256, canonical.text);
    if (cached) return cached;
    await store.writeOperation({ version: 1, jobId: id, state: "running", startedAt });
    const entry = (await buildLibrary(config)).find((item) => item.sourcePath === job.sourcePath);
    if (!entry) throw new Error("A gravação não está disponível na biblioteca");
    const media = await playLibraryEntry(config, entry, job, { launch: async () => undefined });
    const before = await fs.lstat(media.path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== job.source.size || await hashFile(media.path) !== job.source.sha256) {
      throw new Error("A mídia diverge da transcrição original; a identificação foi cancelada");
    }
    workDir = await fs.mkdtemp(join(await store.ensureRoot(), `${id}.work-`));
    await fs.chmod(workDir, 0o700);
    const audio = await prepareDiarizationAudio(media.path, workDir);
    const after = await fs.lstat(media.path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new Error("A mídia mudou durante a leitura; a identificação foi cancelada");
    }
    const turns = await (dependencies.diarize || diarizeAudioWithOpenAI)(config, audio.path, audio.duration, canonical.language);
    const rawResponsePath = join(workDir, "provider-response.json");
    const rawResponse = await fs.readFile(rawResponsePath, "utf8").catch(() => undefined);
    const { ignoredZeroDurationTurns, ignoredEmptyTextTurns } = rawResponse ? normalizeDiarizationResponse(JSON.parse(rawResponse), audio.duration) : { ignoredZeroDurationTurns: 0, ignoredEmptyTextTurns: 0 };
    const alignment = alignCanonicalTranscript(canonical, turns);
    const labels = Object.fromEntries([...new Set(turns.map((turn) => turn.speaker))].map((speaker, index) => [speaker, `Falante ${index + 1}`]));
    const result: DiarizationResult = {
      version: 1, jobId: id, mediaSha256: job.source.sha256, transcriptSha256: transcriptChecksum(canonical.text),
      provider: "openai", model: DIARIZATION_MODEL, duration: audio.duration, generatedAt: new Date().toISOString(),
      labels, acousticValidation: "pending", audioEncoding: { ...DIARIZATION_AUDIO_ENCODING }, turns, alignment,
      ...(ignoredZeroDurationTurns ? { ignoredZeroDurationTurns } : {}), ...(ignoredEmptyTextTurns ? { ignoredEmptyTextTurns } : {})
    };
    const latest = await readCanonicalTranscript(await new JobStore().get(id));
    if (transcriptChecksum(latest.text) !== result.transcriptSha256) throw new Error("A transcrição mudou durante a identificação; tente novamente");
    await store.save(result);
    if (ignoredZeroDurationTurns || ignoredEmptyTextTurns) await fs.rename(rawResponsePath, join(store.root, `${id}.provider-response.json`));
    await fs.rm(join(store.root, `${id}.failed-response.json`), { force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    workDir = undefined;
    return result;
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const safe = /^(O áudio excede 24 MB|O diarizador |A conta OpenAI |O limite da conta OpenAI |A OpenAI não concluiu|Não foi possível (concluir|salvar a resposta de) diarização|A chave OpenAI |A mídia (diverge|mudou)|A transcrição mudou|A gravação ainda não possui)/.test(raw)
      ? raw.slice(0, 500) : "Não foi possível identificar os falantes. A transcrição original foi preservada.";
    await store.writeOperation({ version: 1, jobId: id, state: "failed", startedAt, message: safe });
    // Retain at most the latest provider diagnostic for this job. A successful
    // retry removes it; temporary audio and attempt directories never accumulate.
    if (workDir) {
      await fs.rename(join(workDir, "provider-response.json"), join(store.root, `${id}.failed-response.json`)).catch(() => undefined);
      await fs.rm(workDir, { recursive: true, force: true });
    }
    throw new Error(safe);
  } finally { await lease.release(); }
};

export const nameDiarizationSpeaker = async (id: string, speakerId: string, label: string, expected?: { expectedRevision: number; base: RevisionBase }): Promise<RevisionHead> => {
  validateJobId(id);
  if (!validSpeakerLabel(label)) throw new Error("Informe um nome de até 80 caracteres, sem quebras de linha");
  const job = await new JobStore().get(id);
  const view = await readReviewedView(job);
  return saveRevision(job, { expectedRevision: expected?.expectedRevision ?? view.revision.revision, base: expected?.base ?? view.revision.base,
    operations: [{ kind: "speaker-label", speakerId, label }] });
};

export const createDiarization = (...args: Parameters<typeof createDiarizationOwned>) =>
  withHeavyAdmission('diarization', args[1], () => createDiarizationOwned(...args), { onWait: cliAdmissionWait });
