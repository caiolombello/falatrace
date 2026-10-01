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
  assertBackendCompatible("ffmpeg-only", await detectRecordingCapabilities());

  const outputPath = await buildOutputPath(config, options.title);
  const audioSource = options.audioSource || config.gnome.audioSource || "both";
  const audioPath = outputPath.replace('.mkv', '_audio.wav');
  
  // 1. Trigger GNOME native screen recording (runs in background)
  console.log("Starting GNOME screen recording...");
  spawn("xdotool", ["key", "ctrl+alt+shift+r"], {
    stdio: "ignore",
    detached: true
  }).unref();
  
  // Wait a moment for GNOME to start
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log("✓ Video recording started");
  
  // 2. Start FFmpeg for audio (detached, background)
  const audioArgs = ["-f", "pulse", "-i", "default"];
  
  if (audioSource === "both" || audioSource === "desktop") {
    audioArgs.push("-f", "pulse", "-i", "alsa_output.usb-GeneralPlus_USB_Audio_Device-00.analog-stereo.monitor");
    if (audioSource === "both") {
      audioArgs.push("-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest");
    }
  }
  
  audioArgs.push("-y", audioPath);
  
  const audioChild = spawn("ffmpeg", audioArgs, {
    stdio: "ignore",
    detached: true
  });

  if (!audioChild.pid) {
    throw new Error("Failed to start audio recording");
  }
  
  audioChild.unref();
  console.log("✓ Audio recording started");

  await writeState({
    backend: "gnome-native",
    pid: audioChild.pid,
    outputPath,
    audioPath,
    startedAt: new Date().toISOString()
  });
  
  console.log(`\n🎬 Recording in background!`);
  console.log(`   Run: bun run src/cli/index.ts record stop`);
  
  return { outputPath };
};

export const stopRecording = async (): Promise<void> => {
  const state = await readState();
  if (!state) {
    throw new Error("No active recording found.");
  }

  console.log("Stopping recording...");

  // Stop GNOME native recording via shortcut
  const xdotool = spawn("xdotool", ["key", "ctrl+alt+shift+r"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve) => xdotool.on("close", resolve));
  
  console.log("✓ Video stopped");

  // Stop FFmpeg audio
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGINT");
    } catch {}
  }
  
  console.log("✓ Audio stopped");
  
  // Wait for files
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Find the latest GNOME screencast file
  const { readdirSync, statSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const videosDir = join(homedir(), "Videos");
  
  try {
    const files = readdirSync(videosDir)
      .filter(f => f.startsWith("Screencast") && f.endsWith(".webm"))
      .map(f => ({ name: f, time: statSync(join(videosDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);
    
    if (files.length > 0 && state.audioPath) {
      const videoPath = join(videosDir, files[0].name);
      console.log(`Found video: ${videoPath}`);
      
      // Combine video + audio
      console.log("Combining video + audio...");
      
      const combineResult = await new Promise<boolean>((resolve) => {
        const child = spawn("ffmpeg", [
          "-i", videoPath,
          "-i", state.audioPath!,
          "-c:v", "copy",
          "-c:a", "aac",
          "-y", state.outputPath
        ], { stdio: ["ignore", "pipe", "pipe"] });
        
        child.on("close", (code) => resolve(code === 0));
      });
      
      if (combineResult) {
        console.log(`✅ Recording saved: ${state.outputPath}`);
      } else {
        console.log(`⚠️ Combine failed. Files:`);
        console.log(`   Video: ${videoPath}`);
        console.log(`   Audio: ${state.audioPath}`);
      }
    } else {
      console.log(`Audio saved: ${state.audioPath}`);
      console.log(`Video: Check ~/Videos/ for Screencast*.webm`);
    }
  } catch (err) {
    console.log(`Audio saved: ${state.audioPath}`);
    console.log(`Video: Check ~/Videos/ for Screencast*.webm`);
  }
  
  await clearState();
};
