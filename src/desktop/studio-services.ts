// The bridge's long-lived services: the library index and assistant runner for the current
// configuration (src/app/context.ts), a snapshot of indexed facts that `list` can read without
// waiting, a background index refresh, and the Studio presence lock held for the bridge's lifetime.
import { listActionsForFacts } from "../actions/list";
import { createAppServices, type AppServices } from "../app/context";
import type { AssistantRunner } from "../assistant/runner";
import type { AppConfig } from "../config/defaults";
import { loadConfig } from "../config/load";
import type { JobFacts } from "../library-index/types";
import { PeopleStore } from "../people/store";
import type { SingletonLease } from "../runtime/singleton";
import { holdStudioPresence } from "./open-request";

export type StudioServicesDeps = {
  loadConfig?: () => Promise<AppConfig>;
  create?: (config: AppConfig) => AppServices;
  /** The presence lock; null when another Studio holds it. */
  presence?: () => Promise<SingletonLease | null>;
  now?: () => number;
};

/** A background refresh starts at most this often when pages ask for fresh data. */
export const LIBRARY_REFRESH_MIN_AGE_MS = 60_000;
const CLOSE_WAIT_MS = 3_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export class StudioServices {
  private current?: { identity: string; services: AppServices };
  private readonly retired: AppServices[] = [];
  private facts?: Map<string, JobFacts>;
  private openActions?: Map<string, number>;
  private refreshTask?: Promise<void>;
  private refreshedAt = 0;
  private readonly controller = new AbortController();
  private presenceLease?: Promise<SingletonLease | null>;
  private readonly runOwners = new Map<string, AssistantRunner>();
  private closed = false;

  constructor(private readonly deps: StudioServicesDeps = {}) {}

  async config(): Promise<AppConfig> {
    return this.deps.loadConfig ? this.deps.loadConfig() : (await loadConfig()).config;
  }

  /** Services for the configuration on disk now; a changed configuration gets new ones (running questions keep theirs). */
  async services(config?: AppConfig): Promise<AppServices> {
    const current = config ?? await this.config();
    const identity = JSON.stringify(current);
    if (this.current?.identity !== identity) {
      if (this.current) this.retired.push(this.current.services);
      this.current = { identity, services: (this.deps.create ?? ((value: AppConfig) => createAppServices(value)))(structuredClone(current)) };
    }
    return this.current.services;
  }

  /** Holds the Studio presence lock (in the background); links from notifications are then queued for this Studio. */
  holdPresence(): void {
    if (this.presenceLease || this.closed) return;
    this.presenceLease = (this.deps.presence ?? (() => holdStudioPresence()))().catch(() => null);
  }

  get refreshing(): boolean {
    return this.refreshTask !== undefined;
  }

  /** The index was just refreshed by someone else (a test, a targeted refresh): background refreshes wait the minimum age from now. */
  markRefreshed(): void {
    this.refreshedAt = (this.deps.now ?? Date.now)();
  }

  /** Resolves when no background refresh is running (tests; the bridge never waits for it). */
  async whenIdle(): Promise<void> {
    while (this.refreshTask) await this.refreshTask;
  }

  /** Starts a background index refresh unless one is running or one finished less than `minAgeMs` ago. */
  refreshInBackground(minAgeMs = 0): void {
    if (this.closed || this.refreshTask) return;
    if (minAgeMs > 0 && this.refreshedAt && (this.deps.now ?? Date.now)() - this.refreshedAt < minAgeMs) return;
    let task: Promise<void> | undefined = undefined;
    task = (async () => {
      try {
        const services = await this.services();
        // Facts already on disk first: pages show them while the refresh runs.
        if (!this.facts) await this.snapshot(services);
        await services.index.refresh({ signal: this.controller.signal });
        await this.snapshot(services);
      } catch {
        // A refresh that fails keeps the previous facts; pages read the index as it is.
      } finally {
        this.refreshedAt = (this.deps.now ?? Date.now)();
        if (this.refreshTask === task) this.refreshTask = undefined;
      }
    })();
    this.refreshTask = task;
  }

  /** Re-indexes some recordings (a new summary, for example) in the background, then the snapshot. */
  refreshJobs(jobIds: readonly string[]): void {
    if (this.closed || !jobIds.length) return;
    void (async () => {
      const services = await this.services();
      await services.index.refresh({ jobIds: [...jobIds], signal: this.controller.signal });
      await this.snapshot(services);
    })().catch(() => undefined);
  }

  /** Re-reads the facts (after an edit that re-indexed one recording, for example). */
  async snapshot(services?: AppServices): Promise<void> {
    const active = services ?? await this.services();
    const facts = await active.index.listFacts();
    this.facts = new Map(facts.map((item) => [item.jobId, item]));
    try {
      const people = await new PeopleStore().directory().catch(() => undefined);
      const open = await listActionsForFacts(facts, { status: "open", includeOrphaned: false }, { persist: false, ...(people ? { people } : {}) });
      const counts = new Map<string, number>();
      for (const action of open) counts.set(action.jobId, (counts.get(action.jobId) ?? 0) + 1);
      this.openActions = counts;
    } catch {
      this.openActions = undefined;
    }
  }

  /** Indexed facts of the first job that has them, from the in-memory snapshot (no disk access). */
  cachedFacts(jobIds: readonly string[]): JobFacts | undefined {
    if (!this.facts) return undefined;
    for (const id of jobIds) {
      const facts = this.facts.get(id.toLowerCase());
      if (facts) return facts;
    }
    return undefined;
  }

  /** Open actions of a recording from the snapshot; undefined while unknown. */
  cachedOpenActions(jobId: string): number | undefined {
    if (!this.openActions) return undefined;
    return this.openActions.get(jobId.toLowerCase()) ?? 0;
  }

  get factsLoaded(): boolean {
    return this.facts !== undefined;
  }

  /** Assistant runs are polled through the runner that started them, even after a settings change. */
  rememberRun(runId: string, runner: AssistantRunner): void {
    this.runOwners.set(runId, runner);
    // Bounded: runs older than the runner's retention cannot be polled anyway.
    while (this.runOwners.size > 256) {
      const oldest = this.runOwners.keys().next().value;
      if (oldest === undefined) break;
      this.runOwners.delete(oldest);
    }
  }

  runnerFor(runId: string): AssistantRunner | undefined {
    return this.runOwners.get(runId);
  }

  /** Stops the refresh and running questions and releases the presence lock. */
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    const pending = this.refreshTask;
    if (pending) await Promise.race([pending, wait(CLOSE_WAIT_MS)]);
    const all = [...this.retired, ...(this.current ? [this.current.services] : [])];
    await Promise.allSettled(all.map((services) => services.close()));
    const lease = await this.presenceLease;
    await lease?.release().catch(() => undefined);
  }
}

/** The Studio's display language for names the bridge picks (template and recipe names, brief lines). */
export const studioLanguage = (config: Pick<AppConfig, "studio">, env: NodeJS.ProcessEnv = process.env): "pt-BR" | "en" => {
  if (config.studio.language === "pt-BR" || config.studio.language === "en") return config.studio.language;
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").toLowerCase();
  return !locale || locale.startsWith("pt") || locale === "c" || locale.startsWith("c.") || locale === "posix" ? "pt-BR" : "en";
};
