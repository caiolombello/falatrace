import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults";
import { JobStore } from "../jobs/store";
import { artifactDigest, transcriptionIdentity, readArtifactStates } from "../jobs/transcript-access";
import { readMeetingTitle, type LibraryEntry } from "../tui/library";
import { recordingPresentation } from "./recording-presentation";

const mediaTime = Date.parse("2026-10-02T01:20:00Z");
const entry = (): LibraryEntry => ({ sourcePath: "/synthetic/recording.mkv", relativePath: "recording.mkv", sourceExists: true, size: 1, modifiedAt: mediaTime, jobs: [] });

test("fallback uses media time and explicit timezone including date rollover, with no inferred subject", () => {
  const utc = recordingPresentation(entry(), undefined, "UTC");
  const brazil = recordingPresentation(entry(), undefined, "America/Sao_Paulo");
  expect(utc.title).toContain("02/10/2026"); expect(utc.title).toContain("01:20"); expect(utc.title).toContain("UTC");
  expect(brazil.title).toContain("01/10/2026"); expect(brazil.title).toContain("22:20"); expect(brazil.title).toMatch(/BRT|GMT-3/);
  expect(utc.title).not.toContain("recording.mkv");
  expect(utc.artifactStatus).toBe("Transcrição indisponível · Resumo indisponível");
  const local = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(mediaTime);
  expect(recordingPresentation(entry()).title).toBe(`Gravação — ${local}`);
});

test("old jobs fall back to creation date without epoch or queue time overriding known media time", () => {
  const old = { ...entry(), modifiedAt: NaN, jobs: [{ createdAt: "2020-01-01T00:30:00Z" }] } as LibraryEntry;
  expect(recordingPresentation(old, undefined, "UTC").title).toContain("01/01/2020");
  expect(recordingPresentation({ ...old, modifiedAt: mediaTime }, undefined, "UTC").title).toContain("02/10/2026");
  expect(recordingPresentation({ ...entry(), modifiedAt: 0 }).title).toBe("Gravação — data indisponível");
});

test("a known title is preserved exactly and job failure never proves which artifact is ready", () => {
  const known = { ...entry(), meetingTitle: "  Título já existente  " };
  expect(recordingPresentation(known).title).toBe(known.meetingTitle!);
  expect(recordingPresentation(known).hasMeetingTitle).toBe(true);
  expect(recordingPresentation({ ...entry(), meetingTitle: " " }).hasMeetingTitle).toBe(false);
});

test("failed-summary checkpoint and completed legacy artifacts display actual readiness without writing or migrating", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-presentation-"));
  try {
    const source = join(root, "recording.mkv"); await fs.writeFile(source, "synthetic");
    const config = structuredClone(DEFAULT_CONFIG); config.timesheet.enabled = false;
    const store = new JobStore(join(root, "state", "recording-cli", "jobs"), join(root, "data", "recording-cli", "jobs"));
    const initial = await store.enqueue(config, source);
    const work = store.getWorkDir(initial.id);
    const raw = JSON.stringify({ version: 1, ...initial.transcription, text: "Sintético", segments: [] });
    await fs.writeFile(join(work, "transcript.json"), raw);
    await fs.writeFile(join(work, "transcript-receipt.json"), JSON.stringify({ version: 1, identity: transcriptionIdentity(initial), transcriptSha256: artifactDigest(raw) }));
    const failed = await store.update(initial.id, "failed", { error: "Summary budget" });
    const before = await fs.readFile(join(store.stateDir, `${failed.id}.json`), "utf8");
    const failedEntry = { ...entry(), sourcePath: source, jobs: [failed] };
    expect(recordingPresentation(failedEntry, await readArtifactStates(failed, store), "UTC").artifactStatus).toBe("Transcrição pronta · Resumo indisponível");
    // Exercise the actual read-only bridge, not only the formatter or UI stub.
    const configDir = join(root, "config", "recording-cli"); await fs.mkdir(configDir, { recursive: true });
    config.recordingsDir = root; config.archive.enabled = false;
    await fs.writeFile(join(configDir, "config.json"), JSON.stringify(config));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "bridge.ts")], {
      env: { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TZ: "America/Sao_Paulo" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe"
    });
    for (const request of [{ id: 1, op: "list" }, { id: 2, op: "jobs-list" }, { id: 3, op: "detail", key: source }]) child.stdin.write(JSON.stringify(request) + "\n");
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const responses = output.trim().split("\n").map(line => JSON.parse(line)).sort((a, b) => a.id - b.id);
    expect(responses.map(response => response.ok)).toEqual([true, true, true]);
    for (const display of [responses[0].result.items[0], responses[1].result.items[0], responses[2].result]) {
      expect(display.title).toStartWith("Gravação — ");
      expect(display.title).toMatch(/BRT|GMT-3/);
      expect(display.artifactStatus).toBe("Transcrição pronta · Resumo indisponível");
    }
    expect(responses[0].result.items[0].fileName).toBe("recording.mkv");
    expect(responses[2].result.artifacts.transcript.state).toBe("ready");
    expect(recordingPresentation({ ...failedEntry, jobs: [{ ...failed, state: "processing" }] }, await readArtifactStates(failed, store)).artifactStatus).toBe("Transcrição pronta · Resumo indisponível");
    // A newer job without artifacts must not relabel readable older content.
    const pending = await store.enqueue(config, source);
    const later = Bun.spawn([process.execPath, join(import.meta.dir, "bridge.ts")], {
      env: { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), TZ: "America/Sao_Paulo" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe"
    });
    later.stdin.write(JSON.stringify({ id: 4, op: "detail", key: source }) + "\n"); later.stdin.end();
    const laterResponse = JSON.parse((await new Response(later.stdout).text()).trim());
    expect(await later.exited).toBe(0); expect(laterResponse.ok).toBe(true);
    const previousContent = laterResponse.result;
    expect(pending.id).not.toBe(failed.id);
    expect(previousContent.status).toBe("pending");
    expect(previousContent.jobId).toBe(failed.id);
    expect(previousContent.artifacts.transcript.state).toBe("ready");
    expect(previousContent.transcript.text).toBe("Sintético");
    expect(previousContent.artifactStatus).toContain("Transcrição pronta · Resumo indisponível");
    expect(previousContent.artifactStatus).toContain("conteúdo de tarefa anterior");
    await fs.writeFile(join(work, "transcript-receipt.json"), "{}");
    expect(recordingPresentation(failedEntry, await readArtifactStates(failed, store)).artifactStatus).toBe("Transcrição indisponível · Resumo indisponível");
    expect(await fs.readFile(join(store.stateDir, `${failed.id}.json`), "utf8")).toBe(before);
    expect(await fs.readFile(join(work, "transcript.json"), "utf8")).toBe(raw);
    await expect(fs.stat(failed.artifactDir)).rejects.toThrow();
    // Completed old jobs can keep their published title without a receipt.
    await fs.mkdir(failed.artifactDir, { recursive: true });
    await fs.writeFile(join(failed.artifactDir, "transcript.json"), raw);
    await fs.writeFile(join(failed.artifactDir, "summary.json"), JSON.stringify({ title: "Título legado", overview: "Sintético", topics: [], decisions: [], actionItems: [] }));
    const completed = await store.update(failed.id, "completed");
    const legacy = { ...failedEntry, jobs: [completed], meetingTitle: await readMeetingTitle(completed) };
    const display = recordingPresentation(legacy, await readArtifactStates(completed, store));
    expect(display.title).toBe("Título legado"); expect(display.artifactStatus).toBe("Transcrição pronta · Resumo pronto");
    expect(display.hasMeetingTitle).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
