import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import type { runCommand } from "../../jobs/command";
import {
  archiveMediaToVaio,
  downloadArchivedMedia,
  inspectArchivedMedia,
  type ArchiveMediaInput
} from "../remote";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});

const fixture = async (): Promise<{
  config: AppConfig;
  input: ArchiveMediaInput;
  content: string;
}> => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-cli-archive-"));
  temporaryDirectories.push(root);
  const sourcePath = join(root, "meeting.mkv");
  const content = "synthetic media fixture";
  await fs.writeFile(sourcePath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    config: {
      ...DEFAULT_CONFIG,
      remote: { ...DEFAULT_CONFIG.remote, host: "vaio.test", archiveDir: "/srv/archive" }
    },
    input: {
      id: randomUUID(),
      createdAt: "2026-09-08T01:02:03.000Z",
      sourcePath,
      source: { fileName: "meeting.mkv", size: Buffer.byteLength(content), sha256 }
    },
    content
  };
};

type RunCall = { command: string; args: string[]; options?: Parameters<typeof runCommand>[2] };

const successfulRunner = (
  input: ArchiveMediaInput,
  calls: RunCall[],
  initialFinal: "missing" | "matching" | "conflict" = "missing"
): typeof runCommand => {
  let finalProbeCount = 0;
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "rsync") return { stdout: "", stderr: "" };
    const remoteCommand = args[args.length - 1] || "";
    if (remoteCommand.includes("ARCHIVE_PROBE")) {
      const finalPath = `/srv/archive/media/2026/09/${input.id}/source.mkv`;
      const isFinal = remoteCommand.includes(finalPath);
      if (isFinal) {
        finalProbeCount += 1;
        if (finalProbeCount === 1 && initialFinal === "missing") {
          return { stdout: "missing\n", stderr: "" };
        }
        if (initialFinal === "conflict") {
          return { stdout: `ok\t${input.source.size + 1}\t${"b".repeat(64)}\n`, stderr: "" };
        }
      }
      return {
        stdout: `ok\t${input.source.size}\t${input.source.sha256}\n`,
        stderr: ""
      };
    }
    if (remoteCommand.includes("ARCHIVE_PREPARE")) return { stdout: "ready\n", stderr: "" };
    if (remoteCommand.includes("ARCHIVE_PUBLISH")) return { stdout: "published\n", stderr: "" };
    throw new Error(`unexpected command: ${command} ${remoteCommand}`);
  };
};

test("copies verified media to its independent archive namespace and publishes atomically", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];
  const result = await archiveMediaToVaio(config, input, {
    run: successfulRunner(input, calls),
    now: () => new Date("2026-09-08T02:03:04.000Z")
  });

  expect(result).toEqual({
    archiveDir: "/srv/archive",
    archiveRelative: `media/2026/09/${input.id}`,
    sourcePath: `/srv/archive/media/2026/09/${input.id}/source.mkv`,
    size: input.source.size,
    sha256: input.source.sha256,
    verifiedAt: "2026-09-08T02:03:04.000Z"
  });
  const rsync = calls.find((call) => call.command === "rsync");
  expect(rsync?.args).toContain("--partial");
  expect(rsync?.args).toContain("--append-verify");
  expect(rsync?.args).toContain("--protect-args");
  expect(rsync?.args[rsync.args.length - 1]).toBe(
    `vaio.test:/srv/archive/media/2026/09/${input.id}.partial/source.mkv`
  );
  expect(rsync?.options?.env?.RSYNC_RSH).toContain("BatchMode=yes");
  expect(calls.some((call) => call.args[call.args.length - 1]?.includes("server/queue"))).toBe(false);
  const prepare = calls.find((call) => call.args[call.args.length - 1]?.includes("ARCHIVE_PREPARE"));
  expect(prepare?.args[prepare.args.length - 1]).not.toContain('chmod 700 -- "$root"');
  const publish = calls.find((call) => call.args[call.args.length - 1]?.includes("ARCHIVE_PUBLISH"));
  expect(publish?.args[publish.args.length - 1]).toContain(input.source.sha256);
});

test("returns an already matching final archive without retransferring it", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];

  const result = await archiveMediaToVaio(config, input, {
    run: successfulRunner(input, calls, "matching")
  });

  expect(result.sha256).toBe(input.source.sha256);
  expect(calls.some((call) => call.command === "rsync")).toBe(false);
  expect(calls.some((call) => call.args[call.args.length - 1]?.includes("ARCHIVE_PUBLISH"))).toBe(false);
});

