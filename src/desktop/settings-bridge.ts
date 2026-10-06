import { loadConfig } from "../config/load";
import { getConfigPath } from "../config/load";
import {
  exportSettings, listConfigBackups, previewSettings, readCredentialStatus, readImportFile, readSettings, restoreConfigBackup, saveSettings,
  validateSettingsPatch
} from "../config/settings";
import { checkAutomation, checkProcessing, listAudioDevices, readServiceStatus } from "../config/setup-checks";
import { getSecretFiles, parseManagerEnvironment, readSecretFiles, removeSecret, setSecret, unitEnvironment } from "../config/secrets";
import { defaultKeyTestDeps, testProviderKey, type KeyTestProvider } from "../config/credential-test";
import { automaticRecordingBackend, diagnoseRecordingBackend } from "../recording/capabilities";
import { translateCaptureMessage } from "../recording/messages";
import { captureHoldsDevices, readCaptureStatus } from "../recording/application";
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
  obsCheck: (config: Awaited<ReturnType<typeof loadConfig>>["config"], managerEnv: NodeJS.ProcessEnv) => Promise<boolean>;
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
  captureActive: async () => captureHoldsDevices(await readCaptureStatus((await loadConfig()).config)),
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
  // Tested with the password automatic recording gets: the call monitor's environment with calls.env.
  obsCheck: async (config, managerEnv) => {
    const env = unitEnvironment(managerEnv, await readSecretFiles(getSecretFiles()), "calls.env");
    return new ManualObsController({ ...config.obs, enabled: true }, undefined, undefined, undefined, env).isRecording();
  },
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
                      : op === "settings-model-cancel" ? "Não foi possível cancelar o download; ele pode continuar em segundo plano. Tente de novo."
                        : op.startsWith("settings-model") || op.startsWith("settings-ollama") ? "Não foi possível concluir o download. Nada foi instalado; tente novamente."
                          : "Não foi possível alterar o serviço. Confira se há uma gravação em andamento e o estado do systemd.";

const OBS_DURING_CAPTURE = "Não altere a conexão com o OBS durante uma gravação ativa.";
const TIMESHEET_DURING_CAPTURE = "Não ligue nem desligue o apontamento de horas durante uma gravação ativa.";
const OBS_PASSWORD_DURING_CAPTURE = "Não altere a senha do OBS durante uma gravação ativa.";

/**
 * Settings that stopping a capture reads again, with the refusal shown when a save would change them
 * mid-capture: the OBS connection it stops through, and whether it closes the time entry the start opened.
 */
const CAPTURE_BOUND_FIELDS = new Map([
  ["obs.enabled", OBS_DURING_CAPTURE], ["obs.host", OBS_DURING_CAPTURE], ["obs.port", OBS_DURING_CAPTURE],
  ["timesheet.enabled", TIMESHEET_DURING_CAPTURE]
]);

/** Run a change only while no capture runs, under the capture lock so that none starts during it. */
const outsideCapture = async <T>(deps: SettingsDeps, refusal: string, change: () => Promise<T>): Promise<T> => {
  const lease = await deps.lock("capture-control");
  try {
    if (await deps.captureActive()) throw new Error(refusal);
    return await change();
  } finally {
    await lease.release();
  }
};

export const OBS_PASSWORD_UNKNOWN = "Não foi possível ler o ambiente dos serviços do usuário, então não dá para saber qual senha o monitor de chamadas usa. Tente de novo.";

/** Prefix of the refusal to apply the monitor; the capture check's reason follows it. */
export const AUTOMATIC_CAPTURE_BLOCKED = "A gravação automática não funcionaria com esta configuração.";

/** Errors whose text is safe and useful to show verbatim. */
export const SETTINGS_KNOWN_ERRORS = [
  "Não altere os serviços durante uma gravação ativa.",
  "Não altere a conexão com o OBS durante uma gravação ativa.",
  "Não ligue nem desligue o apontamento de horas durante uma gravação ativa.",
  "Não altere a senha do OBS durante uma gravação ativa.",
  "Ative a gravação automática e salve antes de aplicar o monitor.",
  "Configuração mudou; reabra antes de salvar.",
  "Nenhuma alteração para salvar.",
  "Configure o worker remoto antes de escolher o processamento remoto.",
  "Configure o worker remoto antes de arquivar originais nele.",
  "Escolha ao menos um destino antes de ativar o arquivo de originais.",
  "Informe o bucket antes de ativar o envio para o S3.",
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
  "Escolha outro arquivo: a exportação não substitui a configuração do FalaTrace.",
  "O arquivo não contém uma configuração.",
  "Cópia de segurança inválida.",
  "Arquivo inválido ou grande demais.",
  "Confirme o download antes de começar.",
  "O download pelo Ollama só é feito para um Ollama neste computador.",
  "Modelo desconhecido.",
  "Nome de modelo do Ollama inválido.",
  "Não foi possível consultar os serviços do usuário. Tente de novo.",
  "A gravação automática não tem um backend que funcione: escolha Só áudio ou Tela e áudio em Captura e áudio, ou ative o OBS."
];

/** Messages from capture inspection and our own validation that are safe to show as they are. */
export const isDisplayableSettingsError = (op: string, text: string): boolean =>
  SETTINGS_KNOWN_ERRORS.includes(text) || /^(Campo não editável: |Valor inválido para )/.test(text) ||
  (op === "settings-audio-test" && (/^(Dispositivo de áudio indisponível|O microfone e o áudio do sistema|Gravar só áudio|Todas as fontes de áudio)/.test(text))) ||
  (op === "settings-secret-set" && /^secrets\.env /.test(text)) ||
  (op === "settings-service" && text.startsWith(`${AUTOMATIC_CAPTURE_BLOCKED} `));

