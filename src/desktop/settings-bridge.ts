import { loadConfig } from "../config/load";
import { getConfigPath } from "../config/load";
import {
  exportSettings, listConfigBackups, readCredentialStatus, readImportFile, readSettings, restoreConfigBackup, saveSettings
} from "../config/settings";
import { checkAutomation, checkProcessing, listAudioDevices, readServiceStatus } from "../config/setup-checks";
import { parseManagerEnvironment, removeSecret, setSecret } from "../config/secrets";
import { defaultKeyTestDeps, testProviderKey, type KeyTestProvider } from "../config/credential-test";
import { automaticRecordingBackend, diagnoseRecordingBackend } from "../recording/capabilities";
import { translateCaptureMessage } from "../recording/messages";
import { readCaptureStatus } from "../recording/application";
import { runAudioTest } from "../recording/audio-test";
import { ManualObsController } from "../recording/obs-recording";
import { acquireSingleton } from "../runtime/singleton";
import { runCommand } from "../jobs/command";
import { checkRemote } from "../jobs/remote";
import { installSyncTimer, uninstallSyncTimer } from "../jobs/service";
import { installArchiveTimer, uninstallArchiveTimer } from "../archive/service";
import { installProtonBackupTimer, uninstallProtonBackupTimer } from "../proton/service";
import { installCallMonitorService, uninstallCallMonitorService } from "../calls/service";
import { installTrayService, uninstallTrayService } from "../tray/service";
import {
  MODEL_OPERATIONS, handleModelOperation, defaultModelDeps, type ModelOperation
} from "./model-bridge";

export const SETTINGS_OPERATIONS = [
  "settings-read", "settings-save", "settings-diagnose", "settings-service",
  "settings-secret-set", "settings-secret-remove", "settings-secret-test",
  "settings-remote-check", "settings-obs-check", "settings-audio-test",
  "settings-backups", "settings-restore", "settings-export", "settings-import-read",
  ...MODEL_OPERATIONS
] as const;
export type SettingsOperation = typeof SETTINGS_OPERATIONS[number];
export const SERVICE_ACTIONS = [
  "calls-apply", "calls-disable", "tray-apply", "tray-disable",
  "sync-apply", "sync-disable", "archive-apply", "archive-disable", "backup-apply", "backup-disable"
] as const;
export type ServiceAction = typeof SERVICE_ACTIONS[number];

export type SettingsDeps = {
  read: typeof readSettings;
  save: typeof saveSettings;
  loadConfig: typeof loadConfig;
  configPath: () => string;
  credentials: typeof readCredentialStatus;
  managerEnv: () => Promise<NodeJS.ProcessEnv | null>;
  checks: typeof checkProcessing;
  audioDevices: typeof listAudioDevices;
  services: typeof readServiceStatus;
  recording: typeof diagnoseRecordingBackend;
  captureActive: () => Promise<boolean>;
  lock: (name: string) => Promise<{ release: () => Promise<void> }>;
  applyCalls: typeof installCallMonitorService;
  disableCalls: typeof uninstallCallMonitorService;
  applyTray: typeof installTrayService;
  disableTray: typeof uninstallTrayService;
  applySync: typeof installSyncTimer;
  disableSync: typeof uninstallSyncTimer;
  applyArchive: typeof installArchiveTimer;
  disableArchive: typeof uninstallArchiveTimer;
  applyBackup: typeof installProtonBackupTimer;
  disableBackup: typeof uninstallProtonBackupTimer;
  setSecret: typeof setSecret;
  removeSecret: typeof removeSecret;
  testKey: (provider: KeyTestProvider, configApiKey?: string) => ReturnType<typeof testProviderKey>;
  remoteCheck: typeof checkRemote;
  obsCheck: (config: Awaited<ReturnType<typeof loadConfig>>["config"]) => Promise<boolean>;
  audioTest: typeof runAudioTest;
  backups: typeof listConfigBackups;
  restore: typeof restoreConfigBackup;
  exportTo: typeof exportSettings;
  importRead: typeof readImportFile;
};

const readManagerEnv = async (): Promise<NodeJS.ProcessEnv | null> =>
  runCommand("systemctl", ["--user", "show-environment"], { timeoutMs: 5_000 })
    .then(({ stdout }) => parseManagerEnvironment(stdout), () => null);

