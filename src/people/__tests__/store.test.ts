import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  PEOPLE_ERRORS,
  PEOPLE_KNOWN_ERRORS,
  PEOPLE_LIMITS,
  PeopleDirectory,
  PeopleStore,
  cleanPersonName,
  factParticipants,
  personKey,
  validatePeopleFile
} from "../store";
import { fixedClock, removeTempDirs, speaker, tempDir, uuid } from "./fixtures";

afterEach(removeTempDirs);

const newStore = async () => {
  const root = join(await tempDir("people-store-"), "people");
  let next = 1;
  const clock = fixedClock();
  return { root, clock, store: new PeopleStore(root, { now: clock.now, newId: () => uuid(next++), lockTimeoutMs: 2_000 }) };
};

describe("person identity", () => {
  test("folds case, accents and spacing into one key", () => {
    expect(personKey("  José   da SILVA ")).toBe("jose da silva");
    expect(personKey("Ánà")).toBe(personKey("ana"));
    expect(personKey(personKey("Çelik Öz"))).toBe(personKey("Çelik Öz"));
  });

  test("validates typed names", () => {
    expect(cleanPersonName("  Ana   Souza ")).toBe("Ana Souza");
    expect(() => cleanPersonName("Ana\nSouza")).toThrow(PEOPLE_ERRORS.invalidName);
    expect(() => cleanPersonName("")).toThrow(PEOPLE_ERRORS.invalidName);
    expect(() => cleanPersonName("x".repeat(81))).toThrow(PEOPLE_ERRORS.invalidName);
    expect(() => cleanPersonName(42)).toThrow(PEOPLE_ERRORS.invalidName);
  });

  test("participants keep confirmed names and attendees, never default diarizer labels", () => {
    const participants = factParticipants({
      speakers: [speaker("Ana"), speaker("Falante 2", true), speaker("Bruno", false), speaker("Speaker 3", true)],
      attendees: [{ name: "Caio", self: true }, { name: "  Dora  Lima ", self: false }]
    });
    expect(participants).toEqual([
      { name: "Ana", role: "speaker", self: false },
      { name: "Caio", role: "attendee", self: true },
      { name: "Dora Lima", role: "attendee", self: false }
    ]);
  });
});

