import { assertCaptureProfile, CALL_LIGHT_PROFILE } from './profile';
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { resolveExecutable } from "./obsLauncher";

export type CaptureBackend = "audio" | "gpu-screen-recorder";
export type AudioSources = { microphone?: string; desktop?: string };
export type CaptureCommand = { command: string; args: string[] };
export const GSR_APP_ID = "com.dec05eba.gpu_screen_recorder";
export type AudioInspection = {
  available: string[];
  selected: AudioSources;
  warnings?: string[];
};

export const resolveGpuRecorder = async (): Promise<CaptureCommand | null> => {
  const native = await resolveExecutable("gpu-screen-recorder");
  if (native) return { command: native, args: [] };
  const flatpak = await resolveExecutable("flatpak");
  if (!flatpak) return null;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  for (const root of [join(dataHome, "flatpak"), "/var/lib/flatpak"]) {
    if (await fs.access(join(root, "app", GSR_APP_ID, "current", "active")).then(() => true).catch(() => false)) {
      return { command: flatpak, args: ["run", "--die-with-parent", "--command=gpu-screen-recorder", GSR_APP_ID] };
    }
  }
  return null;
};

export const resolveAudioSources = (
  config: AppConfig["capture"],
  available: string[],
  defaults: { microphone: string; desktop: string }
): AudioSources => {
  const result: AudioSources = {};
  for (const kind of ["microphone", "desktop"] as const) {
    if (config.audioSource !== "both" && config.audioSource !== kind) continue;
    const device = config[kind] === "default" ? defaults[kind] : config[kind];
    if (!available.includes(device)) throw new Error(`Audio device unavailable: ${device} (${kind})`);
    result[kind] = device;
  }
  if (result.microphone && result.microphone === result.desktop) {
    throw new Error("Microphone and desktop must use different audio sources");
  }
  return result;
};

type PactlSource = {
  name?: unknown;
  mute?: unknown;
  volume?: unknown;
};

const volumeValues = (value: unknown): number[] => {
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (typeof value === "string") {
    const match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*%?/);
    return match ? [Number(match[1])] : [];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if ("value" in record) return volumeValues(record.value);
  if ("value_percent" in record) return volumeValues(record.value_percent);
  return Object.values(value).flatMap(volumeValues);
};

const sourceIsSilent = (source: PactlSource | undefined): boolean => {
  if (!source) return true;
  const values = volumeValues(source.volume);
  return values.length > 0 && values.every((value) => value <= 0);
};

export const inspectAudioSources = async (
  config: AppConfig["capture"],
  run = runCommand
): Promise<AudioInspection> => {
  const [sources, microphone, sink] = await Promise.all([
    run("pactl", ["--format=json", "list", "sources"], { timeoutMs: 5_000 }),
    run("pactl", ["get-default-source"], { timeoutMs: 5_000 }),
    run("pactl", ["get-default-sink"], { timeoutMs: 5_000 })
  ]);
  const parsed = JSON.parse(sources.stdout) as PactlSource[];
  if (!Array.isArray(parsed)) throw new Error("pactl retornou fontes de áudio inválidas");
  const available = parsed
    .map((source) => source.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const selected = resolveAudioSources(config, available, {
    microphone: microphone.stdout.trim(), desktop: `${sink.stdout.trim()}.monitor`
  });
  const warnings: string[] = [];
  const selectedEntries = Object.entries(selected);
  for (const [kind, name] of selectedEntries) {
    const source = parsed.find((candidate) => candidate.name === name);
    const muted = source?.mute === true;
    const silent = sourceIsSilent(source);
    if (muted || silent) {
      const reason = muted && silent ? "mutada e com volume zero" : muted ? "mutada" : "com volume zero";
      warnings.push(`A origem de áudio ${kind} (${name}) está ${reason}.`);
    }
  }
  if (selectedEntries.length > 0 && warnings.length === selectedEntries.length) {
    throw new Error("Todas as fontes de áudio selecionadas estão mutadas ou com volume zero; habilite uma origem de áudio e tente novamente.");
  }
  return { available, selected, warnings };
};

export const buildCaptureCommand = (
  backend: CaptureBackend,
  config: AppConfig["capture"],
  sources: AudioSources,
  outputPath: string,
  tokenPath: string
): CaptureCommand => {
  const profile = assertCaptureProfile(backend, config);
  const entries = Object.entries(sources);
  if (backend === "gpu-screen-recorder") {
    const devices = entries.map(([, device]) => `device:${device}`);
    const tracks = devices.length === 2 ? [devices.join("|"), ...devices] : devices;
    return {
      command: "gpu-screen-recorder",
      args: ["-w", "portal", "-restore-portal-session", "yes", "-portal-session-token-filepath", tokenPath,
        "-f", String(profile === "call-light" ? Math.min(config.framerate,CALL_LIGHT_PROFILE.maxFps) : config.framerate),
        ...(profile === "call-light" ? ["-s", CALL_LIGHT_PROFILE.maxResolution] : []), "-k", "h264", "-encoder", config.encoder,
        "-fallback-cpu-encoding", "no", "-q", profile === "call-light" ? CALL_LIGHT_PROFILE.quality : "very_high", "-ac", "aac", "-c", "mkv",
        ...tracks.flatMap((device) => ["-a", device]), "-o", outputPath]
    };
  }
  if (!entries.length) throw new Error("Audio recording requires microphone or desktop audio");
  const args = ["-hide_banner", "-nostdin", "-n",
    ...entries.flatMap(([, device]) => ["-thread_queue_size", "1024", "-f", "pulse", "-i", device])];
  if (entries.length === 2) {
    args.push("-filter_complex",
      "[0:a]asplit=2[micmix][microphone];[1:a]asplit=2[deskmix][desktop];[micmix][deskmix]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[mix]",
      "-map", "[mix]", "-map", "[microphone]", "-map", "[desktop]",
      "-metadata:s:a:0", "title=Mixed", "-metadata:s:a:1", "title=Microphone", "-metadata:s:a:2", "title=Desktop");
  } else {
    args.push("-map", "0:a", "-metadata:s:a:0", `title=${entries[0][0]}`);
  }
  args.push("-c:a", "flac", "-ar", "48000", "-f", "matroska", "-flush_packets", "1", outputPath);
  return { command: "ffmpeg", args };
};
