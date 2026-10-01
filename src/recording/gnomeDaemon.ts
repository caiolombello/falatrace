import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { formatName } from "./naming";
import { clearState, writeState } from "./state";

const SCREENCAST_SERVICE = "org.gnome.Shell.Screencast";
const SCREENCAST_PATH = "/org/gnome/Shell/Screencast";
const SCREENCAST_INTERFACE = "org.gnome.Shell.Screencast";
const LOG_PATH = join(homedir(), ".config", "recording-cli", "gnome-daemon.log");

const buildTemplate = (config: AppConfig, title?: string): string => {
  const base = formatName(config.features.namingTemplate, title);
  return join(config.recordingsDir, base);
};

const writeLog = async (message: string): Promise<void> => {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.mkdir(join(homedir(), ".config", "recording-cli"), {
    recursive: true,
    mode: 0o700
  });
  await fs.appendFile(LOG_PATH, line, { mode: 0o600 });
};

export const encodeGVariantString = (value: string): string => {
  if (value.includes("\0")) throw new Error("GVariant strings must not contain NUL bytes");
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}'`;
};

export const buildGVariantOptions = (config: AppConfig): string => {
  const options: string[] = [];
  if (config.gnome.pipeline) {
    options.push(`'pipeline': <${encodeGVariantString(config.gnome.pipeline)}>`);
  }
  if (config.gnome.framerate) {
    options.push(`'framerate': <${config.gnome.framerate}>`);
  }
  if (typeof config.gnome.drawCursor === "boolean") {
    options.push(`'draw-cursor': <${config.gnome.drawCursor}>`);
  }
  return `{${options.join(", ")}}`;
};

const decodeGVariantString = (value: string): string =>
  value.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });

export const parseScreencastResponse = (output: string): string => {
  const match = output.trim().match(/^\((true|false),\s*(['"])([\s\S]*)\2\)$/);
  if (!match) throw new Error("GNOME returned an invalid screencast response");
  if (match[1] !== "true") throw new Error("GNOME screencast failed to start");
  return decodeGVariantString(match[3]);
};

const parseStopResponse = (output: string): void => {
  if (!/^\(true,\s*\)$/.test(output.trim())) {
    throw new Error("GNOME screencast failed to stop");
  }
};

const gdbusBaseArgs = (): string[] => [
  "call",
  "--session",
  "--dest",
  SCREENCAST_SERVICE,
  "--object-path",
  SCREENCAST_PATH,
  "--timeout",
  "10"
];

const startScreencast = async (
  config: AppConfig,
  title?: string,
  geometry?: string
): Promise<string> => {
  const methodArgs: string[] = [];
  let method = `${SCREENCAST_INTERFACE}.Screencast`;
  if (geometry) {
    const match = geometry.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    if (!match) {
      throw new Error("Invalid --geometry format. Use WxH+X+Y (e.g., 1280x720+0+0).");
    }
    method = `${SCREENCAST_INTERFACE}.ScreencastArea`;
    methodArgs.push(match[3], match[4], match[1], match[2]);
  }
  methodArgs.push(
    encodeGVariantString(buildTemplate(config, title)),
    buildGVariantOptions(config)
  );
  const result = await runCommand("gdbus", [
    ...gdbusBaseArgs(),
    "--method",
    method,
    ...methodArgs
  ], { timeoutMs: 15_000 });
  return parseScreencastResponse(result.stdout);
};

const stopScreencast = async (): Promise<void> => {
  const result = await runCommand("gdbus", [
    ...gdbusBaseArgs(),
    "--method",
    `${SCREENCAST_INTERFACE}.StopScreencast`
  ], { timeoutMs: 15_000 });
  parseStopResponse(result.stdout);
};

const monitorErrors = (onError: (message: string) => void): ChildProcess => {
  const child = spawn("gdbus", [
    "monitor",
    "--session",
    "--dest",
    SCREENCAST_SERVICE,
    "--object-path",
    SCREENCAST_PATH
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer = `${buffer}${chunk.toString()}`.slice(-20_000);
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.includes(`${SCREENCAST_INTERFACE}.Error`)) {
        onError(line.replace(/[\r\n\0]+/g, " ").slice(0, 1000));
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-1000);
  });
  child.once("error", (err) => onError(`gdbus monitor error: ${err.message}`));
  child.once("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    const detail = stderr.trim().replace(/[\r\n\0]+/g, " ");
    onError(`gdbus monitor exited with ${reason}${detail ? `: ${detail}` : ""}`);
  });
  return child;
};

export const runGnomeDaemon = async (
  config: AppConfig,
  title?: string,
  geometry?: string
): Promise<void> => {
  let outputPath: string;
  try {
    await fs.mkdir(config.recordingsDir, { recursive: true, mode: 0o700 });
    outputPath = await startScreencast(config, title, geometry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeLog(message);
    await clearState();
    process.exit(1);
    return;
  }

  await writeState({
    backend: "gnome",
    pid: process.pid,
    outputPath,
    startedAt: new Date().toISOString()
  });

  let stopping = false;
  const monitor = monitorErrors((message) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await writeLog(`GNOME screencast error: ${message}`);
      await stopScreencast().catch(async (err) => {
        const stopError = err instanceof Error ? err.message : String(err);
        await writeLog(`Error stopping screencast after monitor failure: ${stopError}`);
      });
      await clearState();
      monitor.kill("SIGTERM");
      process.exit(1);
    })();
  });

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await stopScreencast();
      await writeLog("Recording stopped successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeLog(`Error during stop: ${message}`);
      console.error(`Error during stop: ${message}`);
    } finally {
      await clearState();
      monitor.kill("SIGTERM");
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  setInterval(() => {}, 60_000);
};
