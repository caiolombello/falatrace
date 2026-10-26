import { listUpcomingEvents, type UpcomingEvent, upcomingEventSources } from "../calendar/upcoming";
import { readAutomationState } from "../calls/control";
import type { AppConfig } from "../config/defaults";
import { getConfigPath } from "../config/load";
import { readServiceStatus, type ServiceStatus } from "../config/setup-checks";
import { notificationLanguage } from "../notify/actions";
import {
  buildReminderNotification, createReminderBrief, effectiveReminderMode, installRemindersService, REMINDER_TIMING, reminderRecordingMode,
  remindersServiceProblem, runRemindersService, uninstallRemindersService
} from "../reminders";
import { REMINDERS_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, errorMessage, type Interrupt, printJson, printLine, processInterrupt, processIO } from "./shared";

export { REMINDERS_HELP };

export const REMINDERS_ACTIONS = ["run", "status", "test", "install-service", "uninstall-service"] as const;
export type RemindersAction = (typeof REMINDERS_ACTIONS)[number];

/** `reminders <action>`, exactly; the service unit runs `reminders run`. */
export const parseRemindersArgs = (args: readonly string[]): { action: RemindersAction } => {
  const [command, action, ...rest] = args;
  if (command !== "reminders" || !action || !(REMINDERS_ACTIONS as readonly string[]).includes(action) || rest.length) throw new Error(CLI_USAGE.reminders);
  return { action: action as RemindersAction };
};

export type RemindersCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  runService: typeof runRemindersService;
  install: (config: AppConfig) => Promise<string>;
  uninstall: () => Promise<string>;
  serviceStatus: (config: AppConfig) => Promise<ServiceStatus>;
  listEvents: (config: AppConfig, from: Date, to: Date) => Promise<UpcomingEvent[]>;
  /** Brief lines for an event (earlier meetings); undefined turns them off. */
  brief: (config: AppConfig) => ((event: UpcomingEvent) => Promise<string[] | null>) | undefined;
  automationPaused: () => Promise<boolean>;
  now: () => number;
  interrupt: () => Interrupt;
};

export const defaultRemindersCliDeps = (): RemindersCliDeps => ({
  io: processIO,
  loadConfig: defaultLoadConfig,
  runService: runRemindersService,
  install: (config) => installRemindersService(config),
  uninstall: () => uninstallRemindersService(),
  serviceStatus: async (config) => (await readServiceStatus(config, getConfigPath())).reminders,
  listEvents: (config, from, to) => listUpcomingEvents(config, { from, to }),
  brief: (config) => (config.reminders.brief ? createReminderBrief(config) : undefined),
  automationPaused: async () => (await readAutomationState()).paused,
  now: Date.now,
  interrupt: processInterrupt
});

export const runRemindersCli = async (args: string[], deps: RemindersCliDeps = defaultRemindersCliDeps()): Promise<void> => {
  const { io } = deps;
  if (args[1] === "help" || args[1] === "--help") { io.out(REMINDERS_HELP); return; }
  const { action } = parseRemindersArgs(args);
  // Removing the service needs no configuration: a broken one must not keep a unit running.
  if (action === "uninstall-service") { printLine(io, await deps.uninstall()); return; }
  const config = await deps.loadConfig();
  if (action === "install-service") { printLine(io, await deps.install(config)); return; }
  if (action === "run") {
    const interrupt = deps.interrupt();
    try {
      const result = await deps.runService({
        config, signal: interrupt.signal,
        deps: {
          // One JSON line per problem, for the journal; the loop itself never stops on them.
          onError: (stage, error) => io.err(`${JSON.stringify({ event: "reminders.error", stage, error: errorMessage(error).slice(0, 300) })}\n`)
        }
      });
      // Off, or no calendar: the service ends quietly (exit 0) and systemd does not restart it.
      if (!result.ran && result.reason) printLine(io, result.reason);
    } finally {
      interrupt.dispose();
    }
    return;
  }
  if (action === "status") {
    let service: ServiceStatus | null = null;
    try { service = await deps.serviceStatus(config); } catch { service = null; }
    const problem = remindersServiceProblem(config);
    printJson(io, {
      mode: config.reminders.mode,
      effective: effectiveReminderMode(config),
      leadMinutes: config.reminders.leadMinutes,
      brief: config.reminders.brief,
      calendars: upcomingEventSources(config),
      problem: problem ?? null,
      service,
      ...(service ? {} : { serviceError: CLI_MESSAGES.unitsUnavailable })
    });
    return;
  }
  // test: what the next three hours would bring; nothing is recorded or shown.
  const now = deps.now();
  const events = await deps.listEvents(config, new Date(now), new Date(now + REMINDER_TIMING.horizonMs));
  const paused = await deps.automationPaused().catch(() => true);
  const mode = reminderRecordingMode(config, paused);
  const brief = deps.brief(config);
  const language = notificationLanguage(config);
  const lead = config.reminders.leadMinutes * 60_000;
  const reminders = [];
  for (const event of events) {
    const start = Date.parse(event.startAt);
    if (!Number.isFinite(start) || Date.parse(event.endAt) <= now) continue;
    const fireAt = Math.max(now, start - lead);
    const briefLines = brief ? await brief(event).catch(() => null) : null;
    const notification = buildReminderNotification({ event, now: fireAt, mode, briefLines: briefLines ?? [], language });
    reminders.push({
      title: event.title, startAt: event.startAt, endAt: event.endAt, fireAt: new Date(fireAt).toISOString(), source: event.source,
      notification: { title: notification.title, body: notification.body, actions: notification.actions.map((item) => item.label) }
    });
  }
  const problem = remindersServiceProblem(config);
  printJson(io, { effective: effectiveReminderMode(config), problem: problem ?? null, reminders });
};
