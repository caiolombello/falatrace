import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protonItemSize,
  ProtonDriveClient,
  executeProtonCommand
} from "../upload";

const scratchDirectories: string[] = [];

const makePrivateScratch = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-proton-download-test-"));
  await fs.chmod(path, 0o700);
  scratchDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) =>
      fs.rm(path, { recursive: true, force: true })
    )
  );
});

describe("Proton metadata", () => {
  test("uses logical claimed size from direct and legacy wrapped revisions", () => {
    expect(protonItemSize({
      totalStorageSize: 910,
      activeRevision: { claimedSize: 829, storageSize: 910 }
    })).toBe(829);
    expect(protonItemSize({
      totalStorageSize: 910,
      activeRevision: { ok: true, value: { claimedSize: 829, storageSize: 910 } }
    })).toBe(829);
    expect(protonItemSize({ totalStorageSize: 910 })).toBeUndefined();
    expect(protonItemSize({ activeRevision: { claimedSize: -1 } })).toBeUndefined();
  });
});

describe("Proton transfer commands", () => {
  test("retries transient Secret Service session failures before executing the filesystem operation", async () => {
    let calls = 0;
    const result = await executeProtonCommand(["filesystem", "list", "/my-files"], undefined, async () => {
      calls += 1;
      if (calls === 1) throw new Error("Failed to load session from secrets: Client public key size is invalid (code: 16)");
      if (calls === 2) throw new Error("proton-drive failed with code 1: You need to login first\n");
      return { stdout: "[]", stderr: "" };
    });
    expect(calls).toBe(3); expect(result).toBe("[]");
  });

  test("bounds handshake retries and never replays an uncertain upload failure", async () => {
    for (const [message, expectedCalls] of [
      ["Failed to load session from secrets: Client public key size is invalid (code: 16)", 3],
      ["proton-drive failed with code 1: You need to login first\n", 3],
      ["upload connection lost", 1]
    ] as const) {
      let calls = 0;
      await expect(executeProtonCommand(["filesystem", "upload"], undefined, async () => {
        calls += 1; throw new Error(message);
      })).rejects.toThrow(message);
      expect(calls).toBe(expectedCalls);
    }
  });

  test("downloads into a private scratch directory without overwriting an existing file", async () => {
    const scratch = await makePrivateScratch();
    const calls: string[][] = [];
    const client = new ProtonDriveClient(async (args) => {
      calls.push(args);
      return JSON.stringify({ transferredItems: 1, skippedItems: 0, failures: [] });
    });

    await client.download(["/my-files/archive/file.mkv"], scratch);

    expect(calls).toEqual([[
      "filesystem",
      "download",
      "--file-conflict-strategy",
      "skip",
      "/my-files/archive/file.mkv",
      scratch
    ]]);
  });

  test("rejects unsafe restore targets and reports per-item download failures", async () => {
    const scratch = await makePrivateScratch();
    const publicDirectory = await fs.mkdtemp(join(tmpdir(), "recording-cli-proton-public-test-"));
    scratchDirectories.push(publicDirectory);
    await fs.chmod(publicDirectory, 0o755);
    let executions = 0;
    const client = new ProtonDriveClient(async () => {
      executions += 1;
      return JSON.stringify({ failedItems: 1, failures: [{ error: "download failed" }] });
    });

    await expect(client.download(["/shared-with-me/file"], scratch)).rejects.toThrow("below /my-files");
    await expect(client.download(["/my-files/archive/../file"], scratch)).rejects.toThrow("below /my-files");
    await expect(client.download(["/my-files/archive/file"], publicDirectory)).rejects.toThrow("private directory");
    await expect(client.download([
      "/my-files/archive/file",
      "/my-files/archive/file"
    ], scratch)).rejects.toThrow("unique");
    await expect(client.download(
      Array.from({ length: 11 }, (_, index) => `/my-files/archive/file-${index}`),
      scratch
    )).rejects.toThrow("at most 10");
    await expect(client.download(["/my-files/archive/file"], scratch)).rejects.toThrow("1 download failure");
    expect(executions).toBe(1);
  });

  test("offers immutable upload while preserving legacy replace behavior", async () => {
    const calls: string[][] = [];
    const client = new ProtonDriveClient(async (args) => {
      calls.push(args);
      return JSON.stringify({ transferredItems: 1, failures: [] });
    });

    await client.uploadImmutable(["/tmp/media.mkv"], "/my-files/archive");
    await client.upload(["/tmp/legacy.mkv"], "/my-files/legacy");

    expect(calls[0]).toContain("skip");
    expect(calls[1]).toContain("replace");
  });
});
