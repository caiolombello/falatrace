import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTES_ERRORS, notesText } from "../lines";
import {
  NOTES_MAX_FILE_BYTES, NotesConflictError, NotesStore, clearNotesIndexCache, defaultNotesDir, findNotesForJob, validateMeetingNotes,
  type MeetingNotes
} from "../store";

const START = "2026-10-25T10:00:00.000Z";
const at = (seconds: number): Date => new Date(Date.parse(START) + seconds * 1000);
const mode = async (path: string): Promise<number> => (await fs.stat(path)).mode & 0o777;

let dir: string;
let root: string;
let store: NotesStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "notes-"));
  root = join(dir, "notes");
  store = new NotesStore(root);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const writeRaw = async (id: string, value: unknown): Promise<string> => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${id}.json`);
  await fs.writeFile(path, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
};
const validFile = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1, id, createdAt: START, updatedAt: START, rev: 1, seq: 1,
  entries: [{ id: "n000001", createdAt: START, offsetSeconds: 0, text: "ok" }], ...extra
});

describe("NotesStore.save and read", () => {
  test("the first save creates a private version 1 file with rev 1", async () => {
    const id = randomUUID();
    const saved = await store.save(id, {
      text: "# Pauta\r\n- prazo sexta\n", expectedRev: 0, now: at(30), mediaStartedAt: START, sourcePath: "/rec/a/recording.mkv", title: "Reunião semanal"
    });
    expect(saved).toEqual({
      version: 1, id, createdAt: at(30).toISOString(), updatedAt: at(30).toISOString(), rev: 1, mediaStartedAt: START,
      sourcePath: "/rec/a/recording.mkv", title: "Reunião semanal", seq: 2,
      entries: [
        { id: "n000001", createdAt: at(30).toISOString(), offsetSeconds: 30, text: "# Pauta" },
        { id: "n000002", createdAt: at(30).toISOString(), offsetSeconds: 30, text: "- prazo sexta" }
      ]
    });
    expect(await mode(root)).toBe(0o700);
    expect(await mode(join(root, `${id}.json`))).toBe(0o600);
    expect(JSON.parse(await fs.readFile(join(root, `${id}.json`), "utf8")).version).toBe(1);
    expect(await store.read(id)).toEqual(saved);
    expect(notesText(saved)).toBe("# Pauta\n- prazo sexta");
    expect(await fs.readdir(root)).toEqual([`${id}.json`]);
  });

  test("edits across saves keep each line's id, createdAt and offset", async () => {
    const id = randomUUID();
    const first = await store.save(id, { text: "# Pauta\nLigar pro Joao\nfim", expectedRev: 0, now: at(10), mediaStartedAt: START });
    const second = await store.save(id, { text: "# Pauta\n- novo ponto\nLigar pro João\nfim", expectedRev: 1, now: at(70) });
    expect(second.rev).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(at(70).toISOString());
    expect(second.entries.map((entry) => [entry.id, entry.offsetSeconds, entry.text])).toEqual([
      ["n000001", 10, "# Pauta"], ["n000004", 70, "- novo ponto"], ["n000002", 10, "Ligar pro João"], ["n000003", 10, "fim"]
    ]);
    const third = await store.save(id, { text: "fim\n# Pauta\nLigar pro João", expectedRev: 2, now: at(90) });
    expect(third.entries.map((entry) => entry.id)).toEqual(["n000003", "n000001", "n000002"]);
    const fourth = await store.save(id, { text: "fim\n# Pauta\nLigar pro João\nalgo bem diferente", expectedRev: 3, now: at(95) });
    expect(fourth.entries[3].id).toBe("n000005");
    expect(await store.read(id)).toEqual(fourth);
  });

  test("autosaves while typing keep the moment each line was started; a pasted block is stamped at paste time", async () => {
    const id = randomUUID();
    let rev = 0;
    const type = async (text: string, seconds: number) => { rev = (await store.save(id, { text, expectedRev: rev, now: at(seconds), mediaStartedAt: START })).rev; };
    await type("L", 61);
    await type("Ligar", 62);
    await type("Ligar pro Jo", 64);
    await type("Ligar pro João amanhã\n", 66);
    await type("Ligar pro João amanhã\nE", 80);
    await type("Ligar pro João amanhã\nEnviar proposta", 85);
    const pasted = Array.from({ length: 50 }, (_, index) => `- item colado ${index}`).join("\n");
    await type(`Ligar pro João amanhã\n${pasted}\nEnviar proposta revisada`, 120);
    const notes = await store.read(id);
    expect(notes?.entries[0]).toMatchObject({ id: "n000001", offsetSeconds: 61, text: "Ligar pro João amanhã" });
    expect(notes?.entries[51]).toMatchObject({ id: "n000002", offsetSeconds: 80, text: "Enviar proposta revisada" });
    expect(notes?.entries.slice(1, 51).every((entry) => entry.offsetSeconds === 120)).toBe(true);
    expect(notes?.seq).toBe(52);
  });

  test("a stale revision is refused with the conflict error and the file is left as it was", async () => {
    const id = randomUUID();
    await store.save(id, { text: "versão A", expectedRev: 0, now: at(1) });
    const before = await fs.readFile(store.pathFor(id), "utf8");
    for (const expectedRev of [0, 2, 7]) {
      const error = await store.save(id, { text: "versão B", expectedRev, now: at(2) }).catch((caught) => caught);
      expect(error).toBeInstanceOf(NotesConflictError);
      expect(error.message).toBe("As notas mudaram em outra janela; recarregue antes de salvar.");
    }
    expect(await fs.readFile(store.pathFor(id), "utf8")).toBe(before);
    await expect(store.save(randomUUID(), { text: "nova", expectedRev: 1 })).rejects.toThrow(NOTES_ERRORS.conflict);
  });

  test("concurrent saves based on the same revision: exactly one wins", async () => {
    const id = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => store.save(id, { text: `janela ${index}`, expectedRev: 0 })));
    const won = results.filter((result): result is PromiseFulfilledResult<MeetingNotes> => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.every((result) => result.reason instanceof NotesConflictError)).toBe(true);
    const stored = await store.read(id);
    expect(stored?.rev).toBe(1);
    expect(stored?.entries[0].text).toBe(won[0].value.entries[0].text);
  });

  test("concurrent saves from two store instances on the same folder are serialized", async () => {
    const id = randomUUID();
    const other = new NotesStore(root);
    await store.save(id, { text: "base", expectedRev: 0 });
    const results = await Promise.allSettled([
      store.save(id, { text: "base\nda janela 1", expectedRev: 1 }),
      other.save(id, { text: "base\nda janela 2", expectedRev: 1 })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.read(id))?.rev).toBe(2);
  });

  test("an unchanged save neither writes nor bumps the revision", async () => {
    const id = randomUUID();
    const saved = await store.save(id, { text: "a\nb", expectedRev: 0, now: at(1), title: "T" });
    const before = await fs.stat(store.pathFor(id));
    const again = await store.save(id, { text: "a  \r\n\r\nb\n", expectedRev: 1, now: at(500), title: "T" });
    expect(again).toEqual(saved);
    const after = await fs.stat(store.pathFor(id));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });

  test("an empty notepad is not written until it has content; clearing later keeps the file", async () => {
    const id = randomUUID();
    const empty = await store.save(id, { text: "  \n\n", expectedRev: 0, now: at(1) });
    expect(empty.rev).toBe(0);
    expect(empty.entries).toEqual([]);
    expect(await fs.stat(root).catch(() => null)).toBeNull();
    expect(await store.read(id)).toBeUndefined();
    const first = await store.save(id, { text: "algo", expectedRev: 0, now: at(2) });
    expect(first.rev).toBe(1);
    const cleared = await store.save(id, { text: "", expectedRev: 1, now: at(3) });
    expect(cleared.rev).toBe(2);
    expect(cleared.entries).toEqual([]);
    expect(cleared.seq).toBe(1);
    expect((await store.read(id))?.entries).toEqual([]);
  });

  test("metadata is kept when omitted; the title is flattened, bounded and cleared with an empty string", async () => {
    const id = randomUUID();
    await store.save(id, { text: "a", expectedRev: 0, sourcePath: "/rec/a/../b/recording.mkv", title: `  Reunião\n\tcom   cliente${String.fromCharCode(0)}  ` });
    let stored = await store.read(id);
    expect(stored?.sourcePath).toBe("/rec/b/recording.mkv");
    expect(stored?.title).toBe("Reunião com cliente");
    await store.save(id, { text: "a\nb", expectedRev: 1 });
    stored = await store.read(id);
    expect([stored?.sourcePath, stored?.title]).toEqual(["/rec/b/recording.mkv", "Reunião com cliente"]);
    await store.save(id, { text: "a\nb", expectedRev: 2, title: "x".repeat(500) });
    expect((await store.read(id))?.title).toBe("x".repeat(200));
    await store.save(id, { text: "a\nb", expectedRev: 3, title: `${"y".repeat(199)}😀` });
    expect((await store.read(id))?.title).toBe("y".repeat(199));
    await store.save(id, { text: "a\nb", expectedRev: 4, title: "" });
    expect((await store.read(id))?.title).toBeUndefined();
  });

  test("ids are normalized to lowercase", async () => {
    const id = randomUUID();
    await store.save(id.toUpperCase(), { text: "a", expectedRev: 0 });
    expect(await fs.readdir(root)).toEqual([`${id}.json`]);
    expect((await store.read(id))?.id).toBe(id);
  });

  test("invalid input is rejected with clear errors and writes nothing", async () => {
    const id = randomUUID();
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => store.save("../../etc/passwd", { text: "a", expectedRev: 0 }), NOTES_ERRORS.invalidId],
      [() => store.save("00000000-0000-1000-8000-000000000000", { text: "a", expectedRev: 0 }), NOTES_ERRORS.invalidId],
      [() => store.read(`${id}/../x`), NOTES_ERRORS.invalidId],
      [() => store.save(id, { text: "a", expectedRev: -1 }), NOTES_ERRORS.invalidRev],
      [() => store.save(id, { text: "a", expectedRev: 1.5 }), NOTES_ERRORS.invalidRev],
      [() => store.save(id, { text: "a", expectedRev: "0" } as never), NOTES_ERRORS.invalidRev],
      [() => store.save(id, { text: 5, expectedRev: 0 } as never), NOTES_ERRORS.invalidText],
      [() => store.save(id, null as never), NOTES_ERRORS.invalidText],
      [() => store.save(id, { text: "x".repeat(2001), expectedRev: 0 }), NOTES_ERRORS.lineTooLong],
      [() => store.save(id, { text: Array.from({ length: 501 }, (_, index) => `l${index}`).join("\n"), expectedRev: 0 }), NOTES_ERRORS.tooManyLines],
      [() => store.save(id, { text: "a", expectedRev: 0, now: new Date("nope") }), NOTES_ERRORS.invalidTime],
      [() => store.save(id, { text: "a", expectedRev: 0, mediaStartedAt: "ontem" }), NOTES_ERRORS.invalidMediaTime],
      [() => store.save(id, { text: "a", expectedRev: 0, mediaStartedAt: "2026-10-25" }), NOTES_ERRORS.invalidMediaTime],
      [() => store.save(id, { text: "a", expectedRev: 0, mediaStartedAt: START, mediaEndedAt: at(-5).toISOString() }), NOTES_ERRORS.invalidMediaTime],
      [() => store.save(id, { text: "a", expectedRev: 0, sourcePath: "relative/rec.mkv" }), NOTES_ERRORS.invalidSourcePath],
      [() => store.save(id, { text: "a", expectedRev: 0, sourcePath: "/rec/a\nb.mkv" }), NOTES_ERRORS.invalidSourcePath],
      [() => store.save(id, { text: "a", expectedRev: 0, sourcePath: `/${"x".repeat(5000)}` }), NOTES_ERRORS.invalidSourcePath],
      [() => store.save(id, { text: "a", expectedRev: 0, title: 5 } as never), NOTES_ERRORS.invalidTitle]
    ];
    for (const [run, message] of cases) await expect(run()).rejects.toThrow(message);
    expect(await fs.stat(root).catch(() => null)).toBeNull();
  });

  test("times that cannot be stored are refused as invalid times, not reported as damaged notes", async () => {
    const id = randomUUID();
    // Valid ISO input, but year 10000 once normalized to UTC: toISOString() would write "+010000-…".
    await expect(store.save(id, { text: "a", expectedRev: 0, mediaStartedAt: "9999-12-31T23:30:00-01:00" })).rejects.toThrow(NOTES_ERRORS.invalidMediaTime);
    await expect(store.save(id, { text: "a", expectedRev: 0, mediaEndedAt: "9999-12-31T23:30:00-01:00" })).rejects.toThrow(NOTES_ERRORS.invalidMediaTime);
    await expect(store.save(id, { text: "a", expectedRev: 0, now: new Date(Date.UTC(10_000, 0, 1)) })).rejects.toThrow(NOTES_ERRORS.invalidTime);
    await expect(store.save(id, { text: "a", expectedRev: 0, now: new Date(Date.UTC(-1, 0, 1)) })).rejects.toThrow(NOTES_ERRORS.invalidTime);
    await expect(new NotesStore(root, { now: () => new Date(Date.UTC(10_000, 0, 1)) }).save(id, { text: "a", expectedRev: 0 }))
      .rejects.toThrow(NOTES_ERRORS.invalidTime);
    expect(await fs.stat(root).catch(() => null)).toBeNull();
    const offset = await store.save(id, { text: "a", expectedRev: 0, now: at(5), mediaStartedAt: "2026-10-25T07:00:00-03:00" });
    expect(offset.mediaStartedAt).toBe(START);
    expect(offset.entries[0].offsetSeconds).toBe(5);
  });

  test("a corrected media start moves the timed notes; untimed notes stay untimed", async () => {
    const id = randomUUID();
    await store.save(id, { text: "sem tempo", expectedRev: 0, now: at(5) });
    const timed = await store.save(id, { text: "sem tempo\ncom tempo", expectedRev: 1, now: at(100), mediaStartedAt: START });
    expect(timed.entries.map((entry) => entry.offsetSeconds)).toEqual([null, 100]);
    const corrected = await store.save(id, { text: "sem tempo\ncom tempo", expectedRev: 2, now: at(101), mediaStartedAt: at(40).toISOString() });
    expect(corrected.rev).toBe(3);
    expect(corrected.mediaStartedAt).toBe(at(40).toISOString());
    expect(corrected.entries.map((entry) => entry.offsetSeconds)).toEqual([null, 60]);
  });

  test("after the capture stopped, a late note is untimed and the end must not precede the start", async () => {
    const id = randomUUID();
    await store.save(id, { text: "durante", expectedRev: 0, now: at(60), mediaStartedAt: START });
    const stopped = await store.save(id, { text: "durante\ndepois", expectedRev: 1, now: at(4000), mediaEndedAt: at(3000).toISOString() });
    expect(stopped.entries.map((entry) => entry.offsetSeconds)).toEqual([60, null]);
    await expect(store.save(id, { text: "durante", expectedRev: 2, mediaStartedAt: at(3500).toISOString() })).rejects.toThrow(NOTES_ERRORS.invalidMediaTime);
  });

  test("a busy lock is retried, then reported; other lock failures surface as they are", async () => {
    let attempts = 0;
    const busy = new NotesStore(root, {
      lockAttempts: 3, sleep: async () => undefined,
      lock: async (name) => { attempts++; throw new Error(`${name} is already running`); }
    });
    await expect(busy.save(randomUUID(), { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.busy);
    expect(attempts).toBe(3);
    const broken = new NotesStore(root, { lock: async () => { throw new Error("socket indisponível"); } });
    await expect(broken.save(randomUUID(), { text: "a", expectedRev: 0 })).rejects.toThrow("socket indisponível");
  });

  test("the lock is released after a failed save", async () => {
    const id = randomUUID();
    await store.save(id, { text: "a", expectedRev: 0 });
    await expect(store.save(id, { text: "b", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.conflict);
    const quick = new NotesStore(root, { lockAttempts: 1 });
    expect((await quick.save(id, { text: "b", expectedRev: 1 })).rev).toBe(2);
  });

  test("the injected clock is used when no time is given", async () => {
    const clocked = new NotesStore(root, { now: () => at(42) });
    const saved = await clocked.save(randomUUID(), { text: "a", expectedRev: 0, mediaStartedAt: START });
    expect(saved.entries[0]).toMatchObject({ createdAt: at(42).toISOString(), offsetSeconds: 42 });
    const broken = new NotesStore(root, { now: () => new Date(Number.NaN) });
    await expect(broken.save(randomUUID(), { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.invalidTime);
  });

  test("the default folder follows XDG_DATA_HOME", () => {
    const previous = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/tmp/xdg-data";
      expect(defaultNotesDir()).toBe("/tmp/xdg-data/recording-cli/notes");
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    }
  });
});

describe("damaged and unsafe files", () => {
  test("a damaged file is reported, kept untouched and never overwritten", async () => {
    const id = randomUUID();
    const variants: unknown[] = [
      "{not json", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), [], null,
      validFile(id, { version: 2 }), validFile(randomUUID()), validFile(id, { rev: 0 }), validFile(id, { rev: 1.5 }),
      validFile(id, { createdAt: "ontem" }), validFile(id, { mediaStartedAt: "x" }), validFile(id, { sourcePath: "relativo" }),
      validFile(id, { title: "a\nb" }), validFile(id, { title: "  espaços  " }), validFile(id, { seq: 0 }), validFile(id, { seq: 1_000_000 }),
      validFile(id, { mediaStartedAt: at(10).toISOString(), mediaEndedAt: START }),
      validFile(id, { entries: "x" }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, offsetSeconds: 0, text: "a" }, { id: "n000001", createdAt: START, offsetSeconds: 0, text: "b" }] }),
      validFile(id, { entries: [{ id: "n1", createdAt: START, offsetSeconds: 0, text: "a" }] }),
      validFile(id, { entries: [{ id: "n000000", createdAt: START, offsetSeconds: 0, text: "a" }] }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, offsetSeconds: -1, text: "a" }] }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, text: "a" }] }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, offsetSeconds: 0, text: "a\nb" }] }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, offsetSeconds: 0, text: "a " }] }),
      validFile(id, { entries: [{ id: "n000001", createdAt: START, offsetSeconds: 0, text: "x".repeat(2001) }] }),
      validFile(id, { seq: 600, entries: Array.from({ length: 501 }, (_, index) => ({ id: `n${String(index + 1).padStart(6, "0")}`, createdAt: START, offsetSeconds: 0, text: "a" })) }),
      validFile(id, { seq: 40, entries: Array.from({ length: 34 }, (_, index) => ({ id: `n${String(index + 1).padStart(6, "0")}`, createdAt: START, offsetSeconds: 0, text: "é".repeat(1000) })) })
    ];
    for (const value of variants) {
      const path = await writeRaw(id, value);
      const before = await fs.readFile(path);
      await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.corrupted);
      await expect(store.save(id, { text: "nova", expectedRev: 1 })).rejects.toThrow(NOTES_ERRORS.corrupted);
      expect((await fs.readFile(path)).equals(before)).toBe(true);
    }
  });

  test("an oversized file is refused without reading it whole", async () => {
    const id = randomUUID();
    await writeRaw(id, " ".repeat(NOTES_MAX_FILE_BYTES + 1));
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.corrupted);
  });

  test("unknown fields are dropped when the file is rebuilt", async () => {
    const id = randomUUID();
    await writeRaw(id, validFile(id, { evil: "<script>", entries: [{ id: "n000001", createdAt: START, offsetSeconds: null, text: "ok", extra: 1 }] }));
    const read = await store.read(id);
    expect(read).toEqual({ version: 1, id, createdAt: START, updatedAt: START, rev: 1, seq: 1, entries: [{ id: "n000001", createdAt: START, offsetSeconds: null, text: "ok" }] });
    await store.save(id, { text: "ok\nmais", expectedRev: 1 });
    expect(JSON.parse(await fs.readFile(store.pathFor(id), "utf8")).evil).toBeUndefined();
  });

  test("a missing seq is derived from the highest entry id", () => {
    const id = randomUUID();
    const file = validFile(id, { entries: [{ id: "n000007", createdAt: START, offsetSeconds: null, text: "a" }] });
    delete file.seq;
    expect(validateMeetingNotes(file, id).seq).toBe(7);
  });

  test("a symlinked notes file is refused and its target left alone", async () => {
    const id = randomUUID();
    const target = join(dir, "alvo.json");
    await fs.writeFile(target, JSON.stringify(validFile(id)));
    await fs.mkdir(root, { mode: 0o700 });
    await fs.symlink(target, join(root, `${id}.json`));
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeFile);
    await expect(store.save(id, { text: "x", expectedRev: 1 })).rejects.toThrow(NOTES_ERRORS.unsafeFile);
    expect(JSON.parse(await fs.readFile(target, "utf8")).entries[0].text).toBe("ok");
    expect(await store.remove(id)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toContain("ok");
  });

  test("a directory or a FIFO in place of the notes file is refused without blocking", async () => {
    const id = randomUUID();
    await fs.mkdir(join(root, `${id}.json`), { recursive: true });
    await fs.chmod(root, 0o700);
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeFile);
    await expect(store.remove(id)).rejects.toThrow(NOTES_ERRORS.unsafeFile);
    const fifoId = randomUUID();
    const made = Bun.spawnSync(["mkfifo", join(root, `${fifoId}.json`)]);
    if (made.exitCode === 0) await expect(store.read(fifoId)).rejects.toThrow(NOTES_ERRORS.unsafeFile);
  });

  test("a socket in place of the notes file is refused with the unsafe-file message", async () => {
    const id = randomUUID();
    await fs.mkdir(root, { mode: 0o700 });
    const server = createServer();
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(join(root, `${id}.json`), done); });
    try {
      await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeFile);
      await expect(store.save(id, { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.unsafeFile);
      expect((await fs.lstat(join(root, `${id}.json`))).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("the notes folder must be a private directory, not a link or a file", async () => {
    const id = randomUUID();
    const elsewhere = join(dir, "outro");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, root);
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    await expect(store.save(id, { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    await fs.rm(root);
    await fs.mkdir(root, { mode: 0o755 });
    await fs.chmod(root, 0o755);
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    await expect(store.save(id, { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    await fs.rm(root, { recursive: true });
    await fs.writeFile(root, "arquivo");
    await expect(store.read(id)).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    await expect(store.save(id, { text: "a", expectedRev: 0 })).rejects.toThrow(NOTES_ERRORS.unsafeDir);
    await expect(new NotesStore(join(root, "dentro")).read(id)).rejects.toThrow(NOTES_ERRORS.unsafeDir);
  });

  test("no temporary files are left behind", async () => {
    const id = randomUUID();
    for (let rev = 0; rev < 5; rev++) await store.save(id, { text: `linha ${rev}`, expectedRev: rev });
    expect(await fs.readdir(root)).toEqual([`${id}.json`]);
  });
});

describe("NotesStore.remove", () => {
  test("deletes the notes and is idempotent", async () => {
    const id = randomUUID();
    expect(await store.remove(id)).toBe(false);
    await store.save(id, { text: "a", expectedRev: 0 });
    expect(await store.remove(id)).toBe(true);
    expect(await store.read(id)).toBeUndefined();
    expect(await store.remove(id)).toBe(false);
    expect((await store.save(id, { text: "de novo", expectedRev: 0 })).entries[0].id).toBe("n000001");
  });
});

describe("findNotesForJob", () => {
  const job = (id: string, sourcePath: string) => ({ id, sourcePath });

  test("finds the capture's notes by job id", async () => {
    const id = randomUUID();
    await store.save(id, { text: "durante a captura", expectedRev: 0 });
    expect((await findNotesForJob(job(id, "/somewhere/else.mkv"), store))?.id).toBe(id);
  });

  test("a job created later with a random id finds the notes by the recording file", async () => {
    const captureId = randomUUID();
    const source = join(dir, "rec-a", "recording.mkv");
    await store.save(captureId, { text: "nota da captura", expectedRev: 0, sourcePath: source });
    await store.save(randomUUID(), { text: "outra reunião", expectedRev: 0, sourcePath: join(dir, "rec-b", "recording.mkv") });
    const found = await findNotesForJob(job(randomUUID(), source), store);
    expect(found?.id).toBe(captureId);
    expect(found?.entries[0].text).toBe("nota da captura");
    expect(await findNotesForJob(job(randomUUID(), join(dir, "rec-c", "recording.mkv")), store)).toBeUndefined();
  });

  test("when two notes claim the same file, the newest wins", async () => {
    const source = join(dir, "rec", "recording.mkv");
    const older = randomUUID(), newer = randomUUID();
    await store.save(older, { text: "antiga", expectedRev: 0, now: at(0), sourcePath: source });
    await store.save(newer, { text: "nova", expectedRev: 0, now: at(100), sourcePath: source });
    expect((await findNotesForJob(job(randomUUID(), source), store))?.id).toBe(newer);
  });

  test("the folder's only notes match a renamed recording whose original file is gone", async () => {
    const folder = join(dir, "Reunião-1a2b3c4d");
    await fs.mkdir(folder);
    const captureId = randomUUID();
    await store.save(captureId, { text: "nota", expectedRev: 0, sourcePath: join(folder, "recording.mkv") });
    await fs.writeFile(join(folder, "recording.mp4"), "media");
    expect((await findNotesForJob(job(randomUUID(), join(folder, "recording.mp4")), store))?.id).toBe(captureId);
  });

  test("the capture's own folder matches a recording renamed to another name once the planned file is gone", async () => {
    const captureId = randomUUID();
    const folder = join(dir, `Reunião-${captureId.slice(0, 8)}`);
    await fs.mkdir(folder);
    await store.save(captureId, { text: "nota", expectedRev: 0, sourcePath: join(folder, "recording.mkv") });
    await fs.writeFile(join(folder, "2026-10-25 10-00-00.mkv"), "media");
    expect((await findNotesForJob(job(randomUUID(), join(folder, "2026-10-25 10-00-00.mkv")), store))?.id).toBe(captureId);
    await fs.writeFile(join(folder, "recording.mkv"), "the planned file is back");
    expect(await findNotesForJob(job(randomUUID(), join(folder, "2026-10-25 10-00-00.mkv")), store)).toBeUndefined();
  });

  test("notes of another recording that still exists in the same folder never match", async () => {
    const folder = join(dir, "Videos");
    await fs.mkdir(folder);
    await fs.writeFile(join(folder, "rec-1.mkv"), "media 1");
    await store.save(randomUUID(), { text: "nota da rec-1", expectedRev: 0, sourcePath: join(folder, "rec-1.mkv") });
    expect(await findNotesForJob(job(randomUUID(), join(folder, "rec-2.mkv")), store)).toBeUndefined();
  });

  test("in a flat folder, notes of a recording whose media was deleted never attach to the next recording", async () => {
    // Legacy backends write every recording to one folder, and media retention deletes processed files.
    const folder = join(dir, "Videos");
    await fs.mkdir(folder);
    await store.save(randomUUID(), { text: "nota privada da rec-1", expectedRev: 0, sourcePath: join(folder, "rec-1.mkv") });
    await fs.writeFile(join(folder, "rec-2.mkv"), "media 2");
    expect(await findNotesForJob(job(randomUUID(), join(folder, "rec-2.mkv")), store)).toBeUndefined();
    expect(await findNotesForJob(job(randomUUID(), join(folder, "rec-2.mkv")), store, { exists: async () => false })).toBeUndefined();
    // The same recording converted to another container is still the same recording.
    await fs.writeFile(join(folder, "rec-1.mp4"), "media 1 converted");
    expect((await findNotesForJob(job(randomUUID(), join(folder, "rec-1.mp4")), store))?.entries[0].text).toBe("nota privada da rec-1");
  });

  test("a folder with several notes is ambiguous and matches nothing", async () => {
    const folder = join(dir, "flat");
    await store.save(randomUUID(), { text: "a", expectedRev: 0, sourcePath: join(folder, "a.mkv") });
    await store.save(randomUUID(), { text: "b", expectedRev: 0, sourcePath: join(folder, "b.mkv") });
    expect(await findNotesForJob(job(randomUUID(), join(folder, "c.mkv")), store, { exists: async () => false })).toBeUndefined();
  });

  test("damaged notes of other meetings are skipped; the job's own damaged notes are reported", async () => {
    const source = join(dir, "rec", "recording.mkv");
    const good = randomUUID();
    await store.save(good, { text: "boa", expectedRev: 0, sourcePath: source });
    await writeRaw(randomUUID(), "{broken");
    expect((await findNotesForJob(job(randomUUID(), source), store))?.id).toBe(good);
    const own = randomUUID();
    await writeRaw(own, "{broken");
    await expect(findNotesForJob(job(own, source), store)).rejects.toThrow(NOTES_ERRORS.corrupted);
  });

  test("the sourcePath index is cached per process and refreshed when a file changes or disappears", async () => {
    clearNotesIndexCache();
    const reads: string[] = [];
    class CountingStore extends NotesStore {
      override async read(id: string) { reads.push(id); return super.read(id); }
    }
    const counting = new CountingStore(root);
    const source = join(dir, "rec", "recording.mkv");
    const target = randomUUID(), other = randomUUID();
    await counting.save(target, { text: "alvo", expectedRev: 0, sourcePath: source, now: at(0) });
    await counting.save(other, { text: "outra", expectedRev: 0, sourcePath: join(dir, "x", "y.mkv"), now: at(10) });
    reads.length = 0;
    const firstJob = randomUUID();
    expect((await findNotesForJob(job(firstJob, source), counting))?.id).toBe(target);
    expect(reads.filter((id) => id === other)).toHaveLength(1);
    reads.length = 0;
    const secondJob = randomUUID();
    expect((await findNotesForJob(job(secondJob, source), counting))?.id).toBe(target);
    expect(reads).toEqual([secondJob, target]);
    await counting.save(other, { text: "outra\nmudou", expectedRev: 1, sourcePath: source, now: at(999) });
    reads.length = 0;
    expect((await findNotesForJob(job(randomUUID(), source), counting))?.id).toBe(other);
    expect(reads.filter((id) => id === other).length).toBeGreaterThanOrEqual(1);
    expect(reads.filter((id) => id === target)).toHaveLength(0);
    await counting.remove(other);
    expect((await findNotesForJob(job(randomUUID(), source), counting))?.id).toBe(target);
  });

  test("only the newest files are scanned", async () => {
    const source = join(dir, "rec", "recording.mkv");
    const oldest = randomUUID();
    await store.save(oldest, { text: "antiga", expectedRev: 0, sourcePath: source });
    await fs.utimes(store.pathFor(oldest), new Date(1_000_000), new Date(1_000_000));
    for (let index = 0; index < 3; index++) await store.save(randomUUID(), { text: `n${index}`, expectedRev: 0, sourcePath: join(dir, `r${index}`, "a.mkv") });
    expect(await findNotesForJob(job(randomUUID(), source), store, { maxFiles: 3 })).toBeUndefined();
    expect((await findNotesForJob(job(randomUUID(), source), store, { maxFiles: 4 }))?.id).toBe(oldest);
  });

  test("uses the default notes folder under XDG_DATA_HOME when no store is given", async () => {
    const previous = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = join(dir, "xdg");
      const id = randomUUID();
      await new NotesStore().save(id, { text: "padrão", expectedRev: 0, sourcePath: "/rec/padrao.mkv" });
      expect(await mode(join(dir, "xdg", "recording-cli"))).toBe(0o700);
      expect((await findNotesForJob(job(id, "/x.mkv")))?.entries[0].text).toBe("padrão");
      expect((await findNotesForJob(job(randomUUID(), "/rec/padrao.mkv")))?.id).toBe(id);
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
    }
  });

  test("without a notes folder or a usable recording path there is nothing to find", async () => {
    expect(await findNotesForJob(job(randomUUID(), "/rec/a.mkv"), store)).toBeUndefined();
    await store.save(randomUUID(), { text: "a", expectedRev: 0, sourcePath: "/rec/a.mkv" });
    expect(await findNotesForJob(job(randomUUID(), "rec/a.mkv"), store)).toBeUndefined();
    expect(await findNotesForJob(job(randomUUID(), ""), store)).toBeUndefined();
  });
});
