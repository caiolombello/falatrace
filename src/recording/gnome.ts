import { spawn } from "node:child_process";
import { clearState, readState } from "./state";
import type { AppConfig } from "../config/defaults";
import { assertBackendCompatible, detectRecordingCapabilities } from "./capabilities";
import { getServiceLaunchCommand } from "../runtime/launcher";

export type StartOptions = {
  title?: string;
  geometry?: string;
};

export const startRecording = async (
  config: AppConfig,
  options: StartOptions
): Promise<{ outputPath: string }> => {
  const existing = await readState();
  if (existing) {
    throw new Error("A recording is already running.");
  }
  assertBackendCompatible("gnome", await detectRecordingCapabilities());

  // A compiled binary reports a virtual /$bunfs path as argv[1]: reuse the service launch
  // command, which is [bun, script] from source and the executable itself when compiled.
  const [program, ...prefix] = getServiceLaunchCommand();
  const args = [...prefix, "record", "gnome-daemon"];
  if (options.title) {
    args.push("--title", options.title);
  }
  if (options.geometry) {
    args.push("--geometry", options.geometry);
  }

  const child = spawn(program, args, {
    detached: true,
    stdio: "ignore"
  });

  child.unref();

  const waitForState = async (): Promise<string> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2000) {
      const state = await readState();
      if (state?.outputPath) {
        return state.outputPath;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "GNOME screencast failed to start (no state). Check ~/.config/recording-cli/gnome-daemon.log."
    );
  };

  const outputPath = await waitForState();
  return { outputPath };
};

export type StopResult = {
  stopped: boolean;
  message?: string;
};

export const stopRecording = async (): Promise<StopResult> => {
  const state = await readState();
  if (!state) {
    throw new Error("No active recording found.");
  }

  if (!state.pid) {
    return { stopped: false, message: "Missing GNOME daemon PID." };
  }

  try {
    process.kill(state.pid, "SIGINT");
  } catch (err) {
    await clearState();
    return { stopped: false, message: err instanceof Error ? err.message : String(err) };
  }

  return { stopped: true };
};

export const getStatus = async (): Promise<string> => {
  const state = await readState();
  if (!state) {
    return "idle";
  }
  return `recording (${state.outputPath})`;
};
