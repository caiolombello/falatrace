// What the bridge hands to every operation family: the long-lived services, the library cache
// owned by bridge.ts, and every outside-world dependency, injectable so handler tests run offline.
import type { DetectDeps } from "../assistant/detect";
import type { ChatGptOAuthDeps } from "../assistant/chatgpt/oauth";
import type { ChatProvider } from "../assistant/types";
import type { UpcomingEventsDeps } from "../calendar/upcoming";
import type { AppConfig } from "../config/defaults";
import type { DeliverShareDeps, DescribeDestinationsDeps } from "../destinations";
import type { JobRecord } from "../jobs/types";
import type { LiveUnitDeps } from "../live/unit";
import type { MediaRemovalDeps } from "../media-retention/manual";
import type { FirstRunOptions } from "../metrics/first-run";
import type { RecordingSession } from "../recording/session";
import type { MeetingOverridesOptions } from "../reminders/overrides";
import type { LibraryEntry } from "../tui/library";
import type { StudioInboxOptions } from "./open-request";
import type { StudioServices } from "./studio-services";

export type BridgeLibrary = {
  /** The library entry of a library key (absolute sourcePath); throws "Gravação não encontrada na biblioteca". */
  find(key: string): Promise<{ config: AppConfig; entry: LibraryEntry }>;
  load(): Promise<{ config: AppConfig; entries: LibraryEntry[] }>;
  /** Call after any write that changes the library. */
  invalidate(): void;
};

export type BridgeDeps = {
  now?: () => Date;
  jobs?: { get(id: string): Promise<JobRecord>; list(): Promise<JobRecord[]> };
  sessions?: { read(): Promise<RecordingSession | null> };
  /** Readiness of the assistant destination (no meeting content is sent). */
  provider?: (config: AppConfig) => ChatProvider;
  detect?: DetectDeps;
  chatgpt?: ChatGptOAuthDeps;
  share?: DeliverShareDeps;
  destinations?: DescribeDestinationsDeps;
  live?: LiveUnitDeps;
  upcoming?: UpcomingEventsDeps;
  overrides?: MeetingOverridesOptions;
  retention?: Partial<MediaRemovalDeps>;
  inbox?: StudioInboxOptions;
  firstRun?: FirstRunOptions;
  /** Directories of user files that default to the configuration folder. */
  templatesDir?: string;
  recipesDir?: string;
};

export type BridgeContext = {
  studio: StudioServices;
  library: BridgeLibrary;
  deps: BridgeDeps;
};
