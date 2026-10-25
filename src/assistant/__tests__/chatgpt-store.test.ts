import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  CHATGPT_STORE_MESSAGES,
  type ChatGptCredentials,
  ChatGptStore,
  DYNAMIC_CLIENT_ID,
  defaultChatGptDir,
  newHostId,
  validateChatGptCredentials,
  withoutTokens
} from "../chatgpt/store";
import { withTempDir } from "./provider-helpers";

const HOST = "urn:uuid:12345678-1234-4123-8123-123456789abc";
const signedIn = (patch: Partial<ChatGptCredentials> = {}): ChatGptCredentials => ({
  version: 1,
  rev: 3,
  hostId: HOST,
  clientId: "oaiapp_abc123",
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: "2026-10-25T12:00:00.000Z",
  scopes: ["openid", "chatgpt.tokens.use.direct"],
  email: "ana@example.com",
  updatedAt: "2026-10-25T11:00:00.000Z",
  ...patch
});

const mode = async (path: string) => (await fs.stat(path)).mode & 0o777;

describe("validateChatGptCredentials", () => {
  test("rebuilds a valid record field by field and drops unknown fields", () => {
    const value = { ...signedIn(), extra: "dropped", scopes: ["openid", "openid", "chatgpt.tokens.use.direct"] };
    expect(validateChatGptCredentials(value)).toEqual(signedIn());
    const bare: ChatGptCredentials = { version: 1, rev: 0, hostId: HOST, updatedAt: "2026-10-25T11:00:00.000Z" };
    expect(validateChatGptCredentials(bare)).toEqual(bare);
  });

  test("refuses anything unexpected", () => {
    const { accessToken: _a, ...noAccess } = signedIn();
    const { clientId: _c, ...noClient } = signedIn();
    const bad: unknown[] = [
      null,
      [],
      "x",
      { ...signedIn(), version: 2 },
      { ...signedIn(), rev: -1 },
      { ...signedIn(), rev: 1.5 },
      { ...signedIn(), hostId: "host-1" },
      { ...signedIn(), hostId: "urn:uuid:not-a-uuid" },
      { ...signedIn(), updatedAt: "yesterday" },
      { ...signedIn(), clientId: DYNAMIC_CLIENT_ID },
      { ...signedIn(), clientId: "has space" },
      noAccess,
      noClient,
      { ...signedIn(), accessToken: "line\nbreak" },
      { ...signedIn(), refreshToken: "" },
      { ...signedIn(), accessToken: "x".repeat(16 * 1024 + 1) },
      { ...signedIn(), expiresAt: "soon" },
      { ...signedIn(), scopes: [] },
      { ...signedIn(), scopes: "openid" },
      { ...signedIn(), scopes: Array.from({ length: 31 }, (_, index) => `s${index}`) },
      { ...signedIn(), scopes: ["has space"] },
      { ...signedIn(), email: "not-an-email" },
      { ...signedIn(), email: 42 }
    ];
    for (const value of bad) expect(() => validateChatGptCredentials(value)).toThrow();
  });

  test("withoutTokens keeps the installation and the issued client id only", () => {
    expect(withoutTokens(signedIn())).toEqual({ version: 1, rev: 3, hostId: HOST, clientId: "oaiapp_abc123", updatedAt: "2026-10-25T11:00:00.000Z" });
  });

  test("host ids are random UUID URNs; the default directory follows XDG_STATE_HOME", () => {
    const first = newHostId();
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(newHostId()).not.toBe(first);
    expect(validateChatGptCredentials({ version: 1, rev: 0, hostId: first, updatedAt: new Date().toISOString() }).hostId).toBe(first);
    expect(defaultChatGptDir({ XDG_STATE_HOME: "/home/ana/.state" })).toBe("/home/ana/.state/recording-cli/chatgpt");
    expect(defaultChatGptDir({ XDG_STATE_HOME: "relative" }).endsWith("/.local/state/recording-cli/chatgpt")).toBe(true);
  });
});

