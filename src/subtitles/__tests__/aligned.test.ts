import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { findAlignedSubtitles, createAlignedSubtitles, parseAlignedWhisperJson, type RemoteWhisperConfig } from "../aligned";

const originalDataHome = process.env.XDG_DATA_HOME;
const roots: string[] = [];

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const input = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  sourcePath: "/tmp/meeting.mp4",
  source: { size: 12, sha256: "a".repeat(64), fileName: "source.mp4" },
  archiveRelative: "2026/09/123e4567-e89b-42d3-a456-426614174000"
};

const config = mergeConfig(DEFAULT_CONFIG, {
  remote: { host: "worker.test", user: "worker", port: 22, archiveDir: "~/Videos/RecordingArchive" },
  transcription: {
    language: "pt",
    whisperCpp: { command: "/opt/whisper-cli", modelPath: "/opt/model.bin", threads: 8, variant: "cpu" }
  }
});

test("converts whisper millisecond offsets to real segment timestamps", () => {
  const subtitle = parseAlignedWhisperJson(
    JSON.stringify({
      result: { language: "pt" },
      transcription: [
        { offsets: { from: 1250, to: 2875 }, text: " Olá mundo " },
        { offsets: { from: 3000, to: 3500 }, text: "\t" }
      ]
    }),
    input,
    config,
    () => new Date("2026-09-08T12:00:00.000Z")
  );

  expect(subtitle.provider).toBe("whisper-cpp");
  expect(subtitle.text).toBe("Olá mundo");
  expect(subtitle.segments).toEqual([{ start: 1.25, end: 2.875, text: "Olá mundo" }]);
  expect(subtitle.mediaSha256).toBe(input.source.sha256);
  expect(subtitle.modelSource).toEqual({
    command: "/opt/whisper-cli",
    path: "/opt/model.bin",
    hash: "",
    threads: 8,
    variant: "cpu"
  });
});

test("creates an immutable local cache from only the remote JSON artifact", async () => {
  const root = await fs.mkdtemp("/tmp/recording-subtitles-test-");
  roots.push(root);
  process.env.XDG_DATA_HOME = root;
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push([command, ...args]);
    if (command === "rsync") {
      await fs.writeFile(args[args.length - 1]!, JSON.stringify({
        result: { language: "pt" },
        transcription: [{ offsets: { from: 0, to: 900 }, text: " Olá " }]
      }));
    }
    return { stdout: "", stderr: "" };
  };

  const result = await createAlignedSubtitles(config, input, {
    run,
    now: () => new Date("2026-09-08T12:00:00.000Z"),
    resolveArchiveDir: async () => "/srv/recordings",
    readRemoteWhisperConfig: async (): Promise<RemoteWhisperConfig> => ({
      home: "/home/worker",
      command: "/opt/whisper-cli",
      modelPath: "/opt/model.bin",
      modelSha256: "b".repeat(64),
      threads: 8,
      variant: "cpu",
      language: "pt"
    })
  });
  expect(result.segments).toBe(1);
  expect(await findAlignedSubtitles(input.source.sha256)).toBe(result.path);
  const cached = JSON.parse(await fs.readFile(result.path, "utf8"));
  expect(cached.mediaSha256).toBe(input.source.sha256);
  expect(cached.segments[0]).toEqual({ start: 0, end: 0.9, text: "Olá" });
  expect(calls.filter(([command]) => command === "ssh")).toHaveLength(2);
  expect(calls.filter(([command]) => command === "rsync")).toHaveLength(1);
  const sshCall = calls.find(([command]) => command === "ssh");
  const sshCommand = sshCall ? sshCall[sshCall.length - 1] || "" : "";
  expect(sshCommand).toContain("-map 0:a:0");
  expect(sshCommand).toContain("-ac 1");
  expect(sshCommand).toContain("-ar 16000");
  expect(sshCommand).toContain("/opt/model.bin");
  expect(sshCommand).toContain("/srv/recordings/2026/09/123e4567-e89b-42d3-a456-426614174000/source.mp4");
  expect(sshCommand).not.toContain("/srv/recordings/media/");
  expect(sshCommand).toContain('>"$stage/whisper.log" 2>&1');

  const second = await createAlignedSubtitles(config, input, { run, resolveArchiveDir: async () => "/srv/recordings" });
  expect(second).toEqual(result);
  expect(calls.filter(([command]) => command === "ssh")).toHaveLength(2);
});

test("rejects empty whisper output", () => {
  expect(() => parseAlignedWhisperJson(
    JSON.stringify({ transcription: [] }),
    input,
    config
  )).toThrow("não produziu segmentos");
});

test("rejects absolute archive paths", () => {
  expect(() => createAlignedSubtitles(config, { ...input, archiveRelative: "/2026/09/123e4567-e89b-42d3-a456-426614174000" })).toThrow("archiveRelative inválido");
});

test.each([input.archiveRelative, `media/${input.archiveRelative}`])("preserves archive layout %s and cleans only its staging directory on failure", async (archiveRelative) => {
  const root = await fs.mkdtemp("/tmp/recording-subtitles-test-");
  roots.push(root);
  process.env.XDG_DATA_HOME = root;
  const calls: string[][] = [];
  await expect(createAlignedSubtitles(config, { ...input, archiveRelative }, {
    resolveArchiveDir: async () => "/srv/recordings",
    readRemoteWhisperConfig: async () => ({ home: "/home/worker", command: "/opt/whisper-cli", modelPath: "/opt/model.bin", modelSha256: "b".repeat(64), threads: 8, variant: "cpu", language: "pt" }),
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (calls.length === 1) throw new Error("private transcript output");
      return { stdout: "", stderr: "" };
    }
  })).rejects.toThrow("A geração de legendas no VAIO falhou");
  expect(calls).toHaveLength(2);
  expect(calls[0]![calls[0]!.length - 1]).toContain(`/srv/recordings/${archiveRelative}/source.mp4`);
  expect(calls[1]![calls[1]!.length - 1]).toMatch(/^rm -rf -- '\/home\/worker\/\.local\/share\/recording-cli\/subtitles\/[a-f0-9]{64}\.partial-[a-f0-9-]+'$/);
});
