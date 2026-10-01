import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import { classifyCall, parsePipeWireNode } from "../classifier";
import { parseNetworkProbeResponse, parseNetworkTelemetry } from "../network";
import {
  CallObsController,
  type CallObsClient,
  type CallObsClientFactory
} from "../obs";
import { JsonValueStreamParser, PipeWireGraph } from "../pipewire";
import { buildCallMonitorUnit, buildNetworkProbeUnit } from "../service";
import { CallStateMachine } from "../stateMachine";
import { getCallStatusPath } from "../status";
import type { DetectionObservation, PipeWireNodeRecord } from "../types";

const node = (
  id: number,
  binary: string,
  mediaClass: string,
  state = "running",
  extra: Record<string, unknown> = {}
): PipeWireNodeRecord => ({
  id,
  type: "PipeWire:Interface:Node",
  info: {
    state,
    props: {
      "application.process.binary": binary,
      "media.class": mediaClass,
      "stream.is-live": true,
      ...extra
    }
  }
});

const active = (app: "slack" | "zen" | "helium" = "zen"): DetectionObservation => ({
  active: true,
  app,
  confidence: app === "zen" ? 0.9 : 0.72,
  reasons: ["capture-audio-running"],
  nodeIds: [1]
});

const inactive: DetectionObservation = {
  active: false,
  confidence: 0,
  reasons: [],
  nodeIds: []
};

describe("call detection config", () => {
  test("deeply merges application switches", () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      callDetection: { enabled: true, apps: { slack: false } }
    });
    expect(config.callDetection.enabled).toBe(true);
    expect(config.callDetection.apps.slack).toBe(false);
    expect(config.callDetection.apps.zen).toBe(true);
    expect(config.callDetection.apps.helium).toBe(true);
  });

  test("keeps dry-run status separate from the active service", () => {
    expect(getCallStatusPath(false)).toEndWith("call-monitor.json");
    expect(getCallStatusPath(true)).toEndWith("call-monitor-dry-run.json");
  });

  test("rejects unsafe timing and OBS values", () => {
    const badTiming = structuredClone(DEFAULT_CONFIG);
    badTiming.callDetection.entryDebounceSeconds = 0;
    expect(() => validateConfig(badTiming)).toThrow("entryDebounceSeconds");
    const badObs = structuredClone(DEFAULT_CONFIG);
    badObs.obs.host = "-malicious";
    expect(() => validateConfig(badObs)).toThrow("obs host");
    const badObsEnabled = structuredClone(DEFAULT_CONFIG);
    badObsEnabled.obs.enabled = "true" as unknown as boolean;
    expect(() => validateConfig(badObsEnabled)).toThrow("must be booleans");
    const inconsistentObsMode = structuredClone(DEFAULT_CONFIG);
    inconsistentObsMode.callDetection.mode = "obs";
    expect(() => validateConfig(inconsistentObsMode)).toThrow("requires obs.enabled=true");
  });
});

