import type { AppConfig } from "../config/defaults";
import type {
  CallApplication,
  DetectionObservation,
  PipeWireNodeRecord
} from "./types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string =>
  typeof value === "string" && value.length <= 500 ? value : "";

export const parsePipeWireNode = (value: unknown): PipeWireNodeRecord | null => {
  if (!isObject(value) || value.type !== "PipeWire:Interface:Node") return null;
  if (!Number.isSafeInteger(value.id) || Number(value.id) < 0) return null;
  if (!isObject(value.info)) return null;
  const props = isObject(value.info.props) ? value.info.props : {};
  return {
    id: Number(value.id),
    type: "PipeWire:Interface:Node",
    info: {
      // Monitor deltas may omit state. Explicit unknown values must still
      // clear a prior running state instead of inheriting it during merge.
      state: Object.prototype.hasOwnProperty.call(value.info, "state")
        ? optionalString(value.info.state) || "unknown"
        : undefined,
      props
    }
  };
};

export const mergePipeWireNode = (
  previous: PipeWireNodeRecord | undefined,
  current: PipeWireNodeRecord
): PipeWireNodeRecord => ({
  ...previous,
  ...current,
  info: {
    ...previous?.info,
    ...current.info,
    state: current.info.state ?? previous?.info.state,
    props: {
      ...previous?.info.props,
      ...current.info.props
    }
  }
});

const identifyApplication = (
  props: Record<string, unknown>,
  enabledApps: AppConfig["callDetection"]["apps"]
): CallApplication | null => {
  const binary = optionalString(props["application.process.binary"]).toLowerCase();
  const name = optionalString(props["application.name"]).toLowerCase();
  const id = optionalString(props["application.id"]).toLowerCase();
  if (enabledApps.slack && (binary === "slack" || name === "slack")) return "slack";
  if (
    enabledApps.zen &&
    (binary === "zen" || name === "zen" || id === "app.zen_browser.zen")
  ) {
    return "zen";
  }
  if (
    enabledApps.helium &&
    (binary === "helium" || name === "helium" || id === "helium")
  ) {
    return "helium";
  }
  return null;
};

type ApplicationSignals = {
  inputAudio: number[];
  inputVideo: number[];
  outputAudio: number[];
  communicationRole: boolean;
};

const emptySignals = (): ApplicationSignals => ({
  inputAudio: [],
  inputVideo: [],
  outputAudio: [],
  communicationRole: false
});

export const classifyCall = (
  nodes: Iterable<PipeWireNodeRecord>,
  enabledApps: AppConfig["callDetection"]["apps"]
): DetectionObservation => {
  const byApp: Record<CallApplication, ApplicationSignals> = {
    slack: emptySignals(),
    zen: emptySignals(),
    helium: emptySignals()
  };

  for (const node of nodes) {
    const props = node.info.props;
    const app = identifyApplication(props, enabledApps);
    if (!app || node.info.state !== "running" || props["stream.is-live"] === false) continue;
    const mediaClass = optionalString(props["media.class"]);
    if (mediaClass === "Stream/Input/Audio") byApp[app].inputAudio.push(node.id);
    if (mediaClass === "Stream/Input/Video") byApp[app].inputVideo.push(node.id);
    if (mediaClass === "Stream/Output/Audio") byApp[app].outputAudio.push(node.id);
    if (optionalString(props["media.role"]).toLowerCase() === "communication") {
      byApp[app].communicationRole = true;
    }
  }

  const candidates = (["slack", "zen", "helium"] as const).flatMap((app) => {
    const signals = byApp[app];
    if (signals.inputAudio.length === 0 && signals.inputVideo.length === 0) return [];
    const reasons: string[] = [];
    if (signals.inputAudio.length > 0) reasons.push("capture-audio-running");
    if (signals.inputVideo.length > 0) reasons.push("capture-video-running");
    if (signals.outputAudio.length > 0) reasons.push("playback-audio-running");
    if (signals.communicationRole) reasons.push("media-role-communication");
    const isBrowser = app === "zen" || app === "helium";
    let confidence = signals.inputAudio.length > 0
      ? isBrowser ? 0.9 : 0.72
      : isBrowser ? 0.78 : 0.7;
    if (signals.outputAudio.length > 0) confidence += 0.03;
    if (signals.communicationRole) confidence += 0.04;
    if (signals.inputAudio.length > 0 && signals.inputVideo.length > 0) confidence += 0.01;
    return [{
      active: true as const,
      app,
      confidence: Math.min(confidence, 0.98),
      reasons,
      nodeIds: [...signals.inputAudio, ...signals.inputVideo, ...signals.outputAudio]
    }];
  });

  return candidates.sort((a, b) => b.confidence - a.confidence)[0] || {
    active: false,
    confidence: 0,
    reasons: [],
    nodeIds: []
  };
};

export const sanitizePipeWireNodes = (
  nodes: Iterable<PipeWireNodeRecord>,
  enabledApps: AppConfig["callDetection"]["apps"]
): Array<Record<string, unknown>> => {
  const sanitized: Array<Record<string, unknown>> = [];
  for (const node of nodes) {
    const props = node.info.props;
    const app = identifyApplication(props, enabledApps);
    const mediaClass = optionalString(props["media.class"]);
    if (!app || !mediaClass.startsWith("Stream/")) continue;
    sanitized.push({
      id: node.id,
      app,
      state: node.info.state || "unknown",
      mediaClass,
      mediaRole: optionalString(props["media.role"]) || undefined,
      live: props["stream.is-live"] === true
    });
  }
  return sanitized.sort((a, b) => Number(a.id) - Number(b.id));
};
