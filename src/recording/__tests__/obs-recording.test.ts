import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import {
  ManualObsController,
  ObsStartUncertain,
  type ManualObsClient,
  type ManualObsClientFactory
} from "../obs-recording";

const enabledConfig = () => ({ ...DEFAULT_CONFIG.obs, enabled: true });

const clientFactory = (activeInitially = false) => {
  const requests: string[] = [];
  let active = activeInitially;
  const client = {
    async connect(): Promise<void> { requests.push("connect"); },
    async disconnect(): Promise<void> { requests.push("disconnect"); },
    async call(request: string): Promise<unknown> {
      requests.push(request);
      if (request === "GetRecordStatus") return { outputActive: active };
      if (request === "StartRecord") { active = true; return undefined; }
      if (request === "StopRecord") { active = false; return { outputPath: "/tmp/obs.mkv" }; }
      if (request === "SetRecordDirectory") return undefined;
      throw new Error("unexpected request");
    }
  } as unknown as ManualObsClient;
  return { requests, factory: (() => client) as ManualObsClientFactory };
};

describe("manual OBS recording control", () => {
  test("cancels before StartRecord when the call ends during directory setup", async () => {
    const abort = new AbortController();
    const fake = clientFactory();
    const factory = (() => {
      const client = fake.factory();
      return { ...client, async call(request: string, data?: unknown) {
        if (request === "SetRecordDirectory") abort.abort();
        return await (client.call as Function)(request, data);
      } } as ManualObsClient;
    }) as ManualObsClientFactory;
    await expect(new ManualObsController(enabledConfig(), factory).start("/tmp/owned", { signal: abort.signal })).rejects.toThrow("cancelled");
    expect(fake.requests).not.toContain("StartRecord");
  });

  test("reports uncertainty when StartRecord has no confirmation", async () => {
    const fake = clientFactory();
    const factory = (() => {
      const client = fake.factory();
      return { ...client, async call(request: string, data?: unknown) {
        if (request === "StartRecord") throw new Error("connection lost");
        return await (client.call as Function)(request, data);
      } } as ManualObsClient;
    }) as ManualObsClientFactory;
    await expect(new ManualObsController(enabledConfig(), factory).start("/tmp/owned")).rejects.toBeInstanceOf(ObsStartUncertain);
  });

  test("does not start OBS when a call ends while the WebSocket is launching", async () => {
    const abort = new AbortController();
    let connections = 0;
    const factory = (() => ({
      async connect() { connections++; throw new Error("not ready"); },
      async disconnect() {}, async call() { throw new Error("must not start"); }
    })) as ManualObsClientFactory;
    const controller = new ManualObsController({ ...enabledConfig(), autoLaunch: true }, factory,
      async () => { abort.abort(); }, async () => {});
    await expect(controller.start("/tmp/owned", { signal: abort.signal })).rejects.toThrow("cancelled");
    expect(connections).toBe(1);
  });
  test("does not connect or launch while OBS recording is disabled", async () => {
    let created = 0;
    let launched = false;
    const controller = new ManualObsController(
      DEFAULT_CONFIG.obs,
      (() => { created += 1; throw new Error("unexpected"); }) as ManualObsClientFactory,
      async () => { launched = true; }
    );
    await expect(controller.start("/tmp")).rejects.toThrow("disabled");
    expect(created).toBe(0);
    expect(launched).toBe(false);
  });

  test("checks status and refuses to take over an existing recording", async () => {
    const fake = clientFactory(true);
    const controller = new ManualObsController(enabledConfig(), fake.factory);
    await expect(controller.start("/tmp")).rejects.toThrow("will not take ownership");
    expect(fake.requests).not.toContain("StartRecord");
  });

  test("sets the directory before starting and returns the OBS output on stop", async () => {
    const fake = clientFactory();
    const controller = new ManualObsController(enabledConfig(), fake.factory);
    await controller.start("/tmp/recordings");
    expect(fake.requests.slice(0, 5)).toEqual([
      "connect",
      "GetRecordStatus",
      "SetRecordDirectory",
      "StartRecord",
      "disconnect"
    ]);
    expect(await controller.stop()).toBe("/tmp/obs.mkv");
  });

  test("does not auto-launch after a connection failure when disabled", async () => {
    let launched = false;
    const factory = (() => ({
      async connect(): Promise<void> { throw new Error("offline"); },
      async disconnect(): Promise<void> {},
      async call(): Promise<never> { throw new Error("unexpected"); }
    } as unknown as ManualObsClient)) as ManualObsClientFactory;
    const controller = new ManualObsController(
      enabledConfig(),
      factory,
      async () => { launched = true; }
    );
    await expect(controller.start("/tmp")).rejects.toThrow("Cannot connect");
    expect(launched).toBe(false);
  });

  test("auto-launches and retries only after explicit opt-in", async () => {
    let connectAttempts = 0;
    let launched = false;
    const fake = clientFactory();
    const factory = (() => {
      const client = fake.factory();
      return {
        ...client,
        async connect(url: string, password?: string): Promise<unknown> {
          connectAttempts += 1;
          if (connectAttempts === 1) throw new Error("offline");
          return await client.connect(url, password);
        }
      } as ManualObsClient;
    }) as ManualObsClientFactory;
    const controller = new ManualObsController(
      { ...enabledConfig(), autoLaunch: true },
      factory,
      async () => { launched = true; },
      async () => {}
    );
    await controller.start("/tmp");
    expect(launched).toBe(true);
    expect(connectAttempts).toBe(2);
    expect(fake.requests).toContain("StartRecord");
  });

  test("rejects non-loopback WebSocket control", () => {
    const controller = new ManualObsController({
      ...enabledConfig(),
      host: "192.0.2.10"
    });
    expect(() => controller.assertStartAllowed()).toThrow("loopback");
  });
});