test("never overwrites a divergent final archive", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];

  await expect(
    archiveMediaToVaio(config, input, {
      run: successfulRunner(input, calls, "conflict")
    })
  ).rejects.toThrow("diverge");
  expect(calls.some((call) => call.command === "rsync")).toBe(false);
});

test("does not publish staging whose remote hash differs", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];
  const run = successfulRunner(input, calls);
  const corruptingRun: typeof runCommand = async (command, args, options) => {
    const result = await run(command, args, options);
    const remoteCommand = args[args.length - 1] || "";
    if (remoteCommand.includes("ARCHIVE_PROBE") && remoteCommand.includes(".partial")) {
      return { stdout: `ok\t${input.source.size}\t${"c".repeat(64)}\n`, stderr: "" };
    }
    return result;
  };

  await expect(archiveMediaToVaio(config, input, { run: corruptingRun })).rejects.toThrow(
    "SHA-256 remoto"
  );
  expect(calls.some((call) => call.args[call.args.length - 1]?.includes("ARCHIVE_PUBLISH"))).toBe(false);
});

test("refuses a staging file symlink before invoking rsync", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];
  const baseRun = successfulRunner(input, calls);
  const run: typeof runCommand = async (command, args, options) => {
    const remoteCommand = args[args.length - 1] || "";
    if (
      command === "ssh" &&
      remoteCommand.includes("ARCHIVE_PROBE") &&
      remoteCommand.includes(".partial")
    ) {
      calls.push({ command, args, options });
      return { stdout: "symlink\n", stderr: "" };
    }
    return baseRun(command, args, options);
  };

  await expect(archiveMediaToVaio(config, input, { run })).rejects.toThrow("link simbólico");
  expect(calls.some((call) => call.command === "rsync")).toBe(false);
});

test("keeps deterministic staging so an offline retry can resume safely", async () => {
  const { config, input } = await fixture();
  const firstCalls: RunCall[] = [];
  const firstRun = successfulRunner(input, firstCalls);
  let failed = false;
  const offlineOnce: typeof runCommand = async (command, args, options) => {
    if (command === "rsync" && !failed) {
      failed = true;
      throw new Error("offline");
    }
    return firstRun(command, args, options);
  };

  await expect(archiveMediaToVaio(config, input, { run: offlineOnce })).rejects.toThrow("offline");

  const retryCalls: RunCall[] = [];
  await archiveMediaToVaio(config, input, { run: successfulRunner(input, retryCalls) });
  const destinations = [...firstCalls, ...retryCalls]
    .filter((call) => call.command === "rsync")
    .map((call) => call.args[call.args.length - 1]);
  expect(new Set(destinations)).toEqual(
    new Set([`vaio.test:/srv/archive/media/2026/09/${input.id}.partial/source.mkv`])
  );
});

test("rejects a local symlink and a source that changes during transfer", async () => {
  const { config, input } = await fixture();
  const linkPath = join(input.sourcePath, "..", "meeting-link.mkv");
  await fs.symlink(input.sourcePath, linkPath);
  await expect(
    archiveMediaToVaio(config, { ...input, sourcePath: linkPath }, { run: async () => ({ stdout: "", stderr: "" }) })
  ).rejects.toThrow("link simbólico");

  const calls: RunCall[] = [];
  let hashes = 0;
  await expect(
    archiveMediaToVaio(config, input, {
      run: successfulRunner(input, calls),
      hashFile: async () => (++hashes === 1 ? input.source.sha256 : "d".repeat(64))
    })
  ).rejects.toThrow("mudou durante");
  expect(calls.some((call) => call.args[call.args.length - 1]?.includes("ARCHIVE_PUBLISH"))).toBe(false);
});

test("downloads verified archived media into a new private cache destination", async () => {
  const { config, input, content } = await fixture();
  const destinationRoot = await fs.mkdtemp(join(tmpdir(), "recording-cli-cache-"));
  temporaryDirectories.push(destinationRoot);
  const destinationPath = join(destinationRoot, "source.mkv");
  const calls: RunCall[] = [];
  const probeRun = successfulRunner(input, calls, "matching");
  const run: typeof runCommand = async (command, args, options) => {
    if (command === "rsync") {
      calls.push({ command, args, options });
      await fs.writeFile(args[args.length - 1], content);
      return { stdout: "", stderr: "" };
    }
    return probeRun(command, args, options);
  };

  const result = await downloadArchivedMedia(
    config,
    {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    },
    destinationPath,
    { run }
  );

  expect(result.destinationPath).toBe(destinationPath);
  expect(await fs.readFile(destinationPath, "utf-8")).toBe(content);
  expect((await fs.stat(destinationPath)).mode & 0o077).toBe(0);
  expect(calls.find((call) => call.command === "rsync")?.args[0]).toBe("--partial");
});

