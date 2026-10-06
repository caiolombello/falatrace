import { readTranscriptArtifact, readArtifactStates, artifactDigest, type TranscriptArtifact } from "../jobs/transcript-access";
import { recordingPresentation } from "./recording-presentation";
import { readReviewedView, saveRevision, undoRevision, withRevisionLease, RevisionConflictError, type RevisionBase, type RevisionOperation, type ReviewedView } from "../revisions";
import { readCurrentReviewedView, assertCurrentReviewedView } from "../revisions/compat";
import { readCurrentReviewedSummary, type ReviewedSummaryArtifact } from "../summary/reviewed";
import { StudioSummaryFlow } from "../summary/studio";
import type { AppConfig } from "../config/defaults";
const studioSummary = new StudioSummaryFlow();
import { formatSummaryMarkdown } from "../jobs/format";
import { previewExport, saveExport } from "../export";
import { version as productVersion } from "../../package.json";
import { readHeavyStatus } from '../runtime/heavy-admission';
/** JSONL bridge for the desktop application. */
import { promises as fs } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { loadConfig } from "../../src/config/load";
import { configureDefaultAudio } from "../../src/config/audio";
import { acquireSingleton } from "../../src/runtime/singleton";
import { captureHoldsDevices, readCaptureStatus, startCapture, stopCapture } from "../../src/recording/application";
import { queueSelectedJob } from "../../src/jobs/queue";
import { planRecordingProcessing, runRecordingProcessing } from "../jobs/manual";
import { readMeetingContext } from "../../src/knowledge/meetings";
import { getDefaultJobStateDir, hashFile, JobStore } from "../../src/jobs/store";
import type { JobRecord, Transcript } from "../../src/jobs/types";
import { runCommand } from "../../src/jobs/command";
import { buildLibrary, readArtifact, assertExistingJobArtifactPath, assertExistingManagedPath, type LibraryEntry } from "../../src/tui/library";
import { queuePlayback, readPlayback } from "./playback";
import { readLibrarySnapshot, writeLibrarySnapshot } from "./library-snapshot";
import { readReleaseInfo } from "./release-info";
import { parsePlayerTranscript, type PlayerTranscript } from "../../src/player/transcript";
import { findAlignedSubtitles } from "../../src/subtitles/aligned";
import { queueAlignedSubtitles } from "../subtitles/service";
import { subtitleUnitStatus } from "../subtitles/status";
import { TimeEntryStore } from "../../src/timesheet/store";
import { formatHours } from "../../src/timesheet/format";
import { ArchiveStore } from "../../src/archive/store";
import { DiarizationStore, type DiarizationResult } from "../../src/diarization/store";
import { nameDiarizationSpeaker, queueDiarization, readCanonicalTranscript, readDiarizationStatus, resultStatus } from "../../src/diarization/service";

import { readOnboarding, saveLocalOnboarding } from "../config/onboarding";
import { SETTINGS_OPERATIONS, handleSettingsOperation, isDisplayableSettingsError, settingsErrorMessage, type SettingsOperation } from "./settings-bridge";
import { prepareMockFramePreview } from "../visual/mock-preview";
import { MockFrameReview } from "../visual/review-flow";
const frameReview = new MockFrameReview();
import {StudioVisualFlow,type StudioSource} from '../visual/studio-flow';
import {AgentStudio} from '../agent-context/studio';
import { buildAssistantConnection } from '../agent-context/connect';
const agentStudio=new AgentStudio();
import {ProviderStudio} from '../provider-analysis/studio';
const providerStudio=new ProviderStudio();
const studioFrames=new StudioVisualFlow(join(dirname(getDefaultJobStateDir()),'visual-review'));
export const handleRealFrameOperation=async(flow:StudioVisualFlow,request:Request,source:StudioSource)=>{
 const p=request.payload||{};
 if(request.op==='frames-check-models')return flow.check(source.config,p.visionModel||'',p.summaryModel||'');
 if(request.op==='frames-cancel')return flow.cancel(source.key,p.previewId||'',p.scopeId);
 if(request.op==='frames-confirm')return flow.confirm(source,p.previewId||'',p.consent===true,p.consentKey||'');
 if(request.op==='frames-scope')return flow.scope(source,p.startSeconds??NaN,p.endSeconds??NaN);
 if(request.op==='frames-plan'){if(!p.scopeId)throw Error('Explicit reviewed transcript scope required');return flow.plan(source,p.capabilityId||'',p.consentTranscript===true,p.scopeId);}
 if(request.op==='frames-preview-plan')return flow.previewPlan(source,p.planId||'');
 if(request.op==='frames-preview')return flow.preview(source,p.capabilityId||'',p.question||'',p.seconds??NaN);
 throw Error('Unknown visual operation');
};

import { setAutomationPaused } from "../calls/control";

const OPERATIONS = ["summary-plan", "summary-run", "summary-cancel","provider-authorize","provider-analyze","provider-cancel","agent-cancel","agent-status","agent-authorize","agent-pause","agent-resume","agent-revoke","agent-frames","agent-connect","recording-process-plan","recording-process","processing-status", "ux-capabilities", "list-cached", "onboarding-read", "onboarding-save-local", ...SETTINGS_OPERATIONS, "frames-check-models", "frames-scope", "frames-plan", "frames-preview-plan", "frames-preview", "frames-confirm", "frames-cancel", "list", "detail", "resolve", "playback-status", "subtitles", "diarization", "automation-pause", "automation-resume", "capture-status", "capture-start", "capture-stop", "capture-recover", "audio-defaults", "jobs-list", "job-process", "job-retry", "diarization-name", "context-meeting", "revision-save", "revision-undo", "export-preview", "export-save"] as const;
export type Request = { id: number; op: typeof OPERATIONS[number]; key?: string; payload?: {maxRequests?:number;expectedRevision?:number;expectedSnapshotSha256?:string;base?:RevisionBase;expectedBase?:RevisionBase;operations?:RevisionOperation[];format?:"json"|"markdown"|"srt"|"vtt";track?:"transcript"|"diarization";provider?:'openai'|'google';model?:string;analysis?:import('../provider-analysis/contracts').AnalysisOptions;context?:boolean;maxFrames?:number;maxBytes?:number;requestId?:string;grantId?:string;recipientId?:string;data?:Array<'context'|'frames'>;timestamps?:number[]; title?: string; speakerId?: string; label?: string; maxCharacters?: number; query?: string; offset?: number; question?: string; seconds?: number; previewId?: string; consent?: boolean; revision?: string; visionModel?: string; summaryModel?: string; capabilityId?: string; consentKey?: string; planId?:string; consentTranscript?:boolean; scopeId?:string; startSeconds?:number; endSeconds?:number; changes?: Record<string, unknown>; action?: string; audioSource?: string; microphone?: string; desktop?: string; name?: string; value?: string; service?: string; backup?: string; path?: string; kind?: string; ollamaUrl?: string; initialize?: boolean; client?: string } };
type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
const MAX_LINE = 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/i;
let libraryCache: { at: number; config: Awaited<ReturnType<typeof loadConfig>>["config"]; entries: LibraryEntry[] } | undefined;
let libraryLoad: Promise<NonNullable<typeof libraryCache>> | undefined;