describe("PipeWire classifier", () => {
  test("detects Zen capture without requiring media.role", () => {
    const result = classifyCall([
      node(10, "zen", "Stream/Input/Audio"),
      node(11, "zen", "Stream/Output/Audio")
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result.active).toBe(true);
    expect(result.app).toBe("zen");
    expect(result.reasons).toContain("capture-audio-running");
    expect(result.confidence).toBeCloseTo(0.93);
  });

  test("detects Helium capture without requiring media.role", () => {
    const result = classifyCall([
      node(12, "helium", "Stream/Input/Audio"),
      node(13, "helium", "Stream/Output/Audio")
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result.active).toBe(true);
    expect(result.app).toBe("helium");
    expect(result.reasons).toContain("capture-audio-running");
    expect(result.confidence).toBeCloseTo(0.93);
  });

  test("does not treat playback, an open process, or OBS capture as a call", () => {
    const result = classifyCall([
      node(10, "zen", "Stream/Output/Audio"),
      node(11, "obs", "Stream/Input/Audio")
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result.active).toBe(false);
  });

  test("keeps Slack app-mute as an active capture signal", () => {
    const result = classifyCall([
      node(20, "slack", "Stream/Input/Audio", "running", { mute: false }),
      node(21, "slack", "Stream/Output/Audio")
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result.app).toBe("slack");
    expect(result.confidence).toBeCloseTo(0.75);
  });

  test("supports attributed video capture and application switches", () => {
    expect(classifyCall([
      node(30, "zen", "Stream/Input/Video")
    ], DEFAULT_CONFIG.callDetection.apps).active).toBe(true);
    expect(classifyCall([
      node(31, "slack", "Stream/Input/Audio")
    ], { slack: false, zen: true, helium: true }).active).toBe(false);
  });

});

describe("call state machine", () => {
  test("debounces entry and times out exit", () => {
    const machine = new CallStateMachine(5_000, 15_000, 0);
    expect(machine.update(active("slack"), 0)?.to).toBe("CANDIDATE");
    expect(machine.update(active("slack"), 4_999)).toBeNull();
    expect(machine.update(active("slack"), 5_000)?.to).toBe("IN_CALL");
    expect(machine.update(inactive, 6_000)?.to).toBe("ENDING");
    expect(machine.update(inactive, 20_999)).toBeNull();
    const ended = machine.update(inactive, 21_000);
    expect(ended?.to).toBe("IDLE");
    expect(ended?.app).toBe("slack");
  });

  test("cancels short candidates and resumes during ending", () => {
    const machine = new CallStateMachine(5_000, 15_000, 0);
    machine.update(active(), 0);
    expect(machine.update(inactive, 1_000)?.to).toBe("IDLE");
    machine.update(active(), 2_000);
    machine.update(active(), 7_000);
    machine.update(inactive, 8_000);
    expect(machine.update(active(), 9_000)?.to).toBe("IN_CALL");
  });
});

describe("PipeWire JSON stream", () => {
  test("parses chunked and consecutive JSON arrays", () => {
    const parser = new JsonValueStreamParser();
    expect(parser.push('[{"id":1,"text":"[x]')).toEqual([]);
    expect(parser.push('"}]\n[{"id":2}]')).toEqual([
      [{ id: 1, text: "[x]" }],
      [{ id: 2 }]
    ]);
  });

  test("updates and removes graph nodes", () => {
    const graph = new PipeWireGraph();
    graph.apply([node(1, "zen", "Stream/Input/Audio")]);
    expect(graph.values()).toHaveLength(1);
    graph.apply([{ id: 1, type: null }]);
    expect(graph.values()).toHaveLength(0);
    expect(parsePipeWireNode({ id: "bad" })).toBeNull();
  });
});

describe("network metadata", () => {
  test("aggregates process counters without retaining endpoints", () => {
    const tcp = 'ESTAB 0 0 10.0.0.1:1 20.0.0.1:443 users:(("zen",pid=10,fd=1))\n cubic bytes_sent:12 bytes_received:34\nESTAB 0 0 10.0.0.1:3 40.0.0.1:443 users:(("helium",pid=30,fd=3))\n cubic bytes_sent:56 bytes_received:78\n';
    const udp = 'ESTAB 0 0 10.0.0.1:2 30.0.0.1:443 users:(("slack",pid=20,fd=2))\n';
    const result = parseNetworkTelemetry(tcp, udp);
    expect(result.zen).toEqual({
      tcpSockets: 1,
      udpSockets: 0,
      tcpBytesSent: 12,
      tcpBytesReceived: 34
    });
    expect(result.slack.udpSockets).toBe(1);
    expect(result.helium.tcpBytesReceived).toBe(78);
    expect(JSON.stringify(result)).not.toContain("10.0.0.1");
  });

  test("validates sanitized network probe responses", () => {
    const telemetry = {
      slack: { tcpSockets: 1, udpSockets: 2, tcpBytesSent: 3, tcpBytesReceived: 4 },
      zen: { tcpSockets: 5, udpSockets: 6, tcpBytesSent: 7, tcpBytesReceived: 8 },
      helium: { tcpSockets: 9, udpSockets: 10, tcpBytesSent: 11, tcpBytesReceived: 12 }
    };
    expect(parseNetworkProbeResponse(JSON.stringify(telemetry))).toEqual(telemetry);
    expect(() => parseNetworkProbeResponse('{"zen":{"tcpSockets":-1}}')).toThrow(
      "Invalid network probe response"
    );
  });
});

describe("OBS ownership", () => {
  const makeFactory = (activeInitially: boolean) => {
    const calls: string[] = [];
    let activeNow = activeInitially;
    const client = {
      async connect(): Promise<void> { calls.push("connect"); },
      async disconnect(): Promise<void> { calls.push("disconnect"); },
      async call(request: string): Promise<unknown> {
        calls.push(request);
        if (request === "GetRecordStatus") return { outputActive: activeNow };
        if (request === "StartRecord") { activeNow = true; return undefined; }
        if (request === "StopRecord") { activeNow = false; return { outputPath: "/tmp/call.mkv" }; }
        throw new Error("unexpected request");
      }
    } as unknown as CallObsClient;
    return { calls, factory: (() => client) as CallObsClientFactory };
  };

  test("does not take ownership of an existing recording", async () => {
    const fake = makeFactory(true);
    const controller = new CallObsController(DEFAULT_CONFIG.obs, fake.factory);
    expect(await controller.start("session")).toBe("already-recording");
    expect(controller.ownsRecording()).toBe(false);
    expect(fake.calls).not.toContain("StartRecord");
  });

  test("sets the configured directory before starting a new recording", async () => {
    const requests: Array<{ type: string; data?: unknown }> = [];
    const client = {
      async connect(): Promise<void> {},
      async disconnect(): Promise<void> {},
      async call(type: string, data?: unknown): Promise<unknown> {
        requests.push({ type, data });
        if (type === "GetRecordStatus") return { outputActive: false };
        return undefined;
      }
    } as unknown as CallObsClient;
    const controller = new CallObsController(
      DEFAULT_CONFIG.obs,
      (() => client) as CallObsClientFactory
    );
    controller.configureRecordDirectory("/home/user/Videos/Recordings");

    expect(await controller.start("session")).toBe("started");
    expect(requests).toEqual([
      { type: "GetRecordStatus", data: undefined },
      {
        type: "SetRecordDirectory",
        data: { recordDirectory: "/home/user/Videos/Recordings" }
      },
      { type: "StartRecord", data: undefined }
    ]);
  });

  test("reads OBS recording status without changing ownership", async () => {
    const fake = makeFactory(true);
    const controller = new CallObsController(DEFAULT_CONFIG.obs, fake.factory);
    expect(await controller.getStatus()).toEqual({ outputActive: true });
    expect(controller.ownsRecording()).toBe(false);
    expect(fake.calls).not.toContain("StartRecord");
    expect(fake.calls).not.toContain("StopRecord");
  });

  test("stops only the recording started by the same session", async () => {
    const fake = makeFactory(false);
    const controller = new CallObsController(DEFAULT_CONFIG.obs, fake.factory);
    expect(await controller.start("session")).toBe("started");
    expect(await controller.stop("other")).toBeNull();
    expect(await controller.stop("session")).toBe("/tmp/call.mkv");
    expect(controller.ownsRecording()).toBe(false);
    expect(fake.calls).toContain("StopRecord");
  });

  test("rejects non-loopback automatic control", async () => {
    const controller = new CallObsController({
      ...DEFAULT_CONFIG.obs,
      host: "192.0.2.10"
    });
    expect(controller.start("session")).rejects.toThrow("loopback");
  });

  test("retains ownership when stopping cannot connect", async () => {
    let attempt = 0;
    const factory = (() => ({
      async connect(): Promise<void> {
        attempt += 1;
        if (attempt > 1) throw new Error("offline");
      },
      async disconnect(): Promise<void> {},
      async call(request: string): Promise<unknown> {
        if (request === "GetRecordStatus") return { outputActive: false };
        return undefined;
      }
    } as unknown as CallObsClient)) as CallObsClientFactory;
    const controller = new CallObsController(DEFAULT_CONFIG.obs, factory);
    await controller.start("session");
    expect(controller.stop("session")).rejects.toThrow("offline");
    expect(controller.ownsRecording()).toBe(true);
  });

  test("launches OBS and retries when automatic startup is enabled", async () => {
    const calls: string[] = [];
    let connectAttempts = 0;
    const client = {
      async connect(): Promise<void> {
        calls.push("connect");
        connectAttempts += 1;
        if (connectAttempts === 1) throw new Error("offline");
      },
      async disconnect(): Promise<void> { calls.push("disconnect"); },
      async call(request: string): Promise<unknown> {
        calls.push(request);
        if (request === "GetRecordStatus") return { outputActive: false };
        if (request === "StartRecord") return undefined;
        throw new Error("unexpected request");
      }
    } as unknown as CallObsClient;
    const config = { ...DEFAULT_CONFIG.obs, autoLaunch: true };
    const controller = new CallObsController(
      config,
      (() => client) as CallObsClientFactory,
      async () => { calls.push("launch"); },
      async () => {}
    );

    expect(await controller.startAutomatically("session")).toBe("started");
    expect(calls).toEqual([
      "connect",
      "launch",
      "connect",
      "GetRecordStatus",
      "StartRecord",
      "disconnect"
    ]);
    expect(controller.ownsRecording()).toBe(true);
  });

  test("does not launch OBS when automatic startup is disabled", async () => {
    let launched = false;
    const client = {
      async connect(): Promise<void> { throw new Error("offline"); },
      async disconnect(): Promise<void> {},
      async call(): Promise<never> { throw new Error("unexpected request"); }
    } as unknown as CallObsClient;
    const controller = new CallObsController(
      DEFAULT_CONFIG.obs,
      (() => client) as CallObsClientFactory,
      async () => { launched = true; },
      async () => {}
    );

    expect(controller.startAutomatically("session")).rejects.toThrow("offline");
    expect(launched).toBe(false);
  });

  test("does not auto-launch for a forbidden non-loopback host", async () => {
    let launched = false;
    const controller = new CallObsController(
      { ...DEFAULT_CONFIG.obs, autoLaunch: true, host: "192.0.2.10" },
      undefined,
      async () => { launched = true; },
      async () => {}
    );

    expect(controller.startAutomatically("session")).rejects.toThrow("loopback");
    expect(launched).toBe(false);
  });

  test("cancels startup if the call ends while OBS is opening", async () => {
    let active = true;
    let connectAttempts = 0;
    const client = {
      async connect(): Promise<void> {
        connectAttempts += 1;
        throw new Error("offline");
      },
      async disconnect(): Promise<void> {},
      async call(): Promise<never> { throw new Error("unexpected request"); }
    } as unknown as CallObsClient;
    const controller = new CallObsController(
      { ...DEFAULT_CONFIG.obs, autoLaunch: true },
      (() => client) as CallObsClientFactory,
      async () => { active = false; },
      async () => {}
    );

    expect(await controller.startAutomatically("session", undefined, () => active)).toBe("cancelled");
    expect(connectAttempts).toBe(1);
    expect(controller.ownsRecording()).toBe(false);
  });
});

describe("systemd user service", () => {
  test("keeps the monitor hardened and delegates process network attribution", () => {
    const unit = buildCallMonitorUnit(DEFAULT_CONFIG, ["/home/user/.local/bin/recording-cli"]);
    expect(unit).toContain("calls\" \"run");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=%h/.local/state/recording-cli %h/.local/share/recording-cli/jobs");
    expect(unit).toContain("Wants=recording-cli-network-probe.service");
    expect(unit).toContain("EnvironmentFile=-%h/.config/recording-cli/calls.env");
    expect(unit.toLowerCase()).not.toContain("password=");

    const probe = buildNetworkProbeUnit(["/home/user/.local/bin/recording-cli"]);
    expect(probe).toContain("calls\" \"network-probe");
    expect(probe).toContain("NoNewPrivileges=yes");
    expect(probe).toContain("RestrictNamespaces=yes");
    expect(probe).not.toContain("ProtectSystem=");
    expect(probe).not.toContain("ProtectHome=");
    expect(probe).not.toContain("PrivateTmp=");

  });
});
