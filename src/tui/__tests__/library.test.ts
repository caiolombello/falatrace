import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig } from "../../config/load";
import { JobStore } from "../../jobs/store";
import {
  buildLibrary,
  deleteJobArtifacts,
  deleteRecording,
  getArtifactAvailability,
  moveToTrash,
  readArtifact
} from "../library";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-tui-test-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("recording library", () => {
  test("lists primary recordings and groups jobs while ignoring generated audio", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const sessionDir = join(recordingsDir, "session");
    await fs.mkdir(sessionDir, { recursive: true });
    const mediaPath = join(sessionDir, "meeting.mkv");
    await fs.writeFile(mediaPath, "video");
    await fs.writeFile(join(sessionDir, "audio_fast.mp3"), "generated audio");
    await fs.writeFile(join(sessionDir, "chunk_0.mp3"), "generated chunk");
    await fs.mkdir(join(sessionDir, "meeting.recording", "old"), { recursive: true });
    await fs.writeFile(join(sessionDir, "meeting.recording", "old", "source.wav"), "artifact media");

    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const job = await store.enqueue(config, mediaPath);
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(
      join(job.artifactDir, "summary.json"),
      JSON.stringify({
        overview: "Revisão dos alertas da Example Vet. Ações foram definidas.",
        topics: ["Alertas"],
        decisions: [],
        actionItems: []
      })
    );
    await store.update(job.id, "completed");
    const library = await buildLibrary(config, store);

    expect(library).toHaveLength(1);
    expect(library[0].relativePath).toBe("session/meeting.mkv");
    expect(library[0].jobs.map((item) => item.id)).toEqual([job.id]);
    expect(library[0].meetingTitle).toBe(
      "Revisão dos alertas da Example Vet"
    );
  });

  test("ignores an unsafe summary metadata file without hiding the recording", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(recordingsDir, "meeting.mkv");
    const externalSummary = join(root, "external-summary.json");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    await fs.writeFile(
      externalSummary,
      JSON.stringify({
        title: "Título externo",
        overview: "Resumo",
        topics: [],
        decisions: [],
        actionItems: []
      })
    );
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const job = await store.enqueue(config, mediaPath);
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.symlink(externalSummary, join(job.artifactDir, "summary.json"));
    await store.update(job.id, "completed");

    const library = await buildLibrary(config, store);

    expect(library).toHaveLength(1);
    expect(library[0].meetingTitle).toBeUndefined();
  });

  test("keeps recordings without processing jobs visible", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(join(recordingsDir, "standalone.wav"), "audio");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));

    const library = await buildLibrary(config, store);

    expect(library).toHaveLength(1);
    expect(library[0].jobs).toEqual([]);
  });

  test("reports pending artifacts for a job outside the configured library", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(root, "obs-recording.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const job = await store.enqueue(config, mediaPath);

    expect(await readArtifact(job, "transcript", store)).toBe(
      "Transcrição ainda não disponível."
    );
  });

  test("reports transcript and summary availability independently", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(recordingsDir, "meeting.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const pending = await store.enqueue(config, mediaPath);
    // Legacy published Markdown is readable only after the job is committed.
    const job = await store.update(pending.id, "completed");
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(join(job.artifactDir, "transcript.md"), "transcript");

    expect(await getArtifactAvailability(job, store)).toEqual({
      transcript: true,
      summary: false
    });
  });

  test("reads a job artifact beside an OBS recording outside the configured library", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(root, "obs-recording.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const pending = await store.enqueue(config, mediaPath);
    // Legacy published Markdown is readable only after the job is committed.
    const job = await store.update(pending.id, "completed");
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(join(job.artifactDir, "transcript.md"), "OBS transcript");

    expect(await readArtifact(job, "transcript", store)).toBe("OBS transcript");
  });

  test("refuses to read through a redirected artifact directory", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(root, "obs-recording.mkv");
    const redirectedRoot = join(root, "redirected");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const pending = await store.enqueue(config, mediaPath);
    // Legacy published Markdown is readable only after the job is committed.
    const job = await store.update(pending.id, "completed");
    await fs.mkdir(join(redirectedRoot, job.id), { recursive: true });
    await fs.writeFile(join(redirectedRoot, job.id, "transcript.md"), "redirected");
    await fs.symlink(redirectedRoot, join(root, "obs-recording.recording"), "dir");

    await expect(readArtifact(job, "transcript", store)).rejects.toThrow(
      "Job artifact path does not match its recording"
    );
  });
});

