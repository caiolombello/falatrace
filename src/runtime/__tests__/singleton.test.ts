import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { acquireSingleton } from "../singleton";

describe("process singleton", () => {
  test("allows one owner and releases the kernel lock on shutdown", async () => {
    const name = `test-${randomUUID()}`;
    const first = await acquireSingleton(name);
    await expect(acquireSingleton(name)).rejects.toThrow("already running");
    await first.release();

    const second = await acquireSingleton(name);
    await second.release();
  });
});
