import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_MESSAGES, ShareError } from "../../share/render";
import { DeliveryLog, MAX_DELIVERIES, defaultDeliveryLogDir, deliveryLogKey, parseDeliveryLog, recordDelivery, removeDeliveriesForJob, type DeliveryRecord } from "../log";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const SHA = "a".repeat(64);

const record = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  at: "2026-10-25T10:00:00.000Z",
  destination: "slack",
  target: "hooks.slack.com/services/T1/B1/***",
  sha256: SHA,
  result: "sent",
  ...overrides
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-log-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("DeliveryLog", () => {
  test("appends and reads deliveries in a private file", async () => {
    const dir = join(root, "state", "share-deliveries");
    const log = new DeliveryLog({ dir });
    await log.append(JOB, record());
    await log.append(JOB, record({ destination: "obsidian", target: "/vault/a.md", result: "created", location: "/vault/a.md" }));
    expect(await log.read(JOB)).toEqual([
      record(),
      record({ destination: "obsidian", target: "/vault/a.md", result: "created", location: "/vault/a.md" })
    ]);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(dir, `${JOB}.json`))).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await fs.readFile(join(dir, `${JOB}.json`), "utf8"));
    expect(stored.version).toBe(1);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("keeps the newest 200 entries", async () => {
    const log = new DeliveryLog({ dir: root });
    const file = join(root, `${JOB}.json`);
    const many = Array.from({ length: MAX_DELIVERIES }, (_, index) => record({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
    await fs.writeFile(file, JSON.stringify({ version: 1, deliveries: many }), { mode: 0o600 });
    await log.append(JOB, record({ at: "2027-01-01T00:00:00.000Z" }));
    const records = await log.read(JOB);
    expect(records.length).toBe(MAX_DELIVERIES);
    expect(records[0].at).toBe(many[1].at);
    expect(records[records.length - 1].at).toBe("2027-01-01T00:00:00.000Z");
  });

  test("last() filters by destination, target and result", async () => {
    const log = new DeliveryLog({ dir: root });
    await log.append(JOB, record({ destination: "obsidian", target: "/v/a.md", result: "created", sha256: "1".repeat(64) }));
    await log.append(JOB, record({ destination: "obsidian", target: "/v/a.md", result: "reused", sha256: "2".repeat(64) }));
    await log.append(JOB, record({ destination: "obsidian", target: "/v/b.md", result: "replaced", sha256: "3".repeat(64) }));
    expect((await log.last(JOB, { destination: "obsidian", target: "/v/a.md", results: ["created", "replaced"] }))?.sha256).toBe("1".repeat(64));
    expect((await log.last(JOB, { destination: "obsidian" }))?.sha256).toBe("3".repeat(64));
    expect(await log.last(JOB, { destination: "notion" })).toBeUndefined();
  });

  test("malformed files and records are ignored, never trusted", async () => {
    const log = new DeliveryLog({ dir: root });
    const file = join(root, `${JOB}.json`);
    await fs.writeFile(file, "{not json", { mode: 0o600 });
    expect(await log.read(JOB)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ version: 2, deliveries: [record()] }));
    expect(await log.read(JOB)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ version: 1, deliveries: [record(), { ...record(), sha256: "xyz" }, { ...record(), extra: 1 }, { ...record(), result: "hacked" }, { ...record(), target: "a\nb" }] }));
    expect(await log.read(JOB)).toEqual([record()]);
    // A broken file is replaced by a valid one on the next append.
    await fs.writeFile(file, "garbage");
    await log.append(JOB, record());
    expect(await log.read(JOB)).toEqual([record()]);
    expect(parseDeliveryLog(JSON.stringify({ version: 1, deliveries: "x" }))).toEqual([]);
  });

  test("a symlinked log file is neither followed for reading nor replaced", async () => {
    const log = new DeliveryLog({ dir: root });
    const outside = join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ version: 1, deliveries: [record()] }));
    await fs.symlink(outside, join(root, `${JOB}.json`));
    expect(await log.read(JOB)).toEqual([]);
    await expect(log.append(JOB, record())).rejects.toThrow(SHARE_MESSAGES.logUnsafe);
    expect(JSON.parse(await fs.readFile(outside, "utf8")).deliveries.length).toBe(1);
  });

  test("a symlinked log folder is refused", async () => {
    const real = join(root, "real");
    await fs.mkdir(real);
    await fs.symlink(real, join(root, "link"));
    const log = new DeliveryLog({ dir: join(root, "link") });
    expect(await log.read(JOB)).toEqual([]);
    await expect(log.append(JOB, record())).rejects.toThrow(SHARE_MESSAGES.logUnsafe);
    expect(await fs.readdir(real)).toEqual([]);
  });

  test("concurrent appends are all kept", async () => {
    const log = new DeliveryLog({ dir: root });
    await Promise.all(Array.from({ length: 12 }, (_, index) => new DeliveryLog({ dir: root }).append(JOB, record({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }))));
    expect((await log.read(JOB)).length).toBe(12);
  });

  test("a held lock times out with a known message", async () => {
    const log = new DeliveryLog({ dir: root, lockTimeoutMs: 60, lock: async (name) => { throw new Error(`${name} is already running`); } });
    await expect(log.append(JOB, record())).rejects.toThrow(SHARE_MESSAGES.logBusy);
  });

  test("keys are job ids or library; anything else is refused", async () => {
    const log = new DeliveryLog({ dir: root });
    expect(deliveryLogKey(undefined)).toBe("library");
    expect(deliveryLogKey(JOB)).toBe(JOB);
    expect(() => deliveryLogKey("../../etc/passwd")).toThrow(ShareError);
    await log.append("library", record());
    expect((await log.read("library")).length).toBe(1);
    expect(() => log.path("../x")).toThrow(ShareError);
    await expect(log.append(JOB, record({ sha256: "nope" }))).rejects.toThrow(ShareError);
  });

  test("remove() forgets a recording; recordDelivery never throws", async () => {
    await new DeliveryLog({ dir: root }).append(JOB, record());
    expect(await removeDeliveriesForJob(JOB, { dir: root })).toBe(true);
    expect(await removeDeliveriesForJob(JOB, { dir: root })).toBe(false);
    expect(await recordDelivery(new DeliveryLog({ dir: root }), "not-a-uuid", record())).toBe(false);
    expect(await recordDelivery(undefined, JOB, record())).toBe(false);
    expect(await recordDelivery(new DeliveryLog({ dir: root }), JOB, record())).toBe(true);
  });

  test("the default folder follows XDG_STATE_HOME", () => {
    expect(defaultDeliveryLogDir({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/recording-cli/share-deliveries");
    expect(defaultDeliveryLogDir({}, "/h")).toBe("/h/.local/state/recording-cli/share-deliveries");
  });
});
