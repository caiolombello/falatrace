import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import type { CommandResult } from "../../jobs/command";
import { JobStore } from "../../jobs/store";
import { ArchiveStore } from "../../archive/store";
import type { JobRecord } from "../../jobs/types";
import { buildLibrary } from "../library";
import {
  ensureRemoteArchiveMounted,
  findCompletedRemoteJob,
  parseTimestamp,
  parseTranscriptJson,
  parseTranscriptMarkdown,
  playLibraryEntry,
  removeVerifiedLocalSource,
  searchTranscript
} from "../media";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-media-test-"));
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

const result = (stdout = "", stderr = ""): CommandResult => ({
  stdout,
  stderr
});

const createCompletedRemoteEntry = async () => {
  const root = await makeTemporaryDirectory();
  const recordingsDir = join(root, "recordings");
  const mediaPath = join(recordingsDir, "meeting.mkv");
  await fs.mkdir(recordingsDir);
  await fs.writeFile(mediaPath, "video data");
  const config = mergeConfig(DEFAULT_CONFIG, {
    recordingsDir,
    processing: { defaultTarget: "remote" },
    remote: {
      host: "worker.test",
      user: "recorder",
      archiveDir: "/srv/recordings"
    }
  });
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const created = await store.enqueue(config, mediaPath);
  await fs.mkdir(created.artifactDir, { recursive: true });
  await fs.writeFile(join(created.artifactDir, "transcript.md"), "transcript");
  await store.update(created.id, "completed");
  const job = await store.get(created.id);
  const [entry] = await buildLibrary(config, store);
  return { root, recordingsDir, mediaPath, config, store, job, entry };
};

describe("recording playback", () => {
  test("parses transcript timestamps without inventing one for untimed text", () => {
    expect(parseTimestamp("1:02")).toBe(62);
    expect(parseTimestamp("01:02:03.5")).toBe(3723.5);
    expect(parseTimestamp("sem tempo")).toBeUndefined();
    expect(parseTranscriptMarkdown("# Transcrição\n\n[1:02] Olá\nTexto sem tempo")).toEqual([
      { text: "Olá", startSeconds: 62 },
      { text: "Texto sem tempo" }
    ]);
  });

  test("searches JSON transcript segments and preserves their time range", () => {
    const results = searchTranscript(
      JSON.stringify({
        version: 1,
        provider: "openai",
        model: "model",
        language: "pt",
        text: "A pauta",
        segments: [{ start: 12.5, end: 15, text: "A pauta começa aqui" }]
      }),
      "PAUTA"
    );
    expect(results).toEqual([
      { text: "A pauta começa aqui", startSeconds: 12.5, endSeconds: 15 }
    ]);
    expect(parseTranscriptJson({ text: "somente texto", segments: [] })).toEqual([
      { text: "somente texto" }
    ]);
  });

  test("passes a finite non-negative start offset to the player", async () => {
    const { config, job, entry, mediaPath } = await createCompletedRemoteEntry();
    const launched: Array<{ path: string; options?: { startSeconds?: number } }> = [];
    await playLibraryEntry(config, entry, job, {
      launch: async (path, options) => {
        launched.push({ path, options });
      }
    }, { startSeconds: 12.5 });
    expect(launched).toEqual([{ path: mediaPath, options: { startSeconds: 12.5 } }]);
  });

  test("rejects an invalid playback offset before launching", async () => {
    const { config, job, entry } = await createCompletedRemoteEntry();
    let launched = false;
    await expect(playLibraryEntry(config, entry, job, {
      launch: async () => {
        launched = true;
      }
    }, { startSeconds: Number.NaN })).rejects.toThrow("número finito não negativo");
    expect(launched).toBe(false);
  });

  test("prefers the local source without contacting the vaio", async () => {
    const { config, job, entry, mediaPath } = await createCompletedRemoteEntry();
    const launched: string[] = [];

    const playback = await playLibraryEntry(config, entry, job, {
      launch: async (path) => {
        launched.push(path);
      },
      inspectRemote: async () => {
        throw new Error("remote inspection should not run");
      }
    });

    expect(playback).toEqual({ location: "local", path: mediaPath });
    expect(launched).toEqual([mediaPath]);
  });

  test("mounts the archive read-only and launches a missing source from the vaio", async () => {
    const { root, config, job, entry, mediaPath } =
      await createCompletedRemoteEntry();
    await fs.rm(mediaPath);
    entry.sourceExists = false;
    const mountPoint = join(root, "mount");
    const archiveRelative = `2026/07/${job.id}`;
    const expectedSource = "recorder@worker.test:/srv/recordings";
    let mounted = false;
    const launched: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const playback = await playLibraryEntry(config, entry, job, {
      mountPoint,
      inspectRemote: async () => ({
        archiveDir: "/srv/recordings",
        archiveRelative,
        sourcePath: `/srv/recordings/${archiveRelative}/${job.source.mediaFile}`,
        size: job.source.size
      }),
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === "findmnt") {
          if (!mounted) throw new Error("not mounted");
          return result(`fuse.sshfs ${expectedSource}\n`);
        }
        if (command === "sshfs") {
          mounted = true;
          const mountedMedia = join(
            mountPoint,
            archiveRelative,
            job.source.mediaFile
          );
          await fs.mkdir(join(mountPoint, archiveRelative), {
            recursive: true
          });
          await fs.writeFile(mountedMedia, "video data");
          return result();
        }
        throw new Error(`unexpected command: ${command}`);
      },
      launch: async (path) => {
        launched.push(path);
      }
    });

    expect(playback.location).toBe("vaio");
    expect(launched).toEqual([
      join(mountPoint, archiveRelative, job.source.mediaFile)
    ]);
    const sshfs = commands.find((command) => command.command === "sshfs")!;
    expect(sshfs.args).toContain("ro");
    expect(sshfs.args).toContain("StrictHostKeyChecking=yes");
    expect(sshfs.args).toContain("PasswordAuthentication=no");
    expect(sshfs.args).toContain(expectedSource);
  });

  test("reuses only a matching SSHFS mount", async () => {
    const root = await makeTemporaryDirectory();
    const mountPoint = join(root, "mount");
    const config = mergeConfig(DEFAULT_CONFIG, {
      remote: { host: "worker.test", user: "recorder" }
    });

    await expect(
      ensureRemoteArchiveMounted(config, "/srv/recordings", {
        mountPoint,
        run: async () => result("ext4 /dev/nvme0n1p1\n")
      })
    ).rejects.toThrow("ocupado por outra origem");
  });

  test("restores a verified Proton original without a processing job when VAIO is unavailable", async () => {
    const { root, config, entry, mediaPath } = await createCompletedRemoteEntry();
    const store = new ArchiveStore(join(root, "archive"));
    const record = await store.enqueue(mediaPath);
    const sealed = await store.seal(record.id);
    const verifiedAt = new Date().toISOString();
    sealed.vaio = { state: "completed", path: "/archive/source.mkv", archiveRelative: `media/2026/09/${record.id}`, verifiedAt };
    sealed.proton = { state: "completed", path: "/my-files/source.mkv", verifiedAt };
    entry.archive = sealed; entry.jobs = []; entry.sourceExists = false;
    await fs.unlink(mediaPath);
    let launches = 0; let requestedHash = false;
    const restored = join(root, "restored.mkv"); await fs.writeFile(restored, "video data");
    const playback = await playLibraryEntry(config, entry, undefined, {
      inspectArchive: async (_config, _source, options) => { requestedHash = options?.verifyHash === true; throw new Error("offline"); },
      restoreProton: async (_config, source) => { expect(source.source.sha256).toBe(sealed.source.sha256!); return restored; },
      launch: async (path) => { launches += 1; expect(path).toBe(restored); }
    });
    expect(playback.location).toBe("proton"); expect(requestedHash).toBe(true); expect(launches).toBe(1);
  });

  test("does not download another copy when only the player fails to start", async () => {
    const { root, config, entry, mediaPath } = await createCompletedRemoteEntry();
    const store = new ArchiveStore(join(root, "archive"));
    const record = await store.enqueue(mediaPath); const archive = await store.seal(record.id);
    archive.proton = { state: "completed", path: "/my-files/source.mkv", verifiedAt: new Date().toISOString() };
    entry.archive = archive;
    let downloads = 0;
    await expect(playLibraryEntry(config, entry, undefined, {
      launch: async () => { throw new Error("player unavailable"); },
      restoreProton: async () => { downloads += 1; return mediaPath; }
    })).rejects.toThrow("player unavailable");
    expect(downloads).toBe(0);
  });
});

