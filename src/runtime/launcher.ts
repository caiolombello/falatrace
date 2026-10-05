import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Command used by generated systemd units. Installed releases live in versioned
 * directories; when a stable link in ~/.local/bin resolves to the running executable,
 * prefer it so a unit written from the Studio keeps following the current release.
 */
export const getServiceLaunchCommand = (
  execPath = process.execPath,
  argv1 = process.argv[1],
  stableLinks = ["recording-cli", "falatrace"].map((name) => join(homedir(), ".local", "bin", name))
): string[] => {
  const executableName = basename(execPath);
  if (executableName === "bun" || executableName.startsWith("bun-")) return [execPath, argv1];
  const resolve = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
  const running = resolve(execPath);
  const stable = running ? stableLinks.find((link) => link !== execPath && resolve(link) === running) : undefined;
  return [stable || execPath];
};
