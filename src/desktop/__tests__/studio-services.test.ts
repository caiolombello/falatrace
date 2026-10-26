import { expect, test } from "bun:test";
import type { AppServices } from "../../app/context";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import type { JobFacts } from "../../library-index/types";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { LIBRARY_REFRESH_MIN_AGE_MS, StudioServices } from "../studio-services";

assertQaIsolation();

/** Services whose index refresh waits for the test to release it; nothing touches the disk but the people store read. */
const fakeServices = () => {
  const state = { refreshes: 0, closed: 0, release: () => {} };
  const facts = [{ jobId: "123e4567-e89b-42d3-a456-426614174042", actions: [] } as unknown as JobFacts];
  const create = (config: AppConfig): AppServices => ({
    config,
    index: {
      refresh: async () => {
        state.refreshes += 1;
        await new Promise<void>((resolve) => { state.release = resolve; });
      },
      listFacts: async () => facts
    },
    close: async () => { state.closed += 1; }
  }) as unknown as AppServices;
  return { state, create };
};

test("the index refreshes in the background once at a time, and pages wait the minimum age between refreshes", async () => {
  let now = 1_000_000;
  const { state, create } = fakeServices();
  const studio = new StudioServices({ loadConfig: async () => DEFAULT_CONFIG, create, presence: async () => null, now: () => now });
  expect(studio.refreshing).toBe(false);
  expect(studio.factsLoaded).toBe(false);
  studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  expect(studio.refreshing).toBe(true);
  // Facts already on disk are read before the refresh: pages see them while it runs.
  while (state.refreshes === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(studio.factsLoaded).toBe(true);
  expect(studio.cachedFacts(["123E4567-E89B-42D3-A456-426614174042"])?.jobId).toBe("123e4567-e89b-42d3-a456-426614174042");
  expect(studio.cachedOpenActions("123e4567-e89b-42d3-a456-426614174042")).toBe(0);
  studio.refreshInBackground();
  expect(state.refreshes).toBe(1);
  state.release();
  await studio.whenIdle();
  expect(studio.refreshing).toBe(false);
  // Within the minimum age nothing starts; after it, a page starts one again; an explicit refresh never waits.
  now += LIBRARY_REFRESH_MIN_AGE_MS - 1;
  studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  expect(studio.refreshing).toBe(false);
  now += 2;
  studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  expect(studio.refreshing).toBe(true);
  while (state.refreshes === 1) await new Promise((resolve) => setTimeout(resolve, 1));
  state.release();
  await studio.whenIdle();
  studio.markRefreshed();
  studio.refreshInBackground(LIBRARY_REFRESH_MIN_AGE_MS);
  expect(studio.refreshing).toBe(false);
  studio.refreshInBackground();
  expect(studio.refreshing).toBe(true);
  while (state.refreshes === 2) await new Promise((resolve) => setTimeout(resolve, 1));
  state.release();
  await studio.close();
  expect(studio.refreshing).toBe(false);
});

test("a changed configuration gets new services; closing stops all of them and releases the presence lock", async () => {
  let config = structuredClone(DEFAULT_CONFIG);
  const { state, create } = fakeServices();
  let released = 0;
  let held = 0;
  const studio = new StudioServices({
    loadConfig: async () => config, create,
    presence: async () => { held += 1; return { release: async () => { released += 1; } } as never; }
  });
  studio.holdPresence();
  studio.holdPresence();
  const first = await studio.services();
  expect(await studio.services()).toBe(first);
  config = structuredClone(DEFAULT_CONFIG);
  config.assistant.provider = "api";
  const second = await studio.services();
  expect(second).not.toBe(first);
  expect(second.config.assistant.provider).toBe("api");
  await studio.close();
  expect(state.closed).toBe(2);
  expect(held).toBe(1);
  expect(released).toBe(1);
  // Closed: nothing starts again.
  studio.refreshInBackground();
  studio.holdPresence();
  expect(studio.refreshing).toBe(false);
  expect(held).toBe(1);
});
