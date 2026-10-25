import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import type { JobRecord, Transcript } from "../../jobs/types";
import { RETAINED_AUDIO_FILE, recordingRootOf } from "../../media-retention/store";
import { writeRemovedTombstone } from "../../media-retention/__tests__/fixture";

assertQaIsolation();
const repo = join(import.meta.dir, "../../..");
const removedId = "66666666-6666-4666-8666-666666666666", audioId = "77777777-7777-4777-8777-777777777777";
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
type Reply = { id: number; ok: boolean; result?: any; error?: string };

const fixture = async () => {
  const root = await fs.mkdtemp(join(process.env.TMPDIR!, "retention-bridge-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const [key, name] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_STATE_HOME", "state"], ["XDG_DATA_HOME", "data"], ["XDG_RUNTIME_DIR", "runtime"], ["XDG_CACHE_HOME", "cache"], ["TMPDIR", "tmp"]] as const) {
    env[key] = join(root, name);
    await fs.mkdir(env[key]!, { mode: 0o700 });
  }
  assertQaIsolation(env);
  const recordings = join(root, "home", "recordings");
  await fs.mkdir(join(env.XDG_CONFIG_HOME!, "recording-cli"), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(env.XDG_CONFIG_HOME!, "recording-cli/config.json"), `${JSON.stringify({ recordingsDir: recordings })}\n`, { mode: 0o600 });
  await fs.mkdir(join(env.XDG_STATE_HOME!, "recording-cli/jobs"), { recursive: true, mode: 0o700 });
  const job = async (id: string, name: string, createdAt: string): Promise<JobRecord> => {
    const sourcePath = join(recordings, `${name}.mkv`), artifactDir = join(recordings, `${name}.recording`, id);
    await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const record: JobRecord = { version: 1, id, createdAt, updatedAt: createdAt,
      source: { originalName: `${name}.mkv`, mediaFile: "source.mkv", size: 15, sha256: digest(`media of ${name}`) },
      transcription: { provider: "whisper-cpp", model: "synthetic-local", language: "pt" }, summary: { provider: "ollama", model: "qwen3.5:9b" },
      sourcePath, artifactDir, target: "local", state: "completed" };
    await fs.writeFile(join(env.XDG_STATE_HOME!, "recording-cli/jobs", `${id}.json`), JSON.stringify(record), { mode: 0o600 });
    const transcript: Transcript = { version: 1, provider: "whisper-cpp", model: "synthetic-local", language: "pt", text: "Bom dia.", segments: [{ start: 0, end: 2, text: "Bom dia." }] };
    await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify(transcript), { mode: 0o600 });
    return record;
  };
  const removed = await job(removedId, "removed", "2026-10-20T00:00:00Z");
  await writeRemovedTombstone(removed);
  const audio = await job(audioId, "audio", "2026-10-21T00:00:00Z");
  const retained = join(recordingRootOf(audio.sourcePath), RETAINED_AUDIO_FILE), bytes = Buffer.from("synthetic retained audio");
  await fs.writeFile(retained, bytes, { mode: 0o600 });
  await writeRemovedTombstone(audio, { mode: "audio-only", source: { fileName: "audio.mkv", size: 15, sha256: audio.source.sha256, mtimeMs: Date.parse("2026-10-21T00:30:00Z") },
    audio: { fileName: RETAINED_AUDIO_FILE, size: bytes.length, sha256: digest(bytes), streams: [{ index: 0, title: "Mixed", channels: 2, codec: "opus" }], durationSeconds: 60 } });
  return { root, env, removed, audio, retained, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
};