export const defaultSettingsDeps: SettingsDeps = {
  read: readSettings,
  save: saveSettings,
  loadConfig,
  configPath: getConfigPath,
  credentials: readCredentialStatus,
  managerEnv: readManagerEnv,
  checks: checkProcessing,
  audioDevices: listAudioDevices,
  services: readServiceStatus,
  recording: diagnoseRecordingBackend,
  captureActive: async () => (await readCaptureStatus((await loadConfig()).config)).active,
  lock: acquireSingleton,
  applyCalls: installCallMonitorService,
  disableCalls: uninstallCallMonitorService,
  applyTray: installTrayService,
  disableTray: uninstallTrayService,
  applySync: installSyncTimer,
  disableSync: uninstallSyncTimer,
  applyArchive: installArchiveTimer,
  disableArchive: uninstallArchiveTimer,
  applyBackup: installProtonBackupTimer,
  disableBackup: uninstallProtonBackupTimer,
  setSecret,
  removeSecret,
  testKey: (provider, configApiKey) => testProviderKey(provider, defaultKeyTestDeps(readManagerEnv, configApiKey)),
  remoteCheck: checkRemote,
  obsCheck: (config) => new ManualObsController({ ...config.obs, enabled: true }).isRecording(),
  audioTest: runAudioTest,
  backups: listConfigBackups,
  restore: restoreConfigBackup,
  exportTo: exportSettings,
  importRead: readImportFile
};

export const settingsErrorMessage = (op: string): string =>
  op === "settings-read" ? "Não foi possível ler a configuração. Confira se o arquivo é válido e está em um local seguro."
    : op === "settings-save" ? "Não foi possível confirmar o salvamento. Releia as configurações; o arquivo pode ter mudado, ser inválido ou a combinação escolhida não é aceita."
      : op === "settings-diagnose" ? "Não foi possível concluir o diagnóstico. Nenhuma configuração foi alterada."
        : op.startsWith("settings-secret") ? "Não foi possível alterar a chave. Confira a permissão de secrets.env na pasta da configuração."
          : op === "settings-remote-check" ? "Não foi possível conectar ao worker remoto. Confira host, usuário, porta, chave SSH e se o host já é conhecido."
            : op === "settings-obs-check" ? "O OBS não respondeu. Abra o OBS e ative o servidor WebSocket em Ferramentas, nas configurações do servidor WebSocket."
              : op === "settings-audio-test" ? "Não foi possível testar o áudio. Confira as fontes escolhidas e se nenhuma gravação está em andamento."
                : op === "settings-backups" || op === "settings-restore" ? "Não foi possível restaurar a cópia escolhida. Nenhuma alteração foi feita."
                  : op === "settings-export" ? "Não foi possível exportar. Confira a pasta escolhida."
                    : op === "settings-import-read" ? "Não foi possível ler o arquivo escolhido. Use uma configuração JSON exportada pelo FalaTrace."
                      : op.startsWith("settings-model") || op.startsWith("settings-ollama") ? "Não foi possível concluir o download. Nada foi instalado; tente novamente."
                        : "Não foi possível alterar o serviço. Confira se há uma gravação em andamento e o estado do systemd.";

/** Errors whose text is safe and useful to show verbatim. */
export const SETTINGS_KNOWN_ERRORS = [
  "Não altere os serviços durante uma gravação ativa.",
  "Ative a gravação automática e salve antes de aplicar o monitor.",
  "Configuração mudou; reabra antes de salvar.",
  "Nenhuma alteração para salvar.",
  "Configure o worker remoto antes de escolher o processamento remoto.",
  "Configure o worker remoto antes de arquivar originais nele.",
  "Ative o arquivo de originais e escolha um destino antes de instalar o timer.",
  "Ative o backup no Proton Drive antes de instalar o timer.",
  "Chave não suportada.",
  "Valor inválido: use uma única linha, sem caracteres de controle.",
  "Não teste o áudio durante uma gravação ativa.",
  "Nenhuma fonte de áudio foi escolhida para gravar.",
  "Configure o worker remoto antes de testá-lo.",
  "Escolha um arquivo .json com caminho absoluto.",
  "A pasta de destino não existe.",
  "O destino não é um arquivo comum.",
  "O arquivo não contém uma configuração.",
  "Cópia de segurança inválida.",
  "Arquivo inválido ou grande demais.",
  "Confirme o download antes de começar.",
  "O download pelo Ollama só é feito para um Ollama neste computador.",
  "Modelo desconhecido.",
  "Nome de modelo do Ollama inválido.",
  "A gravação automática não tem um backend que funcione: escolha Só áudio ou Tela e áudio em Captura e áudio, ou ative o OBS."
];

