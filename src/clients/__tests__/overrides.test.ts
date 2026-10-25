import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { facts, fixedClock, mediaSha, removeTempDirs, tempDir, uuid } from "../../people/__tests__/fixtures";
import type { TimesheetContext } from "../../timesheet/types";
import {
  CLIENT_OVERRIDE_ERRORS,
  CLIENT_OVERRIDE_KNOWN_ERRORS,
  CLIENT_OVERRIDE_LIMITS,
  type ClientOverridesFile,
  ClientOverridesStore,
  effectiveClients,
  overrideFor,
  validateClientOverrides
} from "../overrides";

afterEach(removeTempDirs);

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "ACME", name: "Acme Brasil", aliases: [], responsibleNames: [] },
    { code: "BETA", name: "Beta", aliases: [], responsibleNames: [] }
  ]
};

const newStore = async () => {
  const clock = fixedClock();
  const root = await tempDir("client-overrides-");
  return { clock, root, store: new ClientOverridesStore(join(root, "recording-cli", "client-overrides.json"), { now: clock.now, lockTimeoutMs: 2_000 }) };
};

const entry = (n: number, codes: string[], setAt = "2026-10-20T10:00:00.000Z", media = mediaSha(n)) =>
  ({ jobId: uuid(n), mediaSha256: media, clientCodes: codes, setAt });

