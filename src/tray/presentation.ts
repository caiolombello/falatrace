import type { CallMonitorStatus } from "../calls/status";
import type { RecordingSession } from "../recording/session";
import type { TimeEntryCounts } from "../timesheet/store";

export type TrayPresentation = {
  icon: string;
  label: string;
  title: string;
  description: string;
  menuText: string;
  restartMonitorEnabled: boolean;
  processingText: string;
  timesheetText: string;
  recordingText: string;
  durationStartedAt: string | null;
  durationEndedAt: string | null;
  screenText: string;
  audioText: string;
  automationText: string;
  actionText: string;
  toggleAutomationLabel: string;
  startRecordingEnabled: boolean;
  stopRecordingEnabled: boolean;
  toggleAutomationEnabled: boolean;
  actionsEnabled: boolean;
};

export type TrayActionFeedback = {
  kind: "busy" | "success" | "error";
  action: "open-tui" | "start-recording" | "stop-recording" | "pause-automation" | "resume-automation";
  text: string;
};

export type TrayContext = {
  automation: { paused?: boolean; error?: string };
  recording?: {
    session: RecordingSession;
    active: boolean;
    warning?: string;
  };
  recordingError?: string;
  action?: TrayActionFeedback;
};

/**
 * `disabled` is an intentional local choice: the call monitor is optional and
 * the tray should still be useful for the library and timesheet.
 */
export type CallMonitorState = "active" | "disabled" | "unhealthy";

export type TrayProcessingCounts = {
  pending: number;
  transferring: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
};

const emptyCounts: TimeEntryCounts = {
  capturing: 0,
  draft: 0,
  ready: 0,
  synced: 0
};

const emptyProcessingCounts: TrayProcessingCounts = {
  pending: 0,
  transferring: 0,
  queued: 0,
  processing: 0,
  completed: 0,
  failed: 0
};

const timesheetText = (counts: TimeEntryCounts): string => {
  if (counts.capturing > 0) return `Horas · ${counts.capturing} atividade(s) em andamento`;
  if (counts.draft > 0) {
    return `Horas · ${counts.draft} revisar · ${counts.ready} pronta(s)`;
  }
  if (counts.ready > 0) return `Horas · ${counts.ready} atividade(s) pronta(s)`;
  return "Horas · nenhuma atividade pendente";
};

const processingText = (counts: TrayProcessingCounts): string => {
  const active =
    counts.transferring + counts.queued + counts.processing;
  if (counts.failed > 0) {
    return `Processamento · ${counts.failed} falha(s) · ${active} em andamento`;
  }
  if (active > 0 || counts.pending > 0) {
    return `Processamento · ${active} em andamento · ${counts.pending} pendente(s)`;
  }
  return `Processamento · tudo em dia · ${counts.completed} concluído(s)`;
};

const appLabel = (status: CallMonitorStatus): string => {
  if (status.app === "slack") return "Slack";
  if (status.app === "zen") return "Zen";
  if (status.app === "helium") return "Helium";
  return "aplicativo desconhecido";
};

const recordingSourceText = (session: RecordingSession): Pick<
  TrayPresentation,
  "screenText" | "audioText"
> => {
  const sources = [
    session.audio?.microphone ? `microfone: ${session.audio.microphone}` : "",
    session.audio?.desktop ? `sistema: ${session.audio.desktop}` : ""
  ].filter(Boolean);
  return {
    screenText: session.backend === "gpu-screen-recorder"
      ? "Tela/janela selecionada no portal"
      : session.backend === "audio"
        ? "Tela · não capturada"
        : "Tela e áudio · conforme cena do OBS",
    audioText: sources.length
      ? `Áudio · ${sources.join(" · ")}`
      : session.backend === "obs"
        ? "Áudio · conforme cena do OBS"
        : "Áudio · nenhuma fonte registrada"
  };
};

const contextFields = (context: TrayContext): Pick<
  TrayPresentation,
  | "recordingText"
  | "durationStartedAt"
  | "durationEndedAt"
  | "screenText"
  | "audioText"
  | "automationText"
  | "actionText"
  | "toggleAutomationLabel"
  | "startRecordingEnabled"
  | "stopRecordingEnabled"
  | "toggleAutomationEnabled"
  | "actionsEnabled"
> => {
  const busy = context.action?.kind === "busy";
  const session = context.recording?.session;
  const paused = context.automation.paused;
  const sourceText = session
    ? recordingSourceText(session)
    : { screenText: "Tela · sem gravação", audioText: "Áudio · sem gravação" };
  return {
    recordingText: session
      ? `Gravação ${session.owner === "manual" ? "manual" : "automática"} · ${
        session.phase === "recording" ? "em andamento" : session.phase === "starting" ? "iniciando" : "parada"
      }`
      : "Gravação · parada",
    durationStartedAt: session?.startedAt || null,
    durationEndedAt: session?.endedAt || null,
    ...sourceText,
    automationText: context.automation.error
      ? `Captura automática · erro: ${context.automation.error}`
      : `Captura automática · ${paused ? "pausada" : "ativa"}`,
    actionText: context.action?.text || "",
    toggleAutomationLabel: paused ? "Retomar captura automática" : "Suspender captura automática",
    startRecordingEnabled: !busy && !session && !context.recordingError,
    stopRecordingEnabled: !busy && Boolean(session),
    toggleAutomationEnabled: !busy,
    actionsEnabled: !busy
  };
};