/** Messages from capture inspection and our own validation that are safe to show as they are. */
export const isDisplayableSettingsError = (op: string, text: string): boolean =>
  SETTINGS_KNOWN_ERRORS.includes(text) || /^(Campo não editável: |Valor inválido para )/.test(text) ||
  (op === "settings-audio-test" && (/^(Dispositivo de áudio indisponível|O microfone e o áudio do sistema|Gravar só áudio|Todas as fontes de áudio)/.test(text))) ||
  (op === "settings-secret-set" && /^secrets\.env /.test(text));

const parseRemoteCheck = (output: string) => {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const host = lines.find((line) => line.startsWith("host="))?.slice(5).replace(/[^\w.-]/g, "").slice(0, 120) || null;
  const commands = lines.filter((line) => /^[a-z-]+=(ok|missing)$/.test(line)).map((line) => {
    const [name, state] = line.split("=");
    return { name, ok: state === "ok" };
  });
  const disk = lines.find((line) => line.startsWith("/") || /^\S+\s+\d/.test(line))?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) || null;
  return { host, commands, disk };
};

const remoteHint = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return "O host ainda não é conhecido ou mudou de chave. Conecte uma vez pelo terminal com ssh para conferir e aceitar a chave.";
  if (/Permission denied/i.test(text)) return "O servidor recusou a chave SSH. Confira o usuário e o arquivo de chave.";
  if (/Could not resolve hostname|Name or service not known/i.test(text)) return "O nome do host não foi encontrado. Confira o endereço.";
  if (/Connection refused|timed out|No route to host/i.test(text)) return "O host não aceitou a conexão. Confira a porta, a rede e se o SSH está ativo.";
  return "A conexão falhou. Confira host, usuário, porta e chave SSH.";
};

