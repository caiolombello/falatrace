import type { AppConfig } from "../config/defaults";
import { LibraryIndex, type LibraryIndexDeps } from "../library-index/index";
import { findNotesForJob } from "../notes";
import { createIndexClientResolver } from "../clients/build";
import { readClientCatalog } from "../clients/catalog";
import { ClientOverridesStore } from "../clients/overrides";
import { TimeEntryStore } from "../timesheet/store";
import { AssistantRunner, type AssistantRunnerOptions } from "../assistant/runner";
import { createAssistantReaders, type AssistantReaders } from "../assistant/retrieval";
import { ThreadStore } from "../assistant/threads";
import { createChatProvider } from "../assistant/providers";
import type { ChatProvider } from "../assistant/types";
import type { LibraryIndexReader } from "../library-index/types";
import { PeopleStore } from "../people/store";
import { buildPeople, type BuildPeopleOptions } from "../people/build";
import { listVoicePeople } from "../speakers/voices";

/**
 * Composition root for the features built on the library index: it wires the index to the
 * notes and clients modules, and the assistant runner to the providers, threads and people.
 * The CLI and the Studio bridge build their services here instead of wiring them by hand.
 */

/** Voice profiles are optional (the voice model may not be installed): any failure means none. */
export const voicePeople = (): Promise<Array<{ id: string; name: string }>> =>
  listVoicePeople().then((people) => people.map(({ id, name }) => ({ id, name })), () => []);

export const peopleOptions = (overrides: BuildPeopleOptions = {}): BuildPeopleOptions => ({ listVoicePeople: voicePeople, ...overrides });

/** The index reads notes and clients through these modules; a broken notes file never breaks indexing. */
export const createLibraryIndex = (config: AppConfig, deps: LibraryIndexDeps = {}): LibraryIndex =>
  new LibraryIndex(config, {
    notes: (job) => findNotesForJob(job).catch(() => undefined),
    clients: createIndexClientResolver({
      readyConfidence: config.timesheet.readyConfidence,
      loadCatalog: () => readClientCatalog(config.timesheet.contextPath).then((read) => read.context),
      listEntries: () => new TimeEntryStore().list(),
      readOverrides: () => new ClientOverridesStore().read()
    }),
    ...deps
  });

/** Name and aliases of a person for the assistant's person scope. */
export const personReader = (index: LibraryIndexReader, people: PeopleStore): NonNullable<AssistantReaders["person"]> =>
  async (personId) => {
    const person = (await buildPeople(index, people, peopleOptions({ actions: false, includeHidden: true }))).find((candidate) => candidate.id === personId);
    return person ? { name: person.name, aliases: person.aliases } : undefined;
  };

export type AssistantServiceOptions = Partial<Omit<AssistantRunnerOptions, "config" | "index">> & { people?: PeopleStore };

export const createAssistantRunner = (config: AppConfig, index: LibraryIndex, options: AssistantServiceOptions = {}): AssistantRunner => {
  const people = options.people ?? new PeopleStore();
  return new AssistantRunner({
    config,
    index,
    providerFactory: options.providerFactory ?? ((current: AppConfig): ChatProvider => createChatProvider(current)),
    readers: options.readers ?? createAssistantReaders({ person: personReader(index, people) }),
    store: options.store ?? new ThreadStore(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
    ...(options.retentionMs ? { retentionMs: options.retentionMs } : {})
  });
};

export type AppServices = {
  config: AppConfig;
  index: LibraryIndex;
  people: PeopleStore;
  clientOverrides: ClientOverridesStore;
  threads: ThreadStore;
  runner: AssistantRunner;
  /** Stops running questions; the index keeps its files. */
  close(): Promise<void>;
};

/** Everything the CLI or the bridge needs for one configuration. */
export const createAppServices = (config: AppConfig, options: { index?: LibraryIndexDeps; assistant?: AssistantServiceOptions } = {}): AppServices => {
  const index = createLibraryIndex(config, options.index);
  const people = options.assistant?.people ?? new PeopleStore();
  const threads = options.assistant?.store ?? new ThreadStore();
  const runner = createAssistantRunner(config, index, { ...options.assistant, people, store: threads });
  return {
    config,
    index,
    people,
    clientOverrides: new ClientOverridesStore(),
    threads,
    runner,
    close: () => runner.shutdown()
  };
};
