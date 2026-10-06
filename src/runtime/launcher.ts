import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Entry script for source runs under Bun. The Studio bridge runs from bridge.ts, so its
 * own argv[1] must not be reused for CLI commands such as `calls run` or `models download`.
 */
export const cliEntryForBun = (argv1 = process.argv[1] || ""): string => {
  if (/(?:^|\/)(?:src\/cli\/index\.ts|dist\/index\.js)$/.test(argv1)) return argv1;
  const candidate = resolve(import.meta.dir, "../cli/index.ts");
  return existsSync(candidate) ? candidate : argv1;
};

/**
 * Command used by generated systemd units and detached helpers. Installed releases live
 * in versioned directories; when a stable link in ~/.local/bin resolves to the running
 * executable, prefer it so a unit written from the Studio keeps following the release.
 */
export const getServiceLaunchCommand = (
  execPath = process.execPath,
  argv1 = cliEntryForBun(),
  stableLinks = ["recording-cli", "falatrace"].map((name) => join(homedir(), ".local", "bin", name))
): string[] => {
  const executableName = basename(execPath);
  if (executableName === "bun" || executableName.startsWith("bun-")) return [execPath, argv1];
  const resolvePath = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
  const running = resolvePath(execPath);
  const stable = running ? stableLinks.find((link) => link !== execPath && resolvePath(link) === running) : undefined;
  return [stable || execPath];
};
