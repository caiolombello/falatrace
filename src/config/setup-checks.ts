import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./defaults";
import { runCommand } from "../jobs/command";
import { resolveExecutable } from "../recording/obsLauncher";
import { automaticRecordingBackend } from "../recording/capabilities";
import { buildCallMonitorUnit } from "../calls/service";
import { quoteSystemd, userUnitDir } from "../runtime/systemd-units";
import { isPlaceholderRemoteHost } from "./settings";
import type { CredentialReport, SecretFileName, SecretSource } from "./secrets";

/**
 * Read-only setup diagnostics for the Studio. Nothing here records, transcribes,
 * downloads models or contacts a non-loopback host; Ollama is queried only on loopback
 * and only for its installed model list.
 */
export type SetupCheckStatus = "ok" | "warning" | "missing" | "skipped";
/** `action` names the Studio control that fixes the problem; the UI decides how to show it. */
export type SetupCheck = { id: string; label: string; status: SetupCheckStatus; detail: string; action?: string };
export type CredentialStatus = {
  openai: SecretSource | string;
  gemini: SecretSource | string;
  details?: CredentialReport[];
  files?: Array<{ file: SecretFileName; tooOpen: boolean; usable: boolean; problem?: string; exists: boolean }>;
};

export type SetupProbe = {
  resolve: (name: string) => Promise<string | null>;
  isFile: (path: string) => Promise<boolean>;
  isExecutable: (path: string) => Promise<boolean>;
  ollamaModels: (baseUrl: string) => Promise<string[]>;
  run: typeof runCommand;
};

const isLoopbackUrl = (value: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};

