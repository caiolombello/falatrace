import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { runCommand } from "../jobs/command";
import { GSR_APP_ID } from "./capture";

export type CaptureProcess = { pid: number; startTicks: string };

const readCaptureProcess = async (pid: number, outputPath: string, procRoot: string): Promise<CaptureProcess | null> => {
  try {
    const dir = join(procRoot, String(pid));
    const [command, rawStat] = await Promise.all([fs.readFile(join(dir, "cmdline"), "utf8"), fs.readFile(join(dir, "stat"), "utf8")]);
    const args = command.split("\0");
    const stat = rawStat.slice(rawStat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (basename(args[0]) !== "gpu-screen-recorder" || args.indexOf("-o") < 0 ||
      args[args.indexOf("-o") + 1] !== outputPath || stat[0] === "Z" || !/^\d+$/.test(stat[19])) return null;
    return { pid, startTicks: stat[19] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export const captureProcessMatches = async (process: CaptureProcess, outputPath: string, procRoot = "/proc"): Promise<boolean> =>
  (await readCaptureProcess(process.pid, outputPath, procRoot))?.startTicks === process.startTicks;

/** Flatpak moves the sandbox outside systemd-run's service; follow only its advertised process trees. */
export const findFlatpakCapture = async (outputPath: string, run = runCommand, procRoot = "/proc"): Promise<CaptureProcess | null> => {
  const { stdout } = await run("flatpak", ["ps", "--columns=child-pid,application"], { timeoutMs: 5_000 });
  const queue = stdout.split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([pid, app]) => app === GSR_APP_ID && /^\d+$/.test(pid) && Number(pid) > 1).map(([pid]) => Number(pid));
  const seen = new Set<number>();
  const matches: CaptureProcess[] = [];
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (seen.size > 256) throw new Error("Flatpak capture process tree is unexpectedly large");
    const capture = await readCaptureProcess(pid, outputPath, procRoot);
    if (capture) matches.push(capture);
    const children = await fs.readFile(join(procRoot, String(pid), "task", String(pid), "children"), "utf8")
      .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return ""; throw err; });
    queue.push(...children.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid) && Number(pid) > 1).map(Number));
  }
  if (matches.length > 1) throw new Error("Multiple Flatpak processes claim this recording; state retained");
  return matches[0] || null;
};
