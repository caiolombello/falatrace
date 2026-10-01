import { promises as fs } from "node:fs";
import type { AppConfig } from "../config/defaults";
import { resolveExecutable, resolveObsLaunchSpec } from "./obsLauncher";
import { inspectAudioSources, resolveGpuRecorder } from "./capture";
import { runCommand } from "../jobs/command";

export type RecordingCapabilities = {
  sessionType: string;
  desktop: string;
  plasmaWayland: boolean;
  gnomeSession: boolean;
  wlrootsSession: boolean;
  commands: {
    obs: boolean;
    flatpak: boolean;
    gdbus: boolean;
    wfRecorder: boolean;
    ffmpeg: boolean;
    pwCli: boolean;
    wpctl: boolean;
    xrandr: boolean;
    xdotool: boolean;
    systemdRun?: boolean;
    systemctl?: boolean;
    pactl?: boolean;
    ffprobe?: boolean;
  };
  portals: {
    desktop: boolean;
    kde: boolean;
  };
  obsLauncher: "native" | "flatpak" | null;
  gpuRecorder?: boolean;
};

export type CapabilityProbe = {
  env?: NodeJS.ProcessEnv;
  commandExists?: (name: string) => Promise<boolean>;
  pathExists?: (path: string) => Promise<boolean>;
  obsLauncher?: () => Promise<"native" | "flatpak" | null>;
};

const defaultPathExists = async (path: string): Promise<boolean> =>
  fs.access(path).then(() => true).catch(() => false);

const desktopTokens = (desktop: string): string[] =>
  desktop.toLowerCase().split(":").map((value) => value.trim()).filter(Boolean);

export const detectRecordingCapabilities = async (
  probe: CapabilityProbe = {}
): Promise<RecordingCapabilities> => {
  const env = probe.env || process.env;
  const sessionType = (env.XDG_SESSION_TYPE || "unknown").toLowerCase();
  const desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "unknown";
  const tokens = desktopTokens(desktop);
  const gnomeSession = tokens.some((value) => value.includes("gnome"));
  const plasmaSession = tokens.some((value) => value === "kde" || value.includes("plasma"));
  const wlrootsSession = tokens.some((value) =>
    ["sway", "hyprland", "river", "wayfire", "labwc", "niri", "wlroots"].some(
      (name) => value.includes(name)
    )
  );
  const pathExists = probe.pathExists || defaultPathExists;
  const commandExists = probe.commandExists || (async (name: string) =>
    (await resolveExecutable(name, env)) !== null);
  const commandNames = [
    "obs",
    "flatpak",
    "gdbus",
    "wf-recorder",
    "ffmpeg",
    "pw-cli",
    "wpctl",
    "xrandr",
    "xdotool", "systemd-run", "systemctl", "pactl", "ffprobe"
  ] as const;
  const [commandValues, portalDesktop, portalKde, obsLauncher] = await Promise.all([
    Promise.all(commandNames.map(commandExists)),
    pathExists("/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service"),
    pathExists("/usr/share/xdg-desktop-portal/portals/kde.portal"),
    probe.obsLauncher
      ? probe.obsLauncher()
      : resolveObsLaunchSpec({ env, pathExists }).then((spec) => spec?.kind || null)
  ]);
  const available = Object.fromEntries(
    commandNames.map((name, index) => [name, commandValues[index]])
  ) as Record<(typeof commandNames)[number], boolean>;

  return {
    sessionType,
    desktop,
    plasmaWayland: sessionType === "wayland" && plasmaSession,
    gnomeSession,
    wlrootsSession: sessionType === "wayland" && wlrootsSession,
    commands: {
      obs: available.obs,
      flatpak: available.flatpak,
      gdbus: available.gdbus,
      wfRecorder: available["wf-recorder"],
      ffmpeg: available.ffmpeg,
      pwCli: available["pw-cli"],
      wpctl: available.wpctl,
      xrandr: available.xrandr,
      xdotool: available.xdotool,
      systemdRun: available["systemd-run"], systemctl: available.systemctl,
      pactl: available.pactl, ffprobe: available.ffprobe
    },
    portals: {
      desktop: portalDesktop,
      kde: portalKde
    },
    obsLauncher,
    gpuRecorder: (await resolveGpuRecorder()) !== null
  };
};

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

