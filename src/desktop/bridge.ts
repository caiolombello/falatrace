import { version as productVersion } from "../../package.json";
import { readHeavyStatus } from '../runtime/heavy-admission';
/** JSONL bridge for the desktop application. */
import { promises as fs } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { loadConfig } from "../../src/config/load";
import { configureDefaultAudio } from "../../src/config/audio";
import { acquireSingleton } from "../../src/runtime/singleton";
import { readCaptureStatus, startCapture, stopCapture } from "../../src/recording/application";
import { queueSelectedJob } from "../../src/jobs/queue";
import { readMeetingContext } from "../../src/knowledge/meetings";
import { getDefaultJobStateDir, JobStore } from "../../src/jobs/store";
import type { JobRecord, Transcript } from "../../src/jobs/types";
import { runCommand } from "../../src/jobs/command";
import { buildLibrary, readArtifact, assertExistingJobArtifactPath, assertExistingManagedPath, type LibraryEntry } from "../../src/tui/library";
import { queuePlayback, readPlayback } from "./playback";
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
import { prepareMockFramePreview } from "../visual/mock-preview";
import { MockFrameReview } from "../visual/review-flow";
const frameReview = new MockFrameReview();
import {StudioVisualFlow,type StudioSource} from '../visual/studio-flow';
import {AgentStudio} from '../agent-context/studio';
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

