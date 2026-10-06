import type { AppConfig } from "../config/defaults";
import { enqueueRecording } from "../jobs/enqueue";
import type { JobRecord } from "../jobs/types";
import { TimeEntryStore } from "../timesheet/store";
import { stopRecording as stopFfmpegOnlyRecording } from "./ffmpeg-only";
import { stopRecording as stopGnomeRecording } from "./gnome";
import { stopRecording as stopHybridRecording } from "./hybrid";
import { stopRecording as stopSimpleRecording } from "./simple";
import { readState, type RecordingState } from "./state";
import { stopRecording as stopWfRecording } from "./wf";

/**
 * Stop a capture started by a legacy, unmanaged backend (GNOME screencast, wf-recorder,
 * manual OBS, hybrid, ffmpeg-only) and enqueue it like the managed path. Shared by
 * `record stop` and the Studio so neither has to send the user to the other.
 */
export type LegacyStopResult = { state: RecordingState; videoPath: string; endedAt: string; job: JobRecord | null; warning?: string };

export const LEGACY_SIMPLE_BACKENDS = ["simple", "pipewire", "gstreamer", "kooha", "obs-ws", "obs-cli"];
export const LEGACY_FFMPEG_BACKENDS = ["ffmpeg-only", "gnome-ffmpeg", "gnome-native"];

export const stopLegacyRecording = async (config: AppConfig): Promise<LegacyStopResult | null> => {
  const state = await readState();
  if (!state) return null;
  const backend = state.backend ?? config.backend;
  let videoPath = state.outputPath;
  let warning: string | undefined;
  if (backend === "wf-recorder") {
    await stopWfRecording();
  } else if (backend === "gnome") {
    const result = await stopGnomeRecording();
    if (!result.stopped) warning = result.message || "O GNOME informou falha ao parar; o estado foi limpo.";
  } else if (LEGACY_SIMPLE_BACKENDS.includes(backend)) {
    const result = await stopSimpleRecording(config);
    videoPath = result.videoPath || videoPath;
  } else if (backend === "hybrid") {
    await stopHybridRecording();
  } else if (LEGACY_FFMPEG_BACKENDS.includes(backend)) {
    await stopFfmpegOnlyRecording();
  } else {
    throw new Error("Current backend is not supported yet.");
  }
  const endedAt = new Date().toISOString();
  if (config.timesheet.enabled) {
    await new TimeEntryStore().finishRecording(state.outputPath, endedAt, videoPath).catch((error) => {
      warning = [warning, `Time entry was not finalized: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join(" ");
    });
  }
  const job = await enqueueRecording(config, videoPath, { startedAt: state.startedAt, endedAt });
  return { state, videoPath, endedAt, job, ...(warning ? { warning } : {}) };
};