const assertObsCompatible = (
  config: AppConfig,
  capabilities: RecordingCapabilities
): void => {
  if (!config.obs.enabled) {
    throw new Error("OBS recording is disabled; set obs.enabled=true after configuring OBS manually");
  }
  if (!isLoopback(config.obs.host)) {
    throw new Error("OBS recording is restricted to a loopback WebSocket host");
  }
  if (config.obs.autoLaunch && !capabilities.obsLauncher) {
    throw new Error("obs.autoLaunch is enabled, but no native or Flatpak OBS launcher was found");
  }
  if (
    capabilities.plasmaWayland &&
    (!capabilities.portals.desktop || !capabilities.portals.kde)
  ) {
    throw new Error("Plasma Wayland recording requires xdg-desktop-portal and its KDE backend");
  }
  if (
    capabilities.plasmaWayland &&
    (!capabilities.commands.pwCli || !capabilities.commands.wpctl)
  ) {
    throw new Error("Plasma Wayland recording requires PipeWire and WirePlumber tools");
  }
};

export type EffectiveRecordingBackend = "obs" | "gnome" | "wf-recorder" | "audio" | "gpu-screen-recorder";

export const resolveSimpleBackend = (
  config: AppConfig,
  capabilities: RecordingCapabilities
): EffectiveRecordingBackend => {
  if (config.obs.enabled) {
    assertObsCompatible(config, capabilities);
    return "obs";
  }
  if (capabilities.gnomeSession && capabilities.commands.gdbus) return "gnome";
  if (capabilities.wlrootsSession && capabilities.commands.wfRecorder) return "wf-recorder";
  if (capabilities.plasmaWayland) {
    throw new Error(
      "Plasma recording remains inert. Configure the OBS scene and WebSocket, then set obs.enabled=true"
    );
  }
  throw new Error("No compatible recording backend was detected for this desktop session");
};

export const assertBackendCompatible = (
  backend: "gnome" | "hybrid" | "ffmpeg-only" | "wf-recorder",
  capabilities: RecordingCapabilities
): void => {
  if (backend === "gnome") {
    if (!capabilities.gnomeSession || !capabilities.commands.gdbus) {
      throw new Error("The GNOME backend requires a GNOME session and gdbus");
    }
    return;
  }
  if (backend === "wf-recorder") {
    if (!capabilities.wlrootsSession || !capabilities.commands.wfRecorder) {
      throw new Error("wf-recorder is supported only in a detected wlroots Wayland session");
    }
    return;
  }
  if (backend === "hybrid") {
    if (
      !capabilities.gnomeSession ||
      capabilities.sessionType !== "x11" ||
      !capabilities.commands.gdbus ||
      !capabilities.commands.ffmpeg ||
      !capabilities.commands.xrandr
    ) {
      throw new Error("The legacy hybrid backend requires GNOME on X11, gdbus, FFmpeg and xrandr");
    }
    return;
  }
  if (
    !capabilities.gnomeSession ||
    capabilities.sessionType !== "x11" ||
    !capabilities.commands.xdotool ||
    !capabilities.commands.ffmpeg
  ) {
    throw new Error("The legacy ffmpeg-only backend requires GNOME on X11, xdotool and FFmpeg");
  }
};

export const resolveConfiguredBackend = (
  config: AppConfig,
  capabilities: RecordingCapabilities
): EffectiveRecordingBackend => {
  if (config.backend === "audio" || config.backend === "gpu-screen-recorder") {
    if (!capabilities.commands.ffmpeg || !capabilities.commands.ffprobe ||
      !capabilities.commands.systemdRun || !capabilities.commands.systemctl) {
      throw new Error("Managed recording requires FFmpeg, ffprobe and systemd user tools");
    }
    if (config.capture.audioSource !== "none" && !capabilities.commands.pactl) {
      throw new Error("Audio recording requires pactl and a PulseAudio-compatible server");
    }
    if (config.backend === "audio" && config.capture.audioSource === "none") {
      throw new Error("Audio recording requires microphone or desktop audio");
    }
    if (config.backend === "gpu-screen-recorder") {
      if (!capabilities.gpuRecorder) throw new Error("GPU Screen Recorder is not installed (native or Flatpak)");
      if (!capabilities.portals.desktop || (capabilities.plasmaWayland && !capabilities.portals.kde)) {
        throw new Error("Screen recording requires the desktop portal and its compositor backend");
      }
    }
    return config.backend;
  }
  if (config.backend === "simple") return resolveSimpleBackend(config, capabilities);
  if (["obs", "obs-ws", "obs-cli"].includes(config.backend)) {
    assertObsCompatible(config, capabilities);
    return "obs";
  }
  if (config.backend === "gnome") {
    assertBackendCompatible("gnome", capabilities);
    return "gnome";
  }
  if (config.backend === "wf-recorder") {
    assertBackendCompatible("wf-recorder", capabilities);
    return "wf-recorder";
  }
  if (config.backend === "hybrid" || config.backend === "ffmpeg-only") {
    assertBackendCompatible(config.backend, capabilities);
    throw new Error(`${config.backend} is a legacy backend and is not selected automatically`);
  }
  throw new Error(`Backend ${config.backend} has no portable implementation`);
};

