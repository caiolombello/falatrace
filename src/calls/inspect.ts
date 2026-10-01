import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { classifyCall, sanitizePipeWireNodes } from "./classifier";
import { collectNetworkTelemetry } from "./network";
import { CallObsController } from "./obs";
import { readPipeWireSnapshot } from "./pipewire";
import { RecordingController } from "../recording/controller";

const readVersion = async (command: string, args: string[]): Promise<string> => {
  try {
    const result = await runCommand(command, args, { timeoutMs: 3_000 });
    return result.stdout.trim().replace(/[\r\n]+/g, " | ").slice(0, 500) || "unknown";
  } catch {
    return "unavailable";
  }
};

export const inspectCallEnvironment = async (config: AppConfig): Promise<Record<string, unknown>> => {
  const nodes = await readPipeWireSnapshot();
  const [network, processes, versions, obsStatus] = await Promise.all([
    collectNetworkTelemetry().catch(() => null),
    runCommand("ps", ["-eo", "comm="], { timeoutMs: 3_000 })
      .then(({ stdout }) => {
        const names = stdout.split("\n").map((value) => value.trim());
        return {
          slack: names.filter((name) => name === "slack").length,
          zen: names.filter((name) => name === "zen").length,
          helium: names.filter((name) => name === "helium").length,
          obs: names.filter((name) => name === "obs").length
        };
      })
      .catch(() => null),
    Promise.all([
      readVersion("gnome-shell", ["--version"]),
      readVersion("pipewire", ["--version"]),
      readVersion("wireplumber", ["--version"])
    ]),
    config.obs.enabled ? new CallObsController(config.obs).getStatus()
      .then((status) => ({ available: true, outputActive: status.outputActive }))
      .catch(() => ({ available: false })) : Promise.resolve({ available: false })
  ]);
  const [gnome, pipewire, wireplumber] = versions;
  const recording = await new RecordingController(config, "call").inspect()
    .then(({ session, active }) => ({
      autoControlEnabled: config.callDetection.mode !== "notify-only",
      backend: session?.backend || config.backend,
      phase: session?.phase || "idle", active
    }))
    .catch(() => ({ active: false, needsAttention: true }));
  return {
    capturedAt: new Date().toISOString(),
    session: {
      type: process.env.XDG_SESSION_TYPE || "unknown",
      desktop: process.env.XDG_CURRENT_DESKTOP || "unknown"
    },
    versions: { gnome, pipewire, wireplumber },
    processes,
    pipewire: {
      observation: classifyCall(nodes, config.callDetection.apps),
      streams: sanitizePipeWireNodes(nodes, config.callDetection.apps)
    },
    network,
    recording,
    obs: {
      autoControlEnabled:
        config.callDetection.mode === "obs" && config.obs.enabled,
      autoLaunchEnabled: config.obs.autoLaunch,
      recordingBackendEnabled: config.obs.enabled,
      hostScope: ["127.0.0.1", "localhost", "::1"].includes(config.obs.host)
        ? "loopback"
        : "non-loopback",
      port: config.obs.port,
      ...obsStatus
    },
    privacy: {
      remoteEndpoints: "omitted",
      windowTitles: "omitted",
      payloads: "not-captured",
      mediaContent: "not-captured"
    }
  };
};