describe("PeopleStore", () => {
  test("a missing file is an empty store; the first edit writes a private file", async () => {
    const { store, root } = await newStore();
    expect(await store.read()).toEqual({ version: 1, rev: 0, people: [] });
    const result = await store.rename("name:ana", "Ana Souza", { currentName: "ana" });
    expect(result.changed).toBe(true);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("renaming a name nobody edited creates a record that still answers to the old name", async () => {
    const { store } = await newStore();
    const { file, personId } = await store.rename("name:ana", "Ana Souza", { currentName: "Aná" });
    expect(personId).toBe(uuid(1));
    expect(file.rev).toBe(1);
    expect(file.people[0]).toMatchObject({ id: uuid(1), displayName: "Ana Souza", aliases: ["Aná"], hidden: false });
    const directory = new PeopleDirectory(file);
    expect(directory.idForName("ana")).toBe(uuid(1));
    expect(directory.idForName("ANA SOUZA")).toBe(uuid(1));
    expect(directory.resolveId("name:ana")?.id).toBe(uuid(1));
    expect(directory.idForName("Bruno")).toBe("name:bruno");
  });

  test("a hint that is not the same name falls back to the key", async () => {
    const { store } = await newStore();
    const { file } = await store.rename("name:ana", "Ana Souza", { currentName: "Beatriz" });
    expect(file.people[0]!.aliases).toEqual(["ana"]);
  });

  test("renaming a stored person keeps the previous display name as an alias, once", async () => {
    const { store } = await newStore();
    await store.rename("name:ana", "Ana Souza", { currentName: "Ana" });
    const second = await store.rename(uuid(1), "Ana S.");
    expect(second.file.people[0]).toMatchObject({ displayName: "Ana S.", aliases: ["Ana", "Ana Souza"] });
    const back = await store.rename(uuid(1), "ana souza");
    expect(back.file.people[0]).toMatchObject({ displayName: "ana souza", aliases: ["Ana", "Ana S."] });
    expect(back.file.rev).toBe(3);
  });

  test("a name that belongs to someone else is refused", async () => {
    const { store } = await newStore();
    await store.rename("name:ana", "Ana Souza", { currentName: "Ana" });
    await expect(store.rename("name:bruno", "Ana")).rejects.toThrow(PEOPLE_ERRORS.conflict);
    await expect(store.addAlias("name:bruno", "ana souza")).rejects.toThrow(PEOPLE_ERRORS.conflict);
    expect((await store.read()).rev).toBe(1);
  });

  test("aliases can be added and removed; a duplicate alias changes nothing", async () => {
    const { store } = await newStore();
    const added = await store.addAlias("name:ana souza", "Aninha", { currentName: "Ana Souza" });
    expect(added.file.people[0]).toMatchObject({ displayName: "Ana Souza", aliases: ["Aninha"] });
    const again = await store.addAlias(uuid(1), "ANINHA");
    expect(again.changed).toBe(false);
    expect(again.file.rev).toBe(1);
    expect((await store.addAlias("name:ana souza", "Ana Souza")).changed).toBe(false);
    const removed = await store.removeAlias(uuid(1), "aninha");
    expect(removed.file.people[0]!.aliases).toEqual([]);
    await expect(store.removeAlias(uuid(1), "Aninha")).rejects.toThrow(PEOPLE_ERRORS.aliasMissing);
    await expect(store.removeAlias("name:bruno", "Bruno")).rejects.toThrow(PEOPLE_ERRORS.aliasMissing);
  });

  test("an alias for a name nobody edited is a no-op when it is the same name", async () => {
    const { store } = await newStore();
    const result = await store.addAlias("name:ana", "Aná");
    expect(result).toMatchObject({ changed: false, personId: "name:ana" });
    expect(await fs.stat(store.path).catch(() => null)).toBeNull();
  });

  test("aliases are limited", async () => {
    const { store } = await newStore();
    for (let index = 0; index < PEOPLE_LIMITS.maxAliases; index++) await store.addAlias("name:ana", `Apelido ${index}`, { currentName: "Ana" });
    await expect(store.addAlias("name:ana", "Mais um")).rejects.toThrow(PEOPLE_ERRORS.aliasesFull);
    await expect(store.rename("name:ana", "Ana Souza")).rejects.toThrow(PEOPLE_ERRORS.aliasesFull);
  });

  test("merging a name into a person makes it an alias of that person", async () => {
    const { store } = await newStore();
    const merged = await store.merge("name:aninha", "name:ana souza", { sourceName: "Aninha", targetName: "Ana Souza" });
    expect(merged.personId).toBe(uuid(1));
    expect(merged.file.people).toHaveLength(1);
    expect(merged.file.people[0]).toMatchObject({ displayName: "Ana Souza", aliases: ["Aninha"] });
    const directory = new PeopleDirectory(merged.file);
    expect(directory.resolveId("name:aninha")?.id).toBe(uuid(1));
    await expect(store.merge("name:aninha", uuid(1))).rejects.toThrow(PEOPLE_ERRORS.mergeSelf);
  });

  test("merging stored people chains to the final record and can be undone", async () => {
    const { store } = await newStore();
    await store.rename("name:a", "Alice", { currentName: "A" });            // uuid(1)
    await store.rename("name:b", "Beatriz", { currentName: "B" });          // uuid(2)
    await store.rename("name:c", "Carla", { currentName: "C" });            // uuid(3)
    await store.merge(uuid(1), uuid(2));
    const second = await store.merge(uuid(2), uuid(3));
    // Records that pointed at the source now point at the target directly.
    expect(second.file.people.map((person) => [person.id, person.mergedInto])).toEqual([[uuid(1), uuid(3)], [uuid(2), uuid(3)], [uuid(3), undefined]]);
    const directory = new PeopleDirectory(second.file);
    expect(directory.idForName("Alice")).toBe(uuid(3));
    expect(directory.idForName("b")).toBe(uuid(3));
    expect(directory.resolveId(uuid(1))?.id).toBe(uuid(3));
    expect(directory.members(uuid(3)).map((person) => person.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    await expect(store.merge(uuid(1), uuid(3))).rejects.toThrow(PEOPLE_ERRORS.mergeSelf);

    const undone = await store.unmerge(uuid(2));
    expect(new PeopleDirectory(undone.file).idForName("Beatriz")).toBe(uuid(2));
    expect(new PeopleDirectory(undone.file).idForName("Alice")).toBe(uuid(3));
    await expect(store.unmerge(uuid(3))).rejects.toThrow(PEOPLE_ERRORS.notMerged);
    await expect(store.unmerge(uuid(99))).rejects.toThrow(PEOPLE_ERRORS.notFound);
    await expect(store.unmerge("name:x")).rejects.toThrow(PEOPLE_ERRORS.invalidId);
  });

  test("hiding creates a record only when needed", async () => {
    const { store } = await newStore();
    expect((await store.setHidden("name:bot", false)).changed).toBe(false);
    const hidden = await store.setHidden("name:bot", true, { currentName: "Bot" });
    expect(hidden.file.people[0]).toMatchObject({ displayName: "Bot", hidden: true });
    expect(new PeopleDirectory(hidden.file).isHidden(uuid(1))).toBe(true);
    const shown = await store.setHidden(uuid(1), false);
    expect(shown.file.people[0]!.hidden).toBe(false);
  });

  test("updatedAt changes only on the touched record", async () => {
    const { store, clock } = await newStore();
    await store.rename("name:a", "Alice", { currentName: "A" });
    await store.rename("name:b", "Beatriz", { currentName: "B" });
    clock.advance(60_000);
    const { file } = await store.addAlias(uuid(2), "Bia");
    expect(file.people[0]!.updatedAt).toBe("2026-10-25T12:00:00.000Z");
    expect(file.people[1]!.updatedAt).toBe("2026-10-25T12:01:00.000Z");
    expect(file.people[1]!.createdAt).toBe("2026-10-25T12:00:00.000Z");
  });

  test("ids are checked", async () => {
    const { store } = await newStore();
    await expect(store.rename("../../etc", "Ana")).rejects.toThrow(PEOPLE_ERRORS.invalidId);
    await expect(store.rename(uuid(5), "Ana")).rejects.toThrow(PEOPLE_ERRORS.notFound);
    await expect(store.rename("name:Ana", "Ana")).rejects.toThrow(PEOPLE_ERRORS.notFound);
    expect(new PeopleDirectory().resolveId("name:a\nb")).toBeUndefined();
    expect(new PeopleDirectory().resolveId(42)).toBeUndefined();
  });

  test("compare-and-swap on rev", async () => {
    const { store } = await newStore();
    await store.rename("name:ana", "Ana", { expectedRev: 0 });
    await expect(store.addAlias(uuid(1), "Aninha", { expectedRev: 0 })).rejects.toThrow(PEOPLE_ERRORS.stale);
    await expect(store.addAlias(uuid(1), "Aninha", { expectedRev: -1 })).rejects.toThrow(PEOPLE_ERRORS.stale);
    expect((await store.addAlias(uuid(1), "Aninha", { expectedRev: 1 })).file.rev).toBe(2);
  });

  test("concurrent edits with the same rev: exactly one wins", async () => {
    const { store } = await newStore();
    await store.rename("name:ana", "Ana");
    const results = await Promise.allSettled([
      store.addAlias(uuid(1), "Aninha", { expectedRev: 1 }),
      store.addAlias(uuid(1), "Nana", { expectedRev: 1 }),
      store.setHidden(uuid(1), true, { expectedRev: 1 })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect((result.reason as Error).message).toBe(PEOPLE_ERRORS.stale);
    expect((await store.read()).rev).toBe(2);
  });

  test("concurrent edits without rev are serialized, none is lost", async () => {
    const { store } = await newStore();
    await store.rename("name:ana", "Ana");
    await Promise.all(["Um", "Dois", "Tres", "Quatro"].map((alias) => store.addAlias(uuid(1), alias)));
    const file = await store.read();
    expect(file.rev).toBe(5);
    expect([...file.people[0]!.aliases].sort()).toEqual(["Dois", "Quatro", "Tres", "Um"]);
  });

  test("an invalid file is refused and never replaced", async () => {
    const { store, root } = await newStore();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    for (const content of [
      "{not json",
      JSON.stringify({ version: 2, rev: 0, people: [] }),
      JSON.stringify({ version: 1, rev: 0, people: [{ id: uuid(1), displayName: "A\nB", aliases: [], hidden: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }] }),
      JSON.stringify({ version: 1, rev: 0, people: [
        { id: uuid(1), displayName: "A", aliases: [], hidden: false, mergedInto: uuid(2), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
        { id: uuid(2), displayName: "B", aliases: [], hidden: false, mergedInto: uuid(1), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }
      ] }),
      JSON.stringify({ version: 1, rev: 0, people: [{ id: uuid(1), displayName: "A", aliases: [], hidden: false, mergedInto: uuid(9), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }] })
    ]) {
      await fs.writeFile(store.path, content, { mode: 0o600 });
      await expect(store.read()).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
      await expect(store.rename("name:ana", "Ana")).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
      expect(await fs.readFile(store.path, "utf8")).toBe(content);
    }
  });

  test("a symlinked file or oversized file is refused", async () => {
    const { store, root } = await newStore();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const elsewhere = join(root, "..", "elsewhere.json");
    await fs.writeFile(elsewhere, JSON.stringify({ version: 1, rev: 0, people: [] }));
    await fs.symlink(elsewhere, store.path);
    await expect(store.read()).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
    await expect(store.rename("name:ana", "Ana")).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
    expect(await fs.readFile(elsewhere, "utf8")).toBe(JSON.stringify({ version: 1, rev: 0, people: [] }));
    await fs.rm(store.path);
    await fs.writeFile(store.path, " ".repeat(PEOPLE_LIMITS.maxFileBytes + 1));
    await expect(store.read()).rejects.toThrow(PEOPLE_ERRORS.invalidFile);
  });

  test("validation rebuilds records and drops unknown fields", () => {
    const file = validatePeopleFile({
      version: 1, rev: 3, extra: true,
      people: [{ id: uuid(1), displayName: "Ana", aliases: ["Aninha"], hidden: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", email: "x@y.z" }]
    });
    expect(file).toEqual({ version: 1, rev: 3, people: [{ id: uuid(1), displayName: "Ana", aliases: ["Aninha"], hidden: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }] });
    expect(() => validatePeopleFile({ version: 1, rev: 0, people: [{ id: uuid(1), displayName: "Ana", aliases: [], hidden: false, createdAt: "x", updatedAt: "y" }] })).toThrow(PEOPLE_ERRORS.invalidFile);
    expect(() => validatePeopleFile({ version: 1, rev: 0, people: Array.from({ length: PEOPLE_LIMITS.maxPeople + 1 }, () => ({})) })).toThrow(PEOPLE_ERRORS.invalidFile);
  });

  test("when two records claim a name, the first one wins", () => {
    const record = (n: number, name: string) => ({ id: uuid(n), displayName: name, aliases: [], hidden: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
    const directory = new PeopleDirectory(validatePeopleFile({ version: 1, rev: 0, people: [record(1, "Ana"), record(2, "ANA")] }));
    expect(directory.idForName("ana")).toBe(uuid(1));
  });

  test("a store that cannot be created on disk fails with a Portuguese message", async () => {
    const parent = join(await tempDir("people-blocked-"), "not-a-directory");
    await fs.writeFile(parent, "x");
    const store = new PeopleStore(join(parent, "people"), { lockTimeoutMs: 2_000 });
    await expect(store.read()).rejects.toThrow(PEOPLE_ERRORS.storage);
    await expect(store.rename("name:ana", "Ana")).rejects.toThrow(PEOPLE_ERRORS.storage);
  });

  test("every error message is listed for translation", () => {
    for (const message of Object.values(PEOPLE_ERRORS)) expect(PEOPLE_KNOWN_ERRORS).toContain(message);
  });
});