const PROCESS_KNOWN_ERRORS = [
  "Confirme o destino antes de processar.", "A gravação ou as configurações mudaram. Revise o destino de novo.",
  "Esta gravação já foi processada.", "O processamento já está em andamento.", "O arquivo original não está neste computador.",
  "O processamento está marcado como remoto, mas nenhum worker foi configurado.",
  "Não foi possível ler a gravação. Confira a permissão do arquivo e tente de novo."
];
const emit = (response: Response): void => { process.stdout.write(`${JSON.stringify(response)}\n`); };
const safeError = (op: string, error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const known = [
    "id deve ser um inteiro positivo", "key é obrigatório para esta operação",
    "Gravação não encontrada na biblioteca", "Outra resolução de reprodução está em andamento",
    "A gravação precisa ter uma cópia concluída no VAIO", "linha JSON excede 1 MiB",
    "Informe o id UUID da gravação", "Aguarde a transcrição terminar antes de identificar os falantes",
    "A transcrição original é inválida", "A gravação ainda não possui uma transcrição utilizável",
    "Já existe uma captura gerenciada. Finalize-a antes de iniciar outra.",
    "Há uma gravação legada em andamento. Pare-a antes de iniciar outra; o estado foi preservado.",
    "Não foi possível iniciar a captura. Verifique o backend e as fontes de áudio configuradas.",
    "Não foi possível finalizar a gravação. O estado foi preservado para nova tentativa.",
    "Aguarde a operação de captura em andamento.", "Não altere o áudio durante uma captura ativa.",
    "O job falhou. Use a ação de tentar novamente para colocá-lo na fila.",
    "O job selecionado é inválido ou não está mais disponível.", "Não foi possível colocar o job selecionado na fila.",
    "Informe um nome de até 80 caracteres, sem quebras de linha", "Falante não encontrado nesta gravação",
    "A gravação ainda não possui contexto disponível.", "Muitas operações pendentes; tente novamente."
  ];
  if (known.includes(text)) return text;
  if (op.startsWith("settings-")) return isDisplayableSettingsError(op, text) ? text : settingsErrorMessage(op);
  if (op.startsWith("summary-")) return error instanceof RevisionConflictError ? "A revisão ou sua origem mudou. Prepare um novo plano antes de gerar; o original foi preservado." : "Resumo não confirmado ou cancelado. Confira modelo local, destino, limite e consentimento. Não repita uma tentativa incerta; releia antes de preparar outro plano. Original preservado.";
  if (op.startsWith("revision-")) return error instanceof RevisionConflictError ? "A revisão ou sua origem mudou. Releia antes de salvar; sua edição não foi aplicada." : "Não foi possível confirmar a revisão. Releia o resultado antes de tentar novamente.";
  if (op.startsWith("export-")) return "Não foi possível confirmar a exportação. Atualize a prévia e confira a origem e a revisão antes de salvar novamente.";
  if(op.startsWith("provider-"))return "Análise indisponível ou recusada. Confira destino/modelo, autorização e orçamento; não repita automaticamente uma tentativa incerta.";
  if(op.startsWith("agent-"))return "Acesso recusado ou indisponível. Confira escopo, destinatário, pausa/revogação e orçamento. Dados preservados.";
  if (op.startsWith("frames-")) return "Pedido visual recusado/cancelado. Confira horário, preview, consentimento e budget; verifique modelos locais/capabilities, identidade da origem, consentimento e limite persistente. Dados preservados.";
  if (op === "onboarding-save-local") return "Não foi possível confirmar o salvamento. Confira a configuração após reler; ela pode ser inválida, insegura ou ter sido alterada.";
  if (op === "onboarding-read") return "Não foi possível ler a configuração. Confira se o arquivo é válido e está em um local seguro.";
  if (op.startsWith("recording-process")) return PROCESS_KNOWN_ERRORS.includes(text) ? text : "Não foi possível iniciar o processamento. Revise o destino e tente de novo; a gravação foi preservada.";
  if (op.startsWith("capture-") || op === "audio-defaults") return "Falha na operação de captura; verifique o estado e a configuração de áudio.";
  if (op.startsWith("job")) return "Falha na operação do job selecionado.";
  if (op === "context-meeting") return "Não foi possível carregar o contexto desta reunião.";
  if (op === "diarization-name") return "Não foi possível salvar o nome do falante.";
  return op === "list" ? "Falha ao carregar a biblioteca" : op === "detail" ? "Falha ao carregar os detalhes" : op === "resolve" ? "Falha ao resolver a reprodução" : op === "subtitles" ? "Falha ao enfileirar as legendas" : op === "diarization" ? "Falha ao iniciar a identificação de falantes" : "Request inválido";
};
const completedJob = (entry: LibraryEntry): JobRecord | undefined =>
  entry.jobs.find((job) => job.state === "completed");
export const readableTranscriptJob = async (entry: LibraryEntry): Promise<{ job: JobRecord; artifact: TranscriptArtifact } | undefined> => {
  const ordered = [...entry.jobs.filter(job => job.state === "completed"), ...entry.jobs.filter(job => job.state !== "completed" && job.target === "local")];
  for (const job of ordered) {
    const artifact = await readTranscriptArtifact(job).catch(() => undefined);
    if (artifact) return { job, artifact };
  }
  return undefined;
};
const locationOf = (entry: LibraryEntry): "local" | "vaio" | "proton" | "missing" => {
  if (entry.sourceExists) return "local";
  if (entry.archive?.vaio.state === "completed" || entry.jobs.some((j) => j.target === "remote" && j.state === "completed")) return "vaio";
  if (entry.archive?.proton.state === "completed") return "proton";
  return "missing";
};
const backupOf = (entry: LibraryEntry): string => {
  const states = [entry.archive?.vaio.state === "completed" ? "vaio" : "", entry.archive?.proton.state === "completed" ? "proton" : ""].filter(Boolean);
  return states.length ? states.join("+") : "none";
};
const statusOf = (entry: LibraryEntry): string => entry.archive?.vaio.state === "completed" && entry.archive.proton.state === "completed"
  ? "archived" : entry.jobs[0]?.state || (entry.archive ? "archive-pending" : "unprocessed");