export const handleSettingsOperation = async (
  op: SettingsOperation,
  payload: Record<string, unknown>,
  deps: SettingsDeps = defaultSettingsDeps
): Promise<unknown> => {
  if ((MODEL_OPERATIONS as readonly string[]).includes(op)) {
    return handleModelOperation(op as ModelOperation, payload, defaultModelDeps);
  }
  if (op === "settings-read") return deps.read(deps.configPath(), process.env, { managerEnv: await deps.managerEnv() });
  if (op === "settings-save") {
    return deps.save(String(payload.revision || ""), payload.changes, deps.configPath(), undefined, {
      initialize: payload.initialize === true,
      credentials: { managerEnv: await deps.managerEnv() }
    });
  }
  if (op === "settings-diagnose") {
    const { config } = await deps.loadConfig();
    const credentials = await deps.credentials(config, { managerEnv: await deps.managerEnv() });
    const [checks, audio, services, recording] = await Promise.all([
      deps.checks(config, credentials),
      deps.audioDevices().catch(() => null),
      deps.services(config, deps.configPath()).catch(() => null),
      deps.recording(config).then(
        (result) => ({
          selectedBackend: result.selectedBackend ?? null,
          blockedReason: typeof result.blockedReason === "string" ? translateCaptureMessage(result.blockedReason) : null,
          warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 20).map((warning) => translateCaptureMessage(String(warning))) : [],
          session: result.session ?? null
        }),
        () => ({ selectedBackend: null, blockedReason: "Não foi possível inspecionar o backend de gravação.", warnings: [], session: null })
      )
    ]);
    const automatic = config.callDetection.enabled ? automaticRecordingBackend(config) : null;
    return { checks, automation: checkAutomation(config, services), audio, services, recording, automatic, credentials };
  }
  if (op === "settings-secret-set") {
    await deps.setSecret(payload.name, payload.value);
    return { name: payload.name, saved: true, credentials: await deps.credentials((await deps.loadConfig()).config, { managerEnv: await deps.managerEnv() }) };
  }
  if (op === "settings-secret-remove") {
    const result = await deps.removeSecret(payload.name);
    return { name: payload.name, ...result, credentials: await deps.credentials((await deps.loadConfig()).config, { managerEnv: await deps.managerEnv() }) };
  }
  if (op === "settings-secret-test") {
    const provider = payload.service === "gemini" ? "gemini" : payload.service === "openai" ? "openai" : null;
    if (!provider) throw new Error("Chave não suportada.");
    const { config } = await deps.loadConfig();
    return deps.testKey(provider, config.openai.apiKey);
  }
  if (op === "settings-remote-check") {
    const { config } = await deps.loadConfig();
    const { isPlaceholderRemoteHost } = await import("../config/settings");
    if (isPlaceholderRemoteHost(config.remote.host)) throw new Error("Configure o worker remoto antes de testá-lo.");
    try {
      return { ok: true, ...parseRemoteCheck(await deps.remoteCheck(config)) };
    } catch (error) {
      return { ok: false, hint: remoteHint(error) };
    }
  }
  if (op === "settings-obs-check") {
    const { config } = await deps.loadConfig();
    try {
      const recording = await deps.obsCheck(config);
      return { ok: true, recording, detail: recording ? "O OBS respondeu e está gravando agora." : "O OBS respondeu e não está gravando." };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: /loopback/.test(text) ? translateCaptureMessage("OBS recording is restricted to a loopback WebSocket host")
        : /auth|password|Authentication/i.test(text) ? "O OBS recusou a senha do WebSocket. Salve a senha certa em Chaves de API."
          : "O OBS não respondeu. Abra o OBS e ative o servidor WebSocket nas configurações do servidor WebSocket." };
    }
  }
  if (op === "settings-backups") return { backups: await deps.backups(deps.configPath()) };
  if (op === "settings-restore") {
    const result = await deps.restore(String(payload.revision || ""), payload.backup, deps.configPath());
    return { ...result, settings: await deps.read(deps.configPath(), process.env, { managerEnv: await deps.managerEnv() }) };
  }
  if (op === "settings-export") return deps.exportTo(payload.path, deps.configPath());
  if (op === "settings-import-read") return deps.importRead(payload.path);
  if (op === "settings-audio-test") {
    // Same lock as capture start/stop: never measure while a recording owns the devices.
    const lease = await deps.lock("capture-control");
    try {
      if (await deps.captureActive()) throw new Error("Não teste o áudio durante uma gravação ativa.");
      const seconds = Number.isSafeInteger(payload.seconds) ? payload.seconds as number : 5;
      return await deps.audioTest((await deps.loadConfig()).config, seconds);
    } finally {
      await lease.release();
    }
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
      if (config.callDetection.mode !== "notify-only") {
        const automatic = automaticRecordingBackend(config);
        if (!automatic || (automatic === "obs" && !config.obs.enabled)) {
          throw new Error("A gravação automática não tem um backend que funcione: escolha Só áudio ou Tela e áudio em Captura e áudio, ou ative o OBS.");
        }
      }
      await deps.applyCalls(config);
    } else if (action === "calls-disable") {
      await deps.disableCalls();
    } else if (action === "tray-apply") {
      await deps.applyTray();
    } else if (action === "tray-disable") {
      await deps.disableTray();
    } else if (action === "sync-apply") {
      await deps.applySync(config);
    } else if (action === "sync-disable") {
      await deps.disableSync();
    } else if (action === "archive-apply") {
      if (!config.archive.enabled || (!config.archive.vaio && !config.archive.proton)) throw new Error("Ative o arquivo de originais e escolha um destino antes de instalar o timer.");
      await deps.applyArchive(config);
    } else if (action === "archive-disable") {
      await deps.disableArchive();
    } else if (action === "backup-apply") {
      if (!config.proton.enabled) throw new Error("Ative o backup no Proton Drive antes de instalar o timer.");
      await deps.applyBackup(config);
    } else {
      await deps.disableBackup();
    }
    return { action, services: await deps.services(config, deps.configPath()) };
  } finally {
    await lease.release();
  }
};
