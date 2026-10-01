import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { formatName } from "./naming";
import { clearState, readState, writeState } from "./state";
import type { AppConfig } from "../config/defaults";
import { assertBackendCompatible, detectRecordingCapabilities } from "./capabilities";

export type StartOptions = {
  title?: string;
  durationMinutes?: number;
  geometry?: string;
  foreground?: boolean;
};

const buildOutputPath = async (config: AppConfig, title?: string): Promise<string> => {
  await fs.mkdir(config.recordingsDir, { recursive: true });
  const base = formatName(config.features.namingTemplate, title);
  return join(config.recordingsDir, `${base}.mkv`);
};

export const startRecording = async (
  config: AppConfig,
  options: StartOptions
): Promise<{ outputPath: string; finished?: boolean }> => {
  const existing = await readState();
  if (existing) {
    throw new Error("A recording is already running.");
  }
  assertBackendCompatible("wf-recorder", await detectRecordingCapabilities());

  const outputPath = await buildOutputPath(config, options.title);
  const args = ["-f", outputPath];
  if (options.geometry) {
    args.push("-g", options.geometry);
  }
  
  // Add audio support for wf-recorder
  const audioSource = config.gnome.audioSource || "both";
  if (audioSource !== "none") {
    args.push("-a");
    if (audioSource === "microphone") {
      args.push("--audio-device", "default");
    } else if (audioSource === "desktop") {
      args.push("--audio-device", "default.monitor");
    }
    // For "both", wf-recorder will use default which usually captures both
  }

  const child = spawn("wf-recorder", args, {
    stdio: options.foreground ? "inherit" : ["ignore", "pipe", "pipe"],
    detached: !options.foreground
  });

  const waitForExit = (): Promise<void> =>
    new Promise((resolve) => {
      child.on("exit", () => resolve());
    });

  let stderr = "";
  if (!options.foreground && child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  }
  if (options.foreground && child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  }

  child.on("error", (err) => {
    if (err.message.includes("ENOENT")) {
      console.error("wf-recorder not found. Install it before recording.");
    } else {
      console.error("Failed to start wf-recorder:", err.message);
    }
  });

  if (!child.pid) {
    throw new Error("Failed to start wf-recorder.");
  }

  await writeState({
    backend: "wf-recorder",
    pid: child.pid,
    outputPath,
    startedAt: new Date().toISOString()
  });

  const ensureRunning = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (child.exitCode !== null) {
      await clearState();
      const details = stderr.trim() ? `\n${stderr.trim()}` : "";
      throw new Error(`wf-recorder exited early (code ${child.exitCode}).${details}`);
    }
  };

  if (options.foreground) {
    const sigintHandler = async (): Promise<void> => {
      await stopRecording();
      process.exit(0);
    };
    process.once("SIGINT", sigintHandler);

    await ensureRunning();
    if (options.durationMinutes) {
      const durationMs = options.durationMinutes * 60 * 1000;
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      await stopRecording();
    }

    await waitForExit();
    if (child.exitCode && child.exitCode !== 0) {
      await clearState();
      const details = stderr.trim() ? `\n${stderr.trim()}` : "";
      throw new Error(`wf-recorder failed (code ${child.exitCode}).${details}`);
    }
    await clearState();
    return { outputPath, finished: true };
  } else {
    await ensureRunning();
    child.unref();
  }

  return { outputPath };
};

export const stopRecording = async (): Promise<void> => {
  const state = await readState();
  if (!state) {
    throw new Error("No active recording found.");
  }

  try {
    if (state.pid) {
      process.kill(state.pid, "SIGINT");
    }
  } catch {
    // ignore if process already ended
  } finally {
    await clearState();
  }
  
};

export const getStatus = async (): Promise<string> => {
  const state = await readState();
  if (!state) {
    return "idle";
  }
  return `recording (${state.outputPath})`;
};