export const presentTrayStatus = (
  status: CallMonitorStatus | null,
  monitorState: CallMonitorState,
  counts: TimeEntryCounts = emptyCounts,
  processingCounts: TrayProcessingCounts = emptyProcessingCounts,
  context: TrayContext = { automation: { paused: false } }
): TrayPresentation => {
  const timeStatus = timesheetText(counts);
  const processingStatus = processingText(processingCounts);
  const fields = contextFields(context);
  const common = {
    restartMonitorEnabled: monitorState !== "disabled",
    processingText: processingStatus,
    timesheetText: timeStatus,
    ...fields
  };
  if (context.action?.kind === "error" || context.recordingError) {
    const message = context.action?.text || context.recordingError || "Não foi possível ler o estado da gravação";
    return {
      icon: "dialog-warning-symbolic",
      label: "!",
      title: "FalaTrace — ação requer atenção",
      description: message,
      menuText: message,
      ...common
    };
  }
  if (context.action?.kind === "busy" && context.action.action === "start-recording") {
    return {
      icon: "media-record-symbolic",
      label: "…",
      title: "FalaTrace — iniciando gravação",
      description: context.action.text,
      menuText: context.action.text,
      ...common
    };
  }
  if (context.recording) {
    const { session, warning } = context.recording;
    const owner = session.owner === "manual" ? "manual" : "automática";
    if (warning) {
      return {
        icon: "dialog-warning-symbolic", label: "!", title: "FalaTrace — verifique a gravação",
        description: warning, menuText: warning, ...common
      };
    }
    if (session.phase === "starting") {
      return {
        icon: "media-record-symbolic", label: "…", title: "FalaTrace — iniciando gravação",
        description: `Iniciando gravação ${owner}`, menuText: `Iniciando gravação ${owner}`, ...common
      };
    }
    if (session.phase === "stopped") {
      return {
        icon: "media-playback-stop-symbolic", label: "■", title: "FalaTrace — gravação parada",
        description: "Gravação parada aguardando finalização", menuText: "Gravação parada · aguardando finalização", ...common
      };
    }
    return {
      icon: "media-record-symbolic",
      label: "REC",
      title: `FalaTrace — gravando ${owner}`,
      description: `Gravação ${owner} em andamento`,
      menuText: `Gravando${session.backend === "audio" ? " áudio" : session.backend === "gpu-screen-recorder" ? " tela e áudio" : " no OBS"} · ${owner}`,
      ...common
    };
  }
  if (monitorState === "disabled") {
    return {
      icon: "media-playback-stop-symbolic",
      label: "",
      title: "FalaTrace — monitor de chamadas desativado",
      description: "Monitor de chamadas desativado intencionalmente",
      menuText: "Monitor de chamadas · desativado",
      ...common
    };
  }
  if (monitorState === "unhealthy") {
    return {
      icon: "dialog-warning-symbolic",
      label: "!",
      title: "FalaTrace — monitor parado",
      description: "Monitor de chamadas parado",
      menuText: "Monitor de chamadas parado",
      ...common
    };
  }
  if (!status) {
    return {
      icon: "dialog-warning-symbolic",
      label: "?",
      title: "FalaTrace — aguardando estado",
      description: "Aguardando estado do monitor",
      menuText: "Aguardando estado do monitor",
      ...common
    };
  }
  if (status.recordingWarning) {
    return {
      icon: "dialog-warning-symbolic", label: "!", title: "FalaTrace — verifique a gravação",
      description: status.recordingWarning, menuText: status.recordingWarning,
      ...common
    };
  }
  if (status.recordingOwned) {
    const application = appLabel(status);
    return {
      icon: "media-record-symbolic",
      label: "REC",
      title: `FalaTrace — gravando ${application}`,
      description: `Gravando chamada no ${application}`,
      menuText: `Gravando${status.recordingBackend === "audio" ? " áudio" : status.recordingBackend === "gpu-screen-recorder" ? " tela e áudio" : " no OBS"} · ${application}`,
      ...common
    };
  }

  const application = appLabel(status);
  switch (status.state) {
    case "CANDIDATE":
      return {
        icon: "audio-input-microphone-symbolic",
        label: "?",
        title: `FalaTrace — possível chamada no ${application}`,
        description: `Possível chamada no ${application}`,
        menuText: `Confirmando chamada · ${application}`,
        ...common
      };
    case "IN_CALL":
      return {
        icon: "call-start-symbolic",
        label: "CALL",
        title: `FalaTrace — em chamada no ${application}`,
        description: `Em chamada no ${application}`,
        menuText: `Em chamada · ${application}`,
        ...common
      };
    case "ENDING":
      return {
        icon: "call-stop-symbolic",
        label: "…",
        title: `FalaTrace — encerrando chamada no ${application}`,
        description: `Aguardando encerramento da chamada no ${application}`,
        menuText: `Aguardando fim da chamada · ${application}`,
        ...common
      };
    case "IDLE":
      return {
        icon: "audio-input-microphone-symbolic",
        label: "",
        title: "FalaTrace — monitorando",
        description: "Monitorando chamadas",
        menuText: "Monitorando · nenhuma chamada",
        ...common
      };
  }
};
