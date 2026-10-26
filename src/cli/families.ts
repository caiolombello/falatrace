/**
 * Command families that live in their own module under src/cli. Each module is loaded only when
 * its command runs; `run<Family>Cli(args)` throws a Portuguese message on error, which
 * src/cli/index.ts prints on stderr with exit code 1.
 */

export type FamilyRunner = (args: string[]) => Promise<void>;

const FAMILIES: Readonly<Record<string, () => Promise<FamilyRunner>>> = Object.freeze({
  notes: async () => (await import("./notes")).runNotesCli,
  templates: async () => (await import("./templates")).runTemplatesCli,
  ask: async () => (await import("./ask")).runAskCli,
  recipes: async () => (await import("./recipes")).runRecipesCli,
  share: async () => (await import("./share")).runShareCli,
  people: async () => (await import("./people")).runPeopleCli,
  clients: async () => (await import("./clients")).runClientsCli,
  actions: async () => (await import("./actions")).runActionsCli,
  reminders: async () => (await import("./reminders")).runRemindersCli,
  live: async () => (await import("./live")).runLiveCli,
  media: async () => (await import("./media")).runMediaCli,
  studio: async () => (await import("./studio")).runStudioCli,
  notify: async () => (await import("./notify")).runNotifyCli,
  assistant: async () => (await import("./assistant")).runAssistantCli,
  library: async () => (await import("./library")).runLibraryCli
});

export const CLI_FAMILY_NAMES: readonly string[] = Object.freeze(Object.keys(FAMILIES));

/** The loader of a family command, or undefined for the commands index.ts handles itself. */
export const familyLoader = (command: string | undefined): (() => Promise<FamilyRunner>) | undefined =>
  command !== undefined && Object.getOwnPropertyDescriptor(FAMILIES, command) !== undefined ? FAMILIES[command] : undefined;
