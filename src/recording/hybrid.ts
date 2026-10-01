import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { formatName } from "./naming";
import { clearState, readState, writeState } from "./state";
import type { AppConfig } from "../config/defaults";
import { assertBackendCompatible, detectRecordingCapabilities } from "./capabilities";

export type StartOptions = {
  title?: string;
  audioSource?: "none" | "microphone" | "desktop" | "both";
  monitor?: string;
};

const buildOutputPath = async (config: AppConfig, title?: string): Promise<string> => {
  await fs.mkdir(config.recordingsDir, { recursive: true });
  const base = formatName(config.features.namingTemplate, title);
  return join(config.recordingsDir, `${base}.mkv`);
};

export const startRecording = async (
  config: AppConfig,
  options: StartOptions
): Promise<{ outputPath: string }> => {
  const existing = await readState();
  if (existing) {
    throw new Error("A recording is already running.");
  }
  assertBackendCompatible("hybrid", await detectRecordingCapabilities());

  const audioSource = options.audioSource || config.gnome.audioSource || "both";
  
  // Start GNOME recording for video (without custom pipeline)
  const { startRecording: startGnomeRecording } = await import("./gnome");
  
  // Use default GNOME recording (no custom pipeline)
  let gnomeOptions: any = { title: options.title };
  
  if (options.monitor && options.monitor !== "all") {
    // Convert monitor ID to geometry for specific monitor
    const monitorId = parseInt(options.monitor);
    if (!isNaN(monitorId)) {
      // Get monitor geometry using xrandr
      const { spawn } = await import("node:child_process");
      const geometry = await new Promise<string | undefined>((resolve) => {
        const xrandr = spawn("xrandr", ["--listmonitors"], {
          stdio: ["ignore", "pipe", "pipe"]
        });
        
        let output = "";
        xrandr.stdout?.on("data", (data) => {
          output += data.toString();
        });
        
        xrandr.on("close", () => {
          const lines = output.split('\n');
          for (const line of lines) {
            if (line.includes(`${monitorId}:`)) {
              const match = line.match(/(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
              if (match) {
                const [, width, height, x, y] = match;
                resolve(`${width}x${height}+${x}+${y}`);
                return;
              }
            }
          }
          resolve(undefined);
        });
      });
      
      if (geometry) {
        gnomeOptions.geometry = geometry;
        console.log(`Recording monitor ${monitorId} with geometry: ${geometry}`);
      }
    }
  }
  
  // Temporarily override config to use default GNOME (no custom pipeline)
  const configForGnome = {
    ...config,
    gnome: {
      ...config.gnome,
      pipeline: undefined // Use default GNOME pipeline
    }
  };
  
  const gnomeResult = await startGnomeRecording(configForGnome, gnomeOptions);
  
  // Start FFmpeg for audio recording (parallel)
  if (audioSource !== "none") {
    const audioPath = gnomeResult.outputPath.replace('.mp4', '_audio.wav');
    
    const audioArgs = ["-f", "pulse"];
    
    if (audioSource === "microphone") {
      audioArgs.push("-i", "default");
    } else if (audioSource === "desktop") {
      audioArgs.push("-i", "alsa_output.usb-GeneralPlus_USB_Audio_Device-00.analog-stereo.monitor");
    } else { // both
      audioArgs.push("-i", "default", "-f", "pulse", "-i", "alsa_output.usb-GeneralPlus_USB_Audio_Device-00.analog-stereo.monitor");
      audioArgs.push("-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest");
    }
    
    audioArgs.push("-y", audioPath);
    
    console.log("Starting audio recording:", "ffmpeg", audioArgs.join(" "));
    
    const audioChild = spawn("ffmpeg", audioArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    
    if (audioChild.pid) {
      // Update state with audio info
      await writeState({
        backend: "hybrid",
        pid: audioChild.pid,
        outputPath: gnomeResult.outputPath,
        audioPath,
        startedAt: new Date().toISOString()
      });
      
      audioChild.unref();
    }
  }
  
  return { outputPath: gnomeResult.outputPath };
};

export const stopRecording = async (): Promise<void> => {
  const state = await readState();
  if (!state) {
    throw new Error("No active recording found.");
  }

  // Stop GNOME recording
  const { stopRecording: stopGnomeRecording } = await import("./gnome");
  await stopGnomeRecording();
  
  // Stop audio recording
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGINT");
    } catch {
      // ignore if already stopped
    }
  }
  
  // Wait a bit for files to be written
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Combine video + audio if audio was recorded
  if (state.audioPath && state.outputPath) {
    const finalPath = state.outputPath.replace('.mp4', '_final.mkv');
    
    console.log("Combining video + audio...");
    
    const combineArgs = [
      "-i", state.outputPath,  // video from GNOME
      "-i", state.audioPath,   // audio from FFmpeg
      "-c:v", "copy",          // don't re-encode video
      "-c:a", "aac",           // encode audio to AAC
      "-y", finalPath
    ];
    
    const combineResult = await new Promise<boolean>((resolve) => {
      const child = spawn("ffmpeg", combineArgs, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      
      child.on("close", (code) => {
        resolve(code === 0);
      });
    });
    
    if (combineResult) {
      // Replace original with combined version
      await fs.unlink(state.outputPath);
      await fs.unlink(state.audioPath);
      await fs.rename(finalPath, state.outputPath);
      console.log(`✅ Combined video + audio: ${state.outputPath}`);
    } else {
      console.error("❌ Failed to combine video + audio");
    }
  }
  
  await clearState();
};