describe("Trash operations", () => {
  test("moves a file to the freedesktop Trash with restore metadata", async () => {
    const root = await makeTemporaryDirectory();
    const source = join(root, "meeting notes.mkv");
    const trashRoot = join(root, "trash");
    await fs.writeFile(source, "video");

    const destination = await moveToTrash(source, trashRoot);

    expect(destination).toBe(join(trashRoot, "files", "meeting notes.mkv"));
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(destination!, "utf-8")).toBe("video");
    const info = await fs.readFile(join(trashRoot, "info", "meeting notes.mkv.trashinfo"), "utf-8");
    expect(info).toContain("Path=");
    expect(info).toContain("meeting%20notes.mkv");
    expect(info).toContain("DeletionDate=");
  });

  test("deletes one job without deleting its recording", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(recordingsDir, "meeting.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const job = await store.enqueue(config, mediaPath);
    await fs.mkdir(job.artifactDir, { recursive: true });
    await fs.writeFile(join(job.artifactDir, "transcript.md"), "transcript");
    const [entry] = await buildLibrary(config, store);

    const result = await deleteJobArtifacts(config, entry, job, store, join(root, "trash"));

    expect(result.removedJobs).toBe(1);
    expect((await fs.stat(mediaPath)).isFile()).toBe(true);
    await expect(fs.stat(job.artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.get(job.id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("deletes a recording and all of its local job artifacts", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(recordingsDir, "meeting.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const first = await store.enqueue(config, mediaPath);
    const second = await store.enqueue(config, mediaPath);
    for (const job of [first, second]) {
      await fs.mkdir(job.artifactDir, { recursive: true });
      await fs.writeFile(join(job.artifactDir, "summary.md"), "summary");
    }
    const [entry] = await buildLibrary(config, store);

    const result = await deleteRecording(config, entry, store, join(root, "trash"));

    expect(result.removedJobs).toBe(2);
    await expect(fs.stat(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(join(recordingsDir, "meeting.recording"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list()).toEqual([]);
  });

  test("preserves jobs for a recording with the same basename", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const firstPath = join(recordingsDir, "meeting.mkv");
    const secondPath = join(recordingsDir, "meeting.mp4");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(firstPath, "first");
    await fs.writeFile(secondPath, "second");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const firstJob = await store.enqueue(config, firstPath);
    const secondJob = await store.enqueue(config, secondPath);
    await fs.mkdir(firstJob.artifactDir, { recursive: true });
    await fs.mkdir(secondJob.artifactDir, { recursive: true });
    await fs.writeFile(join(firstJob.artifactDir, "summary.md"), "first summary");
    await fs.writeFile(join(secondJob.artifactDir, "summary.md"), "second summary");
    const entry = (await buildLibrary(config, store)).find(
      (candidate) => candidate.sourcePath === firstPath
    )!;

    const result = await deleteRecording(config, entry, store, join(root, "trash"));

    expect(result.keptSharedArtifacts).toBe(true);
    expect(await fs.readFile(join(secondJob.artifactDir, "summary.md"), "utf-8")).toBe("second summary");
    expect((await fs.stat(secondPath)).isFile()).toBe(true);
    expect((await store.get(secondJob.id)).id).toBe(secondJob.id);
    await expect(store.get(firstJob.id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to follow an artifact directory symlink outside the library", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const mediaPath = join(recordingsDir, "meeting.mkv");
    const externalRoot = join(root, "external-artifacts");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(mediaPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    const job = await store.enqueue(config, mediaPath);
    await fs.mkdir(join(externalRoot, job.id), { recursive: true });
    await fs.writeFile(join(externalRoot, job.id, "summary.md"), "keep me");
    await fs.symlink(externalRoot, join(recordingsDir, "meeting.recording"), "dir");
    const [entry] = await buildLibrary(config, store);

    await expect(
      deleteJobArtifacts(config, entry, job, store, join(root, "trash"))
    ).rejects.toThrow("outside the recordings directory");
    expect(await fs.readFile(join(externalRoot, job.id, "summary.md"), "utf-8")).toBe("keep me");
    expect((await store.get(job.id)).id).toBe(job.id);
  });

  test("refuses to delete a recording outside the configured library", async () => {
    const root = await makeTemporaryDirectory();
    const recordingsDir = join(root, "recordings");
    const externalPath = join(root, "external.mkv");
    await fs.mkdir(recordingsDir);
    await fs.writeFile(externalPath, "video");
    const config = mergeConfig(DEFAULT_CONFIG, { recordingsDir });
    const store = new JobStore(join(root, "state"), join(root, "data"));
    await store.enqueue(config, externalPath);
    const [entry] = await buildLibrary(config, store);

    await expect(deleteRecording(config, entry, store, join(root, "trash"))).rejects.toThrow(
      "outside the recordings directory"
    );
    expect((await fs.stat(externalPath)).isFile()).toBe(true);
  });
});
