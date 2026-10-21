import { findGoogleCalendarMeeting, googleCalendarEnabled } from "../google/calendar";
import type { MeetingContext } from "./types";
import type { CallApplication } from "../calls/apps";
import { promises as fs } from "node:fs";
import { findGnomeCalendarMeeting } from "../calendar/gnome";
import type { AppConfig } from "../config/defaults";
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

/** The calendar event of a call: the Google Calendar when it is on and connected, else the GNOME one. */
export const findMeetingContext = async (
  config: AppConfig, options: EnqueueRecordingOptions, lookups = { google: findGoogleCalendarMeeting, gnome: findGnomeCalendarMeeting }
): Promise<MeetingContext | undefined> => {
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
  return config.calendar.enabled ? lookups.gnome(options.startedAt, options.endedAt, options.app).catch(unavailable) : undefined;
};

export const enqueueRecording = async (
  config: AppConfig,
  filePath: string,
  options: EnqueueRecordingOptions = {},
  store = new JobStore()
): Promise<JobRecord | null> => {
  if (!config.processing.autoEnqueue && !config.archive.enabled) return null;
  await waitForStableFile(filePath);
  if (config.archive.enabled) {
    await new ArchiveStore().enqueue(filePath, { id: options.recordingId, createdAt: options.startedAt });
  }
  if (!config.processing.autoEnqueue) return null;
  const meetingContext = await findMeetingContext(config, options);
  const job = await store.enqueue(config, filePath, { meetingContext, recordingId: options.recordingId });
  console.log(`Processing job queued: ${job.id}`);
  return job;
};
