import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import {
  assertBackendCompatible,
  detectRecordingCapabilities,
  diagnoseRecordingBackend,
  resolveConfiguredBackend,
  type RecordingCapabilities
} from "../capabilities";
import { resolveObsLaunchSpec } from "../obsLauncher";

type CapabilityOverrides = Omit<Partial<RecordingCapabilities>, "commands" | "portals"> & {
  commands?: Partial<RecordingCapabilities["commands"]>;
  portals?: Partial<RecordingCapabilities["portals"]>;
};

const capabilities = (override: CapabilityOverrides = {}): RecordingCapabilities => {
  const base: RecordingCapabilities = {
    sessionType: "wayland",
    desktop: "KDE",
    plasmaWayland: true,
    gnomeSession: false,
    wlrootsSession: false,
    commands: {
      obs: true,
      flatpak: false,
      gdbus: true,
      wfRecorder: false,
      ffmpeg: true,
      pwCli: true,
      wpctl: true,
      xrandr: true,
      xdotool: false
    },
    portals: { desktop: true, kde: true },
    obsLauncher: "native"
  };
  return {
    ...base,
    ...override,
    commands: { ...base.commands, ...override.commands },
    portals: { ...base.portals, ...override.portals }
  };
};

describe("portable recording backend selection", () => {
  test("ignores the legacy enqueue switch in mode=record", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    config.callDetection.mode = "record";
    config.callDetection.enqueueOnStop = false;
    config.processing.autoEnqueue = true;
    const detected = capabilities({ commands: { systemdRun: true, systemctl: true, pactl: true, ffprobe: true } });
    expect((await diagnoseRecordingBackend(config, detected)).warnings).toEqual([]);
    config.callDetection.mode = "obs";
    expect((await diagnoseRecordingBackend(config, detected)).warnings).toContain("Automatic call processing is disabled by conflicting enqueue settings");
  });
  test("selects an explicit audio or portal backend without an OBS installation", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.backend = "audio";
    const detected = capabilities({ gpuRecorder: true, obsLauncher: null,
      commands: { obs: false, systemdRun: true, systemctl: true, pactl: true, ffprobe: true } });
    expect(resolveConfiguredBackend(config, detected)).toBe("audio");
    config.backend = "gpu-screen-recorder";
    expect(resolveConfiguredBackend(config, detected)).toBe("gpu-screen-recorder");
    expect(() => resolveConfiguredBackend(config, { ...detected, gpuRecorder: false })).toThrow("GPU Screen Recorder");
  });
  test("keeps Plasma Wayland inert until OBS is explicitly enabled", () => {
    expect(() => resolveConfiguredBackend(DEFAULT_CONFIG, capabilities())).toThrow(
      "obs.enabled=true"
    );
  });

  test("selects OBS on Plasma only with PipeWire and KDE portal support", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.obs.enabled = true;
    expect(resolveConfiguredBackend(config, capabilities())).toBe("obs");
    expect(() =>
      resolveConfiguredBackend(config, capabilities({ portals: { kde: false } }))
    ).toThrow("KDE backend");
    expect(() =>
      resolveConfiguredBackend(config, capabilities({ commands: { wpctl: false } }))
    ).toThrow("PipeWire and WirePlumber");
  });

  test("does not permit auto-launch without a detected native or Flatpak launcher", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.obs.enabled = true;
    config.obs.autoLaunch = true;
    expect(() =>
      resolveConfiguredBackend(config, capabilities({ obsLauncher: null }))
    ).toThrow("no native or Flatpak");
  });

  test("keeps GNOME and wlroots fallbacks scoped to their own desktops", () => {
    expect(resolveConfiguredBackend(
      DEFAULT_CONFIG,
      capabilities({
        sessionType: "wayland",
        desktop: "GNOME",
        plasmaWayland: false,
        gnomeSession: true
      })
    )).toBe("gnome");
    expect(resolveConfiguredBackend(
      DEFAULT_CONFIG,
      capabilities({
        sessionType: "wayland",
        desktop: "sway",
        plasmaWayland: false,
        wlrootsSession: true,
        commands: { wfRecorder: true }
      })
    )).toBe("wf-recorder");
    expect(() => assertBackendCompatible("ffmpeg-only", capabilities())).toThrow(
      "GNOME on X11"
    );
  });

  test("detects Plasma without invoking desktop services", async () => {
    const detected = await detectRecordingCapabilities({
      env: { PATH: "/usr/bin", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" },
      commandExists: async (name) => ["obs", "gdbus", "ffmpeg", "pw-cli", "wpctl"].includes(name),
      pathExists: async (path) => path.includes("portal"),
      obsLauncher: async () => "native"
    });
    expect(detected.plasmaWayland).toBe(true);
    expect(detected.wlrootsSession).toBe(false);
    expect(detected.portals).toEqual({ desktop: true, kde: true });
  });
});

describe("OBS launcher discovery", () => {
  test("prefers a native executable", async () => {
    expect(await resolveObsLaunchSpec({
      resolveExecutable: async (name) => name === "obs" ? "/opt/obs/bin/obs" : null,
      pathExists: async () => false
    })).toEqual({
      command: "/opt/obs/bin/obs",
      args: ["--minimize-to-tray"],
      kind: "native"
    });
  });

  test("uses Flatpak only when its deployment exists", async () => {
    expect(await resolveObsLaunchSpec({
      env: { HOME: "/home/user", PATH: "/usr/bin" },
      resolveExecutable: async (name) => name === "flatpak" ? "/usr/bin/flatpak" : null,
      pathExists: async (path) => path.includes("com.obsproject.Studio")
    })).toEqual({
      command: "/usr/bin/flatpak",
      args: ["run", "com.obsproject.Studio", "--minimize-to-tray"],
      kind: "flatpak"
    });
  });
});
