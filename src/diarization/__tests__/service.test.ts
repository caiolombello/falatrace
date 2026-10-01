import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { JobRecord, Transcript } from "../../jobs/types";
import { queueDiarization } from "../service";

test("diarizes once, preserves original artifacts, and rejects a changed source before upload", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-diarization-flow-"));
  const repository = resolve(import.meta.dir, "../../..");
  const script = join(root, "flow.ts");
  const module = (name: string): string => JSON.stringify(join(repository, name));
  try {
    await fs.writeFile(script, `
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from ${module("src/config/defaults.ts")};
import { JobStore, hashFile } from ${module("src/jobs/store.ts")};
import { createDiarization, nameDiarizationSpeaker, resultStatus } from ${module("src/diarization/service.ts")};
const root = process.env.TEST_ROOT!;
const config = structuredClone(DEFAULT_CONFIG);
config.recordingsDir = join(root, "recordings");
config.transcription.provider = "openai";
config.transcription.openaiModel = "gpt-transcribe";
config.processing.defaultTarget = "local";
config.timesheet.contextPath = join(root, "no-context.json");
await fs.mkdir(config.recordingsDir, {recursive:true});
const source = join(config.recordingsDir, "fixture.wav");
const pcm = Buffer.alloc(44 + 3 * 16000 * 2);
pcm.write("RIFF", 0); pcm.writeUInt32LE(pcm.length-8, 4); pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16,16); pcm.writeUInt16LE(1,20); pcm.writeUInt16LE(1,22);
pcm.writeUInt32LE(16000,24); pcm.writeUInt32LE(32000,28); pcm.writeUInt16LE(2,32); pcm.writeUInt16LE(16,34);
pcm.write("data",36); pcm.writeUInt32LE(pcm.length-44,40);
await fs.writeFile(source,pcm);
const jobs = new JobStore();
const created = await jobs.enqueue(config,source);
const job = await jobs.update(created.id,"completed");
await fs.mkdir(job.artifactDir,{recursive:true});
const text = "Olá, primeira pessoa.  Segunda pessoa responde.\\n";
const transcript = {version:1,provider:"openai",model:"gpt-transcribe",language:"pt",text,segments:[{start:0,end:3,text}]};
const original = join(job.artifactDir,"transcript.json");
const summary = join(job.artifactDir,"summary.md");
await fs.writeFile(original,JSON.stringify(transcript));
await fs.writeFile(summary,"Resumo preservado.");
const before = [await hashFile(original),await hashFile(summary),await hashFile(source)];
let requests = 0;
let entered!: () => void; let release!: () => void;
const started = new Promise<void>(done => {entered=done;});
const gate = new Promise<void>(done => {release=done;});
const diarize = async () => { requests++; entered(); await gate; return [
  {start:0,end:1.5,text:"Olá, primeira pessoa.",speaker:"S01"},
  {start:1.5,end:3,text:"Segunda pessoa responde.",speaker:"S02"}
]; };
const processing = createDiarization(config,job.id,{diarize});
await started;
let duplicateRejected = false;
try {await createDiarization(config,job.id,{diarize});} catch {duplicateRejected=true;}
release();
const first = await processing;
await createDiarization(config,job.id,{diarize});
await nameDiarizationSpeaker(job.id,"S01","Pessoa local");
const renamed = await createDiarization(config,job.id,{diarize});
const after = [await hashFile(original),await hashFile(summary),await hashFile(source)];
const different = await jobs.enqueue(config,source);
const changedJob = await jobs.update(different.id,"completed");
await fs.mkdir(changedJob.artifactDir,{recursive:true});
await fs.writeFile(join(changedJob.artifactDir,"transcript.json"),JSON.stringify(transcript));
pcm[pcm.length-1]=1; await fs.writeFile(source,pcm);
let rejected = false;
try {await createDiarization(config,changedJob.id,{diarize});} catch {rejected=true;}
console.log(JSON.stringify({requests,duplicateRejected,preserved:JSON.stringify(before)===JSON.stringify(after),textPreserved:first.alignment.text===text,state:resultStatus(first).state,label:renamed.labels.S01,rejected}));
`, { mode: 0o600 });
    const env = { ...process.env, TEST_ROOT: root, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config") };
    await fs.mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const child = Bun.spawn([globalThis.process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ requests: 1, duplicateRejected: true, preserved: true, textPreserved: true, state: "review", label: "Pessoa local", rejected: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

const queueJob = (id: string): JobRecord => ({
  version: 1, id, createdAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z",
  source: { originalName: "source.wav", mediaFile: "source.wav", size: 10, sha256: "a".repeat(64) },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
  summary: { provider: "ollama", model: "model" }, sourcePath: "/tmp/source.wav", artifactDir: "/tmp/source.recording/" + id,
  target: "local", state: "completed"
});

const queueCanonical: Transcript = { version: 1, provider: "openai", model: "gpt-transcribe", language: "pt", text: "Uma transcrição.", segments: [] };

const queueDeps = (id: string, options: { cached?: boolean; active?: boolean; fail?: boolean } = {}) => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operations: string[] = [];
  return {
    calls,
    operations,
    dependencies: {
      getJob: async () => queueJob(id),
      readCanonical: async () => queueCanonical,
      store: {
        read: async () => options.cached ? ({ labels: { S01: "Pessoa" } } as never) : undefined,
        writeOperation: async (operation: { state: string }) => { operations.push(operation.state); }
      },
      unitActive: async () => options.active === true,
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (options.fail) throw new Error("systemd indisponível");
        return { stdout: "", stderr: "" };
      }
    }
  };
};

test("queues a new diarization unit with the worker EnvironmentFile", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174001";
  const fixture = queueDeps(id);
  const result = await queueDiarization(id, fixture.dependencies);
  expect(result).toEqual({ id, status: "queued", unit: `recording-cli-diarization-${id}.service` });
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]!.command).toBe("systemd-run");
  expect(fixture.calls[0]!.args).toContain(`--property=EnvironmentFile=-${join(homedir(), ".config/recording-cli/worker.env")}`);
  expect(fixture.calls[0]!.args.slice(-3)).toEqual(["diarization", "create", id]);
  expect(fixture.operations).toEqual(["running"]);
});

test("returns review for cached diarization without launching a unit", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174002";
  const fixture = queueDeps(id, { cached: true });
  await expect(queueDiarization(id, fixture.dependencies)).resolves.toEqual({ id, status: "review" });
  expect(fixture.calls).toEqual([]);
  expect(fixture.operations).toEqual([]);
});

test("returns queued for an active unit without launching another", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174003";
  const fixture = queueDeps(id, { active: true });
  await expect(queueDiarization(id, fixture.dependencies)).resolves.toEqual({ id, status: "queued", unit: `recording-cli-diarization-${id}.service` });
  expect(fixture.calls).toEqual([]);
  expect(fixture.operations).toEqual([]);
});

test("records failed when launching the diarization unit fails", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174004";
  const fixture = queueDeps(id, { fail: true });
  await expect(queueDiarization(id, fixture.dependencies)).rejects.toThrow("Não foi possível iniciar a identificação");
  expect(fixture.calls[0]!.command).toBe("systemd-run");
  expect(fixture.operations).toEqual(["running", "failed"]);
});