const bridge = async (env: NodeJS.ProcessEnv, request: unknown): Promise<Reply> => {
  assertQaIsolation(env);
  const child = Bun.spawn(["/usr/bin/python3", "-I", join(repo, "scripts/qa-run.py"), process.execPath, "run", "--preload", join(repo, "scripts/offline-network.ts"), join(repo, "src/desktop/bridge.ts")],
    { cwd: repo, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout.trim());
};

test("the production bridge shows recordings whose media retention removed as transcript-only or audio-only, never missing", async () => {
  const context = await fixture();
  try {
    const list = await bridge(context.env, { id: 1, op: "list" });
    expect(list.ok).toBe(true);
    const byKey = new Map(list.result.items.map((item: any) => [item.key, item]));
    expect(byKey.get(context.removed.sourcePath)).toMatchObject({ location: "transcript-only", media: "removed", sourceExists: false, modifiedAt: Date.parse("2026-10-01T10:30:00.000Z") });
    expect(byKey.get(context.audio.sourcePath)).toMatchObject({ location: "audio-only", media: "audio-only", sourceExists: false, modifiedAt: Date.parse("2026-10-21T00:30:00Z") });
    const detail = await bridge(context.env, { id: 2, op: "detail", key: context.removed.sourcePath });
    expect(detail.ok).toBe(true);
    expect(detail.result.media).toEqual({ state: "removed", removedAt: "2026-10-05T09:00:01.000Z", reason: "policy",
      features: { playback: false, frames: false, diarize: false, speakersMic: false, voices: false, subtitles: false, reprocess: false } });
    expect(detail.result.transcript.segments.map((segment: { text: string }) => segment.text)).toEqual(["Bom dia."]);
    const audioDetail = await bridge(context.env, { id: 3, op: "detail", key: context.audio.sourcePath });
    expect(audioDetail.result.media).toMatchObject({ state: "audio-only", features: { playback: true, frames: false, diarize: true, reprocess: false } });
    // Audio-only plays the kept audio here; nothing is queued.
    expect(await bridge(context.env, { id: 4, op: "resolve", key: context.audio.sourcePath }))
      .toEqual({ id: 4, ok: true, result: { key: context.audio.sourcePath, state: "completed", location: "audio-only", path: context.retained } });
  } finally { await context.cleanup(); }
}, 30_000);

test("audio-only plays the kept audio here even with a verified archive copy elsewhere: no network, no full video restored", async () => {
  const context = await fixture();
  try {
    await fs.writeFile(join(context.env.XDG_CONFIG_HOME!, "recording-cli/config.json"),
      `${JSON.stringify({ recordingsDir: join(context.root, "home", "recordings"), archive: { enabled: true, vaio: true, proton: true } })}\n`, { mode: 0o600 });
    const catalog = join(context.env.XDG_STATE_HOME!, "recording-cli/media-archive");
    await fs.mkdir(catalog, { recursive: true, mode: 0o700 });
    const archiveId = "88888888-8888-4888-8888-888888888888";
    await fs.writeFile(join(catalog, `${archiveId}.json`), JSON.stringify({
      version: 1, id: archiveId, createdAt: "2026-10-21T00:00:00Z", sourcePath: context.audio.sourcePath,
      source: { fileName: "source.mkv", size: 15, mtimeMs: 1, sha256: context.audio.source.sha256 },
      vaio: { state: "completed", path: "/srv/archive/media/2026/10/source.mkv", verifiedAt: "2026-10-21T01:00:00Z", archiveRelative: "media/2026/10/x" },
      proton: { state: "completed", path: "/my-files/RecordingArchive/media/2026/10/source.mkv", verifiedAt: "2026-10-21T02:00:00Z" }
    }), { mode: 0o600 });
    const list = await bridge(context.env, { id: 1, op: "list" });
    // The listing still says where the copies are; playback uses the audio kept on this computer.
    expect(list.result.items.find((item: any) => item.key === context.audio.sourcePath)).toMatchObject({ location: "vaio", media: "audio-only", backup: "vaio+proton" });
    expect(await bridge(context.env, { id: 2, op: "resolve", key: context.audio.sourcePath }))
      .toEqual({ id: 2, ok: true, result: { key: context.audio.sourcePath, state: "completed", location: "audio-only", path: context.retained } });
  } finally { await context.cleanup(); }
}, 30_000);