const fetchOllamaModels = async (baseUrl: string): Promise<string[]> => {
  const response = await fetch(new URL("/api/tags", baseUrl), { redirect: "error", signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<{ name?: unknown }> };
  return (body.models || []).map((model) => model.name).filter((name): name is string => typeof name === "string").slice(0, 500);
};

export const defaultSetupProbe: SetupProbe = {
  resolve: (name) => resolveExecutable(name),
  isFile: (path) => fs.stat(path).then((stat) => stat.isFile(), () => false),
  isExecutable: (path) => fs.access(path, constants.X_OK).then(() => true, () => false),
  ollamaModels: fetchOllamaModels,
  run: runCommand
};

export const credentialLabel = (source: string): string =>
  source === "secrets.env" ? "salva pelo Studio"
    : source === "worker.env" ? "definida em worker.env"
      : source === "calls.env" ? "definida em calls.env"
        : source === "environment" ? "definida no ambiente do systemd do usuário"
          : source === "config" ? "definida no config.json, formato antigo"
            : "não encontrada";

const keyCheck = (
  id: string,
  label: string,
  name: "OPENAI_API_KEY" | "GEMINI_API_KEY",
  credentials: CredentialStatus,
  missingDetail: string,
  okDetail: string
): SetupCheck => {
  const source = name === "OPENAI_API_KEY" ? credentials.openai : credentials.gemini;
  const report = credentials.details?.find((detail) => detail.name === name);
  if (source === "missing") {
    return { id, label, status: "missing", action: "keys", detail: report?.sessionOnly
      ? `${name} existe só no ambiente desta sessão do Studio; o processamento em segundo plano não a recebe. Salve a chave em Chaves de API.`
      : missingDetail };
  }
  const notes: string[] = [];
  if (credentials.files?.find((file) => file.file === source)?.tooOpen) notes.push(`${source} pode ser lido por outros usuários: ajuste a permissão para 600.`);
  if (report?.shadowsStudioKey) notes.push(`Uma chave ${credentialLabel(source)} tem prioridade sobre a salva pelo Studio.`);
  if (source === "config") notes.push("Salve a chave pelo Studio para tirá-la do config.json.");
  return { id, label, status: notes.length ? "warning" : "ok", detail: [`Chave ${credentialLabel(source)}. ${okDetail}`, ...notes].join(" "), ...(notes.length ? { action: "keys" } : {}) };
};

/** The worker processes remote jobs with its own configuration, keys and Ollama. */
const REMOTE_PROVIDER_DETAIL = "Roda no worker remoto, com a configuração, as chaves e os modelos de lá; não verificado neste computador. Use Testar conexão em Integrações.";

export const checkProcessing = async (
  config: AppConfig,
  credentials: CredentialStatus,
  probe: SetupProbe = defaultSetupProbe
): Promise<SetupCheck[]> => {
  const checks: SetupCheck[] = [];
  const ffmpeg = await probe.resolve("ffmpeg");
  checks.push({ id: "ffmpeg", label: "FFmpeg", status: ffmpeg ? "ok" : "missing",
    detail: ffmpeg ? "Encontrado." : "Necessário para gravar só áudio e para extrair o áudio antes da transcrição. Instale pelo gerenciador de pacotes." });

  const remote = config.processing.defaultTarget === "remote";
  const transcription = config.transcription.provider;
  if (transcription === "whisper-cpp") {
    if (remote) {
      checks.push({ id: "whisper", label: "Whisper.cpp", status: "skipped", detail: "A transcrição roda no worker remoto configurado; não verificado neste computador." });
    } else {
      const command = config.transcription.whisperCpp.command;
      const found = command.includes("/") ? (await probe.isExecutable(command) ? command : null) : await probe.resolve(command);
      checks.push({ id: "whisper", label: "Whisper.cpp", status: found ? "ok" : "missing",
        detail: found
          ? `Comando ${command} encontrado.`
          : `Comando ${command} não encontrado. Instale o whisper.cpp ou informe o caminho do executável.` });
      const model = await probe.isFile(config.transcription.whisperCpp.modelPath);
      checks.push({ id: "whisper-model", label: "Modelo do Whisper", status: model ? "ok" : "missing",
        ...(model ? {} : { action: "whisper-model" }),
        detail: model ? "Arquivo do modelo encontrado." : "Arquivo do modelo não encontrado no caminho configurado. Baixe um modelo pelo Studio ou informe o caminho de um arquivo ggml." });
    }
  } else if (remote) {
    checks.push({ id: "transcription-key", label: "Transcrição", status: "skipped", detail: REMOTE_PROVIDER_DETAIL });
  } else {
    const variable = transcription === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    const provider = transcription === "openai" ? "a OpenAI" : "o Gemini";
    checks.push(keyCheck("transcription-key", `Transcrição · ${variable}`, variable, credentials,
      `A transcrição usa ${provider}, mas ${variable} não foi encontrada. Salve a chave em Chaves de API.`,
      "O áudio é enviado para um serviço externo."));
  }

  if (remote) {
    checks.push({ id: config.summary.provider === "ollama" ? "ollama" : "summary-key", label: "Resumo", status: "skipped", detail: REMOTE_PROVIDER_DETAIL });
  } else if (config.summary.provider === "ollama") {
    if (!isLoopbackUrl(config.summary.ollamaUrl)) {
      checks.push({ id: "ollama", label: "Ollama", status: "skipped", detail: "Endereço fora deste computador; não contatado pelo diagnóstico." });
    } else {
      const models = await probe.ollamaModels(config.summary.ollamaUrl).catch(() => null);
      const model = config.summary.ollamaModel;
      checks.push(models === null
        ? { id: "ollama", label: "Ollama", status: "missing", detail: "Ollama não respondeu neste computador. Instale e inicie o Ollama." }
        : models.includes(model) || models.includes(`${model}:latest`)
          ? { id: "ollama", label: "Ollama", status: "ok", detail: `Modelo ${model} instalado.` }
          : { id: "ollama", label: "Ollama", status: "warning", action: "ollama-model", detail: `Ollama respondeu, mas o modelo ${model} não está instalado. Baixe pelo Studio ou rode: ollama pull ${model}` });
    }
  } else {
    checks.push(keyCheck("summary-key", "Resumo · OPENAI_API_KEY", "OPENAI_API_KEY", credentials,
      "O resumo usa a OpenAI, mas OPENAI_API_KEY não foi encontrada. Salve a chave em Chaves de API.",
      "A transcrição é enviada para um serviço externo para resumir."));
  }
  return checks;
};

export type AudioDevice = { name: string; description: string; monitor: boolean };

export const listAudioDevices = async (run: typeof runCommand = runCommand) => {
  const [sources, source, sink] = await Promise.all([
    run("pactl", ["--format=json", "list", "sources"], { timeoutMs: 5_000 }),
    run("pactl", ["get-default-source"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" })),
    run("pactl", ["get-default-sink"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }))
  ]);
  const parsed = JSON.parse(sources.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("pactl retornou fontes de áudio inválidas");
  const devices: AudioDevice[] = parsed.flatMap((value) => {
    const item = value as { name?: unknown; description?: unknown };
    if (typeof item.name !== "string" || !/^[A-Za-z0-9_.:@+-]{1,300}$/.test(item.name)) return [];
    const description = typeof item.description === "string" ? item.description.replace(/\p{Cc}/gu, " ").slice(0, 200) : item.name;
    return [{ name: item.name, description, monitor: item.name.endsWith(".monitor") }];
  }).slice(0, 100);
  const defaultSink = sink.stdout.trim();
  return { devices, defaultMicrophone: source.stdout.trim() || null, defaultDesktop: defaultSink ? `${defaultSink}.monitor` : null };
};

/** `outdated`: the unit's writable paths do not match the configured recordings folder.
 * `staleConfig`: the configuration file changed after the service started, so the running
 * monitor still uses the previous settings until it is restarted. */
export type ServiceStatus = { installed: boolean; enabled: boolean; active: boolean; outdated: boolean; staleConfig: boolean };
/** Periodic jobs read the configuration on every run; only values baked into the unit can drift. */
export type TimerStatus = { installed: boolean; enabled: boolean; active: boolean; outdated: boolean; nextRunAt: string | null; lastResult: string | null };

export const TIMER_UNITS = {
  sync: "recording-cli-sync",
  archive: "recording-cli-archive",
  backup: "recording-cli-proton-backup"
} as const;
export type TimerName = keyof typeof TIMER_UNITS;

const unitState = async (run: typeof runCommand, verb: "is-enabled" | "is-active", unit: string): Promise<boolean> =>
  run("systemctl", ["--user", verb, unit], { timeoutMs: 5_000 }).then(({ stdout }) => ["enabled", "active"].includes(stdout.trim()), () => false);

const showUnix = async (run: typeof runCommand, unit: string, property: string): Promise<number | null> =>
  run("systemctl", ["--user", "show", unit, "-p", property, "--value", "--timestamp=unix"], { timeoutMs: 5_000 })
    .then(({ stdout }) => { const match = stdout.trim().match(/^@(\d+)$/); return match ? Number(match[1]) * 1000 : null; }, () => null);

/**
 * A timestamp to the millisecond. `--timestamp=unix` stops at whole seconds, so a monitor
 * restarted in the same second as a save would look older than the configuration it loaded.
 */
const showMillis = async (run: typeof runCommand, unit: string, property: string): Promise<number | null> =>
  run("systemctl", ["--user", "show", unit, "-p", property, "--value", "--timestamp=us+utc"], { timeoutMs: 5_000 })
    .then(({ stdout }) => {
      const match = stdout.trim().match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\d{3} UTC$/);
      return match ? Date.parse(`${match[1]}T${match[2]}.${match[3]}Z`) : null;
    }, () => null);

const showValue = async (run: typeof runCommand, unit: string, property: string): Promise<string | null> =>
  run("systemctl", ["--user", "show", unit, "-p", property, "--value"], { timeoutMs: 5_000 })
    .then(({ stdout }) => stdout.trim().slice(0, 80) || null, () => null);

const readTimer = async (
  name: TimerName,
  config: AppConfig,
  run: typeof runCommand,
  unitDir: string
): Promise<TimerStatus> => {
  const base = TIMER_UNITS[name];
  const [service, timer] = await Promise.all([
    fs.readFile(join(unitDir, `${base}.service`), "utf8").catch(() => null),
    fs.readFile(join(unitDir, `${base}.timer`), "utf8").catch(() => null)
  ]);
  if (service === null || timer === null) {
    return { installed: false, enabled: false, active: false, outdated: false, nextRunAt: null, lastResult: null };
  }
  const [enabled, active, nextRun, lastResult] = await Promise.all([
    unitState(run, "is-enabled", `${base}.timer`),
    unitState(run, "is-active", `${base}.timer`),
    showUnix(run, `${base}.timer`, "NextElapseUSecRealtime"),
    showValue(run, `${base}.service`, "Result")
  ]);
  // Only the values written into the unit can drift: the interval and, for job sync, the recordings
  // folder. The sync and Proton backup timers both use the processing interval.
  const interval = name === "archive" ? config.archive.syncIntervalMinutes : config.processing.syncIntervalMinutes;
  const intervalOutdated = !new RegExp(`^On(?:UnitActive|UnitInactive)Sec=${interval}min$`, "m").test(timer);
  const pathOutdated = name === "sync" && !service.includes(quoteSystemd(config.recordingsDir));
  return {
    installed: true, enabled, active, outdated: intervalOutdated || pathOutdated,
    nextRunAt: nextRun ? new Date(nextRun).toISOString() : null, lastResult
  };
};

export const readServiceStatus = async (
  config: AppConfig,
  configPath: string,
  run: typeof runCommand = runCommand,
  unitDir?: string
): Promise<{ calls: ServiceStatus; tray: ServiceStatus; sync: TimerStatus; archive: TimerStatus; backup: TimerStatus }> => {
  const directory = unitDir ?? await userUnitDir(run);
  const read = (name: string) => fs.readFile(join(directory, name), "utf8").catch(() => null);
  const [callsUnit, trayUnit] = await Promise.all([read("recording-cli-calls.service"), read("recording-cli-tray.service")]);
  const [callsEnabled, callsActive, trayEnabled, trayActive] = await Promise.all([
    unitState(run, "is-enabled", "recording-cli-calls.service"), unitState(run, "is-active", "recording-cli-calls.service"),
    unitState(run, "is-enabled", "recording-cli-tray.service"), unitState(run, "is-active", "recording-cli-tray.service")
  ]);
  // Only the parts the Studio controls are compared: the launch target is allowed to differ.
  const expectedPaths = buildCallMonitorUnit(config, ["X"]).split("\n").find((line) => line.startsWith("ReadWritePaths="));
  const callsOutdated = callsUnit !== null && !!expectedPaths && !callsUnit.includes(expectedPaths);
  const configChangedAt = await fs.stat(configPath).then((stat) => stat.mtimeMs, () => null);
  const callsStartedAt = callsActive ? await showMillis(run, "recording-cli-calls.service", "ActiveEnterTimestamp") : null;
  const staleConfig = callsStartedAt !== null && configChangedAt !== null && Math.floor(configChangedAt) > callsStartedAt;
  const [sync, archive, backup] = await Promise.all((["sync", "archive", "backup"] as const).map((name) => readTimer(name, config, run, directory)));
  return {
    calls: { installed: callsUnit !== null, enabled: callsEnabled, active: callsActive, outdated: callsOutdated, staleConfig },
    tray: { installed: trayUnit !== null, enabled: trayEnabled, active: trayActive, outdated: false, staleConfig: false },
    sync, archive, backup
  };
};

/**
 * Checks that combine settings with service state: what will really happen after a call,
 * whether new recordings will be processed and whether enabled copies have a timer.
 */
export const checkAutomation = (
  config: AppConfig,
  services: Awaited<ReturnType<typeof readServiceStatus>> | null
): SetupCheck[] => {
  const checks: SetupCheck[] = [];
  if (config.callDetection.enabled && config.callDetection.mode !== "notify-only") {
    const automatic = automaticRecordingBackend(config);
    if (!automatic) {
      checks.push({ id: "automatic-backend", label: "Gravação automática", status: "missing", action: "capture",
        detail: `O backend “${config.backend}” não grava automaticamente. Escolha Só áudio, Tela e áudio ou OBS em Captura e áudio.` });
    } else if (automatic === "obs" && !config.obs.enabled) {
      checks.push({ id: "automatic-backend", label: "Gravação automática", status: "missing", action: "capture",
        detail: config.callDetection.mode === "obs"
          ? "O modo “Controlar o OBS” exige o OBS ativado em Integrações."
          : `Com o backend “${config.backend}”, a gravação automática usa o OBS, que está desativado. Escolha Só áudio ou Tela e áudio em Captura e áudio, ou ative o OBS.` });
    } else {
      const label = automatic === "audio" ? "só áudio" : automatic === "gpu-screen-recorder" ? "tela e áudio pelo GPU Screen Recorder" : "o OBS";
      // Detection runs in the call monitor: while it is not running, nothing records on its own,
      // and while its state cannot be read nothing is promised.
      const calls = services?.calls;
      checks.push(!calls
        ? { id: "automatic-backend", label: "Gravação automática", status: "skipped",
          detail: "Estado do monitor de chamadas indisponível; não dá para confirmar que as chamadas serão gravadas." }
        : !(calls.installed && calls.enabled && calls.active)
          ? { id: "automatic-backend", label: "Gravação automática", status: "warning", action: "calls-apply",
            detail: "O monitor de chamadas não está rodando: nada será gravado automaticamente. Aplique o monitor em Serviços." }
          : { id: "automatic-backend", label: "Gravação automática", status: "ok", detail: `As chamadas detectadas serão gravadas com ${label}.` });
    }
  }
  if (config.processing.defaultTarget === "remote" && isPlaceholderRemoteHost(config.remote.host)) {
    checks.push({ id: "remote-worker", label: "Worker remoto", status: "missing", action: "remote",
      detail: "O processamento está marcado como remoto, mas nenhum worker foi configurado. Configure-o em Integrações ou volte para “Neste computador”." });
  }
  if (config.processing.autoEnqueue) {
    const timer = services?.sync;
    checks.push(!timer
      ? { id: "processing-timer", label: "Processamento automático", status: "skipped", detail: "Estado do timer de processamento indisponível." }
      : !timer.installed || !timer.enabled || !timer.active
        ? { id: "processing-timer", label: "Processamento automático", status: "warning", action: "sync-apply",
          detail: "Gravações novas entram na fila, mas ficam pendentes até você processá-las: ative o processamento em segundo plano em Serviços." }
        : { id: "processing-timer", label: "Processamento automático", status: timer.outdated ? "warning" : "ok",
          ...(timer.outdated ? { action: "sync-apply" } : {}),
          detail: timer.outdated ? "O timer usa um intervalo ou pasta antigos: aplique de novo em Serviços." : "Gravações novas são processadas em segundo plano." });
  }
  // Like the processing timer: an enabled copy needs its timer installed, enabled and running,
  // and a state that cannot be read is said, not assumed.
  if (config.archive.enabled) {
    const timer = services?.archive;
    if (!timer) checks.push({ id: "archive-timer", label: "Arquivo de originais", status: "skipped", detail: "Estado do timer do arquivo de originais indisponível." });
    else if (!timer.installed || !timer.enabled || !timer.active) {
      checks.push({ id: "archive-timer", label: "Arquivo de originais", status: "warning", action: "archive-apply",
        detail: timer.installed
          ? "O arquivo de originais está ativado, mas o timer que copia as gravações está desativado ou parado. Aplique-o em Serviços."
          : "O arquivo de originais está ativado, mas o timer que copia as gravações não está instalado." });
    }
  }
  if (config.proton.enabled) {
    const timer = services?.backup;
    if (!timer) checks.push({ id: "backup-timer", label: "Backup no Proton Drive", status: "skipped", detail: "Estado do timer de backup indisponível." });
    else if (!timer.installed || !timer.enabled || !timer.active) {
      checks.push({ id: "backup-timer", label: "Backup no Proton Drive", status: "warning", action: "backup-apply",
        detail: timer.installed
          ? "O backup no Proton Drive está ativado, mas o timer de backup está desativado ou parado. Aplique-o em Serviços."
          : "O backup no Proton Drive está ativado, mas o timer de backup não está instalado." });
    }
  }
  return checks;
};
