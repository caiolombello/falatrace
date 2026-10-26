import { randomUUID } from "node:crypto";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { enqueueRecording, fastPathActive } from "../jobs/enqueue";
import { queueSelectedJob } from "../jobs/queue";
import { markFirstRun } from "../metrics/first-run";
import {
  activeOverride, MEETING_OVERRIDES_FILE, type MeetingOverride, OVERRIDE_WINDOW, readMeetingOverrides
} from "../reminders/overrides";
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
  /** The per-meeting decision ("skip" or "record") that applies now; defaults to the meeting-overrides file. */
  meetingOverride?: (now: Date) => Promise<MeetingOverride | undefined>;
  /** Starts processing a job right away (the fast path); defaults to queueSelectedJob. */
  queueJob?: (jobId: string) => Promise<unknown>;
  enqueue?: typeof enqueueRecording;
};

/** Why a new automatic recording does not start now. */
type RecordingBlock = "meeting-skipped" | "notify-only" | "automation-paused";

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
  /** When the pause was last set or lifted (ms); undefined when not known (damaged or older file). */
  private automationUpdatedAt?: number;
  private meetingOverride?: MeetingOverride;
  /** The "record" decision a recording already used, and its call: a decision covers one call. */
  private recordDecisionUsed?: { key: string; sessionId: string };
  /** The "record" decision a mid-call start was already tried for, so a failure is not retried in a loop. */
  private overrideStartTried?: string;
  /** The recording a "record" decision started, so withdrawing that decision ("Desfazer") can stop it. */
  private overrideRecording?: { eventIdHash: string; sessionId: string; expiresAt: string };
  /** The call whose decision-started recording was withdrawn: a later decision does not reuse its recording id. */
  private withdrawnSession?: string;
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
        const name = filename?.toString();
        if (name && name !== basename(automationPath) && name !== MEETING_OVERRIDES_FILE) return;
        this.automationQueue = this.automationQueue.then(async () => {
          if (this.stopped) return;
          await this.refreshAutomation();
          await this.refreshMeetingOverride();
          await this.persistStatus();
          // A "record" decision made while a call is already going on (a late click on a reminder).
          if (name !== basename(automationPath) && this.meetingOverride?.decision === "record") {
            this.evaluationQueue = this.evaluationQueue.then(() => this.startFromMeetingOverride())
              .catch((err) => logCallEvent("recording.override-error", { error: sanitizeError(err) }));
          }
          // A "record" decision withdrawn ("Desfazer") while the recording it started is running.
          if (name !== basename(automationPath) && this.overrideRecording) {
            this.evaluationQueue = this.evaluationQueue.then(() => this.stopWithdrawnOverrideRecording())
              .catch((err) => logCallEvent("recording.override-error", { error: sanitizeError(err) }));
          }
        }).catch((err) => logCallEvent("automation.status-error", { error: sanitizeError(err) }));
      });
      await this.refreshAutomation();
      await this.refreshMeetingOverride();
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
      if (!this.dryRun) {
        const block = await this.recordingBlock();
        // notify-only warns about the call and records nothing, unless this meeting was marked "record".
        if (block === "notify-only") return;
        if (block) {
          logCallEvent("recording.suspended", { reason: block });
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
    let blocked: RecordingBlock | undefined;
    // A meeting marked "record" names the recording folder after the meeting.
    const decided = this.recordDecision();
    const title = decided?.title;
    try {
      const result = await this.recorder.start({
        sessionId: this.sessionId || undefined,
        ...(title ? { title } : {}),
        app: app,
        signal: this.runSignal,
        shouldContinue: async () => {
          blocked = await this.recordingBlock();
          if (!this.observation.active) inactiveDuringStart = true;
          return !this.stopped && !blocked && this.observation.active &&
            this.machine.getSnapshot().state === "IN_CALL";
        }
      });
      if (result === "cancelled") {
        this.cancelledStartRecovery = !this.stopped && !this.runSignal?.aborted && !blocked && inactiveDuringStart;
        logCallEvent("recording.start-cancelled", { reason: "call-ended-automation-paused-or-monitor-stopped" });
        return;
      }
      logCallEvent(result === "started" ? "recording.started" : "recording.already-recording");
      if (result === "started") {
        // The decision is used up by this call: a later call in its window follows the configured mode.
        if (decided && this.sessionId) this.recordDecisionUsed = { key: recordDecisionKey(decided), sessionId: this.sessionId };
        this.overrideRecording = decided && this.sessionId
          ? { eventIdHash: decided.eventIdHash, sessionId: this.sessionId, expiresAt: decided.expiresAt } : undefined;
        // First-run milestone in the state directory; it never affects the recording.
        await markFirstRun("firstRecording").catch(() => undefined);
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
    if (await this.recordingBlock()) {
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
      const fastPath = fastPathActive(this.config);
      let jobId: string | undefined;
      if ((this.config.processing.autoEnqueue || fastPath) &&
        (this.config.callDetection.mode !== "obs" || this.config.callDetection.enqueueOnStop)) {
        const job = await (this.services.enqueue || enqueueRecording)(this.config, outputPath, {
          recordingId: sessionId, startedAt, endedAt, app
        });
        jobId = job?.id;
        if (job && this.config.timesheet.enabled) {
          const entry = await this.timeEntries.findForJob(job.id, outputPath);
          if (entry) await this.timeEntries.linkJob(entry.id, job.id, outputPath);
        }
      }
      await this.recorder.acknowledge(sessionId);
      this.sessionEndedAt = null;
      // The fast path starts processing now instead of at the next timer run (systemd-run works from the sandbox).
      if (jobId && fastPath) {
        await (this.services.queueJob || queueSelectedJob)(jobId).then(
          () => logCallEvent("processing.queued", { fastPath: true }),
          (err) => logCallEvent("processing.queue-error", { error: sanitizeError(err) })
        );
      }
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
    await this.refreshMeetingOverride();
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
        mode: this.config.callDetection.mode,
        ...(this.meetingOverride ? { meetingDecision: this.meetingOverride.decision } : {}),
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
      const state = await readAutomationState();
      this.automationPaused = state.paused;
      this.automationUpdatedAt = state.updatedAt ? Date.parse(state.updatedAt) : undefined;
    } catch (err) {
      this.automationPaused = true;
      this.automationUpdatedAt = undefined;
      logCallEvent("automation.invalid-state", { error: sanitizeError(err) });
    }
  }

  /**
   * The "record" decision that applies to the current call, if any. It does not apply once a pause
   * was set after it (or a pause whose time is unknown), nor to another call than the one it
   * already recorded, nor (while unused) to a call that began after the meeting's scheduled end:
   * consent given for one meeting never covers a different conversation.
   */
  private recordDecision(): MeetingOverride | undefined {
    const override = this.meetingOverride;
    if (override?.decision !== "record") return undefined;
    if (this.automationPaused && (this.automationUpdatedAt === undefined || this.automationUpdatedAt > Date.parse(override.createdAt))) return undefined;
    const used = this.recordDecisionUsed;
    if (used?.key === recordDecisionKey(override)) return used.sessionId === this.sessionId ? override : undefined;
    // The window's grace after the end keeps the meeting's own call; a call that starts then is another one.
    const began = this.candidateStartedAt ?? Date.parse(this.sessionStartedAt ?? "");
    if (Number.isFinite(began) && began > Date.parse(override.endAt)) return undefined;
    return override;
  }

  /**
   * The decision for the meeting happening now. A damaged file is no decision: the configured mode
   * applies, so a broken file neither records a meeting nor stops one from being recorded.
   */
  private async refreshMeetingOverride(): Promise<MeetingOverride | undefined> {
    try {
      this.meetingOverride = await (this.services.meetingOverride || ((now: Date) => activeOverride(now)))(new Date());
    } catch (err) {
      this.meetingOverride = undefined;
      logCallEvent("meeting-override.invalid-state", { error: sanitizeError(err) });
    }
    return this.meetingOverride;
  }

  /**
   * Whether a new automatic recording may start now: a meeting marked "skip" never records; one
   * marked "record" records its call even in notify-only mode or while automation is paused (the
   * person asked for this meeting), unless paused after the decision; otherwise notify-only and a
   * pause keep today's behaviour.
   */
  private async recordingBlock(): Promise<RecordingBlock | undefined> {
    await this.refreshAutomation();
    const decision = (await this.refreshMeetingOverride())?.decision;
    if (decision === "skip") return "meeting-skipped";
    if (this.recordDecision()) return undefined;
    if (this.config.callDetection.mode === "notify-only") return "notify-only";
    return this.automationPaused ? "automation-paused" : undefined;
  }

  /**
   * A "record" decision written while a call is already going on starts its recording, once per
   * decision, but only for a call that began inside the meeting's window: a call that was already
   * going on before then (the previous meeting running over) is not this meeting. That decision
   * still records the meeting's own call once it starts.
   */
  private async startFromMeetingOverride(): Promise<void> {
    if (this.stopped || this.dryRun || this.runSignal?.aborted || !this.sessionId) return;
    if (this.machine.getSnapshot().state !== "IN_CALL" || !this.observation.active || this.recorder.ownsRecording()) return;
    const override = this.meetingOverride;
    if (override?.decision !== "record" || await this.recordingBlock() || !this.recordDecision()) return;
    const key = `${override.eventIdHash}:${override.createdAt}:${this.sessionId}`;
    if (this.overrideStartTried === key) return;
    const began = Date.parse(this.sessionStartedAt ?? "");
    if (!Number.isFinite(began) || began < Date.parse(override.startAt) - OVERRIDE_WINDOW.beforeStartMs) {
      this.overrideStartTried = key;
      logCallEvent("recording.override-deferred", { reason: "call-began-before-meeting" });
      return;
    }
    // Its recording id was already used by the recording that was withdrawn; a new one would overwrite it.
    if (this.withdrawnSession === this.sessionId) {
      this.overrideStartTried = key;
      logCallEvent("recording.override-deferred", { reason: "withdrawn-in-this-call" });
      return;
    }
    this.overrideStartTried = key;
    logCallEvent("recording.start-from-meeting-decision", { decision: "record" });
    this.cancelledStartRecovery = false;
    await this.startOwnedRecording(this.machine.getSnapshot().app);
    await this.persistStatus();
  }

  /**
   * "Desfazer" (or "Pular") on a "record" decision stops the recording that decision started, when
   * the configured mode would not record this call by itself. A decision that simply expired is not
   * withdrawn, and a damaged file withdraws nothing. The media captured so far is kept as usual.
   */
  private async stopWithdrawnOverrideRecording(): Promise<void> {
    const started = this.overrideRecording;
    if (!started || this.stopped || this.dryRun) return;
    if (!this.recorder.ownsRecording() || this.sessionId !== started.sessionId) {
      this.overrideRecording = undefined;
      return;
    }
    if (Date.now() > Date.parse(started.expiresAt)) return;
    let current: MeetingOverride | undefined;
    try {
      current = (await readMeetingOverrides()).entries.find((entry) => entry.eventIdHash === started.eventIdHash);
    } catch (err) {
      logCallEvent("meeting-override.invalid-state", { error: sanitizeError(err) });
      return;
    }
    if (current?.decision === "record" || !await this.recordingBlock()) return;
    this.overrideRecording = undefined;
    this.withdrawnSession = started.sessionId;
    logCallEvent("recording.override-withdrawn", { decision: current?.decision ?? "cleared" });
    await this.stopOwnedRecording(this.recorder.getSession()?.app);
    await this.persistStatus();
  }
}

const recordDecisionKey = (override: MeetingOverride): string => `${override.eventIdHash}:${override.createdAt}`;

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
