import type { AppConfig } from "../config/defaults";
import { type DetachedNotifyTarget, handleReadyNotification, notificationLanguage, parseNotifyCommand } from "../notify/actions";
import { handleReminderNotification, type ReminderNotificationResult } from "../reminders";
import { NOTIFY_HELP } from "./help";
import { type CliIO, defaultLoadConfig, printJson, processIO } from "./shared";

export { NOTIFY_HELP };

/** `notify ready --job <uuid>` or `notify reminder --event <hash>`, exactly as the detached units run it. */
export const parseNotifyArgs = (args: readonly string[]): DetachedNotifyTarget => parseNotifyCommand(args.slice(1));

export type NotifyCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  ready: (jobId: string, config: AppConfig | undefined) => Promise<string | null>;
  reminder: (eventIdHash: string, config: AppConfig | undefined) => Promise<ReminderNotificationResult>;
};

export const defaultNotifyCliDeps = (): NotifyCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  ready: (jobId, config) => handleReadyNotification(jobId, config ? { language: notificationLanguage(config) } : {}),
  reminder: (eventIdHash, config) => handleReminderNotification(eventIdHash, config ? { config } : {})
});

export const runNotifyCli = async (args: string[], deps: NotifyCliDeps = defaultNotifyCliDeps()): Promise<void> => {
  const { io } = deps;
  if (args[1] === "help" || args[1] === "--help") { io.out(NOTIFY_HELP); return; }
  const target = parseNotifyArgs(args);
  // A broken configuration still shows the notification (in Portuguese, with the reminder's own mode).
  const config = await deps.loadConfig().catch(() => undefined);
  if (target.kind === "ready") {
    printJson(io, { job: target.job, choice: await deps.ready(target.job, config) });
    return;
  }
  printJson(io, { event: target.event, ...(await deps.reminder(target.event, config)) });
};