describe("ChatGptStore", () => {
  test("creates a private file once, keeps the host id, and bumps rev on every write", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "state", "chatgpt"), { now: () => new Date("2026-10-25T10:00:00.000Z") });
      expect(await store.read()).toBeUndefined();
      const created = await store.ensureHostId();
      expect(created).toMatchObject({ version: 1, rev: 1, updatedAt: "2026-10-25T10:00:00.000Z" });
      expect(store.path).toBe(join(dir, "state", "chatgpt", "oauth.json"));
      expect(await mode(store.path)).toBe(0o600);
      expect(await mode(store.root)).toBe(0o700);
      expect((await store.ensureHostId()).hostId).toBe(created.hostId);
      const result = await store.transaction((current) => ({ next: { ...(current as ChatGptCredentials), clientId: "oaiapp_x" }, result: "saved" }));
      expect(result).toBe("saved");
      expect(await store.read()).toMatchObject({ rev: 2, clientId: "oaiapp_x", hostId: created.hostId });
      // undefined keeps the file as it is; null removes it.
      await store.transaction(() => ({ result: undefined }));
      expect((await store.read())?.rev).toBe(2);
      await store.transaction(() => ({ next: null, result: undefined }));
      expect(await store.read()).toBeUndefined();
      // No temporary files are left behind.
      expect(await fs.readdir(store.root)).toEqual([]);
    });
  });

  test("an invalid record is never written", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      await store.ensureHostId();
      await expect(store.transaction((current) => ({ next: { ...(current as ChatGptCredentials), accessToken: "only-half" }, result: undefined }))).rejects.toThrow("incomplete tokens");
      expect((await store.read())?.accessToken).toBeUndefined();
    });
  });

  test("compare-and-set on rev refuses a write based on a stale read", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      const first = await store.ensureHostId();
      await store.transaction((current) => ({ next: current, result: undefined }), { expectedRev: first.rev });
      await expect(store.transaction((current) => ({ next: current, result: undefined }), { expectedRev: first.rev })).rejects.toThrow(CHATGPT_STORE_MESSAGES.conflict);
      expect((await store.read())?.rev).toBe(2);
    });
  });

  test("concurrent writers are serialized by the lock: no update is lost", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "chatgpt");
      await new ChatGptStore(root).ensureHostId();
      const seen: number[] = [];
      await Promise.all(
        Array.from({ length: 6 }, () =>
          new ChatGptStore(root).transaction(async (current) => {
            seen.push((current as ChatGptCredentials).rev);
            await Bun.sleep(5);
            return { next: current, result: undefined };
          })
        )
      );
      expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      expect((await new ChatGptStore(root).read())?.rev).toBe(7);
    });
  });

  test("a held lock makes another writer give up with a clear message", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "chatgpt");
      let release!: () => void;
      const holding = new ChatGptStore(root).transaction(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: undefined };
      });
      await Bun.sleep(30);
      await expect(new ChatGptStore(root, { lockWaitMs: 60 }).ensureHostId()).rejects.toThrow(CHATGPT_STORE_MESSAGES.busy);
      release();
      await holding;
      expect((await new ChatGptStore(root, { lockWaitMs: 60 }).ensureHostId()).rev).toBe(1);
    });
  });

  test("damaged or oversized files read as signed out", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      await store.ensureHostId();
      await fs.writeFile(store.path, "{not json", { mode: 0o600 });
      expect(await store.read()).toBeUndefined();
      await fs.writeFile(store.path, JSON.stringify({ version: 1 }), { mode: 0o600 });
      expect(await store.read()).toBeUndefined();
      await fs.writeFile(store.path, `${JSON.stringify(signedIn())}${" ".repeat(70 * 1024)}`, { mode: 0o600 });
      expect(await store.read()).toBeUndefined();
      // A damaged file is replaced by the next write.
      expect((await store.ensureHostId()).rev).toBe(1);
    });
  });

  test("links and loose permissions are refused, and removal never touches a link's target", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "chatgpt");
      const store = new ChatGptStore(root);
      await store.ensureHostId();
      const target = join(dir, "elsewhere.json");
      await fs.writeFile(target, JSON.stringify(signedIn()), { mode: 0o600 });
      await fs.rm(store.path);
      await fs.symlink(target, store.path);
      await expect(store.read()).rejects.toThrow(CHATGPT_STORE_MESSAGES.unsafe);
      await expect(store.ensureHostId()).rejects.toThrow(CHATGPT_STORE_MESSAGES.unsafe);
      await store.remove();
      expect(await fs.readFile(target, "utf8")).toContain("at-1");
      await expect(fs.lstat(store.path)).rejects.toThrow();

      await fs.writeFile(store.path, JSON.stringify(signedIn()), { mode: 0o644 });
      await fs.chmod(store.path, 0o644);
      await expect(store.read()).rejects.toThrow(CHATGPT_STORE_MESSAGES.unsafe);
      await fs.rm(store.path);

      const linkedRoot = join(dir, "linked");
      await fs.mkdir(join(dir, "real"), { mode: 0o700 });
      await fs.symlink(join(dir, "real"), linkedRoot);
      await expect(new ChatGptStore(linkedRoot).ensureHostId()).rejects.toThrow(CHATGPT_STORE_MESSAGES.unsafe);
      expect(await fs.readdir(join(dir, "real"))).toEqual([]);
    });
  });

  test("a loose directory is tightened to 0700 on write", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "chatgpt");
      await fs.mkdir(root, { mode: 0o755 });
      await fs.chmod(root, 0o755);
      await new ChatGptStore(root).ensureHostId();
      expect(await mode(root)).toBe(0o700);
    });
  });
});
