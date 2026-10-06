import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

const runCommandOwned = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; inherit?: boolean; signal?: AbortSignal } = {}
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason || new Error(`${command} cancelled`)); return; }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString()}`.slice(-100_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, options.timeoutMs)
      : undefined;
    const cancel = (): void => {
      cancelled = true;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.on("error", (err) => {
      finish(err);
    });
    child.on("close", (code, signal) => {
      if (cancelled) {
        finish(new Error(`${command} cancelled`));
      } else if (timedOut) {
        finish(new Error(`${command} timed out after ${options.timeoutMs}ms: ${stderr || stdout}`));
      } else if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            `${command} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}: ${stderr || stdout}`
          )
        );
      }
    });
  });

/** Short, user-initiated local probes (a few seconds of audio) that must not queue behind heavy work. */
export const runCommandDirect = (...args: Parameters<typeof runCommandOwned>): Promise<CommandResult> => runCommandOwned(...args);

// Capture uses its backend spawn and is deliberately never admitted here.
export const runCommand = (...args: Parameters<typeof runCommandOwned>): Promise<CommandResult> =>
  args[0] === 'ffmpeg' ? withHeavyAdmission('command', 'ffmpeg', () => runCommandOwned(...args), { signal: args[2]?.signal, onWait: cliAdmissionWait }) : runCommandOwned(...args);
