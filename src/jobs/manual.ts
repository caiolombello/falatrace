import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AppConfig } from "../config/defaults";
import { isPlaceholderRemoteHost } from "../config/settings";
import { probeMedia } from "./media";
import { queueSelectedJob, type QueueSelectedJobResult } from "./queue";
import { getSshDestination } from "./remote";
import { JobStore } from "./store";
import type { JobRecord } from "./types";

/**
 * Process a recording on explicit request from the Studio. The plan discloses where the
 * audio and transcript go before anything is created; running requires the consent key
 * of that exact plan, so a changed configuration or file needs a fresh confirmation.
 */
export type ProcessAction = "create" | "queue" | "retry" | "none";

export type Destination = { provider: string; model: string; where: string; external: boolean };

export type ProcessPlan = {
  key: string;
  action: ProcessAction;
  reason: string;
  jobId?: string;
  jobState?: string;
  durationSeconds: number | null;
  target: "local" | "remote";
  /** The worker that receives the audio when the target is remote. */
  remote?: { destination: string; port: number };
  transcription: Destination;
  summary: Destination;
  consentKey: string;
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};

export const describeDestinations = (
  target: "local" | "remote",
  transcription: { provider: string; model: string },
  summary: { provider: string; model: string },
  config: AppConfig
): { transcription: Destination; summary: Destination } => {
  const remote = target === "remote";
  const transcriptionWhere = transcription.provider === "whisper-cpp"
    ? (remote ? "Whisper.cpp no worker remoto" : "Whisper.cpp neste computador")
    : transcription.provider === "openai" ? "OpenAI, serviço externo" : "Google Gemini, serviço externo";
  const summaryWhere = summary.provider === "openai" ? "OpenAI, serviço externo"
    : isLoopbackUrl(config.summary.ollamaUrl) ? (remote ? "Ollama no worker remoto" : "Ollama neste computador")
      : `Ollama em ${new URL(config.summary.ollamaUrl).host}`;
  return {
    transcription: { ...transcription, where: transcriptionWhere, external: transcription.provider !== "whisper-cpp" || remote },
    summary: { ...summary, where: summaryWhere, external: summary.provider === "openai" || remote || !isLoopbackUrl(config.summary.ollamaUrl) }
  };
};

export type ManualProcessDeps = {
  store: Pick<JobStore, "get" | "enqueue">;
  duration: (path: string) => Promise<number>;
  queue: (id: string, options?: { retry?: boolean }) => Promise<QueueSelectedJobResult>;
};

export const defaultManualProcessDeps = (): ManualProcessDeps => ({
  store: new JobStore(),
  duration: (path) => probeMedia(path),
  queue: (id, options) => queueSelectedJob(id, options)
});

const modelFor = (config: AppConfig, provider: string, kind: "transcription" | "summary"): string =>
  kind === "transcription"
    ? provider === "openai" ? config.transcription.openaiModel : provider === "gemini" ? config.transcription.geminiModel : config.transcription.whisperCpp.modelPath.split("/").pop() || "whisper.cpp"
    : provider === "openai" ? config.summary.openaiModel : config.summary.ollamaModel;

export const planRecordingProcessing = async (
  config: AppConfig,
  entry: { sourcePath: string; sourceExists: boolean; jobs: JobRecord[] },
  deps: ManualProcessDeps = defaultManualProcessDeps()
): Promise<ProcessPlan> => {
  const latest = entry.jobs.length ? await deps.store.get(entry.jobs[0].id).catch(() => entry.jobs[0]) : undefined;
  let action: ProcessAction;
  let reason: string;
  if (!latest) {
    action = entry.sourceExists ? "create" : "none";
    reason = entry.sourceExists ? "Esta gravação ainda não foi processada." : "O arquivo original não está neste computador.";
  } else if (latest.state === "completed") {
    action = "none"; reason = "Esta gravação já foi processada.";
  } else if (latest.state === "processing") {
    action = "none"; reason = "O processamento já está em andamento.";
  } else if (latest.state === "failed") {
    action = "retry"; reason = "O último processamento falhou; ele pode ser repetido com as mesmas escolhas.";
  } else {
    action = "queue"; reason = "A gravação está na fila e pode ser processada agora.";
  }
  const target = latest ? latest.target : config.processing.defaultTarget;
  // Local processing reads the original recording: without it, queueing or retrying can only fail again.
  if (latest && (action === "queue" || action === "retry") && latest.target === "local" &&
      !(await fs.stat(latest.sourcePath).then((stat) => stat.isFile(), () => false))) {
    action = "none";
    reason = "O arquivo original não está neste computador.";
  }
  if (action === "create" && target === "remote" && isPlaceholderRemoteHost(config.remote.host)) {
    action = "none";
    reason = "O processamento está marcado como remoto, mas nenhum worker foi configurado.";
  }
  const transcription = latest
    ? { provider: latest.transcription.provider, model: latest.transcription.model }
    : { provider: config.transcription.provider, model: modelFor(config, config.transcription.provider, "transcription") };
  const summary = latest
    ? { provider: latest.summary.provider, model: latest.summary.model }
    : { provider: config.summary.provider, model: modelFor(config, config.summary.provider, "summary") };
  const destinations = describeDestinations(target, transcription, summary, config);
  const stat = entry.sourceExists ? await fs.stat(entry.sourcePath).catch(() => null) : null;
  const durationSeconds = stat && action !== "none" ? await deps.duration(entry.sourcePath).catch(() => null) : null;
  // The worker is part of what the user approves: another host, user, port or identity asks again.
  const remote = target === "remote" ? { destination: getSshDestination(config), port: config.remote.port } : undefined;
  const consentKey = createHash("sha256").update(JSON.stringify([
    entry.sourcePath, stat?.size ?? null, stat?.mtimeMs ?? null, action, latest?.id ?? null, target,
    destinations.transcription, destinations.summary, config.summary.ollamaUrl,
    remote ? [remote.destination, remote.port, config.remote.identityFile ?? null] : null
  ])).digest("hex");
  return {
    key: entry.sourcePath, action, reason, ...(latest ? { jobId: latest.id, jobState: latest.state } : {}),
    durationSeconds, target, ...(remote ? { remote } : {}), ...destinations, consentKey
  };
};

export const runRecordingProcessing = async (
  config: AppConfig,
  entry: { sourcePath: string; sourceExists: boolean; jobs: JobRecord[] },
  consent: { consent: boolean; consentKey: string },
  deps: ManualProcessDeps = defaultManualProcessDeps()
): Promise<{ jobId: string; status: QueueSelectedJobResult["status"]; created: boolean; warning?: string }> => {
  if (consent.consent !== true) throw new Error("Confirme o destino antes de processar.");
  const plan = await planRecordingProcessing(config, entry, deps);
  if (plan.consentKey !== consent.consentKey) throw new Error("A gravação ou as configurações mudaram. Revise o destino de novo.");
  if (plan.action === "none") throw new Error(plan.reason);
  const created = plan.action === "create";
  const jobId = created ? (await deps.store.enqueue(config, entry.sourcePath, {})).id : plan.jobId;
  if (!jobId) throw new Error(plan.reason);
  const queued = await deps.queue(jobId, { retry: plan.action === "retry" });
  return { jobId, status: queued.status, created, ...(queued.warning ? { warning: queued.warning } : {}) };
};
