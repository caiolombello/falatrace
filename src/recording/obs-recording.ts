import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import OBSWebSocket from "obs-websocket-js";
import type { AppConfig } from "../config/defaults";
import { launchObsDetached } from "./obsLauncher";
import { formatName } from "./naming";
import { clearState, readState, writeState } from "./state";
import { readSecret } from "../config/secrets";

export type StartOptions = {
  title?: string;
  audioSource?: "none" | "microphone" | "desktop" | "both";
  monitor?: string;
};

export interface ManualObsClient {
  connect(url: string, password?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(requestType: "GetRecordStatus"): Promise<{ outputActive: boolean; outputDuration?: number }>;
  call(requestType: "GetRecordDirectory"): Promise<{ recordDirectory: string }>;
  call(
    requestType: "SetRecordDirectory",
    requestData: { recordDirectory: string }
  ): Promise<void>;
  call(requestType: "StartRecord"): Promise<void>;
  call(requestType: "StopRecord"): Promise<{ outputPath: string }>;
}

export type ManualObsClientFactory = () => ManualObsClient;
export type ManualObsWait = (milliseconds: number) => Promise<void>;

const defaultFactory: ManualObsClientFactory = () =>
  new OBSWebSocket() as unknown as ManualObsClient;
const defaultWait: ManualObsWait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const OBS_LAUNCH_TIMEOUT_MS = 30_000;
const OBS_RETRY_INTERVAL_MS = 1_000;

class ObsConnectionError extends Error {}
export class RecordingStartCancelled extends Error {}
export class ObsStartUncertain extends Error {}

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

export class ManualObsController {
  constructor(
    private readonly config: AppConfig["obs"],
    private readonly createClient: ManualObsClientFactory = defaultFactory,
    private readonly launchObs: () => Promise<void> = launchObsDetached,
    private readonly wait: ManualObsWait = defaultWait
  ) {}

  async isRecording(): Promise<boolean> {
    this.assertLoopback();
    const client = this.createClient();
    await this.connect(client);
    try { return (await client.call("GetRecordStatus")).outputActive; }
    finally { await client.disconnect().catch(() => undefined); }
  }

  async matchesSession(recordDirectory: string, startedAt: string): Promise<boolean> {
    this.assertLoopback();
    const client = this.createClient();
    await this.connect(client);
    try {
      const status = await client.call("GetRecordStatus");
      const directory = await client.call("GetRecordDirectory");
      const elapsed = Date.now() - Date.parse(startedAt);
      return status.outputActive && directory.recordDirectory === recordDirectory &&
        typeof status.outputDuration === "number" && Math.abs(elapsed - status.outputDuration) < 10_000;
    } finally { await client.disconnect().catch(() => undefined); }
  }

  assertStartAllowed(): void {
    if (!this.config.enabled) {
      throw new Error("OBS recording is disabled; set obs.enabled=true after configuring OBS manually");
    }
    this.assertLoopback();
  }

  private assertLoopback(): void {
    if (!isLoopback(this.config.host)) {
      throw new Error("OBS recording is restricted to a loopback WebSocket host");
    }
  }

  private async connect(client: ManualObsClient): Promise<void> {
    const host = this.config.host === "::1" ? "[::1]" : this.config.host;
    const password = (await readSecret("RECORDING_CLI_OBS_PASSWORD")) || this.config.password;
    try {
      await client.connect(`ws://${host}:${this.config.port}`, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ObsConnectionError(`Cannot connect to the OBS WebSocket: ${message}`);
    }
  }

  private async startOnce(recordDirectory: string, assertRequested: () => Promise<void>): Promise<void> {
    const client = this.createClient();
    let connected = false;
    try {
      await this.connect(client);
      connected = true;
      const status = await client.call("GetRecordStatus");
      if (status.outputActive) {
        throw new Error("OBS is already recording; recording-cli will not take ownership of it");
      }
      await assertRequested();
      await client.call("SetRecordDirectory", { recordDirectory });
      await assertRequested();
      try { await client.call("StartRecord"); }
      catch { throw new ObsStartUncertain("OBS did not confirm StartRecord; inspect record status before recovery"); }
    } finally {
      if (connected) await client.disconnect().catch(() => undefined);
    }
  }

  async start(recordDirectory: string, options: { signal?: AbortSignal; shouldContinue?: () => boolean | Promise<boolean> } = {}): Promise<void> {
    const assertRequested = async (): Promise<void> => {
      if (options.signal?.aborted || await options.shouldContinue?.() === false) throw new RecordingStartCancelled("Recording start cancelled");
    };
    await assertRequested();
    this.assertStartAllowed();
    try {
      await this.startOnce(recordDirectory, assertRequested);
      return;
    } catch (err) {
      if (!(err instanceof ObsConnectionError) || !this.config.autoLaunch) throw err;
    }

    await assertRequested();
    await this.launchObs();
    const deadline = Date.now() + OBS_LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.wait(Math.min(OBS_RETRY_INTERVAL_MS, deadline - Date.now()));
      await assertRequested();
      try {
        await this.startOnce(recordDirectory, assertRequested);
        return;
      } catch (err) {
        if (!(err instanceof ObsConnectionError)) throw err;
      }
    }
    throw new Error("OBS opened, but its WebSocket server did not become available within 30 seconds");
  }

  async stop(): Promise<string | null> {
    this.assertLoopback();
    const client = this.createClient();
    let connected = false;
    try {
      await this.connect(client);
      connected = true;
      const status = await client.call("GetRecordStatus");
      if (!status.outputActive) return null;
      const result = await client.call("StopRecord");
      return result.outputPath;
    } finally {
      if (connected) await client.disconnect().catch(() => undefined);
    }
  }
}

const buildOutputPath = async (config: AppConfig, title?: string): Promise<string> => {
  const base = formatName(config.features.namingTemplate, title);
  const folder = join(config.recordingsDir, base);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  return join(folder, `${base}.mkv`);
};

export const startRecording = async (
  config: AppConfig,
  options: StartOptions
): Promise<{ outputPath: string }> => {
  const existing = await readState();
  if (existing) throw new Error("A recording is already running.");
  const controller = new ManualObsController(config.obs);
  controller.assertStartAllowed();
  const outputPath = await buildOutputPath(config, options.title);
  const recordDirectory = outputPath.slice(0, outputPath.lastIndexOf("/"));
  await controller.start(recordDirectory);
  try {
    await writeState({
      backend: "obs-ws",
      outputPath,
      startedAt: new Date().toISOString()
    });
  } catch (err) {
    await controller.stop().catch(() => undefined);
    throw err;
  }
  return { outputPath };
};

export const stopRecording = async (
  config: AppConfig
): Promise<{ videoPath?: string }> => {
  const state = await readState();
  if (!state) throw new Error("No active recording found.");
  const outputPath = await new ManualObsController(config.obs).stop();
  if (!outputPath) {
    throw new Error(
      "OBS is not recording; local state was retained. Verify the output in OBS, then run record reset"
    );
  }
  if (!isAbsolute(outputPath) || /[\r\n\0]/.test(outputPath)) {
    throw new Error("OBS returned an unsafe output path; local state was retained");
  }
  await clearState();
  return { videoPath: outputPath };
};
