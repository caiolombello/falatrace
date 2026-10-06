import type { AppConfig } from "../config/defaults";
import { enqueueRecording } from "../jobs/enqueue";
import type { JobRecord } from "../jobs/types";
import { TimeEntryStore } from "../timesheet/store";
import { readAutomationState, type AutomationState } from "../calls/control";
import { inspectAudioSources, type AudioSources } from "./capture";
import { RecordingController } from "./controller";
import { capturedAudioConfig, RecordingSessionStore, type RecordingSession } from "./session";
import { startRecording as startSimpleRecording } from "./simple";
import { readState, type RecordingState } from "./state";
import { stopLegacyRecording } from "./legacy-stop";

type CaptureController = Pick<
  RecordingController,
  "inspect" | "health" | "recover" | "stop" | "acknowledge"
>;

export type CaptureApplicationDependencies = {
  sessionStore?: Pick<RecordingSessionStore, "read">;
  readLegacyState?: () => Promise<RecordingState | null>;
  createController?: (
    config: AppConfig,
    owner: RecordingSession["owner"]
  ) => CaptureController;
  timeEntries?: Pick<
    TimeEntryStore,
    "startRecording" | "finishRecording" | "finishCall"
  >;
  enqueueRecording?: typeof enqueueRecording;
  inspectAudioSources?: typeof inspectAudioSources;
  readAutomationState?: () => Promise<AutomationState>;
  startRecording?: typeof startSimpleRecording;
  stopLegacy?: typeof stopLegacyRecording;
  now?: () => string;
};

export type CaptureStatus = {
  session: RecordingSession | null;
  active: boolean;
  warning?: string;
  audio: {
    configured: Pick<
      AppConfig["capture"],
      "audioSource" | "microphone" | "desktop"
    >;
    selected?: AudioSources;
    error?: string;
  };
  paused?: boolean;
  /** A capture started by an unmanaged legacy backend; the Studio can stop it but not inspect its audio. */
  legacy?: { backend: string; startedAt: string; outputPath: string };
};

export type StopCaptureResult = {
  state: "idle" | "active" | "stopped";
  sourcePath?: string;
  session?: RecordingSession;
  job?: JobRecord | null;
};

const legacyCaptureError = (): Error =>
  new Error(
    "Há uma gravação legada em andamento. Pare-a antes de iniciar outra; o estado foi preservado."
  );

export const readCaptureStatus = async (
  config: AppConfig,
  dependencies: CaptureApplicationDependencies = {}
): Promise<CaptureStatus> => {
  const store = dependencies.sessionStore || new RecordingSessionStore();
  const managed = await store.read();
  let session = managed;
  let active = false;
  let warning: string | undefined;
  let selected: AudioSources | undefined;
  let audioError: string | undefined;

  if (managed) {
    const controller = (dependencies.createController ||
      ((currentConfig, owner) => new RecordingController(currentConfig, owner)))(
      config,
      managed.owner
    );
    try {
      const inspection = await controller.inspect();
      session = inspection.session || managed;
      active = inspection.active;
      if (active) {
        const health = await controller.health();
        active = health.active;
        warning = health.warning;
        selected = session.audio;
      }
    } catch {
      warning = "Não foi possível confirmar o estado da captura. O estado persistido foi preservado.";
    }
  }
  const legacyState = managed ? null : await (dependencies.readLegacyState || readState)();
  if (legacyState) {
    // The legacy backends keep their own state; report it as active so Stop stays available.
    return {
      session: null,
      active: true,
      warning: `Captura iniciada por um backend legado (${legacyState.backend}). O Studio pode pará-la, mas não acompanha o áudio dela.`,
      audio: { configured: { audioSource: config.capture.audioSource, microphone: config.capture.microphone, desktop: config.capture.desktop }, selected: {} },
      legacy: { backend: String(legacyState.backend), startedAt: legacyState.startedAt, outputPath: legacyState.outputPath },
      ...(await (dependencies.readAutomationState || readAutomationState)().then((state) => ({ paused: state.paused }), () => ({})))
    };
  }

  const audioConfig = active ? (session?.audio ? capturedAudioConfig(config.capture, session.audio) : undefined) : config.capture;
  if (active && !audioConfig) audioError = "As origens capturadas desta sessão estão indisponíveis; os defaults atuais não validam esta captura.";
  if (audioConfig && audioConfig.audioSource !== "none" && (!active || !warning)) {
    try {
      const inspection = await (dependencies.inspectAudioSources || inspectAudioSources)(
        audioConfig
      );
      if (!active) selected = inspection.selected;
      const sourceWarning = (inspection.warnings || [])
        .map((value) => value.replace(/[\r\n\0]+/g, " ").slice(0, 300))
        .filter(Boolean)
        .join(" ");
      if (sourceWarning) {
        warning = warning ? `${warning} ${sourceWarning}` : sourceWarning;
      }
    } catch {
      audioError = "Não foi possível validar as fontes de áudio configuradas.";
    }
  } else if (!active) {
    selected = {};
  }
  if (!active) {
    if (managed && !warning) {
      warning = "A captura terminou; finalize a gravação para preservar e processar o arquivo.";
    }
  }

  let paused: boolean | undefined;
  try {
    paused = (await (dependencies.readAutomationState || readAutomationState)()).paused;
  } catch {
    warning ||= "Não foi possível ler o estado da captura automática.";
  }

  return {
    session,
    active,
    ...(warning ? { warning } : {}),
    audio: {
      configured: {
        audioSource: config.capture.audioSource,
        microphone: config.capture.microphone,
        desktop: config.capture.desktop
      },
      ...(selected ? { selected } : {}),
      ...(audioError ? { error: audioError } : {})
    },
    ...(paused !== undefined ? { paused } : {})
  };
};

