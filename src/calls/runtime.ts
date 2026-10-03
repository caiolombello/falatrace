import { randomUUID } from "node:crypto";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { enqueueRecording } from "../jobs/enqueue";
import { acquireSingleton } from "../runtime/singleton";
import { TimeEntryStore } from "../timesheet/store";
import { classifyCall } from "./classifier";
import { getAutomationStatePath, readAutomationState } from "./control";
import { collectNetworkTelemetry } from "./network";
import {
  notifyCallEnded,
  notifyCallStarted,
  notifyRecordingStarted,
  notifyRecordingStopped,
  notifyRecordingUnavailable,
  notifyRecordingWarning
} from "./notifier";
import { RecordingController } from "../recording/controller";
import { monitorPipeWire } from "./pipewire";
import { CallStateMachine } from "./stateMachine";
import {
  logCallEvent,
  sanitizeError,
  writeCallStatus
} from "./status";
import type {
  CallApplication,
  CallTransition,
  DetectionObservation,
  NetworkTelemetry,
  PipeWireNodeRecord
} from "./types";

const STARTUP_GRACE_MS = 10_000;

const defaultNotifications = {
  callStarted: notifyCallStarted, callEnded: notifyCallEnded,
  recordingStarted: notifyRecordingStarted, recordingStopped: notifyRecordingStopped,
  unavailable: notifyRecordingUnavailable, warning: notifyRecordingWarning
};

type CallMonitorServices = {
  monitor?: typeof monitorPipeWire;
  run?: typeof runCommand;
  notifications?: typeof defaultNotifications;
  network?: typeof collectNetworkTelemetry;
};

const waitForRetry = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });

