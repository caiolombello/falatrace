import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { JobStore } from "../../jobs/store";
import {
  backupProtonJob,
  ProtonBackupStore
} from "../backup";
import { ProtonDriveClient } from "../upload";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-proton-test-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      fs.rm(path, { recursive: true, force: true })
    )
  );
});

describe("Proton backup", () => {
  test("resumes a partial artifact upload without resending confirmed files", async () => {
    const root = await makeTemporaryDirectory();
    const mediaPath = join(root, "meeting.mkv");
    await fs.writeFile(mediaPath, "video");
    const jobStore = new JobStore(join(root, "jobs"), join(root, "job-data"));
    const config = mergeConfig(DEFAULT_CONFIG, {
      proton: {
        enabled: true,
        targetFolder: "/my-files/RecordingArchive",
        policy: "artifacts"
      }
    });
    const job = await jobStore.enqueue(config, mediaPath);
    await fs.mkdir(job.artifactDir, { recursive: true });
    for (const name of [
      "transcript.json",
      "transcript.md",
      "summary.json",
      "summary.md"
    ]) {
      await fs.writeFile(join(job.artifactDir, name), `content:${name}`);
    }
    await jobStore.update(job.id, "completed");

    const folders = new Set(["/my-files"]);
    const remoteFiles = new Map<string, Map<string, number>>();
    const uploadBatches: string[][] = [];
    let interruptFirstUpload = true;
    const execute = async (args: string[]): Promise<string> => {
      const operation = args[1];
      if (operation === "list") {
        const path = args[2];
        const prefix = `${path}/`;
        const items: Array<Record<string, unknown>> = [...folders]
          .filter((folder) =>
            folder.startsWith(prefix) &&
            !folder.slice(prefix.length).includes("/")
          )
          .map((folder) => ({
            type: "folder",
            name: { ok: true, value: folder.slice(prefix.length) }
          }));
        for (const [name, size] of remoteFiles.get(path) || []) {
          items.push({
            type: "file",
            name: { ok: true, value: name },
            activeRevision: {
              ok: true,
              value: { claimedSize: size }
            }
          });
        }
        return JSON.stringify(items);
      }
      if (operation === "create-folder") {
        folders.add(`${args[2]}/${args[3]}`);
        return JSON.stringify({ type: "folder" });
      }
      if (operation === "upload") {
        const parent = args[args.length - 1];
        const localPaths = args.slice(4, -1);
        uploadBatches.push(localPaths.map((path) => basename(path)));
        const files = remoteFiles.get(parent) || new Map<string, number>();
        remoteFiles.set(parent, files);
        const pathsToStore = interruptFirstUpload
          ? localPaths.slice(0, 1)
          : localPaths;
        for (const path of pathsToStore) {
          files.set(basename(path), (await fs.stat(path)).size);
        }
        if (interruptFirstUpload) {
          interruptFirstUpload = false;
          throw new Error("simulated interrupted upload");
        }
        return JSON.stringify({
          transferredItems: localPaths.length,
          skippedItems: 0,
          transferredBytes: 1,
          failures: []
        });
      }
      throw new Error(`Unexpected Proton operation: ${operation}`);
    };
    const backupStore = new ProtonBackupStore(join(root, "backup-state"));
    const client = new ProtonDriveClient(execute);
    const dataDir = join(root, "backup-data");

    const failed = await backupProtonJob(
      config,
      job.id,
      jobStore,
      backupStore,
      client,
      dataDir,
      "proton-backup-test"
    );
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("interrupted");

    const completed = await backupProtonJob(
      config,
      job.id,
      jobStore,
      backupStore,
      client,
      dataDir,
      "proton-backup-test"
    );
    expect(completed.state).toBe("completed");
    expect(completed.files.map((file) => file.name)).toEqual([
      "manifest.json",
      "transcript.json",
      "transcript.md",
      "summary.json",
      "summary.md"
    ]);
    expect(uploadBatches).toHaveLength(2);
    expect(uploadBatches[0]).toContain("manifest.json");
    expect(uploadBatches[1]).not.toContain("manifest.json");
    expect(uploadBatches.flat()).not.toContain("meeting.mkv");

    await backupProtonJob(
      config,
      job.id,
      jobStore,
      backupStore,
      client,
      dataDir,
      "proton-backup-test"
    );
    expect(uploadBatches).toHaveLength(2);

    const fullConfig = mergeConfig(config, {
      proton: { policy: "full" }
    });
    const full = await backupProtonJob(
      fullConfig,
      job.id,
      jobStore,
      backupStore,
      client,
      dataDir,
      "proton-backup-test"
    );
    expect(full.state).toBe("completed");
    expect(full.policy).toBe("full");
    expect(full.files.map((file) => file.name)).toContain("meeting.mkv");
    expect(uploadBatches).toHaveLength(3);
    expect(uploadBatches[2]).toContain("manifest.json");
    expect(uploadBatches[2]).toContain("meeting.mkv");
    expect(uploadBatches[2]).not.toContain("transcript.json");

    await backupProtonJob(
      fullConfig,
      job.id,
      jobStore,
      backupStore,
      client,
      dataDir,
      "proton-backup-test"
    );
    expect(uploadBatches).toHaveLength(3);
    const persisted = await fs.readFile(
      join(root, "backup-state", `${job.id}.json`),
      "utf-8"
    );
    expect(persisted).not.toContain(mediaPath);
    expect(persisted).not.toContain(job.artifactDir);
  });
});
