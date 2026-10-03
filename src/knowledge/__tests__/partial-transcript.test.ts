import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import { artifactDigest, transcriptionIdentity, readTranscriptArtifact, readArtifactStates } from "../../jobs/transcript-access";
import { searchMeetings, readMeetingContext } from "../meetings";
import { readArtifact, getArtifactAvailability } from "../../tui/library";
import { readableTranscriptJob } from "../../desktop/bridge";

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "partial-transcript-"));
  const previous = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state"); process.env.XDG_DATA_HOME = join(root, "data");
  const config = structuredClone(DEFAULT_CONFIG);
  config.processing.defaultTarget = "local";
  config.timesheet.enabled = false;
  config.summary.provider = "openai";
  config.transcription.provider = "openai";
  config.transcription.openaiModel = "gpt-transcribe";
  const source = join(root, "synthetic.mkv"); await fs.writeFile(source, "synthetic media");
  const store = new JobStore(); const initial = await store.enqueue(config, source);
  const work = store.getWorkDir(initial.id);
  const raw = JSON.stringify({ version: 1, ...initial.transcription, text: "Falamos sobre permissões sintéticas. contato@example.com", segments: [{ start: 0, end: 0.347, text: "Falamos sobre permissões sintéticas. contato@example.com" }] });
  await fs.writeFile(join(work, "transcript.json"), raw);
  const receipt = JSON.stringify({ version: 1, identity: transcriptionIdentity(initial), transcriptSha256: artifactDigest(raw) });
  await fs.writeFile(join(work, "transcript-receipt.json"), receipt);
  const job = await store.update(initial.id, "failed", { error: "Multi-request API summary requires an explicit paid-budget policy; use local summary" });
  return { config, store, job, work, raw, receipt, close: async () => {
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous.state;
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.data;
    await fs.rm(root, { recursive: true, force: true });
  } };
};

test("failed summary leaves verified transcript readable in CLI context, Studio selection, and TUI without writes", async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(join(f.store.stateDir, `${f.job.id}.json`), "utf8");
    const context = await readMeetingContext(f.config, f.job.id, { maxCharacters: 4096 });
    expect(context.jobState).toBe("failed"); expect(context.summary).toBeNull(); expect(context.summaryPath).toBeNull();
    expect(context.transcriptProvenance).toEqual({ origin: "work", receipt: "verified", mediaSha256: f.job.source.sha256, transcriptSha256: artifactDigest(f.raw), receiptSha256: artifactDigest(f.receipt) });
    expect(context.artifactStates).toEqual({ transcript: "ready", summary: "unavailable" });
    expect(context.excerpts[0].timing).toBe("block"); expect(context.budget.characters).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(context)).not.toContain("contato@example.com");
    const search = await searchMeetings(f.config, { query: "permissões", limit: 5 });
    expect(search.items).toHaveLength(1); expect(search.items[0].jobState).toBe("failed"); expect(search.items[0].summaryArtifactSha256).toBeNull();
    expect(await getArtifactAvailability(f.job)).toEqual({ transcript: true, summary: false });
    expect(await readArtifact(f.job, "transcript")).toContain("permissões sintéticas");
    const selected = await readableTranscriptJob({ jobs: [f.job] } as any);
    expect(selected?.artifact.provenance.receipt).toBe("verified");
    const states = await readArtifactStates(f.job);
    expect(states.transcript.state).toBe("ready"); expect(states.summary.state).toBe("failed");
    expect(await fs.readFile(join(f.store.stateDir, `${f.job.id}.json`), "utf8")).toBe(before);
    expect(await fs.readFile(join(f.work, "transcript.json"), "utf8")).toBe(f.raw);
    await expect(fs.stat(f.job.artifactDir)).rejects.toThrow(); // no implicit publication/migration
  } finally { await f.close(); }
});

for (const damage of ["missing-receipt", "hash", "identity", "settings", "symlink", "directory-symlink"] as const) test(`partial transcript fails closed for ${damage}, without provider retry`, async () => {
  const f = await fixture();
  try {
    const path = join(f.work, "transcript-receipt.json");
    if (damage === "missing-receipt") await fs.rm(path);
    if (damage === "hash") await fs.writeFile(path, JSON.stringify({ ...JSON.parse(f.receipt), transcriptSha256: "0".repeat(64) }));
    if (damage === "identity") await fs.writeFile(path, JSON.stringify({ ...JSON.parse(f.receipt), identity: "0".repeat(64) }));
    if (damage === "settings") {
      const raw = JSON.stringify({ ...JSON.parse(f.raw), model: "other-model" });
      await fs.writeFile(join(f.work, "transcript.json"), raw);
      await fs.writeFile(path, JSON.stringify({ ...JSON.parse(f.receipt), transcriptSha256: artifactDigest(raw) }));
    }
    if (damage === "symlink") { await fs.rm(path); await fs.symlink(join(f.work, "transcript.json"), path); }
    if (damage === "directory-symlink") { await fs.rename(f.work, f.work + "-moved"); await fs.symlink(f.work + "-moved", f.work); }
    await expect(readTranscriptArtifact(f.job)).rejects.toThrow();
    expect((await searchMeetings(f.config)).items).toHaveLength(0);
    expect((await f.store.get(f.job.id)).state).toBe("failed");
  } finally { await f.close(); }
});

test("processing checkpoint is readable; completed legacy publication remains explicit and compatible", async () => {
  const f = await fixture();
  try {
    const processing = await f.store.update(f.job.id, "processing");
    expect((await readTranscriptArtifact(processing)).provenance.receipt).toBe("verified");
    await fs.mkdir(f.job.artifactDir, { recursive: true }); await fs.writeFile(join(f.job.artifactDir, "transcript.json"), f.raw);
    const completed = await f.store.update(f.job.id, "completed");
    const artifact = await readTranscriptArtifact(completed);
    expect(artifact.provenance).toMatchObject({ origin: "published", receipt: "legacy-unverified" });
    expect((await readMeetingContext(f.config, completed.id)).summary).toBeNull();
    await fs.writeFile(join(f.job.artifactDir, "transcript-receipt.json"), f.receipt);
    expect((await readTranscriptArtifact(completed)).provenance.receipt).toBe("verified");
  } finally { await f.close(); }
});


test("interrupted publication never masks a valid checkpoint or exposes partial Markdown summary", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.job.artifactDir, { recursive: true });
    await fs.writeFile(join(f.job.artifactDir, "transcript.json"), f.raw);
    await fs.writeFile(join(f.job.artifactDir, "transcript.md"), "unverified Markdown sentinel");
    await fs.writeFile(join(f.job.artifactDir, "summary.md"), "uncommitted summary sentinel");
    const result = await readMeetingContext(f.config, f.job.id);
    expect(result.transcriptProvenance.origin).toBe("work");
    expect(result.summary).toBeNull();
    expect(await readArtifact(f.job, "transcript")).not.toContain("sentinel");
    expect(await readArtifact(f.job, "summary")).toBe("Resumo ainda não disponível.");
    await fs.writeFile(join(f.work, "transcript-receipt.json"), "{}");
    expect(await getArtifactAvailability(f.job)).toEqual({ transcript: false, summary: false });
    expect(await readArtifact(f.job, "transcript")).toBe("Transcrição ainda não disponível.");
    expect(await readableTranscriptJob({ jobs: [f.job] } as any)).toBeUndefined();
  } finally { await f.close(); }
});