describe("ClientOverridesStore", () => {
  test("missing file means no choices; setting one writes a private file", async () => {
    const { store } = await newStore();
    expect(await store.read()).toEqual({ version: 1, rev: 0, entries: [] });
    const file = await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"] });
    expect(file).toEqual({ version: 1, rev: 1, entries: [entry(1, ["ACME"], "2026-10-25T12:00:00.000Z")] });
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(file);
  });

  test("setting the same choice again changes nothing; a new choice replaces the old", async () => {
    const { store, clock } = await newStore();
    await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"] });
    expect((await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"] })).rev).toBe(1);
    clock.advance(1_000);
    const file = await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: [] });
    expect(file.rev).toBe(2);
    expect(file.entries).toEqual([entry(1, [], "2026-10-25T12:00:01.000Z")]);
  });

  test("clear goes back to the automatic rule", async () => {
    const { store } = await newStore();
    await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"] });
    await store.set({ jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: ["BETA"] });
    const file = await store.clear(uuid(1));
    expect(file.entries.map((item) => item.jobId)).toEqual([uuid(2)]);
    expect((await store.clear(uuid(1))).rev).toBe(file.rev);
  });

  test("clearing a reprocessed copy with its media really goes back to automatic", async () => {
    const { store } = await newStore();
    const media = mediaSha(40);
    // The choice was made on the first job; the reprocessed job (uuid 2) inherits it.
    await store.set({ jobId: uuid(1), mediaSha256: media, clientCodes: ["ACME"] });
    await store.set({ jobId: uuid(3), mediaSha256: mediaSha(3), clientCodes: ["BETA"] });
    expect(overrideFor(await store.read(), uuid(2), media)?.clientCodes).toEqual(["ACME"]);
    // Clearing only the job id leaves the inherited choice in force (what deletion wants).
    expect(overrideFor(await store.clear(uuid(2)), uuid(2), media)?.clientCodes).toEqual(["ACME"]);
    const cleared = await store.clear(uuid(2), { mediaSha256: media });
    expect(overrideFor(cleared, uuid(2), media)).toBeUndefined();
    expect(cleared.entries.map((item) => item.jobId)).toEqual([uuid(3)]);
    await expect(store.clear(uuid(2), { mediaSha256: "../x" })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidRecording);
  });

  test("input is validated before anything is written", async () => {
    const { store } = await newStore();
    await expect(store.set({ jobId: "x", mediaSha256: mediaSha(1), clientCodes: [] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    await expect(store.set({ jobId: uuid(1), mediaSha256: "abc", clientCodes: [] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    await expect(store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["A", "A"] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidCodes);
    await expect(store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["../x"] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidCodes);
    await expect(store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: Array.from({ length: 11 }, (_, n) => `C${n}`) })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidCodes);
    await expect(store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["GONE"], knownCodes: ["ACME"] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.unknownClient);
    await expect(store.clear("x")).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidRecording);
    expect(await fs.stat(store.path).catch(() => null)).toBeNull();
  });

  test("compare-and-swap on rev; concurrent writers without rev are serialized", async () => {
    const { store } = await newStore();
    await store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: ["ACME"], expectedRev: 0 });
    await expect(store.set({ jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: ["BETA"], expectedRev: 0 })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.stale);
    await expect(store.clear(uuid(1), { expectedRev: 7 })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.stale);
    await expect(store.set({ jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: [], expectedRev: 1.5 })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.stale);

    const results = await Promise.allSettled([3, 4, 5].map((n) => store.set({ jobId: uuid(n), mediaSha256: mediaSha(n), clientCodes: ["BETA"], expectedRev: 1 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    await Promise.all([6, 7, 8, 9].map((n) => store.set({ jobId: uuid(n), mediaSha256: mediaSha(n), clientCodes: ["ACME"] })));
    const file = await store.read();
    expect(file.rev).toBe(6);
    expect(file.entries).toHaveLength(6);
  });

  test("an invalid or unsafe file is refused and never replaced", async () => {
    const { store } = await newStore();
    await fs.mkdir(join(store.path, ".."), { recursive: true });
    const bad = [
      "nope",
      JSON.stringify({ version: 1, rev: 0, entries: [entry(1, ["ACME"]), entry(1, ["BETA"])] }),
      JSON.stringify({ version: 1, rev: 0, entries: [{ ...entry(1, ["ACME"]), setAt: "ontem" }] }),
      JSON.stringify({ version: 2, rev: 0, entries: [] })
    ];
    for (const content of bad) {
      await fs.writeFile(store.path, content, { mode: 0o600 });
      await expect(store.read()).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidFile);
      await expect(store.set({ jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: [] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidFile);
      expect(await fs.readFile(store.path, "utf8")).toBe(content);
    }
    await fs.rm(store.path);
    const elsewhere = join(store.path, "..", "elsewhere.json");
    await fs.writeFile(elsewhere, JSON.stringify({ version: 1, rev: 0, entries: [] }));
    await fs.symlink(elsewhere, store.path);
    await expect(store.read()).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidFile);
    await expect(store.set({ jobId: uuid(2), mediaSha256: mediaSha(2), clientCodes: [] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.invalidFile);
    expect(await fs.readFile(elsewhere, "utf8")).toBe(JSON.stringify({ version: 1, rev: 0, entries: [] }));
  });

  test("the file stays bounded: the oldest choices go first", async () => {
    const { store } = await newStore();
    const file: ClientOverridesFile = {
      version: 1, rev: 0,
      entries: Array.from({ length: CLIENT_OVERRIDE_LIMITS.maxEntries }, (_, n) => entry(n + 1, [], new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString()))
    };
    expect(validateClientOverrides(file).entries).toHaveLength(CLIENT_OVERRIDE_LIMITS.maxEntries);
    expect(() => validateClientOverrides({ ...file, entries: [...file.entries, entry(99_999, [])] })).toThrow(CLIENT_OVERRIDE_ERRORS.invalidFile);
    await fs.mkdir(join(store.path, ".."), { recursive: true });
    await fs.writeFile(store.path, JSON.stringify(file), { mode: 0o600 });
    const saved = await store.set({ jobId: uuid(99_999), mediaSha256: mediaSha(99_999), clientCodes: ["ACME"] });
    expect(saved.entries).toHaveLength(CLIENT_OVERRIDE_LIMITS.maxEntries);
    expect(saved.entries.some((item) => item.jobId === uuid(1))).toBe(false);
    expect(saved.entries[saved.entries.length - 1]!.jobId).toBe(uuid(99_999));
  });

  test("validation rebuilds entries and drops unknown fields", () => {
    expect(validateClientOverrides({ version: 1, rev: 2, extra: 1, entries: [{ ...entry(1, ["ACME"]), note: "x" }] }))
      .toEqual({ version: 1, rev: 2, entries: [entry(1, ["ACME"])] });
  });

  test("a file that cannot be created on disk fails with a Portuguese message", async () => {
    const parent = join(await tempDir("overrides-blocked-"), "not-a-directory");
    await fs.writeFile(parent, "x");
    const store = new ClientOverridesStore(join(parent, "client-overrides.json"), { lockTimeoutMs: 2_000 });
    await expect(store.read()).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.storage);
    await expect(store.set({ jobId: uuid(1), mediaSha256: mediaSha(1), clientCodes: [] })).rejects.toThrow(CLIENT_OVERRIDE_ERRORS.storage);
  });

  test("every error message is listed for translation", () => {
    for (const message of Object.values(CLIENT_OVERRIDE_ERRORS)) expect(CLIENT_OVERRIDE_KNOWN_ERRORS).toContain(message);
  });
});

describe("choices applied to indexed facts", () => {
  const file: ClientOverridesFile = {
    version: 1, rev: 3,
    entries: [
      entry(1, ["BETA"]),
      entry(2, []),
      entry(3, ["GONE"]),
      entry(4, ["ACME"], "2026-10-01T00:00:00.000Z", mediaSha(40)),
      entry(5, ["BETA"], "2026-10-02T00:00:00.000Z", mediaSha(40))
    ]
  };
  const automatic = [{ code: "ACME", name: "Acme (índice)", source: "content-match" as const, confidence: 0.6 }];

  test("a recording's own choice wins over what the index derived", () => {
    expect(effectiveClients(facts(1, { clients: automatic }), file, catalog)).toEqual([{ code: "BETA", name: "Beta", source: "manual", confidence: 1 }]);
  });

  test("'no client' hides the derived client", () => {
    expect(effectiveClients(facts(2, { clients: automatic }), file, catalog)).toEqual([]);
  });

  test("a choice of deleted clients falls back to the derived ones, still limited to the catalog", () => {
    expect(effectiveClients(facts(3, { clients: automatic }), file, catalog)).toEqual([{ code: "ACME", name: "Acme Brasil", source: "content-match", confidence: 0.6 }]);
    expect(effectiveClients(facts(3, { clients: [{ ...automatic[0]!, code: "OLD" }] }), file, catalog)).toEqual([]);
  });

  test("a reprocessed recording inherits the latest choice made for its media", () => {
    expect(overrideFor(file, uuid(9), mediaSha(40))?.clientCodes).toEqual(["BETA"]);
    expect(overrideFor(file, uuid(9))).toBeUndefined();
    expect(overrideFor(undefined, uuid(1), mediaSha(1))).toBeUndefined();
    expect(effectiveClients(facts(9, { mediaSha256: mediaSha(40), clients: automatic }), file, catalog)[0]!.code).toBe("BETA");
  });

  test("without a catalog, codes pass through and duplicates are dropped", () => {
    const doubled = [...automatic, { ...automatic[0]!, source: "entry-locked" as const, confidence: 1 }];
    expect(effectiveClients(facts(7, { clients: doubled }))).toEqual([automatic[0]!]);
    expect(effectiveClients(facts(1, { clients: automatic }), file)).toEqual([{ code: "BETA", name: "BETA", source: "manual", confidence: 1 }]);
  });
});