const findEntry = async (key: string): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>["config"]; entry: LibraryEntry }> => {
  const { config, entries } = await loadLibrary();
  const entry = entries.find((item) => item.sourcePath === resolve(key));
  if (!entry) throw new Error("Gravação não encontrada na biblioteca");
  return { config, entry };
};
/** Drop cached and in-flight reads; the next reader starts a fresh build. */
const invalidateLibrary = (): void => { libraryCache = undefined; libraryLoad = undefined; };
const loadLibrary = async (force = false): Promise<NonNullable<typeof libraryCache>> => {
  if (!force && libraryCache) return libraryCache;
  // Concurrent readers (e.g. list + jobs-list at startup or reconnect) share one build,
  // forced or not. Invalidation drops the in-flight build, so anything still registered
  // started after the last known change.
  if (libraryLoad) return libraryLoad;
  const load = (async () => {
    const { config } = await loadConfig();
    return { at: Date.now(), config, entries: await buildLibrary(config, new JobStore()) };
  })();
  libraryLoad = load;
  try {
    const loaded = await load;
    if (libraryLoad === load) libraryCache = loaded;
    return loaded;
  } finally { if (libraryLoad === load) libraryLoad = undefined; }
};
const readPlainArtifact = async (job: JobRecord, kind: "transcript" | "summary"): Promise<string> => {
  try { return await readArtifact(job, kind); } catch { return ""; }
};
export type DiarizationView = { state: "idle" | "running" | "ready" | "failed" | "review"; message?: string; speakerCount?: number; matchedTokenRatio?: number; textCoverage?: { shownTurns: number; totalTurns: number; maxBytes: number }; turns?: Array<{ start: number; end: number; speaker?: string; label?: string; text?: string }> };
const DIARIZATION_VIEW_TEXT_BYTES = 256 * 1024;
// This text belongs to the acoustic diarizer, not the canonical transcript.
// Bound only the added text payload; never hide omission behind a complete label.
export const buildDiarizationView = (result: DiarizationResult): DiarizationView => {
  let bytes = 0, shownTurns = 0;
  const turns = result.turns.map(({ start, end, speaker, text }) => {
    const addedBytes = Buffer.byteLength(JSON.stringify(text), "utf8") + 8;
    const include = bytes + addedBytes <= DIARIZATION_VIEW_TEXT_BYTES;
    if (include) { bytes += addedBytes; shownTurns += 1; }
    return { start, end, speaker, label: result.labels[speaker], ...(include ? { text } : {}) };
  });
  return { ...resultStatus(result), turns,
    textCoverage: { shownTurns, totalTurns: turns.length, maxBytes: DIARIZATION_VIEW_TEXT_BYTES } };
};
export const buildTranscriptBoundary = (canonical: Transcript | undefined, captionTranscript: PlayerTranscript, diarization: DiarizationView): { transcript: PlayerTranscript; captionTranscript: PlayerTranscript; captionSource: "transcript" | "diarization" | "none"; captionPartial: boolean; diarization: DiarizationView } => {
  // Existing segment captions take precedence. The fallback uses only the
  // diarizer's own timed utterances; it never aligns canonical block text.
  let captions = captionTranscript;
  let captionSource: "transcript" | "diarization" | "none" = captions.timing === "segment" && captions.segments.length ? "transcript" : "none";
  let captionPartial = false;
  if (captionSource === "none" && ["ready", "review"].includes(diarization.state)) {
    const turns = diarization.turns || [];
    const timed = parsePlayerTranscript({ model: "diarization", segments: turns.map(turn => ({
      start: turn.start, end: turn.end, text: turn.text, speaker: turn.label || turn.speaker
    })) });
    if (timed.segments.length) {
      captions = { ...timed, reviewRequired: true };
      captionSource = "diarization";
      captionPartial = timed.segments.length < turns.length;
    }
  }
  return {
    transcript: canonical ? { ...parsePlayerTranscript(canonical), text: canonical.text } : captionTranscript,
    captionTranscript: captions, captionSource, captionPartial, diarization
  };
};
const transcriptFor = async (entry: LibraryEntry, job?: JobRecord): Promise<{ transcript: PlayerTranscript; subtitleId?: string }> => {
  const hash = entry.archive?.source.sha256 || job?.source.sha256;
  if (hash) {
    const aligned = await findAlignedSubtitles(hash);
    if (aligned) {
      try { return { transcript: parsePlayerTranscript(JSON.parse(await fs.readFile(aligned, "utf8"))), subtitleId: entry.archive?.id || job?.id }; } catch { /* fallback */ }
    }
  }
  if (!job) return { transcript: parsePlayerTranscript(null) };
  try {
    const path = resolve(job.artifactDir, "transcript.json");
    const stat = await assertExistingJobArtifactPath(job, path);
    if (stat.isFile() && stat.size <= 10 * 1024 * 1024) {
      return { transcript: parsePlayerTranscript(JSON.parse(await fs.readFile(path, "utf8"))) };
    }
  } catch { /* Keep playback usable when a transcript artifact is absent or invalid. */ }
  const artifact = await readPlainArtifact(job, "transcript");
  try { return { transcript: parsePlayerTranscript(JSON.parse(artifact)) }; } catch { /* markdown fallback */ }
  return { transcript: parsePlayerTranscript({ text: artifact }) };
};
const timesheetText = async (key: string): Promise<string> => {
  const entries = (await new TimeEntryStore().list()).filter((entry) => entry.source.recordingPath && resolve(entry.source.recordingPath) === resolve(key));
  return entries.map((entry) => [entry.clientName || entry.clientCode || "", entry.cardId || "", entry.activityDate, formatHours(entry.hours), entry.description || ""].filter(Boolean).join(" · ")).join("\n");
};
export const buildReviewedBoundary = (view: ReviewedView, captions: PlayerTranscript, diarization: DiarizationView) => {
  const labels=view.diarization?.labels || {};
  const reviewedDiarization=view.diarization ? {
    ...diarization,
    // Keep the existing bounded text envelope; IDs/labels come from the same revision.
    turns:view.diarization.turns.map((turn,index)=>{
      const prior=diarization.turns?.[index];
      return {...turn,...(prior?.text===undefined?{text:undefined}:{text:turn.text})};
    })
  } : diarization;
  // Canonical/aligned subtitle speaker IDs and acoustic diarizer IDs are separate
  // namespaces. A matching string alone never proves their attribution.
  const boundary=buildTranscriptBoundary(view.original.transcript,captions,reviewedDiarization);
  return {...boundary,transcript:{...parsePlayerTranscript(view.transcript),text:view.transcript.text,
    segments:view.segments.filter(segment=>segment.end>segment.start&&segment.text.trim()).map(segment=>({...segment,...(segment.speakerId?{speaker:segment.humanSpeakerEdited?labels[segment.speakerId]||segment.speakerId:segment.speakerId}:{speaker:undefined})}))},
    review:{revision:view.revision,canUndo:view.canUndo,notes:view.notes,derivedStale:view.derivedStale,speakerLabels:labels,
      segmentEditUnavailable:view.segments.some(segment=>!segment.textRange)},
    captionOriginalText:view.segments.some(segment=>segment.humanEdited)};
};
export const registeredAgentRecordingId=(entry:LibraryEntry)=>completedJob(entry)?.id||entry.jobs[0]?.id||(entry.archive?.source.sha256?entry.archive.id:undefined);
export const reviewedVisualIdentity = (view: ReviewedView): string | undefined => view.revision.revision > 0
  ? artifactDigest(JSON.stringify({ revision: view.revision, original: view.original.provenance })) : undefined;