export class CallMonitorRuntime {
  private readonly machine: CallStateMachine;
  private readonly recorder: RecordingController;
  private readonly timeEntries = new TimeEntryStore();
  private readonly readyAt = Date.now() + STARTUP_GRACE_MS;
  private observation: DetectionObservation = {
    active: false,
    confidence: 0,
    reasons: [],
    nodeIds: []
  };
  private latestNetwork?: NetworkTelemetry;
  private evaluationTimer?: ReturnType<typeof setTimeout>;
  private networkTimer?: ReturnType<typeof setTimeout>;
  private recordingStopTimer?: ReturnType<typeof setTimeout>;
  private captureHealthTimer?: ReturnType<typeof setInterval>;
  private recordingWarning?: string;
  // Only a cancelled startup can authorize recovery inside the same inferred call.
  private cancelledStartRecovery = false;
  private networkRunning = false;
  private stopped = false;
  private sessionId: string | null = null;
  private candidateStartedAt: number | null = null;
  private sessionStartedAt: string | null = null;
  private sessionEndedAt: string | null = null;
  private lastCallSignalAt: number | null = null;
  private lastSignalSignature = "";
  private evaluationQueue: Promise<void> = Promise.resolve();
  private runSignal?: AbortSignal;
  private automationPaused = false;
  private automationWatcher?: FSWatcher;
  private automationQueue: Promise<void> = Promise.resolve();
  private statusQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly dryRun: boolean,
    private readonly services: CallMonitorServices = {}
  ) {
    this.machine = new CallStateMachine(
      config.callDetection.entryDebounceSeconds * 1_000,
      config.callDetection.exitTimeoutSeconds * 1_000
    );
    this.recorder = new RecordingController(
      config.callDetection.mode === "obs" ? { ...config, backend: "obs" } : config, "call",
      undefined, services.run
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    const automationPath = getAutomationStatePath();
    await fs.mkdir(dirname(automationPath), { recursive: true, mode: 0o700 });
    try {
      this.automationWatcher = watch(dirname(automationPath), (_event, filename) => {
        if (filename && filename.toString() !== basename(automationPath)) return;
        this.automationQueue = this.automationQueue.then(async () => {
          if (this.stopped) return;
          await this.refreshAutomation();
          await this.persistStatus();
        }).catch((err) => logCallEvent("automation.status-error", { error: sanitizeError(err) }));
      });
      await this.refreshAutomation();
      if (!this.dryRun) {
        const recovered = await this.recorder.recover();
        if (recovered) {
          this.sessionId = recovered.id;
          this.sessionStartedAt = recovered.startedAt;
          this.sessionEndedAt = recovered.endedAt || null;
          if (recovered.phase === "stopped") await this.stopOwnedRecording(recovered.app, recovered.endedAt);
          else this.scheduleEvaluation(this.readyAt);
        }
      }
      await this.persistStatus();
      logCallEvent("call-monitor.started", {
        dryRun: this.dryRun,
        mode: this.config.callDetection.mode,
        startupGraceSeconds: STARTUP_GRACE_MS / 1_000
      });
      if (!this.dryRun) {
        this.captureHealthTimer = setInterval(() => {
          this.evaluationQueue = this.evaluationQueue.then(() => this.checkCaptureHealth());
        }, 5_000);
      }
      while (!signal.aborted) {
        try {
          await (this.services.monitor || monitorPipeWire)((nodes) => this.onNodesChanged(nodes), signal);
        } catch (err) {
          if (signal.aborted) break;
          logCallEvent("pipewire.monitor-error", { error: sanitizeError(err), retrySeconds: 2 });
          await waitForRetry(2_000, signal);
        }
      }
    } finally {
      await this.shutdown();
      logCallEvent("call-monitor.stopped");
    }
  }

  private onNodesChanged(nodes: PipeWireNodeRecord[]): void {
    this.observation = classifyCall(nodes, this.config.callDetection.apps);
    const signature = JSON.stringify({
      active: this.observation.active,
      app: this.observation.app,
      confidence: this.observation.confidence,
      reasons: this.observation.reasons
    });
    if (signature !== this.lastSignalSignature) {
      this.lastSignalSignature = signature;
      logCallEvent("call.signal", {
        active: this.observation.active,
        app: this.observation.app,
        confidence: this.observation.confidence,
        reasons: this.observation.reasons,
        nodeCount: this.observation.nodeIds.length
      });
    }
    this.queueEvaluation();
  }

  private queueEvaluation(): void {
    this.evaluationQueue = this.evaluationQueue
      .then(() => this.evaluate())
      .catch((err) => logCallEvent("call.evaluate-error", { error: sanitizeError(err) }));
  }

  private async evaluate(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    if (now < this.readyAt) {
      this.scheduleEvaluation(this.readyAt);
      await this.persistStatus();
      return;
    }
    if (!this.dryRun) await this.recorder.recover();
    const transition = this.machine.update(this.observation, now);
    if (transition) await this.handleTransition(transition);
    await this.recoverCancelledStart();
    if (this.machine.getSnapshot().state === "IDLE" && !this.observation.active && this.recorder.ownsRecording()) {
      await this.stopOwnedRecording(this.recorder.getSession()?.app);
    }
    await this.persistStatus();
    this.updateNetworkPolling();
    const deadline = this.machine.getNextDeadline();
    if (deadline !== null) this.scheduleEvaluation(deadline);
  }

  private scheduleEvaluation(deadline: number): void {
    if (this.evaluationTimer) clearTimeout(this.evaluationTimer);
    this.evaluationTimer = setTimeout(
      () => this.queueEvaluation(),
      Math.max(0, deadline - Date.now())
    );
  }

  private async handleTransition(transition: CallTransition): Promise<void> {
    logCallEvent("call.state-changed", {
      from: transition.from,
      to: transition.to,
      app: transition.app,
      confidence: transition.confidence,
      reasons: transition.reasons
    });

    if (transition.to === "CANDIDATE" && transition.from === "IDLE") {
      this.candidateStartedAt = transition.at;
    }
    if (transition.to === "IDLE" && transition.from === "CANDIDATE") {
      this.candidateStartedAt = null;
      this.sessionStartedAt = null;
    }
    if (transition.to === "ENDING" && transition.from === "IN_CALL") {
      this.lastCallSignalAt = transition.at;
    }
    if (transition.to === "IN_CALL" && transition.from === "ENDING") {
      this.lastCallSignalAt = null;
      this.sessionEndedAt = null;
    }

    if (transition.to === "IN_CALL" && transition.from === "CANDIDATE") {
      const detectedStartAt = new Date(
        this.candidateStartedAt || transition.at
      ).toISOString();
      if (!this.sessionId || !this.recorder.ownsRecording()) {
        this.sessionId = randomUUID();
        this.sessionStartedAt = detectedStartAt;
      } else if (!this.sessionStartedAt) {
        this.sessionStartedAt = detectedStartAt;
      }
      this.sessionEndedAt = null;
      if (
        !this.dryRun &&
        this.config.timesheet.enabled &&
        this.config.timesheet.automaticFromCalls
      ) {
        await this.timeEntries
          .startCall(
            this.sessionId,
            transition.app,
            this.sessionStartedAt
          )
          .catch((err) =>
            logCallEvent("timesheet.start-error", { error: sanitizeError(err) })
          );
      }
      if (!this.dryRun) {
        await (this.services.notifications || defaultNotifications).callStarted(transition.app).catch((err) =>
          logCallEvent("notification.error", { error: sanitizeError(err) })
        );
      }
      if (
        !this.dryRun &&
        this.config.callDetection.mode !== "notify-only"
      ) {
        await this.refreshAutomation();
        if (this.automationPaused) {
          logCallEvent("recording.suspended", { reason: "automation-paused" });
          return;
        }
        if (this.recorder.ownsRecording()) {
          logCallEvent("recording.retained", { reason: "pending-stop-from-previous-call" });
          return;
        }
        this.cancelledStartRecovery = false;
        await this.startOwnedRecording(transition.app);
      }
    }

    if (transition.to === "IDLE" && transition.from === "ENDING") {
      const sessionId = this.sessionId;
      const endedAt = new Date(this.lastCallSignalAt || transition.at).toISOString();
      this.sessionEndedAt = endedAt;
      if (!this.dryRun) {
        await (this.services.notifications || defaultNotifications).callEnded(transition.app).catch((err) =>
          logCallEvent("notification.error", { error: sanitizeError(err) })
        );
      }
      if (
        sessionId &&
        !this.dryRun &&
        this.config.timesheet.enabled &&
        this.config.timesheet.automaticFromCalls
      ) {
        await this.timeEntries.finishCall(sessionId, endedAt).catch((err) =>
          logCallEvent("timesheet.finish-error", { error: sanitizeError(err) })
        );
      }
      const outputPath = await this.stopOwnedRecording(transition.app, endedAt);
      if (
        sessionId &&
        !outputPath &&
        !this.recorder.ownsRecording() &&
        !this.dryRun &&
        this.config.timesheet.enabled &&
        this.config.timesheet.automaticFromCalls
      ) {
        await this.timeEntries
          .finishCall(sessionId, endedAt, undefined, "disabled")
          .catch((err) =>
            logCallEvent("timesheet.finish-error", { error: sanitizeError(err) })
          );
      }
      if (!this.recorder.ownsRecording()) {
        this.sessionId = null;
        this.sessionStartedAt = null;
      }
      this.candidateStartedAt = null;
      this.lastCallSignalAt = null;
    }
  }

  private updateNetworkPolling(): void {
    const state = this.machine.getSnapshot().state;
    const shouldPoll = this.observation.active || state !== "IDLE";
    if (!shouldPoll) {
      if (this.networkTimer) clearTimeout(this.networkTimer);
      this.networkTimer = undefined;
      return;
    }
    if (!this.networkRunning && !this.networkTimer) {
      this.networkTimer = setTimeout(() => {
        this.networkTimer = undefined;
        void this.sampleNetwork();
      }, 0);
    }
  }

  private async sampleNetwork(): Promise<void> {
    if (this.stopped || this.networkRunning) return;
    this.networkRunning = true;
    try {
      this.latestNetwork = await (this.services.network || collectNetworkTelemetry)();
      logCallEvent("call.network", { processes: this.latestNetwork });
      await this.persistStatus();
    } catch (err) {
      logCallEvent("network.telemetry-error", { error: sanitizeError(err) });
    } finally {
      this.networkRunning = false;
      if (!this.stopped) {
        const state = this.machine.getSnapshot().state;
        if (this.observation.active || state !== "IDLE") {
          this.networkTimer = setTimeout(() => {
            this.networkTimer = undefined;
            void this.sampleNetwork();
          }, this.config.callDetection.networkSampleSeconds * 1_000);
        }
      }
    }
  }

  private async startOwnedRecording(app?: CallApplication): Promise<void> {
    let inactiveDuringStart = false;
    try {
      const result = await this.recorder.start({
        sessionId: this.sessionId || undefined,
        app: app,
        signal: this.runSignal,
        shouldContinue: async () => {
          await this.refreshAutomation();
          if (!this.observation.active) inactiveDuringStart = true;
          return !this.stopped && !this.automationPaused && this.observation.active &&
            this.machine.getSnapshot().state === "IN_CALL";
        }
      });
      if (result === "cancelled") {
        this.cancelledStartRecovery = !this.stopped && !this.runSignal?.aborted && !this.automationPaused && inactiveDuringStart;
        logCallEvent("recording.start-cancelled", { reason: "call-ended-automation-paused-or-monitor-stopped" });
        return;
      }
      logCallEvent(result === "started" ? "recording.started" : "recording.already-recording");
      if (result === "started") {
        await (this.services.notifications || defaultNotifications).recordingStarted(app).catch((err) =>
          logCallEvent("notification.error", { error: sanitizeError(err) })
        );
      }
    } catch (err) {
      logCallEvent("recording.unavailable", { error: sanitizeError(err) });
      await (this.services.notifications || defaultNotifications).unavailable().catch((notifyError) =>
        logCallEvent("notification.error", { error: sanitizeError(notifyError) })
      );
    }
  }
  private async recoverCancelledStart(): Promise<void> {
    if (!this.cancelledStartRecovery || this.stopped || this.runSignal?.aborted || this.dryRun) return;
    const snapshot = this.machine.getSnapshot();
    if (snapshot.state === "IDLE") { this.cancelledStartRecovery = false; return; }
    if (snapshot.state !== "IN_CALL" || !this.observation.active) return;
    await this.refreshAutomation();
    if (this.automationPaused || this.config.callDetection.mode === "notify-only") {
      this.cancelledStartRecovery = false;
      return;
    }
    // All callers run on evaluationQueue. Finish/acknowledge the cancelled
    // fragment before assigning a new recording ID; never overlap two captures.
    await this.recorder.recover();
    if (this.recorder.ownsRecording()) {
      if (this.recorder.getSession()?.phase !== "stopped") {
        this.cancelledStartRecovery = false;
        return;
      }
      await this.stopOwnedRecording(snapshot.app);
      if (this.recorder.ownsRecording()) return; // stop/ack failed: preserve for next evaluation
    }
    this.cancelledStartRecovery = false; // failures/denied permission do not trigger automatic retries
    // Cancelled startup may have produced no media and cleared the controller.
    // Finish the previous call entry before rotating its recording identity.
    if (this.sessionId && this.config.timesheet.enabled && this.config.timesheet.automaticFromCalls) {
      await this.timeEntries.finishCall(this.sessionId, new Date().toISOString(), undefined, "disabled")
        .catch(err => logCallEvent("timesheet.finish-error", { error: sanitizeError(err) }));
    }
    this.sessionId = randomUUID();
    this.sessionStartedAt = new Date().toISOString();
    this.sessionEndedAt = null;
    if (this.config.timesheet.enabled && this.config.timesheet.automaticFromCalls) {
      await this.timeEntries.startCall(this.sessionId, snapshot.app, this.sessionStartedAt)
        .catch(err => logCallEvent("timesheet.start-error", { error: sanitizeError(err) }));
    }
    logCallEvent("recording.start-recovery", { reason: "call-returned-after-cancelled-start" });
    await this.startOwnedRecording(snapshot.app);
  }

  private async stopOwnedRecording(
    app?: CallApplication,
    endedAt = new Date().toISOString()
  ): Promise<string | undefined> {
    if (!this.sessionId || !this.recorder.ownsRecording()) return undefined;
    const sessionId = this.sessionId;
    const startedAt = this.sessionStartedAt || undefined;
    this.sessionEndedAt = endedAt;
    try {
      const stopped = await this.recorder.stop(sessionId, endedAt);
      if (!stopped) return undefined;
      const outputPath = stopped.outputPath;
      logCallEvent("recording.stopped", { outputAvailable: true });
      await (this.services.notifications || defaultNotifications).recordingStopped(app).catch((err) =>
          logCallEvent("notification.error", { error: sanitizeError(err) })
      );
      if (
        !this.dryRun &&
        this.config.timesheet.enabled &&
        this.config.timesheet.automaticFromCalls
      ) {
        await this.timeEntries.finishCall(sessionId, endedAt, outputPath).catch((err) =>
          logCallEvent("timesheet.link-recording-error", { error: sanitizeError(err) })
        );
      }
      if (this.config.processing.autoEnqueue &&
        (this.config.callDetection.mode !== "obs" || this.config.callDetection.enqueueOnStop)) {
        const job = await enqueueRecording(this.config, outputPath, {
          recordingId: sessionId, startedAt, endedAt, app
        });
        if (job && this.config.timesheet.enabled) {
          const entry = await this.timeEntries.findForJob(job.id, outputPath);
          if (entry) await this.timeEntries.linkJob(entry.id, job.id, outputPath);
        }
      }
      await this.recorder.acknowledge(sessionId);
      this.sessionEndedAt = null;
      return outputPath;
    } catch (err) {
      logCallEvent("recording.stop-error", { error: sanitizeError(err) });
      this.scheduleRecordingStopRetry();
      return undefined;
    }
  }

  private scheduleRecordingStopRetry(): void {
    if (this.stopped || this.recordingStopTimer || !this.recorder.ownsRecording()) return;
    this.recordingStopTimer = setTimeout(() => {
      this.recordingStopTimer = undefined;
      this.evaluationQueue = this.evaluationQueue.then(async () => {
        if (this.stopped) return;
        if (this.machine.getSnapshot().state === "IDLE") {
          await this.stopOwnedRecording(
          undefined,
          this.sessionEndedAt ||
            (this.lastCallSignalAt
              ? new Date(this.lastCallSignalAt).toISOString()
              : new Date().toISOString())
          );
        } else {
          this.scheduleRecordingStopRetry();
        }
      }).catch((err) => logCallEvent("recording.stop-retry-error", { error: sanitizeError(err) }));
    }, 5_000);
  }

  private async checkCaptureHealth(): Promise<void> {
    if (this.stopped) return;
    await this.refreshAutomation();
    const previousWarning = this.recordingWarning;
    try {
      if (this.recorder.ownsRecording()) {
        const health = await this.recorder.health();
        this.recordingWarning = health.warning;
        if (!health.active) {
          await this.recorder.recover();
          await this.stopOwnedRecording(this.recorder.getSession()?.app);
        }
      } else {
        this.recordingWarning = undefined;
      }
    } catch (err) {
      this.recordingWarning = "Não foi possível verificar a captura. Confira record status e record logs.";
      logCallEvent("recording.health-error", { error: sanitizeError(err) });
    }
    if (this.recordingWarning && this.recordingWarning !== previousWarning) {
      await (this.services.notifications || defaultNotifications).warning(this.recordingWarning).catch(() => undefined);
    }
    await this.recoverCancelledStart();
    await this.persistStatus().catch((err) => logCallEvent("recording.status-error", { error: sanitizeError(err) }));
  }

  private persistStatus(): Promise<void> {
    this.statusQueue = this.statusQueue.catch(() => undefined).then(async () => {
      const snapshot = this.machine.getSnapshot();
      await writeCallStatus({
        version: 1,
        state: snapshot.state,
        app: snapshot.app,
        confidence: snapshot.confidence,
        reasons: snapshot.reasons,
        updatedAt: new Date().toISOString(),
        dryRun: this.dryRun,
        recordingOwned: this.recorder.ownsRecording(),
        recordingBackend: this.recorder.getSession()?.backend,
        recordingWarning: this.recordingWarning,
        automationPaused: this.automationPaused,
        network: this.latestNetwork
      });
    });
    return this.statusQueue;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.automationWatcher?.close();
    await this.automationQueue;
    if (this.captureHealthTimer) clearInterval(this.captureHealthTimer);
    if (this.evaluationTimer) clearTimeout(this.evaluationTimer);
    if (this.networkTimer) clearTimeout(this.networkTimer);
    if (this.recordingStopTimer) clearTimeout(this.recordingStopTimer);
    await this.evaluationQueue;
    const endedAt = new Date().toISOString();
    if (
      this.sessionId &&
      !this.dryRun &&
      this.config.timesheet.enabled &&
      this.config.timesheet.automaticFromCalls
    ) {
      await this.timeEntries.finishCall(this.sessionId, endedAt).catch((err) =>
        logCallEvent("timesheet.finish-error", { error: sanitizeError(err) })
      );
    }
    const outputPath = await this.stopOwnedRecording(
      this.machine.getSnapshot().app,
      endedAt
    );
    if (
      this.sessionId &&
      !outputPath &&
      !this.recorder.ownsRecording() &&
      !this.dryRun &&
      this.config.timesheet.enabled &&
      this.config.timesheet.automaticFromCalls
    ) {
      await this.timeEntries
        .finishCall(this.sessionId, endedAt, undefined, "disabled")
        .catch((err) =>
          logCallEvent("timesheet.finish-error", { error: sanitizeError(err) })
        );
    }
    await this.persistStatus();
  }

  private async refreshAutomation(): Promise<void> {
    try {
      this.automationPaused = (await readAutomationState()).paused;
    } catch (err) {
      this.automationPaused = true;
      logCallEvent("automation.invalid-state", { error: sanitizeError(err) });
    }
  }
}

export const runCallMonitor = async (
  config: AppConfig,
  options: { dryRun?: boolean; signal: AbortSignal }
): Promise<void> => {
  const dryRun = options.dryRun || config.callDetection.dryRun;
  if (!config.callDetection.enabled && !dryRun) {
    throw new Error("Call detection is disabled. Set callDetection.enabled=true or use --dry-run");
  }
  const lease = await acquireSingleton(dryRun ? "call-monitor-dry-run" : "call-monitor");
  try {
    const runtime = new CallMonitorRuntime(config, dryRun);
    await runtime.run(options.signal);
  } finally {
    await lease.release();
  }
};