test("does not replace an existing cache destination or publish a corrupt download", async () => {
  const { config, input } = await fixture();
  const destinationRoot = await fs.mkdtemp(join(tmpdir(), "recording-cli-cache-"));
  temporaryDirectories.push(destinationRoot);
  const destinationPath = join(destinationRoot, "source.mkv");
  await fs.writeFile(destinationPath, "keep me");
  const calls: RunCall[] = [];

  await expect(
    downloadArchivedMedia(
      config,
      {
        archiveRelative: `media/2026/09/${input.id}`,
        fileName: "source.mkv",
        size: input.source.size,
        sha256: input.source.sha256
      },
      destinationPath,
      { run: successfulRunner(input, calls, "matching") }
    )
  ).rejects.toThrow("já existe");
  expect(await fs.readFile(destinationPath, "utf-8")).toBe("keep me");
  expect(calls).toHaveLength(0);

  await fs.rm(destinationPath);
  const run: typeof runCommand = async (command, args, options) => {
    if (command === "rsync") {
      await fs.writeFile(args[args.length - 1], "corrupt");
      return { stdout: "", stderr: "" };
    }
    return successfulRunner(input, [], "matching")(command, args, options);
  };
  await expect(
    downloadArchivedMedia(
      config,
      {
        archiveRelative: `media/2026/09/${input.id}`,
        fileName: "source.mkv",
        size: input.source.size,
        sha256: input.source.sha256
      },
      destinationPath,
      { run }
    )
  ).rejects.toThrow("download");
  await expect(fs.lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("validates archive paths, file names, hashes and remote symlinks", async () => {
  const { config, input } = await fixture();
  const run: typeof runCommand = async () => ({ stdout: "symlink\n", stderr: "" });

  await expect(
    inspectArchivedMedia(config, {
      archiveRelative: "../escape",
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    }, {}, { run })
  ).rejects.toThrow("archiveRelative");
  await expect(
    inspectArchivedMedia(config, {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "../source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    }, {}, { run })
  ).rejects.toThrow("fileName");
  await expect(
    inspectArchivedMedia(config, {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: "bad"
    }, {}, { run })
  ).rejects.toThrow("SHA-256");
  await expect(
    inspectArchivedMedia(config, {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    }, {}, { run })
  ).rejects.toThrow("link simbólico");

  const invalidRootRun: typeof runCommand = async () => ({ stdout: "invalid-root\n", stderr: "" });
  await expect(
    inspectArchivedMedia(config, {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    }, {}, { run: invalidRootRun })
  ).rejects.toThrow("archive root");
});

test("resolves a tilde archive root through the injected SSH executor", async () => {
  const { config, input } = await fixture();
  config.remote.archiveDir = "~/Recording Archive";
  const calls: RunCall[] = [];
  const run: typeof runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const remoteCommand = args[args.length - 1] || "";
    if (remoteCommand.includes("printenv")) return { stdout: "/home/worker\n", stderr: "" };
    if (remoteCommand.includes("ARCHIVE_PROBE")) {
      return {
        stdout: `ok\t${input.source.size}\t${input.source.sha256}\n`,
        stderr: ""
      };
    }
    throw new Error("unexpected command");
  };

  const result = await inspectArchivedMedia(
    config,
    {
      archiveRelative: `media/2026/09/${input.id}`,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    },
    { verifyHash: true },
    { run }
  );

  expect(result.archiveDir).toBe("/home/worker/Recording Archive");
  expect(calls[0].args[calls[0].args.length - 1]).toContain("'printenv' 'HOME'");
});

test("inspects the validated legacy archive namespace", async () => {
  const { config, input } = await fixture();
  const calls: RunCall[] = [];
  const archiveRelative = `2026/09/${input.id}`;

  const result = await inspectArchivedMedia(
    config,
    {
      archiveRelative,
      fileName: "source.mkv",
      size: input.source.size,
      sha256: input.source.sha256
    },
    { verifyHash: true },
    { run: successfulRunner(input, calls, "matching") }
  );

  expect(result.archiveRelative).toBe(archiveRelative);
  expect(result.sourcePath).toBe(`/srv/archive/${archiveRelative}/source.mkv`);
  expect(calls[0].args[calls[0].args.length - 1]).toContain(`/srv/archive/2026/09/${input.id}`);
});
