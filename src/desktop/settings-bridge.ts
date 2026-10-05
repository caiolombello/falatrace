import { loadConfig } from "../config/load";
import { getConfigPath } from "../config/load";
import { readCredentialStatus, readSettings, saveSettings } from "../config/settings";
import { checkProcessing, listAudioDevices, readServiceStatus } from "../config/setup-checks";
import { diagnoseRecordingBackend } from "../recording/capabilities";
import { readCaptureStatus } from "../recording/application";
import { acquireSingleton } from "../runtime/singleton";
import { installCallMonitorService, uninstallCallMonitorService } from "../calls/service";
import { installTrayService } from "../tray/service";

export const SETTINGS_OPERATIONS = ["settings-read", "settings-save", "settings-diagnose", "settings-service"] as const;
export type SettingsOperation = typeof SETTINGS_OPERATIONS[number];
export const SERVICE_ACTIONS = ["calls-apply", "calls-disable", "tray-apply"] as const;
export type ServiceAction = typeof SERVICE_ACTIONS[number];

export type SettingsDeps = {
  read: typeof readSettings;
  save: typeof saveSettings;
  loadConfig: typeof loadConfig;
  configPath: () => string;
  credentials: typeof readCredentialStatus;
  checks: typeof checkProcessing;
  audioDevices: typeof listAudioDevices;
  services: typeof readServiceStatus;
  recording: typeof diagnoseRecordingBackend;
  captureActive: () => Promise<boolean>;
  lock: (name: string) => Promise<{ release: () => Promise<void> }>;
  applyCalls: typeof installCallMonitorService;
  disableCalls: typeof uninstallCallMonitorService;
  applyTray: typeof installTrayService;
};

export const defaultSettingsDeps: SettingsDeps = {
  read: readSettings,
  save: saveSettings,
  loadConfig,
  configPath: getConfigPath,
  credentials: readCredentialStatus,
  checks: checkProcessing,
  audioDevices: listAudioDevices,
  services: readServiceStatus,
  recording: diagnoseRecordingBackend,
  captureActive: async () => (await readCaptureStatus((await loadConfig()).config)).active,
  lock: acquireSingleton,
  applyCalls: installCallMonitorService,
  disableCalls: uninstallCallMonitorService,
  applyTray: installTrayService
};

export const settingsErrorMessage = (op: string): string =>
  op === "settings-read" ? "Não foi possível ler a configuração. Confira se o arquivo é válido e está em um local seguro."
    : op === "settings-save" ? "Não foi possível confirmar o salvamento. Releia as configurações; o arquivo pode ter mudado, ser inválido ou a combinação escolhida não é aceita."
      : op === "settings-diagnose" ? "Não foi possível concluir o diagnóstico. Nenhuma configuração foi alterada."
        : "Não foi possível alterar o serviço. Confira se há uma gravação em andamento e o estado do systemd.";

/** Errors whose text is safe and useful to show verbatim. */
export const SETTINGS_KNOWN_ERRORS = [
  "Não altere os serviços durante uma gravação ativa.",
  "Ative a gravação automática e salve antes de aplicar o monitor.",
  "Configuração mudou; reabra antes de salvar.",
  "Nenhuma alteração para salvar."
];

export const handleSettingsOperation = async (
  op: SettingsOperation,
  payload: Record<string, unknown>,
  deps: SettingsDeps = defaultSettingsDeps
): Promise<unknown> => {
  if (op === "settings-read") return deps.read();
  if (op === "settings-save") return deps.save(String(payload.revision || ""), payload.changes);
  if (op === "settings-diagnose") {
    const { config } = await deps.loadConfig();
    const credentials = await deps.credentials(config);
    const [checks, audio, services, recording] = await Promise.all([
      deps.checks(config, credentials),
      deps.audioDevices().catch(() => null),
      deps.services(config, deps.configPath()),
      deps.recording(config).then(
        (result) => ({ selectedBackend: result.selectedBackend ?? null, blockedReason: result.blockedReason ?? null, warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 20) : [], session: result.session ?? null }),
        () => ({ selectedBackend: null, blockedReason: "Não foi possível inspecionar o backend de gravação.", warnings: [], session: null })
      )
    ]);
    return { checks, audio, services, recording, credentials };
  }
  const action = payload.action as ServiceAction;
  if (!SERVICE_ACTIONS.includes(action)) throw new Error("Ação de serviço inválida.");
  // Same lock used by capture start/stop and audio changes: no service restart mid-capture.
  const lease = await deps.lock("capture-control");
  try {
    if (await deps.captureActive()) throw new Error("Não altere os serviços durante uma gravação ativa.");
    const { config } = await deps.loadConfig();
    if (action === "calls-apply") {
      if (!config.callDetection.enabled) throw new Error("Ative a gravação automática e salve antes de aplicar o monitor.");
      await deps.applyCalls(config);
    } else if (action === "calls-disable") {
      await deps.disableCalls();
    } else {
      await deps.applyTray();
    }
    return { action, services: await deps.services(config, deps.configPath()) };
  } finally {
    await lease.release();
  }
};
