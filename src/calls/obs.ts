import OBSWebSocket from "obs-websocket-js";
import { isAbsolute } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { launchObsDetached } from "../recording/obsLauncher";
import { readSecret } from "../config/secrets";

export interface CallObsClient {
  connect(url: string, password?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(requestType: "GetRecordStatus"): Promise<{ outputActive: boolean }>;
  call(
    requestType: "SetRecordDirectory",
    requestData: { recordDirectory: string }
  ): Promise<void>;
  call(requestType: "StartRecord"): Promise<void>;
  call(requestType: "StopRecord"): Promise<{ outputPath: string }>;
}

export type CallObsClientFactory = () => CallObsClient;
export type CallObsLauncher = () => Promise<void>;
export type CallObsWait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

const defaultFactory: CallObsClientFactory = () => new OBSWebSocket() as unknown as CallObsClient;
const OBS_LAUNCH_TIMEOUT_MS = 30_000;
const OBS_RETRY_INTERVAL_MS = 1_000;

const defaultLauncher: CallObsLauncher = async () => {
  const alreadyRunning = await runCommand("pgrep", ["-x", "obs"], { timeoutMs: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (alreadyRunning) return;
  await launchObsDetached();
};

const defaultWait: CallObsWait = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

export class CallObsController {
  private ownedSessionId: string | null = null;
  private recordDirectory?: string;

  constructor(
    private readonly config: AppConfig["obs"],
    private readonly createClient: CallObsClientFactory = defaultFactory,
    private readonly launchObs: CallObsLauncher = defaultLauncher,
    private readonly wait: CallObsWait = defaultWait
  ) {}

  ownsRecording(): boolean {
    return this.ownedSessionId !== null;
  }

  configureRecordDirectory(path: string): void {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path)) {
      throw new Error("OBS record directory must be an absolute path");
    }
    this.recordDirectory = path;
  }

  async getStatus(): Promise<{ outputActive: boolean }> {
    if (!isLoopback(this.config.host)) {
      throw new Error("Automatic OBS control only allows a loopback host");
    }
    const client = this.createClient();
    let connected = false;
    try {
      const host = this.config.host === "::1" ? "[::1]" : this.config.host;
      const password = (await readSecret("RECORDING_CLI_OBS_PASSWORD")) || this.config.password;
      await client.connect(`ws://${host}:${this.config.port}`, password);
      connected = true;
      return await client.call("GetRecordStatus");
    } finally {
      if (connected) await client.disconnect().catch(() => undefined);
    }
  }

  async start(sessionId: string): Promise<"started" | "already-recording"> {
    if (!isLoopback(this.config.host)) {
      throw new Error("Automatic OBS control only allows a loopback host");
    }
    const client = this.createClient();
    let connected = false;
    try {
      const host = this.config.host === "::1" ? "[::1]" : this.config.host;
      const password = (await readSecret("RECORDING_CLI_OBS_PASSWORD")) || this.config.password;
      await client.connect(`ws://${host}:${this.config.port}`, password);
      connected = true;
      const status = await client.call("GetRecordStatus");
      if (status.outputActive) return "already-recording";
      if (this.recordDirectory) {
        await client.call("SetRecordDirectory", { recordDirectory: this.recordDirectory });
      }
      await client.call("StartRecord");
      this.ownedSessionId = sessionId;
      return "started";
    } finally {
      if (connected) await client.disconnect().catch(() => undefined);
    }
  }

  async startAutomatically(
    sessionId: string,
    signal?: AbortSignal,
    shouldContinue: () => boolean = () => true
  ): Promise<"started" | "already-recording" | "cancelled"> {
    if (!isLoopback(this.config.host)) return await this.start(sessionId);
    try {
      return await this.start(sessionId);
    } catch (initialError) {
      if (!this.config.autoLaunch) throw initialError;
      await this.launchObs();
      const deadline = Date.now() + OBS_LAUNCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (signal?.aborted || !shouldContinue()) return "cancelled";
        await this.wait(Math.min(OBS_RETRY_INTERVAL_MS, deadline - Date.now()), signal);
        if (signal?.aborted || !shouldContinue()) return "cancelled";
        try {
          return await this.start(sessionId);
        } catch {
          // OBS initializes its WebSocket server after the graphical interface.
        }
      }
      throw new Error(
        "OBS opened, but its WebSocket server did not become available within 30 seconds"
      );
    }
  }

  async stop(sessionId: string): Promise<string | null> {
    if (this.ownedSessionId !== sessionId) return null;
    const client = this.createClient();
    let connected = false;
    try {
      const host = this.config.host === "::1" ? "[::1]" : this.config.host;
      const password = (await readSecret("RECORDING_CLI_OBS_PASSWORD")) || this.config.password;
      await client.connect(`ws://${host}:${this.config.port}`, password);
      connected = true;
      const status = await client.call("GetRecordStatus");
      if (!status.outputActive) {
        this.ownedSessionId = null;
        return null;
      }
      const result = await client.call("StopRecord");
      this.ownedSessionId = null;
      return result.outputPath;
    } finally {
      if (connected) await client.disconnect().catch(() => undefined);
    }
  }
}
