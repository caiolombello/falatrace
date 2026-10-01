import type { AppConfig } from "../config/defaults";
import { detectRecordingCapabilities, resolveConfiguredBackend } from "./capabilities";
import { startRecording as startGnomeRecording } from "./gnome";
import { stopRecording as stopObsRecording } from "./obs-recording";
import { RecordingController } from "./controller";
import { readState } from "./state";
import { startRecording as startWfRecording } from "./wf";

export type StartOptions = {
  title?: string;
  audioSource?: "none" | "microphone" | "desktop" | "both";
  monitor?: string;
};

export const startRecording = async (
  config: AppConfig,
  options: StartOptions
): Promise<{ outputPath: string }> => {
  const existing = await readState();
  if (existing) throw new Error("A recording is already running. Run: record stop");
  const backend = resolveConfiguredBackend(config, await detectRecordingCapabilities());
  if (["obs", "audio", "gpu-screen-recorder"].includes(backend)) {
    const controller = new RecordingController({ ...config, backend }, "manual");
    const result = await controller.start(options);
    if (result !== "started") throw new Error(`Recording was not started: ${result}`);
    return { outputPath: controller.getSession()!.outputPath };
  }
  if (backend === "gnome") {
    return await startGnomeRecording(config, { title: options.title });
  }
  return await startWfRecording(config, {
    title: options.title,
    foreground: false
  });
};

export const stopRecording = stopObsRecording;
