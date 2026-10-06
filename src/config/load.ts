import { existsSync, lstatSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join,dirname,resolve } from "node:path";
import { CALL_APPLICATIONS } from "../calls/apps";
import {
  DEFAULT_CONFIG,
  RECORDING_BACKENDS,
  STUDIO_LANGUAGES,
  TRANSCRIPTION_PROMPT_MAX_LENGTH,
  type AppConfig
} from "./defaults";

const legacyDir = join(homedir(), ".config", "recording-cli");
const requestedDir = process.env.XDG_CONFIG_HOME?.startsWith("/") ? join(process.env.XDG_CONFIG_HOME,"recording-cli") : legacyDir;
// Existing legacy choices win when no config exists at the explicit XDG destination.
// Migration requires an explicit user action; init never creates competing defaults.
export type LoadedConfig = {
  path: string;
  config: AppConfig;
};

const pathPresent=(p:string)=>{try{lstatSync(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
export const getRequestedConfigDir=():string=>resolve(requestedDir);
export const getConfigPath = (): string => join(requestedDir !== legacyDir && !pathPresent(join(requestedDir,'config.json')) && existsSync(join(legacyDir,'config.json')) ? legacyDir : requestedDir,'config.json');

export const ensureConfigDir = async (): Promise<void> => {
  const CONFIG_DIR=dirname(getConfigPath());
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(CONFIG_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Config directory must be a regular directory");
  }
  await fs.chmod(CONFIG_DIR, 0o700);
};

type PartialConfig = Omit<
  Partial<AppConfig>,
  | "gnome"
  | "capture"
  | "obs"
  | "features"
  | "proton"
  | "archive"
  | "s3"
  | "openai"
  | "processing"
  | "retention"
  | "remote"
  | "transcription"
  | "summary"
  | "calendar"
  | "callDetection"
  | "timesheet"
  | "aiContext"
  | "studio"
> & {
  gnome?: Partial<AppConfig["gnome"]>;
  capture?: Partial<AppConfig["capture"]>;
  obs?: Partial<AppConfig["obs"]>;
  features?: Partial<AppConfig["features"]>;
  proton?: Partial<AppConfig["proton"]>;
  archive?: Partial<AppConfig["archive"]>;
  s3?: Partial<AppConfig["s3"]>;
  openai?: Partial<AppConfig["openai"]>;
  processing?: Partial<AppConfig["processing"]>;
  retention?: Partial<AppConfig["retention"]>;
  remote?: Partial<AppConfig["remote"]>;
  transcription?: Omit<Partial<AppConfig["transcription"]>, "whisperCpp"> & {
    whisperCpp?: Partial<AppConfig["transcription"]["whisperCpp"]>;
  };
  summary?: Partial<AppConfig["summary"]>;
  calendar?: Partial<AppConfig["calendar"]>;
  callDetection?: Omit<Partial<AppConfig["callDetection"]>, "apps"> & {
    apps?: Partial<AppConfig["callDetection"]["apps"]>;
  };
  timesheet?: Partial<AppConfig["timesheet"]>;
  aiContext?: Partial<AppConfig["aiContext"]>;
  studio?: Partial<AppConfig["studio"]>;
};

export const loadConfigSnapshot=async(currentPath=getConfigPath())=>{
 const stat=await fs.lstat(currentPath);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Config must be a regular file; preserved');const raw=await fs.readFile(currentPath,'utf8');const data=JSON.parse(raw) as PartialConfig;const config=mergeConfig(DEFAULT_CONFIG,data);validateConfig(config);return {path:currentPath,config,exists:true,visualPolicyDeclared:!!data.visualReview};
};
export const loadConfig = async (): Promise<LoadedConfig> => {
 const currentPath=getConfigPath();try{const loaded=await loadConfigSnapshot(currentPath);return {path:loaded.path,config:loaded.config};}catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')return {path:currentPath,config:DEFAULT_CONFIG};throw Error(`Invalid config at ${currentPath}: ${err instanceof Error?err.message:String(err)}`);}
};

export const writeDefaultConfig = async (): Promise<LoadedConfig & { created: boolean }> => {
  const CONFIG_PATH=getConfigPath(),CONFIG_DIR=dirname(CONFIG_PATH);
  await fs.mkdir(CONFIG_DIR,{recursive:true,mode:0o700});const directory=await fs.lstat(CONFIG_DIR);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error("Config directory must be a regular directory");await fs.chmod(CONFIG_DIR,0o700);
  const temporaryPath = join(CONFIG_DIR, `.config-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(DEFAULT_CONFIG, null, 2), { flag: "wx", mode: 0o600 });
    try {
      // A hard link publishes the complete file atomically without overwriting an existing config.
      await fs.link(temporaryPath, CONFIG_PATH);
      return { path: CONFIG_PATH, config: DEFAULT_CONFIG, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(CONFIG_PATH);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing config must be a regular file; preserved");
      return { ...await loadConfig(), created: false };
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
};

export const mergeConfig = (base: AppConfig, override: PartialConfig): AppConfig => ({
  ...base,
  ...override,
  gnome: { ...base.gnome, ...override.gnome },
  capture: { ...base.capture, ...override.capture },
  obs: { ...base.obs, ...override.obs },
  features: { ...base.features, ...override.features },
  proton: { ...base.proton, ...override.proton },
  archive: { ...base.archive, ...override.archive },
  s3: { ...base.s3, ...override.s3 },
  openai: { ...base.openai, ...override.openai },
  processing: { ...base.processing, ...override.processing },
  retention: { ...base.retention, ...override.retention },
  remote: { ...base.remote, ...override.remote },
  transcription: {
    ...base.transcription,
    ...override.transcription,
    whisperCpp: {
      ...base.transcription.whisperCpp,
      ...override.transcription?.whisperCpp
    }
  },
  summary: { ...base.summary, ...override.summary },
  calendar: { ...base.calendar, ...override.calendar },
  callDetection: {
    ...base.callDetection,
    ...override.callDetection,
    apps: {
      ...base.callDetection.apps,
      ...override.callDetection?.apps
    }
  },
  timesheet: { ...base.timesheet, ...override.timesheet },
  aiContext: { ...base.aiContext, ...override.aiContext },
  studio: { ...base.studio, ...override.studio }
});

export const validateConfig = (config: AppConfig): void => {
  if ([config.archive.enabled, config.archive.vaio, config.archive.proton].some((value) => typeof value !== "boolean") ||
    !Number.isInteger(config.archive.syncIntervalMinutes) || config.archive.syncIntervalMinutes < 1 || config.archive.syncIntervalMinutes > 1440) {
    throw new Error("archive flags must be booleans and syncIntervalMinutes must be between 1 and 1440");
  }
  if (!["none", "microphone", "desktop", "both"].includes(config.capture.audioSource)) {
    throw new Error("capture.audioSource must be none, microphone, desktop or both");
  }
  for (const field of ["microphone", "desktop"] as const) {
    if (!/^[A-Za-z0-9_.@:-]{1,300}$/.test(config.capture[field])) {
      throw new Error(`capture.${field} must be a single audio device name`);
    }
  }
  if(config.visualReview && (config.visualReview.period!=="lifetime" || !Number.isSafeInteger(config.visualReview.maxInferences) || config.visualReview.maxInferences<1 || config.visualReview.maxInferences>1000 || !Number.isSafeInteger(config.visualReview.maxPreviews) || config.visualReview.maxPreviews<1 || config.visualReview.maxPreviews>1000)) throw new Error("visualReview requires explicit lifetime limits between 1 and 1000; no reset or financial provider cap");
  if (config.capture.profile !== undefined && !["standard", "call-light"].includes(config.capture.profile)) throw new Error("capture.profile must be standard or call-light");
  if (!["gpu", "cpu"].includes(config.capture.encoder)) throw new Error("capture.encoder must be gpu or cpu");
  for (const [field, minimum, maximum] of [["framerate", 1, 60], ["startupTimeoutSeconds", 5, 300]] as const) {
    if (!Number.isInteger(config.capture[field]) || config.capture[field] < minimum || config.capture[field] > maximum) {
      throw new Error(`capture.${field} must be between ${minimum} and ${maximum}`);
    }
  }
  if (!config.recordingsDir.startsWith("/") || /[\r\n\0]/.test(config.recordingsDir)) {
    throw new Error("recordingsDir must be an absolute path without control characters");
  }
  if (
    config.obs.host.startsWith("-") ||
    !/^[A-Za-z0-9.:-]+$/.test(config.obs.host) ||
    !Number.isInteger(config.obs.port) ||
    config.obs.port < 1 ||
    config.obs.port > 65535
  ) {
    throw new Error("obs host or port is invalid");
  }
  if (
    typeof config.obs.enabled !== "boolean" ||
    typeof config.obs.autoLaunch !== "boolean"
  ) {
    throw new Error("obs.enabled and obs.autoLaunch must be booleans");
  }
  if (!["local", "remote"].includes(config.processing.defaultTarget)) {
    throw new Error("processing.defaultTarget must be local or remote");
  }
  if (typeof config.processing.notifyOnCompletion !== "boolean" || typeof config.processing.autoEnqueue !== "boolean") {
    throw new Error("processing.autoEnqueue and processing.notifyOnCompletion must be booleans");
  }
  if (
    !/^\/my-files(?:\/[A-Za-z0-9._ -]+)*$/.test(config.proton.targetFolder) ||
    config.proton.targetFolder
      .split("/")
      .some((component) => component === "." || component === "..")
  ) {
    throw new Error("proton.targetFolder must be a safe path below /my-files");
  }
  if (!["artifacts", "full"].includes(config.proton.policy)) {
    throw new Error("proton.policy must be artifacts or full");
  }
  if (!["openai", "whisper-cpp", "gemini"].includes(config.transcription.provider)) {
    throw new Error("transcription.provider must be openai, whisper-cpp or gemini");
  }
  if (
    typeof config.transcription.geminiModel !== "string" ||
    !config.transcription.geminiModel.trim() ||
    config.transcription.geminiModel.length > 200
  ) {
    throw new Error("transcription.geminiModel must be a non-empty string up to 200 characters");
  }
  if (!["openai", "ollama"].includes(config.summary.provider)) {
    throw new Error("summary.provider must be openai or ollama");
  }
  if (!Number.isSafeInteger(config.summary.maxInputCharacters) || config.summary.maxInputCharacters < 4096 || config.summary.maxInputCharacters > 200_000) {
    throw new Error("summary.maxInputCharacters must be between 4096 and 200000");
  }
  if (!(RECORDING_BACKENDS as readonly string[]).includes(config.backend)) {
    throw new Error(`backend must be one of ${RECORDING_BACKENDS.join(", ")}`);
  }
  if (!(STUDIO_LANGUAGES as readonly string[]).includes(config.studio.language)) {
    throw new Error("studio.language must be auto, pt-BR or en");
  }
  if (typeof config.calendar.enabled !== "boolean") {
    throw new Error("calendar.enabled must be a boolean");
  }
  if (config.remote.host.startsWith("-") || !/^[A-Za-z0-9._:-]+$/.test(config.remote.host)) {
    throw new Error("remote.host contains unsupported characters");
  }
  if (
    config.remote.user &&
    (config.remote.user.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(config.remote.user))
  ) {
    throw new Error("remote.user contains unsupported characters");
  }
  if (!Number.isInteger(config.remote.port) || config.remote.port < 1 || config.remote.port > 65535) {
    throw new Error("remote.port must be between 1 and 65535");
  }
  if (
    !Number.isInteger(config.processing.syncIntervalMinutes) ||
    config.processing.syncIntervalMinutes < 1 ||
    config.processing.syncIntervalMinutes > 1440
  ) {
    throw new Error("processing.syncIntervalMinutes must be between 1 and 1440");
  }
  for (const [field, value] of Object.entries(config.retention)) {
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      throw new Error(`retention.${field} must be between 0 and 3650 days`);
    }
  }
  if (
    !Number.isInteger(config.transcription.whisperCpp.threads) ||
    config.transcription.whisperCpp.threads < 1 ||
    config.transcription.whisperCpp.threads > 256
  ) {
    throw new Error("transcription.whisperCpp.threads must be between 1 and 256");
  }
  if (
    config.transcription.language !== "auto" &&
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(config.transcription.language)
  ) {
    throw new Error("transcription.language must be auto or an ISO language code");
  }
  if (
    !Array.isArray(config.transcription.expectedLanguages) ||
    config.transcription.expectedLanguages.length > 10 ||
    new Set(config.transcription.expectedLanguages).size !==
      config.transcription.expectedLanguages.length ||
    config.transcription.expectedLanguages.some(
      (language) =>
        typeof language !== "string" ||
        !/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language)
    )
  ) {
    throw new Error(
      "transcription.expectedLanguages must contain up to 10 unique language codes"
    );
  }
  if (
    typeof config.transcription.openaiPrompt !== "string" ||
    config.transcription.openaiPrompt.length > TRANSCRIPTION_PROMPT_MAX_LENGTH
  ) {
    throw new Error(
      `transcription.openaiPrompt must be a string up to ${TRANSCRIPTION_PROMPT_MAX_LENGTH} characters`
    );
  }
  if (!["notify-only", "obs", "record"].includes(config.callDetection.mode)) {
    throw new Error("callDetection.mode must be notify-only, obs or record");
  }
  if (config.callDetection.mode === "obs" && !config.obs.enabled) {
    throw new Error("callDetection.mode=obs requires obs.enabled=true");
  }
  const callTimingFields = [
    ["entryDebounceSeconds", config.callDetection.entryDebounceSeconds, 1, 120],
    ["exitTimeoutSeconds", config.callDetection.exitTimeoutSeconds, 1, 300],
    ["networkSampleSeconds", config.callDetection.networkSampleSeconds, 1, 60]
  ] as const;
  for (const [field, value, minimum, maximum] of callTimingFields) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`callDetection.${field} must be between ${minimum} and ${maximum}`);
    }
  }
  for (const [field, value] of Object.entries({
    enabled: config.callDetection.enabled,
    dryRun: config.callDetection.dryRun,
    enqueueOnStop: config.callDetection.enqueueOnStop,
    ...Object.fromEntries(CALL_APPLICATIONS.map((app) => [app, config.callDetection.apps[app]]))
  })) {
    if (typeof value !== "boolean") {
      throw new Error(`callDetection.${field} must be a boolean`);
    }
  }
  for (const [field, value] of Object.entries({
    enabled: config.timesheet.enabled,
    automaticFromCalls: config.timesheet.automaticFromCalls,
    aiClassification: config.timesheet.aiClassification
  })) {
    if (typeof value !== "boolean") {
      throw new Error(`timesheet.${field} must be a boolean`);
    }
  }
  if (
    typeof config.timesheet.aiModel !== "string" ||
    config.timesheet.aiModel.length === 0 ||
    config.timesheet.aiModel.length > 200 ||
    /[\r\n\0]/.test(config.timesheet.aiModel)
  ) {
    throw new Error("timesheet.aiModel is invalid");
  }
  if (
    typeof config.timesheet.readyConfidence !== "number" ||
    !Number.isFinite(config.timesheet.readyConfidence) ||
    config.timesheet.readyConfidence < 0.5 ||
    config.timesheet.readyConfidence > 1
  ) {
    throw new Error("timesheet.readyConfidence must be between 0.5 and 1");
  }
  if (
    !config.timesheet.contextPath.startsWith("/") ||
    /[\r\n\0]/.test(config.timesheet.contextPath)
  ) {
    throw new Error("timesheet.contextPath must be an absolute path");
  }
  for (const [field, value] of Object.entries({
    enabled: config.aiContext.enabled,
    autoBuild: config.aiContext.autoBuild
  })) {
    if (typeof value !== "boolean") {
      throw new Error(`aiContext.${field} must be a boolean`);
    }
  }
  if (
    !Number.isInteger(config.aiContext.maxMeetingsPerClient) ||
    config.aiContext.maxMeetingsPerClient < 1 ||
    config.aiContext.maxMeetingsPerClient > 100
  ) {
    throw new Error("aiContext.maxMeetingsPerClient must be between 1 and 100");
  }
  if (
    !Number.isInteger(config.aiContext.maxCharactersPerClient) ||
    config.aiContext.maxCharactersPerClient < 8_000 ||
    config.aiContext.maxCharactersPerClient > 200_000
  ) {
    throw new Error(
      "aiContext.maxCharactersPerClient must be between 8000 and 200000"
    );
  }
  if (
    config.remote.identityFile &&
    (!config.remote.identityFile.startsWith("/") || /[\r\n\0]/.test(config.remote.identityFile))
  ) {
    throw new Error("remote.identityFile must be an absolute path");
  }
  if (
    !(config.remote.archiveDir.startsWith("/") || config.remote.archiveDir.startsWith("~/")) ||
    /[\r\n\0]/.test(config.remote.archiveDir)
  ) {
    throw new Error("remote.archiveDir must be an absolute path or start with ~/");
  }
};
