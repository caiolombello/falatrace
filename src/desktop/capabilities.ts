// Which new Studio features the bridge offers (ux-capabilities `features`): the Studio sends an op
// family only when its flag is true. Live needs the setting on and something that can transcribe.
import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { upcomingEventSources } from "../calendar/upcoming";
import type { AppConfig } from "../config/defaults";
import { liveProviderKey } from "../live/transcribe";

export type StudioFeatures = {
  notes: boolean; live: boolean; assistant: boolean; recipes: boolean; share: boolean; actions: boolean; people: boolean; clients: boolean;
  upcoming: boolean; openInbox: boolean; mediaRemoval: boolean; templates: boolean; librarySearch: boolean;
};

export type CapabilityDeps = {
  which?: (command: string) => string | null;
  fileExists?: (path: string) => Promise<boolean>;
  liveKey?: (config: AppConfig) => Promise<string | undefined>;
};

const regularFile = async (path: string): Promise<boolean> => fs.stat(path).then((stat) => stat.isFile(), () => false);

/** The live transcript can start: setting on, ffmpeg present, and the provider's model or key available. */
export const liveAvailable = async (config: AppConfig, deps: CapabilityDeps = {}): Promise<boolean> => {
  if (!config.live.enabled) return false;
  const which = deps.which ?? ((command: string) => Bun.which(command));
  if (!which("ffmpeg")) return false;
  if (config.live.provider === "whisper-cpp") {
    const command = config.transcription.whisperCpp.command;
    const found = isAbsolute(command) ? await (deps.fileExists ?? regularFile)(command) : !!which(command);
    return found && await (deps.fileExists ?? regularFile)(config.live.whisperModelPath);
  }
  const key = await (deps.liveKey ?? ((value: AppConfig) => liveProviderKey(value.live.provider, value)))(config).catch(() => undefined);
  return !!key;
};

export const studioFeatures = async (config: AppConfig, deps: CapabilityDeps = {}): Promise<StudioFeatures> => ({
  notes: config.notes.enabled,
  live: await liveAvailable(config, deps).catch(() => false),
  assistant: true,
  recipes: true,
  share: true,
  actions: true,
  people: true,
  clients: true,
  upcoming: upcomingEventSources(config).length > 0,
  openInbox: true,
  mediaRemoval: true,
  templates: true,
  librarySearch: true
});
