import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CallMonitorStatus } from "../../calls/status";
import { presentTrayStatus } from "../presentation";
import { INDICATOR_SCRIPT } from "../python";
import {
  buildCliActionRunArgs,
  buildStudioLaunchArgs,
  buildTerminalLaunchArgs,
  findStudioLauncher,
  launchRecordingStudio,
  monitorStateFromSystemdProperties,
  studioLauncherCandidates,
  trayActionIsAllowed
} from "../runtime";
import { buildTrayUnit } from "../service";

// Launches name every XDG directory, the defaults included, so the user manager's own values never apply.
const XDG_DEFAULTS = [["XDG_CONFIG_HOME", ".config"], ["XDG_STATE_HOME", ".local/state"], ["XDG_DATA_HOME", ".local/share"], ["XDG_CACHE_HOME", ".cache"]]
  .map(([name, folder]) => `--setenv=${name}=${join(homedir(), folder)}`);

const status = (overrides: Partial<CallMonitorStatus> = {}): CallMonitorStatus => ({
  version: 1,
  state: "IDLE",
  confidence: 0,
  reasons: [],
  updatedAt: "2026-07-15T12:00:00.000Z",
  dryRun: false,
  recordingOwned: false,
  ...overrides
});

describe("tray presentation", () => {
  test("shows managed recording details and enables only the valid recording action", () => {
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { paused: false },
      recording: {
        session: {
          version: 1,
          id: "123e4567-e89b-42d3-a456-426614174000",
          owner: "manual",
          backend: "gpu-screen-recorder",
          phase: "recording",
          outputPath: "/tmp/recording.mkv",
          startedAt: "2026-09-07T12:00:00.000Z",
          audio: { microphone: "alsa_input.usb-mic", desktop: "alsa_output.pci.monitor" }
        },
        active: true
      }
    })).toMatchObject({
      label: "REC",
      menuText: "Gravando tela e áudio · manual",
      recordingText: "Gravação manual · em andamento",
      durationStartedAt: "2026-09-07T12:00:00.000Z",
      screenText: "Tela/janela selecionada no portal",
      audioText: "Áudio · microfone: alsa_input.usb-mic · sistema: alsa_output.pci.monitor",
      automationText: "Captura automática · ativa",
      toggleAutomationLabel: "Suspender captura automática",
      startRecordingEnabled: false,
      stopRecordingEnabled: true,
      toggleAutomationEnabled: true
    });
  });

  test("keeps recording errors, starting and stopped state above an idle monitor", () => {
    const baseSession = {
      version: 1 as const,
      id: "123e4567-e89b-42d3-a456-426614174000",
      owner: "call" as const,
      backend: "audio" as const,
      outputPath: "/tmp/recording.mka",
      startedAt: "2026-09-07T12:00:00.000Z",
      audio: { microphone: "mic" }
    };
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { paused: true },
      recording: { session: { ...baseSession, phase: "starting" }, active: false }
    })).toMatchObject({
      label: "…",
      menuText: "Iniciando gravação automática",
      toggleAutomationLabel: "Retomar captura automática"
    });
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { paused: false },
      recording: {
        session: { ...baseSession, phase: "recording" },
        active: false,
        warning: "A captura terminou; a gravação precisa ser finalizada."
      }
    })).toMatchObject({
      label: "!",
      menuText: "A captura terminou; a gravação precisa ser finalizada."
    });
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { paused: false },
      recording: {
        session: { ...baseSession, phase: "stopped", endedAt: "2026-09-07T12:05:00.000Z" },
        active: false
      }
    })).toMatchObject({
      label: "■",
      menuText: "Gravação parada · aguardando finalização",
      stopRecordingEnabled: true
    });
  });

  test("surfaces action and automation failures without assuming automation resumed", () => {
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { error: "Estado da automação inválido" },
      action: {
        kind: "error",
        action: "pause-automation",
        text: "Falha: unidade transitória terminou com erro"
      }
    })).toMatchObject({
      label: "!",
      menuText: "Falha: unidade transitória terminou com erro",
      automationText: "Captura automática · erro: Estado da automação inválido",
      toggleAutomationEnabled: true
    });
  });

  test("disables every action while a recording command is running", () => {
    expect(presentTrayStatus(status(), "active", undefined, undefined, {
      automation: { paused: false },
      action: {
        kind: "busy",
        action: "start-recording",
        text: "Iniciando gravação manual…"
      }
    })).toMatchObject({
      label: "…",
      menuText: "Iniciando gravação manual…",
      startRecordingEnabled: false,
      stopRecordingEnabled: false,
      toggleAutomationEnabled: false,
      actionsEnabled: false
    });
  });

  test("identifies native recording and prioritizes a capture warning over REC", () => {
    const capturing = status({ recordingOwned: true, recordingBackend: "audio", app: "helium" });
    expect(presentTrayStatus(capturing, "active").menuText).toBe("Gravando áudio · Helium");
    expect(presentTrayStatus({ ...capturing, recordingWarning: "Microfone desconectado" }, "active"))
      .toMatchObject({ label: "!", menuText: "Microfone desconectado" });
  });
  test("shows idle, call, recording, and unavailable states", () => {
    expect(presentTrayStatus(status(), "active")).toMatchObject({
      icon: "audio-input-microphone-symbolic",
      label: ""
    });
    expect(presentTrayStatus(status({ state: "IN_CALL", app: "slack" }), "active")).toMatchObject({
      icon: "call-start-symbolic",
      label: "CALL",
      menuText: "Em chamada · Slack"
    });
    expect(presentTrayStatus(status({ state: "CANDIDATE", app: "zen" }), "active")).toMatchObject({
      icon: "audio-input-microphone-symbolic",
      label: "?"
    });
    expect(presentTrayStatus(status({ state: "IN_CALL", app: "helium" }), "active")).toMatchObject({
      menuText: "Em chamada · Helium"
    });
    expect(presentTrayStatus(status({ state: "ENDING", app: "zen" }), "active")).toMatchObject({
      icon: "call-stop-symbolic",
      label: "…"
    });
    expect(presentTrayStatus(status({
      state: "IN_CALL",
      app: "zen",
      recordingOwned: true
    }), "active")).toMatchObject({
      icon: "media-record-symbolic",
      label: "REC",
      menuText: "Gravando no OBS · Zen"
    });
    expect(presentTrayStatus(status(), "unhealthy")).toMatchObject({
      icon: "dialog-warning-symbolic",
      label: "!"
    });
    expect(presentTrayStatus(status(), "disabled")).toMatchObject({
      icon: "media-playback-stop-symbolic",
      label: "",
      title: "FalaTrace — monitor de chamadas desativado",
      menuText: "Monitor de chamadas · desativado",
      restartMonitorEnabled: false
    });
    expect(
      presentTrayStatus(status(), "active", {
        capturing: 0,
        draft: 2,
        ready: 3,
        synced: 0
      }, {
        pending: 1,
        transferring: 0,
        queued: 1,
        processing: 1,
        completed: 8,
        failed: 0
      })
    ).toMatchObject({
      timesheetText: "Horas · 2 revisar · 3 pronta(s)",
      processingText: "Processamento · 2 em andamento · 1 pendente(s)"
    });
  });
});

