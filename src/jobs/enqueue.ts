import { findGoogleCalendarMatch, findGoogleCalendarMeeting, googleCalendarEnabled } from "../google/calendar";
import type { MeetingContext } from "./types";
import type { CallApplication } from "../calls/apps";
import { promises as fs } from "node:fs";
import { findGnomeCalendarMatch, findGnomeCalendarMeeting } from "../calendar/gnome";
import { findKdeCalendarMatch, findKdeCalendarMeeting } from "../calendar/kde";
import { type CalendarMatch, writeCalendarLink } from "../calendar/links";
import type { AppConfig } from "../config/defaults";
import { localProcessing } from "../config/settings";
import { type OllamaLocality, probeOllamaLocality } from "../summary/ollama-locality";
import { JobStore } from "./store";
import type { JobRecord } from "./types";
import { ArchiveStore } from "../archive/store";

export type EnqueueRecordingOptions = {
  recordingId?: string;
  startedAt?: string;
  endedAt?: string;
  app?: CallApplication;
};

const waitForStableFile = async (filePath: string): Promise<void> => {
  let previousSize = -1;
  let stableChecks = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const stat = await fs.stat(filePath);
      stableChecks = stat.isFile() && stat.size > 0 && stat.size === previousSize ? stableChecks + 1 : 0;
      if (stableChecks >= 3) return;
      previousSize = stat.size;
    } catch {
      previousSize = -1;
      stableChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Recording file did not become ready: ${filePath}`);
};

type CalendarLookups<T> = {
  google: (config: AppConfig, startAt: string, endAt: string, app?: CallApplication) => Promise<T | undefined>;
  gnome: (startAt: string, endAt: string, app?: CallApplication) => Promise<T | undefined>;
  kde?: (startAt: string, endAt: string, app?: CallApplication) => Promise<T | undefined>;
};

/** The Google Calendar when it is on and connected, else KOrganizer, else the GNOME one; a failing calendar is skipped. */
const lookUpCalendar = async <T>(config: AppConfig, options: EnqueueRecordingOptions, lookups: CalendarLookups<T>): Promise<T | undefined> => {
  if (!options.startedAt || !options.endedAt) return undefined;
  const unavailable = (error: unknown): undefined => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Calendar context unavailable: ${message.slice(0, 500)}`);
    return undefined;
  };
  if (googleCalendarEnabled(config)) {
    const google = await lookups.google(config, options.startedAt, options.endedAt, options.app).catch(unavailable);
    if (google) return google;
  }
  if (config.calendar.kde && lookups.kde) {
    const kde = await lookups.kde(options.startedAt, options.endedAt, options.app).catch(unavailable);
    if (kde) return kde;
  }
  return config.calendar.enabled ? lookups.gnome(options.startedAt, options.endedAt, options.app).catch(unavailable) : undefined;
};

/** The calendar event of a call: the Google Calendar when it is on and connected, else KOrganizer, else the GNOME one. */
export const findMeetingContext = async (
  config: AppConfig, options: EnqueueRecordingOptions,
  lookups: CalendarLookups<MeetingContext> = { google: findGoogleCalendarMeeting, gnome: findGnomeCalendarMeeting, kde: findKdeCalendarMeeting }
): Promise<MeetingContext | undefined> => lookUpCalendar(config, options, lookups);

/** Like findMeetingContext, with the matched event's id, series and invited names for the calendar link. */
export const findMeetingMatch = async (
  config: AppConfig, options: EnqueueRecordingOptions,
  lookups: CalendarLookups<CalendarMatch> = { google: findGoogleCalendarMatch, gnome: findGnomeCalendarMatch, kde: findKdeCalendarMatch }
): Promise<CalendarMatch | undefined> => lookUpCalendar(config, options, lookups);

/** The fast path: a recording is processed as soon as it stops, with local providers only. */
export const fastPathActive = (config: AppConfig): boolean =>
  config.processing.fastPath === true && localProcessing(config);

export type EnqueueRecordingDeps = {
  lookups?: CalendarLookups<CalendarMatch>;
  /** Saves the calendar link beside the job; defaults to `calendar-links/<jobId>.json`. */
  writeLink?: (job: JobRecord, match: CalendarMatch) => Promise<unknown>;
  /** Asks the Ollama whether it runs the summary model itself; defaults to its /api/show. */
  ollamaLocality?: (url: string, model: string) => Promise<OllamaLocality>;
};

export const enqueueRecording = async (
  config: AppConfig,
  filePath: string,
  options: EnqueueRecordingOptions = {},
  store = new JobStore(),
  deps: EnqueueRecordingDeps = {}
): Promise<JobRecord | null> => {
  // Queued only for the fast path, nobody confirms where the recording goes: the Ollama must say
  // it runs the summary model itself (another name for a cloud model is not sent).
  const fast = !config.processing.autoEnqueue && fastPathActive(config) &&
    await (deps.ollamaLocality ?? ((url: string, model: string) => probeOllamaLocality(url, model)))(config.summary.ollamaUrl, config.summary.ollamaModel)
      .then((locality) => {
        if (locality !== "local") console.warn(`Fast path skipped: the Ollama did not confirm the summary model runs on this computer (${locality}).`);
        return locality === "local";
      }, () => false);
  const queue = config.processing.autoEnqueue || fast;
  if (!queue && !config.archive.enabled) return null;
  await waitForStableFile(filePath);
  if (config.archive.enabled) {
    await new ArchiveStore().enqueue(filePath, { id: options.recordingId, createdAt: options.startedAt });
  }
  if (!queue) return null;
  const match = await findMeetingMatch(config, options, deps.lookups);
  // Queued only for the fast path, the job runs here: its providers are local by definition.
  const job = await store.enqueue(config, filePath, {
    meetingContext: match?.meeting, recordingId: options.recordingId, ...(config.processing.autoEnqueue ? {} : { target: "local" as const })
  });
  if (match) {
    // The link only enriches the library (people, series, briefs): the job never depends on it.
    await (deps.writeLink ?? writeCalendarLink)(job, match).catch((error: unknown) => {
      console.warn(`Calendar link not saved: ${(error instanceof Error ? error.message : String(error)).replace(/\p{Cc}+/gu, " ").slice(0, 300)}`);
    });
  }
  console.log(`Processing job queued: ${job.id}`);
  return job;
};
