import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type ObsLaunchSpec = {
  command: string;
  args: string[];
  kind: "native" | "flatpak";
};

export type ObsLaunchProbe = {
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: (name: string) => Promise<string | null>;
  pathExists?: (path: string) => Promise<boolean>;
};

const defaultPathExists = async (path: string): Promise<boolean> =>
  fs.access(path).then(() => true).catch(() => false);

export const resolveExecutable = async (
  name: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> => {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    const executable = await fs.access(candidate, constants.X_OK)
      .then(() => true)
      .catch(() => false);
    if (executable) return candidate;
  }
  return null;
};

export const resolveObsLaunchSpec = async (
  probe: ObsLaunchProbe = {}
): Promise<ObsLaunchSpec | null> => {
  const env = probe.env || process.env;
  const findExecutable = probe.resolveExecutable || ((name: string) => resolveExecutable(name, env));
  const pathExists = probe.pathExists || defaultPathExists;
  const nativeObs = await findExecutable("obs");
  if (nativeObs) {
    return {
      command: nativeObs,
      args: ["--minimize-to-tray"],
      kind: "native"
    };
  }

  const flatpak = await findExecutable("flatpak");
  if (!flatpak) return null;
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const deployments = [
    join(dataHome, "flatpak", "app", "com.obsproject.Studio", "current", "active"),
    "/var/lib/flatpak/app/com.obsproject.Studio/current/active"
  ];
  const installed = (await Promise.all(deployments.map(pathExists))).some(Boolean);
  if (!installed) return null;
  return {
    command: flatpak,
    args: ["run", "com.obsproject.Studio", "--minimize-to-tray"],
    kind: "flatpak"
  };
};

export const launchObsDetached = async (
  probe: ObsLaunchProbe = {}
): Promise<void> => {
  const spec = await resolveObsLaunchSpec(probe);
  if (!spec) {
    throw new Error("OBS auto-launch is enabled, but no native or Flatpak installation was found");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