describe("call monitor systemd state", () => {
  test("treats missing and explicitly disabled units as intentional opt-out", () => {
    expect(monitorStateFromSystemdProperties("not-found", "inactive", "")).toBe("disabled");
    expect(monitorStateFromSystemdProperties("loaded", "inactive", "disabled")).toBe("disabled");
    expect(monitorStateFromSystemdProperties("loaded", "inactive", "masked")).toBe("disabled");
    expect(monitorStateFromSystemdProperties("loaded", "inactive", "masked-runtime")).toBe("disabled");
  });

  test("does not allow restarting an intentionally disabled monitor", () => {
    expect(trayActionIsAllowed("restart-monitor", "disabled")).toBe(false);
    expect(trayActionIsAllowed("restart-monitor", "unhealthy")).toBe(true);
    expect(trayActionIsAllowed("open-tui", "disabled")).toBe(true);
  });

  test("keeps active and unexpectedly unavailable services distinct", () => {
    expect(monitorStateFromSystemdProperties("loaded", "active", "enabled")).toBe("active");
    expect(monitorStateFromSystemdProperties("loaded", "inactive", "enabled")).toBe("unhealthy");
    expect(monitorStateFromSystemdProperties("loaded", "failed", "enabled")).toBe("unhealthy");
  });
});

