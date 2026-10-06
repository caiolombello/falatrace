import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { type runCommand, runCommandDirect } from "../jobs/command";
import { buildCaptureCommand, inspectAudioSources } from "./capture";
import { checkRecordingAudio } from "./health";
import { translateCaptureMessage } from "./messages";

/**
 * Explicit audio check for first use: capture a few seconds from the configured
 * sources into a private temporary folder, measure each track and delete the file.
 * Nothing is uploaded, kept or added to the library.
 */
export type AudioTestTrack = { label: string; hasSignal: boolean; peakDb: number | null };
export type AudioTestResult = { seconds: number; tracks: AudioTestTrack[]; warnings: string[] };

export type AudioTestDeps = {
  run: typeof runCommand;
  inspect: typeof inspectAudioSources;
  check: typeof checkRecordingAudio;
  tempRoot: string;
};

const TRACK_LABELS: Record<string, string> = {
  Mixed: "Mistura",
  Microphone: "Microfone",
  microphone: "Microfone",
  Desktop: "Áudio do sistema",
  desktop: "Áudio do sistema"
};

export const runAudioTest = async (
  config: AppConfig,
  seconds = 5,
  deps: AudioTestDeps = { run: runCommandDirect, inspect: inspectAudioSources, check: checkRecordingAudio, tempRoot: tmpdir() }
): Promise<AudioTestResult> => {
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 15) throw new Error("O teste dura de 2 a 15 segundos.");
  if (config.capture.audioSource === "none") throw new Error("Nenhuma fonte de áudio foi escolhida para gravar.");
  let inspection: Awaited<ReturnType<AudioTestDeps["inspect"]>>;
  try {
    inspection = await deps.inspect(config.capture);
  } catch (error) {
    throw new Error(translateCaptureMessage(error instanceof Error ? error.message : String(error)));
  }
  const directory = await fs.mkdtemp(join(deps.tempRoot, "falatrace-audio-test-"));
  try {
    await fs.chmod(directory, 0o700);
    const output = join(directory, "test.mka");
    // The audio-only command never uses the video profile; standard keeps its checks quiet.
    const { command, args } = buildCaptureCommand("audio", { ...config.capture, profile: "standard" }, inspection.selected, output, join(directory, "unused-token"));
    const limited = [...args.slice(0, -1), "-t", String(seconds), args[args.length - 1]];
    await deps.run(command, limited, { timeoutMs: (seconds + 20) * 1000 });
    const analysis = await deps.check(output, deps.run);
    const tracks = analysis.tracks.map((track) => ({
      label: TRACK_LABELS[track.title || ""] || track.title || `Faixa ${track.index + 1}`,
      hasSignal: track.hasSignal,
      peakDb: track.peakDb
    }));
    const warnings = [...(inspection.warnings || [])];
    for (const track of tracks) {
      if (!track.hasSignal && track.label !== "Mistura") {
        warnings.push(track.label === "Microfone"
          ? "O microfone ficou em silêncio: fale durante o teste e confira se ele não está mutado."
          : `${track.label} ficou em silêncio: toque algum som durante o teste para conferir.`);
      }
    }
    return { seconds, tracks, warnings };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};
