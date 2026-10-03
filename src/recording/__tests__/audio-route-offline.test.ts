import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { runCommand } from "../../jobs/command";
import { CallMonitorRuntime } from "../../calls/runtime";
import { readCaptureStatus } from "../application";
import { RecordingController } from "../controller";
import { RecordingSessionStore, type RecordingSession } from "../session";

const source = (name: string, mute = false) => ({ name, mute, volume: { left: { value: 65536 }, right: { value: 65536 } } });
const createFixture = async (owner: "manual" | "call" = "manual") => {
  const root = await fs.mkdtemp(join(process.env.FALATRACE_QA_ROOT!, "audio-route-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend = "audio";
  config.recordingsDir = root;
  const store = new RecordingSessionStore(join(root, "session.json"));
  const session: RecordingSession = {
    version: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner, backend: "audio", phase: "recording",
    outputPath: join(root, "fixture.mka"), startedAt: new Date().toISOString(),
    audio: { microphone: "mic", desktop: "output-a.monitor" },
    audioSelection: { microphone: "default", desktop: "default" }
  };
  await fs.writeFile(session.outputPath, "synthetic container placeholder; never decoded");
  const telemetry = {
    sink: "output-a", microphone: "mic", sources: [source("mic"), source("output-a.monitor"), source("output-b.monitor")]
  };
  const commands: string[][] = [];
  const run: typeof runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (command === "systemctl" && args.includes("show")) return { stdout: "ActiveState=active\nMainPID=123\n", stderr: "" };
    if (command === "systemd-run") {
      await fs.writeFile(args[args.length - 1], "synthetic capture startup placeholder; never decoded");
      return { stdout: "", stderr: "" };
    }
    if (command === "pactl" && args[0] === "--format=json") return { stdout: JSON.stringify(telemetry.sources), stderr: "" };
    if (command === "pactl" && args[0] === "get-default-source") return { stdout: telemetry.microphone, stderr: "" };
    if (command === "pactl" && args[0] === "get-default-sink") return { stdout: telemetry.sink, stderr: "" };
    throw new Error(`Offline fixture refused command: ${command} ${args.join(" ")}`);
  };
  const controller = new RecordingController(config, owner, store, run);
  return { root, config, store, session, telemetry, commands, controller, run };
};

test("A to B default change warns while A exists, without attributing B mute to captured A or stopping", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.write(fixture.session);
    fixture.telemetry.sink = "output-b";
    fixture.telemetry.sources[2].mute = true;
    const result = await fixture.controller.health();
    expect(result.active).toBe(true);
    expect(result.warning).toContain("output-a.monitor, selecionada pelo padrão no início");
    expect(result.warning).toContain("output-b.monitor");
    expect(result.warning).not.toContain("está mutada");
    expect(result.warning).toContain("rota efetiva do playback não foi verificada");
    expect((await fixture.store.read())?.audio).toEqual(fixture.session.audio);
    expect((await fixture.store.read())?.phase).toBe("recording");
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("explicit pin is labeled as fixed even when current configuration requests defaults", async () => {
  const fixture = await createFixture();
  try {
    fixture.session.audioSelection!.desktop = "explicit";
    await fixture.store.write(fixture.session);
    fixture.telemetry.sink = "output-b";
    const result = await fixture.controller.health();
    expect(result.active).toBe(true);
    expect(result.warning).toContain("configurada explicitamente (fixada)");
    expect(result.warning).not.toContain("desktop da captura (output-a.monitor, selecionada pelo padrão");
    expect((await fixture.store.read())?.audio?.desktop).toBe("output-a.monitor");
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("unknown defaults, controls and legacy selection remain unknown with active capture", async () => {
  const fixture = await createFixture();
  try {
    fixture.session.audioSelection = undefined;
    await fixture.store.write(fixture.session);
    fixture.telemetry.sink = "";
    fixture.telemetry.sources[1] = { name: "output-a.monitor" } as typeof fixture.telemetry.sources[number];
    const result = await fixture.controller.health();
    expect(result.active).toBe(true);
    expect(result.warning).toContain("metadados de mute/volume da origem desktop capturada estão indisponíveis");
    expect(result.warning).toContain("Não foi possível confirmar a origem padrão atual de desktop");
    fixture.telemetry.sink = "output-a";
    fixture.telemetry.sources[1] = source("output-a.monitor");
    expect((await fixture.controller.health()).warning).toContain("modo de seleção inicial de desktop está indisponível");
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("startup warnings and selection intent are persisted, then current metadata can recover", async () => {
  const fixture = await createFixture();
  try {
    fixture.telemetry.sources[0].mute = true;
    expect(await fixture.controller.start({ sessionId: fixture.session.id })).toBe("started");
    const started = await fixture.store.read();
    expect(started?.audioWarnings).toHaveLength(1);
    expect(started?.audioWarnings?.[0]).toContain("microphone (mic) está mutada");
    expect(started?.audioSelection).toEqual({ microphone: "default", desktop: "default" });
    expect((await fixture.controller.health()).warning).toContain("microphone (mic) está mutada");
    fixture.telemetry.sources[0].mute = false;
    expect(await fixture.controller.health()).toEqual({ active: true });
    expect((await fixture.store.read())?.audioWarnings).toEqual(started?.audioWarnings);
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("an active session without captured-source snapshot stays unverified instead of inspecting current defaults", async () => {
  const fixture = await createFixture();
  try {
    fixture.session.audio = undefined;
    fixture.session.audioSelection = undefined;
    await fixture.store.write(fixture.session);
    const health = await fixture.controller.health();
    expect(health.active).toBe(true);
    expect(health.warning).toContain("defaults atuais não validam esta captura");
    const status = await readCaptureStatus(fixture.config, {
      sessionStore: fixture.store,
      createController: () => ({
        inspect: async () => ({ session: fixture.session, active: true }), health: async () => ({ active: true }),
        recover: async () => fixture.session, stop: async () => fixture.session, acknowledge: async () => undefined
      }),
      inspectAudioSources: async () => { throw new Error("Current defaults must not be attributed to an unknown capture"); },
      readAutomationState: async () => ({ version: 1 as const, paused: false })
    });
    expect(status.active).toBe(true);
    expect(status.audio.selected).toBeUndefined();
    expect(status.audio.error).toContain("defaults atuais não validam esta captura");
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("active application inspects captured A despite current default B; current health warning is not duplicated", async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.write(fixture.session);
    let inspected = 0;
    const dependencies = {
      sessionStore: fixture.store,
      createController: () => ({
        inspect: async () => ({ session: fixture.session, active: true }),
        health: async () => ({ active: true }),
        recover: async () => fixture.session, stop: async () => fixture.session, acknowledge: async () => undefined
      }),
      inspectAudioSources: async (capture: typeof fixture.config.capture) => {
        inspected++;
        expect(capture.desktop).toBe("output-a.monitor");
        expect(capture.microphone).toBe("mic");
        return { available: ["mic", "output-a.monitor"], selected: fixture.session.audio!, warnings: ["captured A is muted"] };
      },
      readAutomationState: async () => ({ version: 1 as const, paused: false })
    };
    const status = await readCaptureStatus(fixture.config, dependencies);
    expect(status.warning).toBe("captured A is muted");
    expect(status.audio.selected).toEqual(fixture.session.audio);
    const withWarning = await readCaptureStatus(fixture.config, {
      ...dependencies,
      createController: () => ({ ...dependencies.createController(), health: async () => ({ active: true, warning: "current capture warning" }) })
    });
    expect(withWarning.warning).toBe("current capture warning");
    expect(inspected).toBe(1);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test("automatic warning notifications deduplicate, recover and never auto-stop for route alerts", async () => {
  const fixture = await createFixture("call");
  try {
    await fixture.store.write(fixture.session);
    await fixture.controller.recover();
    const notices: string[] = [];
    const noop = async () => undefined;
    const monitor = new CallMonitorRuntime(fixture.config, false, {
      run: fixture.run,
      notifications: { callStarted: noop, callEnded: noop, recordingStarted: noop, recordingStopped: noop, unavailable: noop,
        warning: async (message) => { notices.push(message); } }
    });
    // Exercise the existing health tick without starting watchers, devices or timers.
    Object.defineProperty(monitor, "recorder", { value: fixture.controller });
    const tick = (monitor as unknown as { checkCaptureHealth(): Promise<void> }).checkCaptureHealth.bind(monitor);
    fixture.telemetry.sink = "output-b";
    await tick();
    await tick();
    expect(notices).toHaveLength(1);
    fixture.telemetry.sink = "output-a";
    await tick();
    expect(await fixture.controller.health()).toEqual({ active: true });
    fixture.telemetry.sink = "output-b";
    await tick();
    expect(notices).toHaveLength(2);
    expect((await fixture.store.read())?.phase).toBe("recording");
    expect(fixture.commands.some((command) => command.includes("stop"))).toBe(false);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});