describe("tray integration", () => {
  test("runs fixed recording and automation commands through a transient user unit", () => {
    expect(buildCliActionRunArgs(
      "start-recording",
      ["/home/user/.local/bin/recording-cli"],
      "123-456",
      { PATH: "/usr/bin" }
    )).toEqual([
      "--user",
      "--quiet",
      "--collect",
      "--wait",
      "--pipe",
      "--unit=recording-cli-tray-action-123-456",
      "--setenv=PATH=/usr/bin",
      ...XDG_DEFAULTS,
      "--",
      "/home/user/.local/bin/recording-cli",
      "record",
      "start"
    ]);
    const expectedCommands = {
      "start-recording": ["record", "start"],
      "stop-recording": ["record", "stop"],
      "pause-automation": ["calls", "pause"],
      "resume-automation": ["calls", "resume"]
    } as const;
    for (const [action, command] of Object.entries(expectedCommands)) {
      expect(buildCliActionRunArgs(
        action as keyof typeof expectedCommands,
        ["/home/user/.local/bin/recording-cli"],
        "123-457"
      ).slice(-3)).toEqual(["/home/user/.local/bin/recording-cli", ...command]);
    }
  });

  test("launches the production studio without a terminal or TUI fallback", () => {
    const args = buildStudioLaunchArgs(
      "/home/user/.local/bin/recording-studio",
      "123-456",
      { PATH: "/usr/bin" }
    );
    expect(args).toEqual([
      "--user",
      "--quiet",
      "--collect",
      "--property=Type=exec",
      "--unit=recording-cli-studio-123-456",
      "--setenv=PATH=/usr/bin",
      ...XDG_DEFAULTS,
      "--",
      "/home/user/.local/bin/recording-studio"
    ]);
    expect(args).not.toContain("tui");
    expect(args).not.toContain("/usr/bin/konsole");
  });

  test("reports a clear error when the production studio is not installed", async () => {
    const missingCommand = `/tmp/recording-studio-missing-${process.pid}`;
    await expect(launchRecordingStudio(missingCommand)).rejects.toThrow(
      `FalaTrace Studio não está instalado em ${missingCommand}. Execute novamente o instalador do FalaTrace ou, a partir do código-fonte, make install-studio.`
    );
  });

  test("finds the Studio next to the installed CLI before ~/.local/bin", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "falatrace-tray-studio-"));
    try {
      const prefixBin = join(root, "opt", "bin");
      const home = join(root, "home");
      const fallback = join(home, ".local", "bin", "recording-studio");
      await fs.mkdir(prefixBin, { recursive: true });
      await fs.mkdir(join(home, ".local", "bin"), { recursive: true });
      const candidates = studioLauncherCandidates(join(prefixBin, "falatrace"), home);
      expect(candidates).toEqual([join(prefixBin, "recording-studio"), fallback]);
      expect(await findStudioLauncher(candidates)).toBe(fallback);
      await fs.writeFile(fallback, "#!/bin/sh\n", { mode: 0o755 });
      expect(await findStudioLauncher(candidates)).toBe(fallback);
      await fs.writeFile(join(prefixBin, "recording-studio"), "#!/bin/sh\n", { mode: 0o755 });
      expect(await findStudioLauncher(candidates)).toBe(join(prefixBin, "recording-studio"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reports a safe error when systemd cannot start the studio unit", async () => {
    const secret = "token=do-not-expose";
    let result: Error | undefined;
    try {
      await launchRecordingStudio(process.execPath, async () => {
        throw new Error(secret);
      });
    } catch (error) {
      result = error as Error;
    }
    if (!result) throw new Error("Expected studio launch to fail");

    expect(result.message).toBe(
      "Não foi possível abrir o FalaTrace Studio. Verifique o journal do usuário para mais detalhes."
    );
    expect(result.message).not.toContain(secret);
  });

  test("launches the timesheet TUI through the user manager outside the tray sandbox", () => {
    expect(buildTerminalLaunchArgs(
      { path: "/usr/bin/konsole", args: ["-e"] },
      ["/home/user/.local/bin/recording-cli", "tui"],
      "123-456",
      { PATH: "/usr/bin" }
    )).toEqual([
      "--user",
      "--quiet",
      "--collect",
      "--unit=recording-cli-terminal-123-456",
      "--setenv=PATH=/usr/bin",
      ...XDG_DEFAULTS,
      "--",
      "/usr/bin/konsole",
      "-e",
      "/home/user/.local/bin/recording-cli",
      "tui"
    ]);
  });

  test("what the tray starts through the user manager reads the configuration the tray reads", () => {
    // The tray unit carries the installer's XDG directories; the units it starts must get them too.
    const env = { PATH: "/usr/bin", XDG_CONFIG_HOME: "/custom/config", XDG_STATE_HOME: "/custom/state", XDG_DATA_HOME: "/custom/data" };
    const launches = [
      buildCliActionRunArgs("stop-recording", ["/home/user/.local/bin/recording-cli"], "1", env),
      buildStudioLaunchArgs("/home/user/.local/bin/recording-studio", "1", env),
      buildTerminalLaunchArgs({ path: "/usr/bin/konsole", args: ["-e"] }, ["/home/user/.local/bin/recording-cli", "tui"], "1", env)
    ];
    for (const args of launches) {
      const options = args.slice(0, args.indexOf("--"));
      expect(options).toEqual(expect.arrayContaining([
        "--setenv=XDG_CONFIG_HOME=/custom/config", "--setenv=XDG_STATE_HOME=/custom/state", "--setenv=XDG_DATA_HOME=/custom/data"
      ]));
    }
  });

  test("embeds syntactically valid Python", () => {
    const result = Bun.spawnSync([
      "python3",
      "-c",
      "import sys; compile(sys.stdin.read(), '<recording-cli-tray>', 'exec')"
    ], { stdin: Buffer.from(INDICATOR_SCRIPT) });
    expect(result.exitCode).toBe(0);
    expect(INDICATOR_SCRIPT).toContain('add_action("Abrir biblioteca", "open-tui")');
    expect(INDICATOR_SCRIPT).toContain('add_action("Abrir apontamentos", "open-timesheet")');
    expect(INDICATOR_SCRIPT).toContain("processing_item.set_label");
    expect(INDICATOR_SCRIPT).toContain("restart_monitor_item.set_sensitive");
    expect(INDICATOR_SCRIPT).toContain('start_recording_item = add_action(');
    expect(INDICATOR_SCRIPT).toContain('"start-recording")');
    expect(INDICATOR_SCRIPT).toContain("update_elapsed");
    expect(INDICATOR_SCRIPT).toContain("toggle_automation_item.set_label");
  });

  test("builds a hardened user service", () => {
    const unit = buildTrayUnit(["/home/user/.local/bin/recording-cli"]);
    expect(unit).toContain('"tray" "run"');
    expect(unit).toContain("PartOf=graphical-session.target");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
  });
});