export const diagnoseRecordingBackend = async (
  config: AppConfig,
  capabilities?: RecordingCapabilities
): Promise<Record<string, unknown>> => {
  const detected = capabilities || await detectRecordingCapabilities();
  let selectedBackend: EffectiveRecordingBackend | null = null;
  let blockedReason: string | null = null;
  try {
    selectedBackend = resolveConfiguredBackend(config, detected);
  } catch (err) {
    blockedReason = err instanceof Error ? err.message : String(err);
  }
  const warnings: string[] = [];
  let audio: unknown;
  let portalVersion: string | undefined;
  let videoCodecs: string[] | undefined;
  let gpuRecorderVersion: string | undefined;
  if (!capabilities) {
    audio = await inspectAudioSources(config.capture).catch((err) => {
      warnings.push(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (detected.commands.gdbus && detected.portals.desktop) {
      portalVersion = await runCommand("gdbus", ["call", "--session", "--dest", "org.freedesktop.portal.Desktop",
        "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.portal.ScreenCast", "version"], { timeoutMs: 5_000 })
        .then(({ stdout }) => stdout.trim()).catch(() => undefined);
    }
    if (selectedBackend === "gpu-screen-recorder") {
      const recorder = await resolveGpuRecorder();
      if (recorder) {
        try {
          const { stdout } = await runCommand(recorder.command, [...recorder.args, "--info"], { timeoutMs: 10_000 });
          gpuRecorderVersion = stdout.match(/^gsr_version\|([^\r\n]+)$/m)?.[1];
          const codecSection = stdout.split("section=video_codecs\n")[1]?.split("section=")[0];
          videoCodecs = codecSection?.trim().split(/\r?\n/).filter((value) => /^[a-z0-9_-]+$/.test(value));
          if (videoCodecs?.includes("h264_software") && !videoCodecs.includes("h264")) {
            warnings.push("GPU Screen Recorder reports only software H.264; screen capture will require CPU encoding");
          }
        } catch {
          warnings.push("Could not inspect GPU Screen Recorder codecs; validate the encoder before capture");
        }
      }
    }
  }
  if (config.callDetection.mode === "obs" && selectedBackend !== "obs") {
    warnings.push("callDetection.mode=obs overrides the manual backend; use mode=record for the configured backend");
  }
  if (config.callDetection.mode === "obs" && config.callDetection.enqueueOnStop !== config.processing.autoEnqueue) {
    warnings.push("Automatic call processing is disabled by conflicting enqueue settings");
  }
  return {
    configuredBackend: config.backend,
    selectedBackend,
    blockedReason,
    audio,
    warnings,
    capture: { gpuRecorder: detected.gpuRecorder, gpuRecorderVersion, videoCodecs, encoder: config.capture.encoder, portalVersion },
    session: {
      type: detected.sessionType,
      desktop: detected.desktop,
      plasmaWayland: detected.plasmaWayland,
      gnome: detected.gnomeSession,
      wlroots: detected.wlrootsSession
    },
    pipewire: {
      pwCli: detected.commands.pwCli,
      wpctl: detected.commands.wpctl
    },
    portals: detected.portals,
    obs: {
      enabled: config.obs.enabled,
      autoLaunch: config.obs.autoLaunch,
      hostScope: isLoopback(config.obs.host) ? "loopback" : "non-loopback",
      launcher: detected.obsLauncher
    },
    legacy: {
      gdbus: detected.commands.gdbus,
      wfRecorder: detected.commands.wfRecorder,
      xrandr: detected.commands.xrandr,
      xdotool: detected.commands.xdotool,
      ffmpeg: detected.commands.ffmpeg
    }
  };
};
