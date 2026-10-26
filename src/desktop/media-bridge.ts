// "Remover mídia agora…" (DESIGN-STUDIO §4 "Media retention"). Planning hashes the media and removing
// re-plans and hashes again, so both are start + poll: media-plan and media-remove return a request
// id at once and media-status reports the outcome.
import { randomUUID } from "node:crypto";
import { MEDIA_RETENTION_KNOWN_ERRORS, MEDIA_RETENTION_MESSAGES, planMediaRemoval, removeMediaNow, type MediaRemovalPlan, type RetainedMode } from "../media-retention";
import type { MediaRetentionResult } from "../media-retention/apply";
import { type BridgeCall, type BridgeFamily, invalid, matches, oneOf, pathKey, SHA256, UUID } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";

export const MEDIA_BRIDGE_OPERATIONS = ["media-plan", "media-remove", "media-status"] as const;

export const MEDIA_BRIDGE_MESSAGES = Object.freeze({
  planFailed: "Não foi possível conferir se a mídia pode ser removida; nada foi apagado.",
  unavailable: "Este pedido de remoção de mídia não está mais disponível; confira a gravação de novo."
});

export const MEDIA_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([...new Set([...Object.values(MEDIA_BRIDGE_MESSAGES), ...MEDIA_RETENTION_KNOWN_ERRORS])]);

export const MEDIA_TASK_LIMITS = Object.freeze({ kept: 32, finishedMs: 10 * 60_000 });

const ALLOWED: Record<(typeof MEDIA_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "media-plan": [],
  "media-remove": ["mode", "consentKey"],
  "media-status": ["requestId"]
};

const validate = (call: BridgeCall): void => {
  if (call.op === "media-status") {
    matches(call.payload, "requestId", UUID);
    return;
  }
  pathKey(call);
  if (call.op === "media-remove") {
    oneOf(call.payload, "mode", ["transcript-only", "audio-only"]);
    matches(call.payload, "consentKey", SHA256);
  }
};

type MediaTask = {
  id: string; kind: "plan" | "remove"; key: string; status: "running" | "completed" | "failed";
  plan?: MediaRemovalPlan; result?: MediaRetentionResult; error?: string; finishedAt?: number;
};

const tasks = new Map<string, MediaTask>();

const prune = (): void => {
  const now = Date.now();
  for (const [id, task] of tasks) if (task.finishedAt !== undefined && now - task.finishedAt > MEDIA_TASK_LIMITS.finishedMs) tasks.delete(id);
  const finished = [...tasks.values()].filter((task) => task.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
  while (tasks.size > MEDIA_TASK_LIMITS.kept && finished.length) tasks.delete(finished.shift()!.id);
};

const knownMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && MEDIA_RETENTION_KNOWN_ERRORS.includes(error.message) ? error.message : fallback;

const run = (kind: MediaTask["kind"], key: string, work: () => Promise<Partial<Pick<MediaTask, "plan" | "result">>>, fallback: string): { requestId: string; status: "running" } => {
  prune();
  // One plan and one removal per recording at a time (each hashes the whole media): a second click joins the running one.
  const running = [...tasks.values()].find((task) => task.kind === kind && task.key === key && task.status === "running");
  if (running) return { requestId: running.id, status: "running" };
  const task: MediaTask = { id: randomUUID(), kind, key, status: "running" };
  tasks.set(task.id, task);
  void work().then((outcome) => Object.assign(task, { status: "completed", finishedAt: Date.now() }, outcome),
    (error: unknown) => Object.assign(task, { status: "failed", finishedAt: Date.now(), error: knownMessage(error, fallback) }));
  return { requestId: task.id, status: "running" };
};

const planView = (plan: MediaRemovalPlan) => ({
  eligible: plan.eligible,
  reasons: plan.reasons,
  // bytesFreed is null for audio-only: the size of the audio kept is known only after extraction.
  options: plan.options.map(({ mode, eligible, bytesFreed, reasons }) => ({ mode, eligible, bytesFreed, reasons })),
  consentKey: plan.consentKey,
  scope: plan.scope,
  legacyTranscript: plan.legacyTranscript
});

export const mediaBridge: BridgeFamily<BridgeContext> = {
  operations: MEDIA_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    if (call.op === "media-status") {
      prune();
      const task = tasks.get(call.payload.requestId as string);
      if (!task) throw new Error(MEDIA_BRIDGE_MESSAGES.unavailable);
      return {
        requestId: task.id, kind: task.kind, key: task.key, status: task.status,
        ...(task.plan ? planView(task.plan) : {}),
        ...(task.result ? { mode: task.result.mode, removed: true, bytesFreed: task.result.bytesFreed, ...(task.result.retainedAudio ? { retainedAudioBytes: task.result.retainedAudio.size } : {}) } : {}),
        ...(task.error ? { error: task.error } : {})
      };
    }
    // Fresh library state: the plan binds the media, jobs and backups as they are now.
    context.library.invalidate();
    const { config, entry } = await context.library.find(call.key!);
    const deps = { ...context.deps.retention, config };
    if (call.op === "media-plan") return run("plan", entry.sourcePath, async () => ({ plan: await planMediaRemoval(entry, deps) }), MEDIA_BRIDGE_MESSAGES.planFailed);
    if (call.op === "media-remove") {
      return run("remove", entry.sourcePath, async () => {
        try {
          return { result: await removeMediaNow(entry, call.payload.mode as RetainedMode, call.payload.consentKey as string, deps) };
        } finally {
          context.library.invalidate();
        }
      }, MEDIA_RETENTION_MESSAGES.removeFailed);
    }
    return invalid();
  },
  knownErrors: MEDIA_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op === "media-remove" ? MEDIA_RETENTION_MESSAGES.removeFailed : op === "media-status" ? MEDIA_BRIDGE_MESSAGES.unavailable : MEDIA_BRIDGE_MESSAGES.planFailed
};

/** Forgets every request (tests). */
export const clearMediaTasks = (): void => tasks.clear();
