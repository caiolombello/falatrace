export type CallApplication = "slack" | "zen" | "helium";

export type CallMonitorState = "IDLE" | "CANDIDATE" | "IN_CALL" | "ENDING";

export type PipeWireNodeRecord = {
  id: number;
  type: "PipeWire:Interface:Node";
  info: {
    state?: string;
    props: Record<string, unknown>;
  };
};

export type DetectionObservation = {
  active: boolean;
  app?: CallApplication;
  confidence: number;
  reasons: string[];
  nodeIds: number[];
};

export type StateMachineSnapshot = {
  state: CallMonitorState;
  app?: CallApplication;
  confidence: number;
  reasons: string[];
  changedAt: number;
};

export type CallTransition = {
  from: CallMonitorState;
  to: CallMonitorState;
  app?: CallApplication;
  confidence: number;
  reasons: string[];
  at: number;
};

export type ProcessNetworkTelemetry = {
  tcpSockets: number;
  udpSockets: number;
  tcpBytesSent: number;
  tcpBytesReceived: number;
};

export type NetworkTelemetry = Record<CallApplication, ProcessNetworkTelemetry>;