const parseRemoteCheck = (output: string) => {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const host = lines.find((line) => line.startsWith("host="))?.slice(5).replace(/[^\w.-]/g, "").slice(0, 120) || null;
  const commands = lines.filter((line) => /^[a-z-]+=(ok|missing)$/.test(line)).map((line) => {
    const [name, state] = line.split("=");
    return { name, ok: state === "ok" };
  });
  const disk = lines.find((line) => line.startsWith("/") || /^\S+\s+\d/.test(line))?.replace(/\p{Cc}/gu, " ").slice(0, 200) || null;
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
    const save = async () => deps.save(String(payload.revision || ""), payload.changes, deps.configPath(), undefined, {
      initialize: payload.initialize === true,
      credentials: { managerEnv: await deps.managerEnv() }
    });
    // Stopping a capture reads some settings again: while one runs, those stay as it started.
    const changes = payload.changes && typeof payload.changes === "object" ? Object.keys(payload.changes) : [];
    const bound = changes.find((field) => CAPTURE_BOUND_FIELDS.has(field));
    return bound ? outsideCapture(deps, CAPTURE_BOUND_FIELDS.get(bound)!, save) : save();
  }
  if (op === "settings-diagnose") {
    const { config: saved } = await deps.loadConfig();
    // Unsaved choices from the assistant are checked as they would be saved; nothing is written.
    const config = payload.changes === undefined ? saved : previewSettings(saved, payload.changes);
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
          session: result.session ?? null,
          capabilities: {
            gpuRecorder: !!(result.capture as { gpuRecorder?: boolean } | undefined)?.gpuRecorder,
            ffmpeg: !!(result.legacy as { ffmpeg?: boolean } | undefined)?.ffmpeg,
            obsLauncher: !!(result.obs as { launcher?: unknown } | undefined)?.launcher,
            sessionType: (result.session as { type?: string } | undefined)?.type ?? null
          }
        }),
        () => ({ selectedBackend: null, blockedReason: "Não foi possível inspecionar o backend de gravação.", warnings: [], session: null })
      )
    ]);
    const automatic = config.callDetection.enabled ? automaticRecordingBackend(config) : null;
    return { checks, automation: checkAutomation(config, services), audio, services, recording, automatic, credentials };
  }
  // The key file has changed once set or remove returns: a failed status refresh asks for a reread
  // instead of reporting the change as failed.
  const refreshedCredentials = async () => {
    try {
      return { credentials: await deps.credentials((await deps.loadConfig()).config, { managerEnv: await deps.managerEnv() }) };
    } catch {
      return { needsReload: true };
    }
  };
  // Stopping an OBS capture authenticates with its password again: while one runs, the password stays.
  const secretChange = <T>(change: () => Promise<T>): Promise<T> =>
    payload.name === "RECORDING_CLI_OBS_PASSWORD" ? outsideCapture(deps, OBS_PASSWORD_DURING_CAPTURE, change) : change();
  if (op === "settings-secret-set") {
    await secretChange(() => deps.setSecret(payload.name, payload.value));
    return { name: payload.name, saved: true, ...(await refreshedCredentials()) };
  }
  if (op === "settings-secret-remove") {
    const result = await secretChange(() => deps.removeSecret(payload.name));
    return { name: payload.name, ...result, ...(await refreshedCredentials()) };
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
    // A password in the user manager's environment wins over secrets.env: without that environment the
    // password the call monitor uses is unknown, so nothing is tested rather than possibly the wrong one.
    const managerEnv = await deps.managerEnv().catch(() => null);
    if (!managerEnv) return { ok: false, unknown: true, detail: OBS_PASSWORD_UNKNOWN };
    try {
      const recording = await deps.obsCheck(config, managerEnv);
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
    // The backup is restored at this point: a failed reread asks for a reload, never reports a failure.
    try {
      return { ...result, settings: await deps.read(deps.configPath(), process.env, { managerEnv: await deps.managerEnv() }) };
    } catch {
      return { ...result, needsReload: true };
    }
  }
  if (op === "settings-export") return deps.exportTo(payload.path, deps.configPath());
  if (op === "settings-import-read") return deps.importRead(payload.path);
  if (op === "settings-audio-test") {
    // Same lock as capture start/stop: never measure while a recording owns the devices.
    const lease = await deps.lock("capture-control");
    try {
      if (await deps.captureActive()) throw new Error("Não teste o áudio durante uma gravação ativa.");
      const seconds = Number.isSafeInteger(payload.seconds) ? payload.seconds as number : 5;
      // The first-use assistant tests choices that are not saved yet; they pass the same rules as saving.
      const overrides: Record<string, unknown> = {};
      for (const field of ["audioSource", "microphone", "desktop"] as const) if (payload[field] !== undefined) overrides[`capture.${field}`] = payload[field];
      if (Object.keys(overrides).length) validateSettingsPatch(overrides);
      const { config } = await deps.loadConfig();
      const capture = { ...config.capture, ...Object.fromEntries(Object.entries(overrides).map(([field, value]) => [field.slice(8), value])) };
      return await deps.audioTest({ ...config, capture: capture as typeof config.capture }, seconds);
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
        // The same checks a capture start runs: a configuration that cannot record (no audio source,
        // missing tools) is refused here instead of failing at every detected call.
        const probe = await deps.recording({ ...config, backend: automatic });
        if (typeof probe.blockedReason === "string") throw new Error(`${AUTOMATIC_CAPTURE_BLOCKED} ${translateCaptureMessage(probe.blockedReason)}`);
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
    // The action has run: a status read that fails afterwards leaves the state unknown, not the action failed.
    return { action, services: await deps.services(config, deps.configPath()).catch(() => null) };
  } finally {
    await lease.release();
  }
};
