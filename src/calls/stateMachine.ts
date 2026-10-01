import type {
  CallTransition,
  DetectionObservation,
  StateMachineSnapshot
} from "./types";

export class CallStateMachine {
  private snapshot: StateMachineSnapshot;

  constructor(
    private readonly entryDebounceMs: number,
    private readonly exitTimeoutMs: number,
    now = Date.now()
  ) {
    this.snapshot = {
      state: "IDLE",
      confidence: 0,
      reasons: [],
      changedAt: now
    };
  }

  getSnapshot(): StateMachineSnapshot {
    return { ...this.snapshot, reasons: [...this.snapshot.reasons] };
  }

  getNextDeadline(): number | null {
    if (this.snapshot.state === "CANDIDATE") {
      return this.snapshot.changedAt + this.entryDebounceMs;
    }
    if (this.snapshot.state === "ENDING") {
      return this.snapshot.changedAt + this.exitTimeoutMs;
    }
    return null;
  }

  update(observation: DetectionObservation, now = Date.now()): CallTransition | null {
    const current = this.snapshot;
    if (current.state === "IDLE") {
      return observation.active ? this.move("CANDIDATE", observation, now) : null;
    }

    if (current.state === "CANDIDATE") {
      if (!observation.active) return this.move("IDLE", observation, now);
      if (observation.app !== current.app) return this.move("CANDIDATE", observation, now);
      this.refresh(observation);
      if (now >= current.changedAt + this.entryDebounceMs) {
        return this.move("IN_CALL", observation, now);
      }
      return null;
    }

    if (current.state === "IN_CALL") {
      if (!observation.active) return this.move("ENDING", observation, now);
      this.refresh(observation);
      return null;
    }

    if (observation.active) return this.move("IN_CALL", observation, now);
    if (now >= current.changedAt + this.exitTimeoutMs) {
      return this.move("IDLE", observation, now);
    }
    return null;
  }

  private refresh(observation: DetectionObservation): void {
    this.snapshot = {
      ...this.snapshot,
      app: observation.app || this.snapshot.app,
      confidence: observation.confidence || this.snapshot.confidence,
      reasons: observation.reasons.length > 0
        ? [...observation.reasons]
        : [...this.snapshot.reasons]
    };
  }

  private move(
    state: StateMachineSnapshot["state"],
    observation: DetectionObservation,
    now: number
  ): CallTransition {
    const previous = this.snapshot;
    const retainCallDetails = state === "ENDING";
    this.snapshot = {
      state,
      app: retainCallDetails ? previous.app : observation.app,
      confidence: retainCallDetails ? previous.confidence : observation.confidence,
      reasons: retainCallDetails ? [...previous.reasons] : [...observation.reasons],
      changedAt: now
    };
    return {
      from: previous.state,
      to: state,
      app: state === "IDLE" ? previous.app : this.snapshot.app,
      confidence: state === "IDLE" ? previous.confidence : this.snapshot.confidence,
      reasons: state === "IDLE" ? [...previous.reasons] : [...this.snapshot.reasons],
      at: now
    };
  }
}