export const startCapture = async (
  config: AppConfig,
  options: { title?: string } = {},
  dependencies: CaptureApplicationDependencies = {}
): Promise<CaptureStatus> => {
  const store = dependencies.sessionStore || new RecordingSessionStore();
  if (await store.read()) {
    throw new Error("Já existe uma captura gerenciada. Finalize-a antes de iniciar outra.");
  }
  if (await (dependencies.readLegacyState || readState)()) {
    throw legacyCaptureError();
  }

  let outputPath: string;
  try {
    outputPath = (
      await (dependencies.startRecording || startSimpleRecording)(config, {
        title: options.title
      })
    ).outputPath;
  } catch (error) {
    throw new Error(
      "Não foi possível iniciar a captura. Verifique o backend e as fontes de áudio configuradas.",
      { cause: error }
    );
  }

  let timesheetWarning: string | undefined;
  if (config.timesheet.enabled) {
    const recordingState = await (dependencies.readLegacyState || readState)();
    await (dependencies.timeEntries || new TimeEntryStore())
      .startRecording(
        outputPath,
        recordingState?.startedAt || (dependencies.now || (() => new Date().toISOString()))()
      )
      .catch(() => {
        timesheetWarning = "A gravação começou, mas o apontamento de horas não foi iniciado.";
      });
  }

  const status = await readCaptureStatus(config, dependencies);
  if (timesheetWarning) {
    status.warning = status.warning
      ? `${status.warning} ${timesheetWarning}`
      : timesheetWarning;
  }
  return status;
};

export const stopCapture = async (
  config: AppConfig,
  options: { recoverOnly?: boolean } = {},
  dependencies: CaptureApplicationDependencies = {}
): Promise<StopCaptureResult> => {
  const store = dependencies.sessionStore || new RecordingSessionStore();
  const managed = await store.read();
  if (!managed) {
    if (await (dependencies.readLegacyState || readState)()) {
      const legacy = await (dependencies.stopLegacy || stopLegacyRecording)(config);
      if (legacy) return { state: "stopped", sourcePath: legacy.videoPath, ...(legacy.job ? { job: legacy.job } : {}) };
    }
    return { state: "idle" };
  }

  const controller = (dependencies.createController ||
    ((currentConfig, owner) => new RecordingController(currentConfig, owner)))(
    config,
    managed.owner
  );
  try {
    const recovered = await controller.recover();
    if (!recovered || recovered.id !== managed.id) {
      throw new Error("Recording session changed");
    }
    if (options.recoverOnly && recovered.phase !== "stopped") {
      return {
        state: "active",
        sourcePath: recovered.outputPath,
        session: recovered
      };
    }
    const stopped = await controller.stop(managed.id, managed.endedAt);
    if (!stopped) throw new Error("Recording session changed");
    if (config.timesheet.enabled) {
      const times = dependencies.timeEntries || new TimeEntryStore();
      if (stopped.owner === "call") {
        await times.finishCall(stopped.id, stopped.endedAt!, stopped.outputPath);
      } else {
        await times.finishRecording(
          managed.outputPath,
          stopped.endedAt!,
          stopped.outputPath
        );
      }
    }
    const job = await (dependencies.enqueueRecording || enqueueRecording)(
      config,
      stopped.outputPath,
      {
        recordingId: stopped.id,
        startedAt: stopped.startedAt,
        endedAt: stopped.endedAt,
        app: stopped.app
      }
    );
    await controller.acknowledge(stopped.id);
    return {
      state: "stopped",
      sourcePath: stopped.outputPath,
      session: stopped,
      ...(job ? { job } : {})
    };
  } catch (error) {
    throw new Error(
      "Não foi possível finalizar a gravação. O estado foi preservado para nova tentativa.",
      { cause: error }
    );
  }
};