describe("local space release", () => {
  test("permanently removes only a source verified locally and on the vaio", async () => {
    const { config, store, job, entry, mediaPath } =
      await createCompletedRemoteEntry();
    let requestedHash = false;

    const removal = await removeVerifiedLocalSource(config, entry, job, {
      inspectRemote: async (_config, inspectedJob, options) => {
        expect(inspectedJob.id).toBe(job.id);
        requestedHash = options?.verifyHash === true;
        return {
          archiveDir: "/srv/recordings",
          archiveRelative: `2026/07/${job.id}`,
          sourcePath: `/srv/recordings/2026/07/${job.id}/${job.source.mediaFile}`,
          size: job.source.size,
          sha256: job.source.sha256
        };
      }
    });

    expect(requestedHash).toBe(true);
    expect(removal.bytesFreed).toBe(job.source.size);
    await expect(fs.stat(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(job.artifactDir, "transcript.md"), "utf-8"))
      .toBe("transcript");
    expect((await store.get(job.id)).state).toBe("completed");
    const [remaining] = await buildLibrary(config, store);
    expect(remaining.sourceExists).toBe(false);
    expect(findCompletedRemoteJob(remaining)?.id).toBe(job.id);
  });

  test("preserves the local source when remote integrity cannot be confirmed", async () => {
    const { config, job, entry, mediaPath } =
      await createCompletedRemoteEntry();

    await expect(
      removeVerifiedLocalSource(config, entry, job, {
        inspectRemote: async () => {
          throw new Error("remote SHA-256 mismatch");
        }
      })
    ).rejects.toThrow("remote SHA-256 mismatch");

    expect(await fs.readFile(mediaPath, "utf-8")).toBe("video data");
  });

  test("does not offer local removal for incomplete or local-only jobs", async () => {
    const entry = {
      jobs: [
        {
          target: "local",
          state: "completed"
        },
        {
          target: "remote",
          state: "processing"
        }
      ] as JobRecord[]
    };

    expect(findCompletedRemoteJob(entry)).toBeUndefined();
  });
});