const OPERATIONS = ["provider-authorize","provider-analyze","provider-cancel","agent-cancel","agent-status","agent-authorize","agent-pause","agent-resume","agent-revoke","agent-frames","processing-status", "ux-capabilities", "onboarding-read", "onboarding-save-local", "frames-check-models", "frames-scope", "frames-plan", "frames-preview-plan", "frames-preview", "frames-confirm", "frames-cancel", "list", "detail", "resolve", "playback-status", "subtitles", "diarization", "automation-pause", "automation-resume", "capture-status", "capture-start", "capture-stop", "capture-recover", "audio-defaults", "jobs-list", "job-process", "job-retry", "diarization-name", "context-meeting"] as const;
type Request = { id: number; op: typeof OPERATIONS[number]; key?: string; payload?: {provider?:'openai'|'google';model?:string;analysis?:import('../provider-analysis/contracts').AnalysisOptions;context?:boolean;maxFrames?:number;maxBytes?:number;requestId?:string;grantId?:string;recipientId?:string;data?:Array<'context'|'frames'>;timestamps?:number[]; title?: string; speakerId?: string; label?: string; maxCharacters?: number; query?: string; offset?: number; question?: string; seconds?: number; previewId?: string; consent?: boolean; revision?: string; visionModel?: string; summaryModel?: string; capabilityId?: string; consentKey?: string; planId?:string; consentTranscript?:boolean; scopeId?:string; startSeconds?:number; endSeconds?:number } };
type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
const MAX_LINE = 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/i;
let libraryCache: { at: number; config: Awaited<ReturnType<typeof loadConfig>>["config"]; entries: LibraryEntry[] } | undefined;

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
    "Há uma gravação legada em andamento. Finalize-a pelo terminal com `record stop`; o estado foi preservado.",
    "Não foi possível iniciar a captura. Verifique o backend e as fontes de áudio configuradas.",
    "Não foi possível finalizar a gravação. O estado foi preservado para nova tentativa.",
    "Aguarde a operação de captura em andamento.", "Não altere o áudio durante uma captura ativa.",
    "O job falhou. Use a ação de tentar novamente para colocá-lo na fila.",
    "O job selecionado é inválido ou não está mais disponível.", "Não foi possível colocar o job selecionado na fila.",
    "Informe um nome de até 80 caracteres, sem quebras de linha", "Falante não encontrado nesta gravação",
    "A gravação ainda não possui contexto disponível.", "Muitas operações pendentes; tente novamente."
  ];
  if (known.includes(text)) return text;
  if(op.startsWith("provider-"))return "Análise indisponível ou recusada. Confira destino/modelo, autorização e orçamento; não repita automaticamente uma tentativa incerta.";
  if(op.startsWith("agent-"))return "Acesso recusado ou indisponível. Confira escopo, destinatário, pausa/revogação e orçamento. Dados preservados.";
  if (op.startsWith("frames-")) return "Pedido visual recusado/cancelado. Confira horário, preview, consentimento e budget; verifique modelos locais/capabilities, identidade da origem, consentimento e limite persistente. Dados preservados.";
  if (op.startsWith("onboarding-")) return "Configuração inválida, insegura ou alterada. Dados preservados; reabra antes de salvar.";
  if (op.startsWith("capture-") || op === "audio-defaults") return "Falha na operação de captura; verifique o estado e a configuração de áudio.";
  if (op.startsWith("job")) return "Falha na operação do job selecionado.";
  if (op === "context-meeting") return "Não foi possível carregar o contexto desta reunião.";
  if (op === "diarization-name") return "Não foi possível salvar o nome do falante.";
  return op === "list" ? "Falha ao carregar a biblioteca" : op === "detail" ? "Falha ao carregar os detalhes" : op === "resolve" ? "Falha ao resolver a reprodução" : op === "subtitles" ? "Falha ao enfileirar as legendas" : op === "diarization" ? "Falha ao iniciar a identificação de falantes" : "Request inválido";
};
const titleOf = (entry: LibraryEntry): string => entry.meetingTitle || basename(entry.sourcePath);
const completedJob = (entry: LibraryEntry): JobRecord | undefined =>
  entry.jobs.find((job) => job.state === "completed");
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
const loadLibrary = async (force = false): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>["config"]; entries: LibraryEntry[] }> => {
  if (!force && libraryCache) return libraryCache;
  const { config } = await loadConfig();
  const entries = await buildLibrary(config, new JobStore());
  libraryCache = { at: Date.now(), config, entries };
  return libraryCache;
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
export const buildTranscriptBoundary = (canonical: Transcript | undefined, captionTranscript: PlayerTranscript, diarization: DiarizationView): { transcript: PlayerTranscript; captionTranscript: PlayerTranscript; diarization: DiarizationView } => ({
  transcript: canonical ? { ...parsePlayerTranscript(canonical), text: canonical.text } : captionTranscript,
  captionTranscript,
  diarization
});
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
export const registeredAgentRecordingId=(entry:LibraryEntry)=>completedJob(entry)?.id||entry.jobs[0]?.id||(entry.archive?.source.sha256?entry.archive.id:undefined);
const list = async (): Promise<unknown> => {
  const { entries: items } = await loadLibrary(true);
  return { items: items.map((entry) => ({ key: entry.sourcePath, recordingId:registeredAgentRecordingId(entry), title: titleOf(entry), fileName: basename(entry.sourcePath), modifiedAt: entry.modifiedAt, sourceExists: entry.sourceExists, location: locationOf(entry), status: statusOf(entry), backup: backupOf(entry) })) };
};
const detail = async (key: string): Promise<unknown> => {
  const { entry } = await findEntry(key);
  const jobStore = new JobStore();
  entry.jobs = await Promise.all(entry.jobs.map(job => jobStore.get(job.id).catch(() => job)));
  if (entry.archive) entry.archive = (await new ArchiveStore().get(entry.archive.id).catch(() => entry.archive)) || undefined;
  const job = completedJob(entry);
  const subtitleId = entry.archive?.vaio.state === "completed" ? entry.archive.id : entry.jobs.find((item) => item.target === "remote" && item.state === "completed")?.id;
  const [{ transcript: originalTranscript }, summary, timesheet, canonical] = await Promise.all([transcriptFor(entry, job), job ? readPlainArtifact(job, "summary") : Promise.resolve(""), timesheetText(entry.sourcePath), job ? readCanonicalTranscript(job).catch(() => undefined) : Promise.resolve(undefined)]);
  const visualReview=job&&canonical?await studioFrames.readResult(job.id,job.source.sha256,canonical).catch(()=>undefined):undefined;
  const diarizationResult = job && canonical ? await new DiarizationStore().read(job.id, job.source.sha256, canonical.text) : undefined;
  // Speaker timing comes from its own acoustic timeline. A lexical match inside
  // a 10-minute transcript block is not enough evidence to invent word timing.
  const diarization: DiarizationView = diarizationResult ? buildDiarizationView(diarizationResult)
    : job && canonical ? await readDiarizationStatus(job, canonical) : { state: "idle" };
  const boundary = buildTranscriptBoundary(canonical, originalTranscript, diarization);
  let subtitleState = originalTranscript.timing === "segment" ? "ready" : "idle";
  let subtitleMessage: string | undefined;
  if (subtitleId && subtitleState !== "ready") {
    const status = await runCommand("systemctl", ["--user", "show", `recording-cli-subtitles-${subtitleId}.service`, "--property=ActiveState"], { timeoutMs: 5000 }).catch(() => undefined);
    const operation = subtitleUnitStatus(status?.stdout);
    subtitleState = operation.state;
    subtitleMessage = operation.message;
  }
  return { key: entry.sourcePath, recordingId:registeredAgentRecordingId(entry), title: titleOf(entry), status: entry.jobs[0]?.state || statusOf(entry), backup: backupOf(entry), ...boundary, summary: summary, visualReview, summaryInfo: job ? `${job.summary.provider}/${job.summary.model} · ${job.summary.provider === "openai" ? "provedor externo" : "Ollama: endpoint configurado"}` : "", timesheet, subtitleState, subtitleMessage,
    ...(job && canonical ? { diarizationId: job.id, jobId: job.id } : {}), ...(subtitleId ? { subtitleId } : {}) };
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
export const parseRequest = (value: unknown): Request => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request inválido");
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 1) throw new Error("id deve ser um inteiro positivo");
  if (!OPERATIONS.includes(request.op as Request["op"])) throw new Error("operação desconhecida");
  if (request.key !== undefined && (typeof request.key !== "string" || request.key.length > 4096 || /[\x00-\x1f]/.test(request.key))) throw new Error("key inválido");
  if (request.payload !== undefined && (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload))) throw new Error("payload inválido");
  const payload = (request.payload || {}) as Record<string, unknown>;
  const allowed = request.op === "provider-authorize" ? ["provider","model","analysis","context","maxFrames","maxBytes","consent"] : request.op === "provider-analyze" ? ["grantId","requestId","question","timestamps"] : request.op === "provider-cancel" ? ["grantId"] : request.op === "agent-status" ? [] : request.op === "agent-authorize" ? ["recipientId","data","consent"] : ["agent-cancel","agent-pause","agent-resume","agent-revoke"].includes(request.op as string) ? ["grantId"] : request.op === "agent-frames" ? ["grantId","timestamps"] : request.op === "frames-check-models" ? ["visionModel", "summaryModel"] : request.op === "frames-scope" ? ["startSeconds","endSeconds"] : request.op === "frames-plan" ? ["capabilityId","consentTranscript","scopeId"] : request.op === "frames-preview-plan" ? ["planId"] : request.op === "frames-preview" ? ["question", "seconds", "capabilityId"] : request.op === "frames-confirm" ? ["previewId", "consent", "consentKey"] : request.op === "frames-cancel" ? ["previewId","scopeId"] : request.op === "onboarding-save-local" ? ["revision"] : request.op === "capture-start" ? ["title"] : request.op === "diarization-name" ? ["speakerId", "label"] : request.op === "context-meeting" ? ["maxCharacters", "query", "offset"] : [];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("payload inválido");
  for (const [key, max] of [["title", 200], ["speakerId", 8], ["label", 80], ["query", 1000], ["question", 1000], ["previewId", 36], ["revision", 64], ["visionModel", 200], ["summaryModel", 200], ["capabilityId", 36], ["consentKey", 64]] as const) {
    if (payload[key] !== undefined && (typeof payload[key] !== "string" || (payload[key] as string).length > max || /[\x00-\x1f\x7f]/.test(payload[key] as string))) throw new Error("payload inválido");
  }
  if (payload.maxCharacters !== undefined && (!Number.isSafeInteger(payload.maxCharacters) || (payload.maxCharacters as number) < 4096 || (payload.maxCharacters as number) > 24000)) throw new Error("payload inválido");
  if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0)) throw new Error("payload inválido");
  if (payload.seconds !== undefined && (typeof payload.seconds !== "number" || !Number.isFinite(payload.seconds) || payload.seconds < 0)) throw new Error("payload inválido");
  for(const name of ["startSeconds","endSeconds"] as const)if(payload[name]!==undefined && (typeof payload[name]!=="number"||!Number.isFinite(payload[name])||payload[name]!<0||payload[name]!>86400))throw Error("payload inválido");
  if(payload.scopeId!==undefined && (typeof payload.scopeId!=="string"||payload.scopeId.length>100||/[\x00-\x1f]/.test(payload.scopeId)))throw Error("payload inválido");
  if(payload.planId!==undefined && (typeof payload.planId!=="string"||payload.planId.length>100||/[\x00-\x1f]/.test(payload.planId)))throw Error("payload inválido");
  if(payload.consentTranscript!==undefined && typeof payload.consentTranscript!=="boolean")throw Error("payload inválido");
  if(payload.provider!==undefined&&!['openai','google'].includes(payload.provider as string))throw Error('payload inválido');
  if(payload.model!==undefined&&(typeof payload.model!=='string'||!/^[-a-zA-Z0-9._]{1,160}$/.test(payload.model)))throw Error('payload inválido');
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
  return { id: request.id as number, op: request.op as Request["op"], ...(request.key === undefined ? {} : { key: request.key as string }), payload };
};
const handle = async (request: Request): Promise<unknown> => {
  if(request.op.startsWith('provider-')){const p=request.payload||{},key=request.key||'';
   if(request.op==='provider-cancel')return providerStudio.cancel(p.grantId||'');
   const resolveId=async()=>{libraryCache=undefined;const {entry}=await findEntry(key);const id=registeredAgentRecordingId(entry);if(!id)throw Error('Recording not registered');return id;};
   if(request.op==='provider-analyze')return providerStudio.run(resolveId,{grantId:p.grantId||'',requestId:p.requestId||'',question:p.question||'',timestamps:p.timestamps||[]});
   return providerStudio.authorize(await resolveId(),{provider:p.provider!,model:p.model||'',consent:p.consent===true,analysis:p.analysis!,context:p.context===true,maxFrames:p.maxFrames,maxBytes:p.maxBytes});
  }
  if(request.op.startsWith('agent-')){const key=request.key||'';const p=request.payload||{};
   if(request.op==='agent-cancel')return agentStudio.cancel(p.grantId||'');
   if(request.op==='agent-frames')return agentStudio.frames(async()=>{libraryCache=undefined;const {entry}=await findEntry(key);const id=registeredAgentRecordingId(entry);if(!id)throw Error('Recording is not registered');return id;},p.grantId||'',p.timestamps||[]);
   libraryCache=undefined;const {entry}=await findEntry(key);const recordingId=registeredAgentRecordingId(entry);if(!recordingId)throw Error('Recording is not registered; no agent opt-in available');
   if(request.op==='agent-status')return agentStudio.status(recordingId);
   if(request.op==='agent-authorize')return agentStudio.authorize(recordingId,p.recipientId||'',p.data||[],p.consent===true);
   return agentStudio.change(recordingId,p.grantId||'',request.op.slice(6) as 'pause'|'resume'|'revoke');
  }
  if(request.op === "processing-status") return readHeavyStatus();
  if (request.op === "ux-capabilities") return {mockFrames: process.env.FALATRACE_UX_MOCK_ONLY === "1",realFrames:true,productVersion};
  if (request.op === "onboarding-read") return readOnboarding();
  if (request.op === "onboarding-save-local") { const result=await saveLocalOnboarding(request.payload?.revision || ""); libraryCache=undefined; return result; }
  if (request.op.startsWith("frames-")) {
    const key=request.key || "";
    if(process.env.FALATRACE_UX_MOCK_ONLY !== "1"){
      if(request.op==='frames-cancel')return studioFrames.cancel(key,request.payload?.previewId||'',request.payload?.scopeId);
      const readSource=async():Promise<StudioSource>=>{
        libraryCache=undefined;
        const {entry}=await findEntry(key);const {config}=await loadConfig();const candidate=completedJob(entry);
        if(!candidate)throw Error('A completed transcript is required');
        const job=await new JobStore().get(candidate.id);if(job.state!=='completed')throw Error('Completed job changed');
        await assertExistingManagedPath(config,entry.sourcePath);
        const transcript=await readCanonicalTranscript(job);if(!transcript)throw Error('Transcript unavailable');
        return {key,jobId:job.id,path:entry.sourcePath,mediaHash:job.source.sha256,transcript,config};
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
          if ((await readCaptureStatus(config)).active) throw new Error("Não altere o áudio durante uma captura ativa.");
          const configuration = await configureDefaultAudio();
          libraryCache = undefined;
          return { ...await readCaptureStatus((await loadConfig()).config), configuration };
        } finally { await captureLease.release(); }
      }
      const stopped = await stopCapture(config, { recoverOnly: request.op === "capture-recover" });
      libraryCache = undefined;
      return { ...await readCaptureStatus(config), outcome: stopped.state, jobId: stopped.job?.id };
    } finally { await lease.release(); }
  }
  if (request.op === "jobs-list") {
    const { entries } = await loadLibrary();
    const titles = new Map(entries.flatMap((entry) => entry.jobs.map((job) => [job.id, titleOf(entry)] as const)));
    const jobs = (await new JobStore().list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: jobs.slice(0, 200).map((job) => ({ id: job.id, title: titles.get(job.id) || basename(job.sourcePath), state: job.state, target: job.target, createdAt: job.createdAt })), total: jobs.length };
  }
  if (!request.key) throw new Error("key é obrigatório para esta operação");
  if (request.op === "job-process" || request.op === "job-retry") return queueSelectedJob(request.key, { retry: request.op === "job-retry" });
  if (request.op === "diarization-name" || request.op === "context-meeting") {
    const id = UUID.test(request.key) ? request.key : completedJob((await findEntry(request.key)).entry)?.id;
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
        if (pending.size >= 32) throw new Error("Muitas operações pendentes; tente novamente.");
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
  await Promise.allSettled([...pending]);
};
if (import.meta.main) void runDesktopBridge();