export const assertCurrentSummaryPresentation = async (job: JobRecord, expected: ReviewedSummaryArtifact | undefined): Promise<void> => {
  const current = await readCurrentReviewedSummary(job);
  if (current?.raw !== expected?.raw) throw new RevisionConflictError("Summary result changed during Studio read; reread before presenting it");
};
const list = async (): Promise<unknown> => {
  const { entries } = await loadLibrary(true);
  const items = await Promise.all(entries.map(async (entry) => ({ key: entry.sourcePath, recordingId:registeredAgentRecordingId(entry), ...recordingPresentation(entry, entry.jobs[0] ? await readArtifactStates(entry.jobs[0]) : undefined), fileName: basename(entry.sourcePath), modifiedAt: entry.modifiedAt, sourceExists: entry.sourceExists, location: locationOf(entry), status: statusOf(entry), backup: backupOf(entry) })));
  // Presentation cache only; a failed write never fails the fresh list.
  await writeLibrarySnapshot(items).catch(() => undefined);
  return { items };
};
const detail = async (key: string): Promise<unknown> => {
  const { entry } = await findEntry(key);
  const jobStore = new JobStore();
  entry.jobs = await Promise.all(entry.jobs.map(job => jobStore.get(job.id).catch(() => job)));
  if (entry.archive) entry.archive = (await new ArchiveStore().get(entry.archive.id).catch(() => entry.archive)) || undefined;
  const readable = await readableTranscriptJob(entry);
  const job = readable?.job || completedJob(entry);
  const subtitleId = entry.archive?.vaio.state === "completed" ? entry.archive.id : entry.jobs.find((item) => item.target === "remote" && item.state === "completed")?.id;
  const reviewed=job&&readable?await readCurrentReviewedView(job):undefined;
  const canonical=reviewed?.original.transcript || readable?.artifact.transcript;
  const [{ transcript: originalTranscript }, timesheet] = await Promise.all([transcriptFor(entry, job), timesheetText(entry.sourcePath)]);
  const currentSummary=job&&reviewed?await readCurrentReviewedSummary(job,reviewed):undefined;
  const summary=currentSummary?formatSummaryMarkdown(currentSummary.summary):job?await readPlainArtifact(job,"summary"):"";
  const visualReview=job&&reviewed?await studioFrames.readResult(job.id,job.source.sha256,reviewed.transcript,reviewedVisualIdentity(reviewed)).catch(()=>undefined):undefined;
  const diarizationResult = job && canonical ? await new DiarizationStore().read(job.id, job.source.sha256, canonical.text) : undefined;
  // Speaker timing comes from its own acoustic timeline. A lexical match inside
  // a 10-minute transcript block is not enough evidence to invent word timing.
  const diarization: DiarizationView = diarizationResult ? buildDiarizationView(diarizationResult)
    : job && canonical ? await readDiarizationStatus(job, canonical) : { state: "idle" };
  const captions = canonical && job?.state !== "completed" ? parsePlayerTranscript(canonical) : originalTranscript;
  const boundary = reviewed?buildReviewedBoundary(reviewed,captions,diarization):buildTranscriptBoundary(canonical, captions, diarization);
  let subtitleState = originalTranscript.timing === "segment" ? "ready" : "idle";
  let subtitleMessage: string | undefined;
  if (subtitleId && subtitleState !== "ready") {
    const status = await runCommand("systemctl", ["--user", "show", `recording-cli-subtitles-${subtitleId}.service`, "--property=ActiveState"], { timeoutMs: 5000 }).catch(() => undefined);
    const operation = subtitleUnitStatus(status?.stdout);
    subtitleState = operation.state;
    subtitleMessage = operation.message;
  }
  const artifacts = job ? await readArtifactStates(job) : undefined;
  const presentation = recordingPresentation(entry, artifacts);
  if (job && entry.jobs[0] && entry.jobs[0].id !== job.id) presentation.artifactStatus += " · conteúdo de tarefa anterior";
  if (job && reviewed) { await assertCurrentReviewedView(job, reviewed); await assertCurrentSummaryPresentation(job,currentSummary); }
  return { key: entry.sourcePath, recordingId:registeredAgentRecordingId(entry), ...presentation, status: entry.jobs[0]?.state || statusOf(entry), backup: backupOf(entry), artifacts, transcriptProvenance: reviewed?.original.provenance || readable?.artifact.provenance, artifactMessage: currentSummary ? "Resumo de modelo vinculado à revisão humana atual; o original foi preservado. Hashes verificam origem, não qualidade semântica." : reviewed?.derivedStale ? "Revisão humana aplicada. O resumo e a revisão visual anteriores estão desatualizados; nenhum modelo foi chamado para refazê-los." : readable && job?.state !== "completed" ? "Transcrição pronta e verificada. O processamento posterior não foi concluído; o resumo está indisponível. Não é necessário repetir a transcrição." : "", ...boundary, summary: artifacts?.summary.state!=="ready" ? "" : summary, visualReview, summaryInfo: currentSummary ? `${currentSummary.provenance.provider.provider}/${currentSummary.provenance.provider.model} · revisão ${currentSummary.revision.revision} · autoria: modelo` : job ? `${job.summary.provider}/${job.summary.model} · ${job.summary.provider === "openai" ? "provedor externo" : "Ollama: endpoint configurado"}` : "", timesheet, subtitleState, subtitleMessage,
    ...(job && canonical ? { jobId: job.id, ...(job.state === "completed" ? { diarizationId: job.id } : {}) } : {}), ...(subtitleId ? { subtitleId } : {}) };
};
const resolvePlayback = async (key: string): Promise<unknown> => {
  const { config, entry } = await findEntry(key);
  const stat = await fs.lstat(entry.sourcePath).catch(() => null);
  if (stat?.isFile() && !stat.isSymbolicLink()) {
    await assertExistingManagedPath(config, entry.sourcePath);
    return { key: entry.sourcePath, state: "completed", location: "local", path: entry.sourcePath };
  }
  return queuePlayback(entry.sourcePath);
};
const subtitles = async (key: string): Promise<unknown> => {
  if (!UUID.test(key)) throw new Error("Informe o id UUID da gravação");
  const archive = await import("../../src/archive/store").then(({ ArchiveStore }) => new ArchiveStore().get(key)).catch(() => null);
  const job = await new JobStore().get(key).catch(() => null);
  const id = archive?.vaio.state === "completed" ? archive.id : job?.target === "remote" && job.state === "completed" ? job.id : undefined;
  if (!id) throw new Error("A gravação precisa ter uma cópia concluída no VAIO");
  const unit = await queueAlignedSubtitles(id);
  return { id, status: "queued", unit };
};
/** Payload keys each operation accepts; anything else is refused before dispatch. */
const ALLOWED_PAYLOAD: Partial<Record<Request["op"], string[]>> = {
  "summary-plan": ["requestId", "maxRequests"], "summary-run": ["requestId", "consent", "consentKey"], "summary-cancel": ["requestId"],
  "provider-authorize": ["provider", "model", "analysis", "context", "maxFrames", "maxBytes", "consent"],
  "provider-analyze": ["grantId", "requestId", "question", "timestamps"], "provider-cancel": ["grantId"],
  "agent-status": [], "agent-authorize": ["recipientId", "data", "consent"],
  "agent-cancel": ["grantId"], "agent-pause": ["grantId"], "agent-resume": ["grantId"], "agent-revoke": ["grantId"],
  "agent-frames": ["grantId", "timestamps"], "agent-connect": ["grantId", "client"],
  "frames-check-models": ["visionModel", "summaryModel"], "frames-scope": ["startSeconds", "endSeconds"],
  "frames-plan": ["capabilityId", "consentTranscript", "scopeId"], "frames-preview-plan": ["planId"],
  "frames-preview": ["question", "seconds", "capabilityId"], "frames-confirm": ["previewId", "consent", "consentKey"],
  "frames-cancel": ["previewId", "scopeId"],
  "revision-save": ["expectedRevision", "base", "operations"], "revision-undo": ["expectedRevision", "base"],
  "export-preview": ["format", "track"], "export-save": ["format", "track", "expectedRevision", "expectedBase", "expectedSnapshotSha256"],
  "onboarding-save-local": ["revision"],
  "settings-save": ["revision", "changes", "initialize"], "settings-diagnose": ["changes"], "settings-service": ["action"],
  "settings-secret-set": ["name", "value"], "settings-secret-remove": ["name"], "settings-secret-test": ["service"],
  "settings-restore": ["revision", "backup"], "settings-export": ["path"], "settings-import-read": ["path"],
  "settings-audio-test": ["seconds", "audioSource", "microphone", "desktop"],
  "settings-model-catalog": ["ollamaUrl"], "settings-model-download": ["kind", "model", "consent", "ollamaUrl"],
  "settings-model-status": ["kind", "model"], "settings-model-cancel": ["kind", "model"],
  "recording-process": ["consent", "consentKey"],
  "capture-start": ["title"], "diarization-name": ["speakerId", "label"], "context-meeting": ["maxCharacters", "query", "offset"]
};
export const parseRequest = (value: unknown): Request => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request inválido");
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 1) throw new Error("id deve ser um inteiro positivo");
  if (!OPERATIONS.includes(request.op as Request["op"])) throw new Error("operação desconhecida");
  if (request.key !== undefined && (typeof request.key !== "string" || request.key.length > 4096 || /[\x00-\x1f]/.test(request.key))) throw new Error("key inválido");
  if (request.payload !== undefined && (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload))) throw new Error("payload inválido");
  const payload = (request.payload || {}) as Record<string, unknown>;
  const allowed = ALLOWED_PAYLOAD[request.op as Request["op"]] || [];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("payload inválido");
  for (const [key, max] of [["title", 200], ["speakerId", 8], ["label", 80], ["query", 1000], ["question", 1000], ["previewId", 36], ["revision", 64], ["visionModel", 200], ["summaryModel", 200], ["capabilityId", 36], ["consentKey", 64]] as const) {
    if (payload[key] !== undefined && (typeof payload[key] !== "string" || (payload[key] as string).length > max || /[\x00-\x1f\x7f]/.test(payload[key] as string))) throw new Error("payload inválido");
  }
  if (payload.action !== undefined && (typeof payload.action !== "string" || payload.action.length > 40)) throw new Error("payload inválido");
  if (payload.name !== undefined && (typeof payload.name !== "string" || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(payload.name))) throw new Error("payload inválido");
  if (payload.value !== undefined && (typeof payload.value !== "string" || payload.value.length > 4096 || /[\x00-\x1f\x7f]/.test(payload.value))) throw new Error("payload inválido");
  if (payload.service !== undefined && !["openai", "gemini"].includes(payload.service as string)) throw new Error("payload inválido");
  if (payload.backup !== undefined && (typeof payload.backup !== "string" || !/^[\w.-]{1,200}$/.test(payload.backup))) throw new Error("payload inválido");
  if (payload.path !== undefined && (typeof payload.path !== "string" || !payload.path.startsWith("/") || payload.path.length > 4096 || /[\x00-\x1f\x7f]/.test(payload.path))) throw new Error("payload inválido");
  if (payload.kind !== undefined && !["whisper", "ollama"].includes(payload.kind as string)) throw new Error("payload inválido");
  if (payload.ollamaUrl !== undefined && (typeof payload.ollamaUrl !== "string" || payload.ollamaUrl.length > 200 || /[\x00-\x1f\x7f]/.test(payload.ollamaUrl))) throw new Error("payload inválido");
  if (request.op !== "provider-authorize" && payload.model !== undefined && (typeof payload.model !== "string" || !/^[A-Za-z0-9._:/-]{1,120}$/.test(payload.model))) throw new Error("payload inválido");
  if (payload.initialize !== undefined && typeof payload.initialize !== "boolean") throw new Error("payload inválido");
  if (payload.client !== undefined && !["claude", "codex", "gemini"].includes(payload.client as string)) throw new Error("payload inválido");
  for (const field of ["audioSource", "microphone", "desktop"] as const) if (payload[field] !== undefined && (typeof payload[field] !== "string" || !/^[A-Za-z0-9_.:@+-]{1,300}$/.test(payload[field] as string))) throw new Error("payload inválido");
  if (request.op === "settings-audio-test" && payload.seconds !== undefined && (!Number.isSafeInteger(payload.seconds) || (payload.seconds as number) < 2 || (payload.seconds as number) > 15)) throw new Error("payload inválido");
  if (payload.changes !== undefined && (!payload.changes || typeof payload.changes !== "object" || Array.isArray(payload.changes) || Object.keys(payload.changes).length > 100)) throw new Error("payload inválido");
  if (request.op === "settings-save" && (typeof payload.revision !== "string" || payload.changes === undefined)) throw new Error("payload inválido");
  if (request.op === "settings-service" && typeof payload.action !== "string") throw new Error("payload inválido");
  if (payload.expectedRevision !== undefined && (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number)<0)) throw new Error("payload inválido");
  if (["revision-save","revision-undo","export-save"].includes(request.op as string) && payload.expectedRevision === undefined) throw new Error("payload inválido");
  for (const name of ["base","expectedBase"] as const) {
    const base=payload[name];
    if(base!==undefined) {
      if(!base||typeof base!=="object"||Array.isArray(base))throw new Error("payload inválido");
      const b=base as Record<string,unknown>;
      if(Object.keys(b).some(key=>!["jobId","mediaSha256","transcriptArtifactSha256","diarizationSha256"].includes(key))||typeof b.jobId!=="string"||!UUID.test(b.jobId)||![b.mediaSha256,b.transcriptArtifactSha256].every(h=>typeof h==="string"&&/^[a-f0-9]{64}$/.test(h))||(b.diarizationSha256!==undefined&&(typeof b.diarizationSha256!=="string"||!/^[a-f0-9]{64}$/.test(b.diarizationSha256))))throw new Error("payload inválido");
    }
  }
  if(["revision-save","revision-undo"].includes(request.op as string)&&!payload.base)throw new Error("payload inválido");
  if(request.op==="revision-save"&&(!Array.isArray(payload.operations)||payload.operations.length<1||payload.operations.length>100))throw new Error("payload inválido");
  if(request.op==="export-save"&&(!payload.expectedBase||typeof payload.expectedSnapshotSha256!=="string"||!/^[a-f0-9]{64}$/.test(payload.expectedSnapshotSha256)))throw new Error("payload inválido");
  if((request.op as string).startsWith("export-")&&(!["json","markdown","srt","vtt"].includes(payload.format as string)||!["transcript","diarization"].includes(payload.track as string)))throw new Error("payload inválido");
  if (payload.maxCharacters !== undefined && (!Number.isSafeInteger(payload.maxCharacters) || (payload.maxCharacters as number) < 4096 || (payload.maxCharacters as number) > 24000)) throw new Error("payload inválido");
  if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0)) throw new Error("payload inválido");
  if (payload.seconds !== undefined && (typeof payload.seconds !== "number" || !Number.isFinite(payload.seconds) || payload.seconds < 0)) throw new Error("payload inválido");
  for(const name of ["startSeconds","endSeconds"] as const)if(payload[name]!==undefined && (typeof payload[name]!=="number"||!Number.isFinite(payload[name])||payload[name]!<0||payload[name]!>86400))throw Error("payload inválido");
  if(payload.scopeId!==undefined && (typeof payload.scopeId!=="string"||payload.scopeId.length>100||/[\x00-\x1f]/.test(payload.scopeId)))throw Error("payload inválido");
  if(payload.planId!==undefined && (typeof payload.planId!=="string"||payload.planId.length>100||/[\x00-\x1f]/.test(payload.planId)))throw Error("payload inválido");
  if(payload.consentTranscript!==undefined && typeof payload.consentTranscript!=="boolean")throw Error("payload inválido");
  if(payload.provider!==undefined&&!['openai','google'].includes(payload.provider as string))throw Error('payload inválido');
  if(request.op==='provider-authorize'&&payload.model!==undefined&&(typeof payload.model!=='string'||!/^[-a-zA-Z0-9._]{1,160}$/.test(payload.model)))throw Error('payload inválido');
  if(payload.context!==undefined&&typeof payload.context!=='boolean')throw Error('payload inválido');
  if(payload.maxFrames!==undefined&&(!Number.isSafeInteger(payload.maxFrames)||(payload.maxFrames as number)<1||(payload.maxFrames as number)>6))throw Error('payload inválido');
  if(payload.maxBytes!==undefined&&(!Number.isSafeInteger(payload.maxBytes)||(payload.maxBytes as number)<65536||(payload.maxBytes as number)>8388608))throw Error('payload inválido');
  if(payload.analysis!==undefined){const {validateAnalysis}=require('../provider-analysis/contracts');validateAnalysis(payload.analysis);}
  if(payload.requestId!==undefined&&(typeof payload.requestId!=='string'||!UUID.test(payload.requestId)))throw Error('payload inválido');
  if(payload.grantId!==undefined&&(typeof payload.grantId!=='string'||!UUID.test(payload.grantId)))throw Error('payload inválido');
  if(payload.recipientId!==undefined&&(typeof payload.recipientId!=='string'||!/^[-a-z0-9._]{1,64}$/.test(payload.recipientId)))throw Error('payload inválido');
  if(payload.data!==undefined&&(!Array.isArray(payload.data)||!payload.data.length||payload.data.length>2||payload.data.some(x=>!['context','frames'].includes(x))))throw Error('payload inválido');
  if(payload.timestamps!==undefined&&(!Array.isArray(payload.timestamps)||payload.timestamps.length>6||payload.timestamps.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0||x>86400)))throw Error('payload inválido');
  if (payload.consent !== undefined && typeof payload.consent !== "boolean") throw new Error("payload inválido");
  if ((request.op as string).startsWith("summary-")) {
    if (typeof request.key!=="string" || !UUID.test(request.key) || typeof payload.requestId!=="string" || !UUID.test(payload.requestId)) throw Error("payload inválido");
    if (request.op==="summary-plan" && (!Number.isSafeInteger(payload.maxRequests) || Number(payload.maxRequests)<1 || Number(payload.maxRequests)>8)) throw Error("payload inválido");
    if (request.op==="summary-run" && (payload.consent!==true || typeof payload.consentKey!=="string" || !/^[a-f0-9]{64}$/.test(payload.consentKey))) throw Error("payload inválido");
  }
  return { id: request.id as number, op: request.op as Request["op"], ...(request.key === undefined ? {} : { key: request.key as string }), payload };
};
export const handleStudioSummaryOperation = async (flow: StudioSummaryFlow, request: Request, job: JobRecord, config?: AppConfig): Promise<unknown> => {
  const p=request.payload || {};
  if (request.key!==job.id) throw Error("Summary request/source mismatch");
  if (request.op==="summary-cancel") return flow.cancel(job,p.requestId || "");
  if (!config) throw Error("Explicit summary configuration required");
  if (request.op==="summary-plan") return flow.plan(job,config,{requestId:p.requestId || "",maxRequests:p.maxRequests!});
  if (request.op==="summary-run") return flow.run(job,config,{requestId:p.requestId || "",consent:p.consent===true,consentKey:p.consentKey || ""});
  throw Error("Unknown summary operation");
};
/** Register cancellation before awaiting source/config reads, including an in-flight plan. */
export class StudioSummaryRequestRouter {
  private readonly resolving = new Map<string,{cancelled:boolean;readers:number;job?:JobRecord}>();
  constructor(private readonly flow:StudioSummaryFlow) {}
  async dispatch(request:Request,readSource:()=>Promise<{job:JobRecord;config?:AppConfig}>):Promise<unknown> {
    const identity=JSON.stringify([request.key,request.payload?.requestId]);
    if(request.op==="summary-cancel") {
      const pending=this.resolving.get(identity);
      if(pending)pending.cancelled=true;
      // Active/queued work already resolved this exact job. Abort its controller
      // before any further disk read can allow a late response to commit.
      if(pending?.job)return handleStudioSummaryOperation(this.flow,request,pending.job);
      const source=await readSource();
      try { return await handleStudioSummaryOperation(this.flow,request,source.job); }
      catch(error) {
        if(pending && error instanceof Error && error.message==="Reviewed summary request is unavailable")
          return {jobId:source.job.id,requestId:request.payload!.requestId,status:"cancelled",persisted:false};
        throw error;
      }
    }
    const pending=this.resolving.get(identity)||{cancelled:false,readers:0,job:undefined as JobRecord|undefined};pending.readers++;
    this.resolving.set(identity,pending);
    try {
      const source=await readSource();
      if(pending.cancelled)throw Error("Studio summary cancelled before source resolution; no dispatch");
      pending.job=source.job;
      return await handleStudioSummaryOperation(this.flow,request,source.job,source.config);
    } finally { if(--pending.readers===0 && this.resolving.get(identity)===pending)this.resolving.delete(identity); }
  }
}
const summaryRouter=new StudioSummaryRequestRouter(studioSummary);
export const desktopRequestAdmitted=(pending:number,op:Request["op"]):boolean=>pending<32 || op==="summary-cancel";
const handle = async (request: Request): Promise<unknown> => {
  if (request.op.startsWith("summary-")) {
    const result=await summaryRouter.dispatch(request,async()=>({
      job:await new JobStore().get(request.key!),
      config:request.op==="summary-cancel" ? undefined : (await loadConfig()).config,
    }));
    if (request.op==="summary-run") invalidateLibrary();
    return result;
  }
  if(request.op.startsWith('provider-')){const p=request.payload||{},key=request.key||'';
   if(request.op==='provider-cancel')return providerStudio.cancel(p.grantId||'');
   const resolveId=async()=>{invalidateLibrary();const {entry}=await findEntry(key);const id=registeredAgentRecordingId(entry);if(!id)throw Error('Recording not registered');return id;};
   if(request.op==='provider-analyze')return providerStudio.run(resolveId,{grantId:p.grantId||'',requestId:p.requestId||'',question:p.question||'',timestamps:p.timestamps||[]});
   return providerStudio.authorize(await resolveId(),{provider:p.provider!,model:p.model||'',consent:p.consent===true,analysis:p.analysis!,context:p.context===true,maxFrames:p.maxFrames,maxBytes:p.maxBytes});
  }
  if(request.op.startsWith('agent-')){const key=request.key||'';const p=request.payload||{};
   if(request.op==='agent-cancel')return agentStudio.cancel(p.grantId||'');
   if(request.op==='agent-connect'){const grant=await agentStudio.access.read(p.grantId||'');if(grant.revoked||grant.recipient.kind!=='agent')throw Error('Grant unavailable for assistant connection');return {grantId:grant.id,recipientId:grant.recipient.id,paused:grant.paused,...buildAssistantConnection({id:grant.id,recipient:{id:grant.recipient.id}})};}
   if(request.op==='agent-frames')return agentStudio.frames(async()=>{invalidateLibrary();const {entry}=await findEntry(key);const id=registeredAgentRecordingId(entry);if(!id)throw Error('Recording is not registered');return id;},p.grantId||'',p.timestamps||[]);
   invalidateLibrary();const {entry}=await findEntry(key);const recordingId=registeredAgentRecordingId(entry);if(!recordingId)throw Error('Recording is not registered; no agent opt-in available');
   if(request.op==='agent-status')return agentStudio.status(recordingId);
   if(request.op==='agent-authorize')return agentStudio.authorize(recordingId,p.recipientId||'',p.data||[],p.consent===true);
   return agentStudio.change(recordingId,p.grantId||'',request.op.slice(6) as 'pause'|'resume'|'revoke');
  }
  if(request.op === "processing-status") return readHeavyStatus();
  if (request.op === "ux-capabilities") return {mockFrames: process.env.FALATRACE_UX_MOCK_ONLY === "1",realFrames:true,productVersion,release:await readReleaseInfo()};
  if ((SETTINGS_OPERATIONS as readonly string[]).includes(request.op)) {
    // A save or a restore replaces the configuration and may move the recordings folder; one that
    // failed may have replaced it too. Library reads after it start from the file on disk.
    try {
      return await handleSettingsOperation(request.op as SettingsOperation, request.payload || {});
    } finally {
      if (request.op === "settings-save" || request.op === "settings-restore") invalidateLibrary();
    }
  }
  if (request.op === "onboarding-read") return readOnboarding();
  if (request.op === "onboarding-save-local") { const result=await saveLocalOnboarding(request.payload?.revision || ""); invalidateLibrary(); return result; }
  if (request.op.startsWith("frames-")) {
    const key=request.key || "";
    if(process.env.FALATRACE_UX_MOCK_ONLY !== "1"){
      if(request.op==='frames-cancel')return studioFrames.cancel(key,request.payload?.previewId||'',request.payload?.scopeId);
      const readSource=async():Promise<StudioSource>=>{
        invalidateLibrary();
        const {entry}=await findEntry(key);const {config}=await loadConfig();const candidate=completedJob(entry);
        if(!candidate)throw Error('A completed transcript is required');
        const job=await new JobStore().get(candidate.id);if(job.state!=='completed')throw Error('Completed job changed');
        await assertExistingManagedPath(config,entry.sourcePath);
        const reviewed=await readCurrentReviewedView(job);
        return {key,jobId:job.id,path:entry.sourcePath,mediaHash:job.source.sha256,transcript:reviewed.transcript,config,
          reviewIdentity:reviewedVisualIdentity(reviewed),publishCurrent:publish=>withRevisionLease(job.id,async()=>{
            await assertCurrentReviewedView(job,reviewed);
            await assertExistingManagedPath(config,entry.sourcePath);
            if(await hashFile(entry.sourcePath)!==job.source.sha256)throw new RevisionConflictError("Frame media changed before result publication");
            return publish();
          })};
      };
      return handleRealFrameOperation(studioFrames,request,{...await readSource(),refresh:readSource});
    }
    if(request.op === "frames-confirm") return frameReview.confirm(key,request.payload?.previewId || "",request.payload?.consent === true);
    if(request.op === "frames-cancel") return frameReview.cancel(key,request.payload?.previewId || "");
    const {entry}=await findEntry(key);const job=completedJob(entry);
    if(!job) throw new Error("Uma transcrição concluída é necessária para o preview.");
    const transcript=await readCanonicalTranscript(job);if(!transcript)throw new Error("Transcrição indisponível.");
    await assertExistingManagedPath((await loadConfig()).config,entry.sourcePath);
    return prepareMockFramePreview(frameReview,key,entry.sourcePath,job.source.sha256,transcript,request.payload?.question || "",request.payload?.seconds ?? NaN);
  }
  if (request.op === "list") return list();
  if (request.op === "list-cached") return { cached: true, ...(await readLibrarySnapshot() || { items: null }) };
  if (request.op === "automation-pause" || request.op === "automation-resume") {
    await setAutomationPaused(request.op === "automation-pause");
    return readCaptureStatus((await loadConfig()).config);
  }
  if (request.op === "capture-status") return readCaptureStatus((await loadConfig()).config);
  if (["capture-start", "capture-stop", "capture-recover", "audio-defaults"].includes(request.op)) {
    const lease = await acquireSingleton("desktop-capture-operation").catch(() => { throw new Error("Aguarde a operação de captura em andamento."); });
    try {
      const { config } = await loadConfig();
      if (request.op === "capture-start") return await startCapture(config, { title: request.payload?.title });
      if (request.op === "audio-defaults") {
        const captureLease = await acquireSingleton("capture-control");
        try {
          if (captureHoldsDevices(await readCaptureStatus(config))) throw new Error("Não altere o áudio durante uma captura ativa.");
          const configuration = await configureDefaultAudio();
          invalidateLibrary();
          return { ...await readCaptureStatus((await loadConfig()).config), configuration };
        } finally { await captureLease.release(); }
      }
      const stopped = await stopCapture(config, { recoverOnly: request.op === "capture-recover" });
      invalidateLibrary();
      // Automatic processing is on (a job was created): start it now instead of waiting for the timer.
      const queued = stopped.job ? await queueSelectedJob(stopped.job.id).then((result) => result.status, () => null) : null;
      return { ...await readCaptureStatus(config), outcome: stopped.state, jobId: stopped.job?.id, jobQueued: queued, ...(stopped.warning ? { stopWarning: stopped.warning } : {}) };
    } finally { await lease.release(); }
  }
  if (request.op === "jobs-list") {
    const { entries } = await loadLibrary();
    const byJob = new Map(entries.flatMap((entry) => entry.jobs.map((job) => [job.id, entry] as const)));
    const jobs = (await new JobStore().list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: await Promise.all(jobs.slice(0, 200).map(async (job) => {
      const artifacts = await readArtifactStates(job);
      const entry = byJob.get(job.id) || { sourcePath: job.sourcePath, relativePath: basename(job.sourcePath), sourceExists: false, size: job.source.size, modifiedAt: Date.parse(job.createdAt), jobs: [job] };
      return { artifacts, ...recordingPresentation(entry, artifacts), id: job.id, state: job.state, target: job.target, createdAt: job.createdAt };
    })), total: jobs.length };
  }
  if (!request.key) throw new Error("key é obrigatório para esta operação");
  if (request.op === "job-process" || request.op === "job-retry") return queueSelectedJob(request.key, { retry: request.op === "job-retry" });
  if (request.op === "recording-process-plan" || request.op === "recording-process") {
    invalidateLibrary();
    const { config, entry } = await findEntry(request.key);
    if (entry.sourceExists) await assertExistingManagedPath(config, entry.sourcePath);
    if (request.op === "recording-process-plan") return planRecordingProcessing(config, entry);
    const result = await runRecordingProcessing(config, entry, { consent: request.payload?.consent === true, consentKey: request.payload?.consentKey || "" });
    invalidateLibrary();
    return result;
  }
  if(request.op.startsWith("revision-")||request.op.startsWith("export-")) {
    if(!UUID.test(request.key))throw new Error("Informe o id UUID da gravação");
    const job=await new JobStore().get(request.key), p=request.payload!;
    if(request.op==="revision-save")return saveRevision(job,{expectedRevision:p.expectedRevision!,base:p.base!,operations:p.operations!});
    if(request.op==="revision-undo")return undoRevision(job,{expectedRevision:p.expectedRevision!,base:p.base!});
    if(request.op==="export-preview")return previewExport(job,{format:p.format!,track:p.track!});
    return saveExport(job,{format:p.format!,track:p.track!,expectedRevision:p.expectedRevision!,expectedBase:p.expectedBase!,expectedSnapshotSha256:p.expectedSnapshotSha256!});
  }
  if (request.op === "diarization-name" || request.op === "context-meeting") {
    const entry = UUID.test(request.key) ? undefined : (await findEntry(request.key)).entry;
    const id = UUID.test(request.key) ? request.key : request.op === "context-meeting" ? (await readableTranscriptJob(entry!))?.job.id : completedJob(entry!)?.id;
    if (!id) throw new Error("A gravação ainda não possui contexto disponível.");
    if (request.op === "diarization-name") {
      await nameDiarizationSpeaker(id, request.payload?.speakerId || "", request.payload?.label || "");
      return { id, saved: true };
    }
    return readMeetingContext((await loadConfig()).config, id, request.payload);
  }
  if (request.op === "detail") return detail(request.key);
  if (request.op === "resolve") return resolvePlayback(request.key);
  if (request.op === "playback-status") return readPlayback(request.key);
  if (request.op === "diarization") return queueDiarization(request.key);
  return subtitles(request.key);
};
export const runDesktopBridge = async (): Promise<void> => {
  const pending = new Set<Promise<void>>();
  const accept = (line: string): void => {
    const task = (async () => {
      let request: Request;
      try {
        if (Buffer.byteLength(line, "utf8") > MAX_LINE) throw new Error("linha JSON excede 1 MiB");
        request = parseRequest(JSON.parse(line));
        if (!desktopRequestAdmitted(pending.size,request.op)) throw new Error("Muitas operações pendentes; tente novamente.");
        const result = await handle(request);
        emit({ id: request.id, ok: true, result });
      } catch (error) {
        const id = (() => { try { return Number((JSON.parse(line) as { id?: unknown }).id); } catch { return 0; } })();
        const rawOp = (() => { try { return String((JSON.parse(line) as { op?: unknown }).op || "request"); } catch { return "request"; } })();
        emit({ id: Number.isSafeInteger(id) && id > 0 ? id : 0, ok: false, error: safeError(rawOp, error) });
      }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  let buffer = Buffer.alloc(0);
  let dropping = false;
  for await (const chunk of process.stdin) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (bytes.length) {
      const newline = bytes.indexOf(10);
      const piece = newline < 0 ? bytes : bytes.subarray(0, newline);
      if (!dropping && buffer.length + piece.length > MAX_LINE) {
        emit({ id: 0, ok: false, error: "linha JSON excede 1 MiB" });
        buffer = Buffer.alloc(0); dropping = true;
      }
      if (!dropping) buffer = Buffer.concat([buffer, piece]);
      if (newline < 0) break;
      if (!dropping && buffer.length) accept(buffer.toString("utf8").replace(/\r$/, ""));
      buffer = Buffer.alloc(0); dropping = false; bytes = bytes.subarray(newline + 1);
    }
  }
  if (!dropping && buffer.length) accept(buffer.toString("utf8"));
  studioFrames.cancelAll();
  await studioSummary.shutdown();
  await Promise.allSettled([...pending]);
};
if (import.meta.main) void runDesktopBridge();
