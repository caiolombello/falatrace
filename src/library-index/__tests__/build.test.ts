import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { JobRecord } from "../../jobs/types";
import {
  buildJobIndex,
  calendarLinksDir,
  type MeetingSegment,
  notesDigestOf,
  probeJob,
  readCalendarLink,
  readMeetingSource,
  segmentChunks,
  segmentsNearNote,
  sourceFingerprint,
  validateCalendarLink
} from "../build";
import { validateStoredJobIndex } from "../store";
import { fakeArtifacts, filler, type FixtureRoot, makeRoot, summaryOf, writeJob } from "./fixtures";

let fixture: FixtureRoot | undefined;
afterEach(async () => { await fixture?.restore(); fixture = undefined; });

const JOB = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  version: 1, id: JOB, createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-01T14:00:00.000Z",
  source: { originalName: "reuniao.mkv", mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) },
  transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" }, summary: { provider: "openai", model: "gpt-4o-mini" },
  sourcePath: "/m/reuniao.mkv", artifactDir: `/m/reuniao.recording/${JOB}`, target: "local", state: "completed", ...overrides
});

const segment = (index: number, text: string, extra: Partial<MeetingSegment> = {}): MeetingSegment =>
  ({ id: `s${String(index).padStart(6, "0")}`, start: index * 10, end: index * 10 + 9, text, ...extra });

describe("segmentChunks", () => {
  test("groups consecutive segments into chunks of about 500–800 characters without splitting any", () => {
    const segments = Array.from({ length: 40 }, (_value, index) => segment(index, `Frase número ${index} com algum conteúdo para medir o tamanho do trecho.`));
    const chunks = segmentChunks(JOB, segments);
    const ids = chunks.flatMap((chunk) => chunk.segmentIds);
    expect(ids).toEqual(segments.map((item) => item.id));
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(500);
      expect(chunk.text.length).toBeLessThanOrEqual(800);
    }
    // One line per segment, so a line maps back to its id.
    for (const chunk of chunks) expect(chunk.text.split("\n")).toHaveLength(chunk.segmentIds.length);
    expect(chunks[0]!.chunkId).toBe(`${JOB}:s000000-${chunks[0]!.segmentIds[chunks[0]!.segmentIds.length - 1]}`);
    expect(chunks[0]!.start).toBe(0);
  });

  test("closes a short run instead of exceeding 800 characters", () => {
    const chunks = segmentChunks(JOB, [segment(0, "a".repeat(300)), segment(1, "b".repeat(600)), segment(2, "c".repeat(100))]);
    expect(chunks.map((chunk) => chunk.segmentIds)).toEqual([["s000000"], ["s000001"], ["s000002"]]);
  });

  test("cuts only very long block segments, keeping their id on every piece", () => {
    const long = Array.from({ length: 400 }, (_value, index) => `palavra${index}`).join(" ");
    const chunks = segmentChunks(JOB, [segment(0, "curto"), segment(1, long, { speaker: "Ana" }), segment(2, "fim")]);
    const pieces = chunks.filter((chunk) => chunk.segmentIds[0] === "s000001");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((chunk) => chunk.segmentIds.length === 1 && chunk.text.length <= 800 && chunk.speakers?.[0] === "Ana")).toBe(true);
    expect(pieces.map((chunk) => chunk.text).join(" ")).toBe(long);
    expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(chunks.length);
  });

  test("keeps the speakers of a chunk", () => {
    const [chunk] = segmentChunks(JOB, [segment(0, "oi", { speaker: "Ana" }), segment(1, "olá", { speaker: "Bruno" }), segment(2, "tudo", { speaker: "Ana" })]);
    expect(chunk!.speakers).toEqual(["Ana", "Bruno"]);
  });
});

describe("segmentsNearNote", () => {
  const timeline = Array.from({ length: 30 }, (_value, index) => ({ id: `s${String(index).padStart(6, "0")}`, start: index * 10, end: index * 10 + 9 }));
  test("looks back 90 s and ahead 10 s, nearest first", () => {
    // s000012 contains 125 s; s000013 starts 5 s later; s000011 ended 6 s before.
    expect(segmentsNearNote(125, timeline)).toEqual(["s000012", "s000013", "s000011", "s000010"]);
    expect(segmentsNearNote(300, timeline, 2)).toEqual(["s000029", "s000028"]);
    expect(segmentsNearNote(null, timeline)).toEqual([]);
    expect(segmentsNearNote(5_000, timeline)).toEqual([]);
  });
});

describe("validateCalendarLink", () => {
  const link = { version: 1, jobId: JOB, mediaSha256: "a".repeat(64), source: "google-calendar", eventIdHash: "e".repeat(64), title: "Kickoff Acme",
    startAt: "2026-10-01T12:00:00.000Z", endAt: "2026-10-01T13:00:00.000Z", recurring: false,
    attendees: [{ name: "Ana Souza", self: true }, { name: "bruno@example.com", self: false }], capturedAt: "2026-10-01T12:01:00.000Z" };
  test("accepts a link of this job and masks e-mails in names", () => {
    const value = validateCalendarLink(link, job());
    expect(value?.title).toBe("Kickoff Acme");
    expect(value?.attendees[1]?.name).toBe("[e-mail omitido]");
  });
  test("ignores links of another job or media and malformed links", () => {
    expect(validateCalendarLink({ ...link, jobId: "4e3b529e-5c22-4802-97b8-f3e1a52c1919" }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, mediaSha256: "b".repeat(64) }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, eventIdHash: "raw-event-id" }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, startAt: "soon" }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, email: "x@y.z" }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, attendees: [{ name: "x", self: false, email: "x@y.z" }] }, job())).toBeUndefined();
    expect(validateCalendarLink({ ...link, attendees: new Array(51).fill({ name: "x", self: false }) }, job())).toBeUndefined();
    expect(validateCalendarLink(null, job())).toBeUndefined();
  });

  test("reads the file only when private to the user and not a link", async () => {
    fixture = await makeRoot();
    const record = job();
    await fs.mkdir(calendarLinksDir(), { recursive: true, mode: 0o700 });
    const path = join(calendarLinksDir(), `${JOB}.json`);
    await fs.writeFile(path, JSON.stringify(link), { mode: 0o600 });
    expect((await readCalendarLink(record))?.link.title).toBe("Kickoff Acme");
    await fs.chmod(path, 0o666);
    expect(await readCalendarLink(record)).toBeUndefined();
    await fs.rm(path);
    const elsewhere = join(fixture.root, "elsewhere.json");
    await fs.writeFile(elsewhere, JSON.stringify(link), { mode: 0o600 });
    await fs.symlink(elsewhere, path);
    expect(await readCalendarLink(record)).toBeUndefined();
    await fs.rm(path);
    await fs.writeFile(path, "{broken", { mode: 0o600 });
    expect(await readCalendarLink(record)).toBeUndefined();
  });
});

describe("facts and chunks", () => {
  const summary = summaryOf({
    title: "Planejamento do trimestre", overview: "Equipe revisou o escopo. Contato: ana@example.com", topics: ["Escopo", "Prazos"],
    decisions: ["Adiar a migração", "Contratar agência"], actionItems: [{ description: "Enviar proposta", owner: "Ana", dueDate: "sexta" }],
    citations: [{ section: "decision", index: 0, segmentIds: ["s000001", "s000002"], uncertainty: "clear" }, { section: "action", index: 0, segmentIds: ["s000003"], uncertainty: "clear" },
      { section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }]
  });
  const artifacts = fakeArtifacts({
    segments: [
      { start: 0, end: 5, text: "Bom dia, vamos ao escopo.", speaker: "S01", humanSpeakerEdited: true },
      { start: 6, end: 10, text: "Acho melhor adiar a migração.", speaker: "S02" },
      { start: 11, end: 15, text: "Concordo, adiamos.", speaker: "S01", humanSpeakerEdited: true },
      { start: 16, end: 20, text: "Ana envia a proposta até sexta. sk-abcdefghijklmnopqrstuv", speaker: "S02" },
      { start: 21, end: 21, text: "   " }
    ],
    summary, labels: { S01: "Ana", S02: "Falante 2" }, revision: 2
  });

  test("builds facts from the reviewed view, summary, notes and calendar", async () => {
    const source = await readMeetingSource(job({ summary: { provider: "openai", model: "gpt-4o-mini", context: { meeting: { source: "gnome-calendar", title: "Planejamento",
      startAt: "2026-10-01T12:30:00.000Z", endAt: "2026-10-01T13:30:00.000Z", recurring: true, confidence: 0.9 } } } }), {
      readArtifacts: async () => artifacts,
      notes: async () => ({ entries: [{ id: "n000001", text: "[ ] revisar contrato com o jurídico", offsetSeconds: 12 }, { id: "n000002", text: "# Pontos", offsetSeconds: null },
        { id: "bad id!", text: "ignored", offsetSeconds: 1 }, { id: "n000003", text: "   ", offsetSeconds: 1 }] }),
      calendarLink: async () => undefined
    });
    expect(source.segments).toHaveLength(4);
    expect(source.segments[0]!.speaker).toBe("Ana");
    // Without a human binding, the transcript's own code is kept.
    expect(source.segments[1]!.speaker).toBe("S02");
    expect(source.segments[3]!.text).toContain("[credencial omitida]");
    expect(source.notes.map((note) => note.id)).toEqual(["n000001", "n000002"]);
    expect(source.date).toBe("2026-10-01T12:30:00.000Z");
    const entry = buildJobIndex(source, [{ code: "CL001", name: "Acme", source: "manual", confidence: 1 }], "9".repeat(64));
    expect(validateStoredJobIndex(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    const { facts } = entry;
    expect(facts.title).toBe("Planejamento do trimestre");
    expect(facts.revision).toBe(2);
    expect(facts.overview).not.toContain("ana@example.com");
    expect(facts.speakers).toEqual([{ speakerId: "S01", label: "Ana", confirmed: true }, { speakerId: "S02", label: "Falante 2", confirmed: false }]);
    expect(facts.decisions).toEqual([{ index: 0, text: "Adiar a migração", segmentIds: ["s000001", "s000002"] }, { index: 1, text: "Contratar agência", segmentIds: [] }]);
    expect(facts.actions).toEqual([
      { index: 0, text: "Enviar proposta", owner: "Ana", dueDate: "sexta", segmentIds: ["s000003"], origin: "model" },
      { index: 1, text: "revisar contrato com o jurídico", owner: "", dueDate: "", segmentIds: [], origin: "note" }
    ]);
    expect(facts.calendar).toEqual({ title: "Planejamento", recurring: true });
    expect(facts.clients[0]!.code).toBe("CL001");
    expect(facts.noteCount).toBe(2);
    expect(facts.durationSeconds).toBe(20);
    const kinds = entry.chunks.map((chunk) => chunk.kind);
    expect(kinds.filter((kind) => kind === "summary")).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "note")).toHaveLength(2);
    const note = entry.chunks.find((chunk) => chunk.chunkId === `${JOB}:note:n000001`)!;
    expect(note.segmentIds[0]).toBe("s000002");
    expect(entry.chunks.find((chunk) => chunk.text.startsWith("Decisão: Adiar"))!.segmentIds).toEqual(["s000001", "s000002"]);
    expect(entry.segments.map((item) => item.id)).toEqual(["s000000", "s000001", "s000002", "s000003"]);
  });

  test("the fingerprint follows every input", async () => {
    const base = await readMeetingSource(job(), { readArtifacts: async () => artifacts, calendarLink: async () => undefined });
    const fingerprint = sourceFingerprint(base, []);
    expect(sourceFingerprint({ ...base }, [])).toBe(fingerprint);
    for (const changed of [
      { ...base, job: { ...base.job, updatedAt: "2026-10-02T00:00:00.000Z" } },
      { ...base, transcriptSha256: "f".repeat(64) },
      { ...base, summarySha256: "e".repeat(64) },
      { ...base, revision: 3 },
      { ...base, diarizationSha256: "d".repeat(64) },
      { ...base, notesDigest: notesDigestOf([{ id: "n1", text: "x", offsetSeconds: null }]) },
      { ...base, calendarSha256: "c".repeat(64) }
    ]) expect(sourceFingerprint(changed, [])).not.toBe(fingerprint);
    expect(sourceFingerprint(base, [{ code: "CL1", name: "x", source: "manual", confidence: 1 }])).not.toBe(fingerprint);
  });

  test("the title falls back to the calendar, then the file name, never to raw control characters", async () => {
    const blank = fakeArtifacts({ segments: [{ start: 0, end: 1, text: "oi" }], summary: summaryOf({ title: "\u0007", overview: "", topics: [], decisions: [], actionItems: [] }) });
    const meeting = { source: "gnome-calendar" as const, title: "Daily", startAt: "2026-10-01T12:00:00.000Z", endAt: "2026-10-01T12:15:00.000Z", recurring: true, confidence: 0.9 };
    const deps = { readArtifacts: async () => blank, calendarLink: async () => undefined };
    expect((await readMeetingSource(job({ summary: { provider: "openai", model: "gpt-4o-mini", context: { meeting } } }), deps)).title).toBe("Daily");
    expect((await readMeetingSource(job(), deps)).title).toBe("reuniao.mkv");
    const odd = job({ source: { originalName: "\u0001\u0002", mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) } });
    const source = await readMeetingSource(odd, deps);
    expect(source.title).toBe("Reunião sem título");
    expect(validateStoredJobIndex(JSON.parse(JSON.stringify(buildJobIndex(source, [], "9".repeat(64))))).facts.title).toBe("Reunião sem título");
  });

  test("a recording without usable segments is refused", async () => {
    await expect(readMeetingSource(job(), { readArtifacts: async () => fakeArtifacts({ segments: [{ start: 0, end: 1, text: "  " }] }), calendarLink: async () => undefined }))
      .rejects.toThrow("transcrição utilizável");
  });

  test("reads real artifacts through the validated readers", async () => {
    fixture = await makeRoot();
    const record = await writeJob(fixture, { segments: filler("orçamento", 6), summary: { title: "Orçamento 2027", overview: "Revisão do orçamento.", topics: [], decisions: [], actionItems: [] } });
    const source = await readMeetingSource(record);
    expect(source.title).toBe("Orçamento 2027");
    expect(source.summaryOrigin).toBe("original");
    expect(source.segments).toHaveLength(6);
    expect(source.transcriptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the probe changes when a source file or the notes change", async () => {
    fixture = await makeRoot();
    const record = await writeJob(fixture, { segments: filler("probe", 2) });
    const paths = [join(record.artifactDir, "transcript.json"), join(record.artifactDir, "summary.json")];
    const first = await probeJob(record, "n", paths);
    expect(await probeJob(record, "n", paths)).toBe(first);
    expect(await probeJob(record, "other", paths)).not.toBe(first);
    expect(await probeJob({ ...record, updatedAt: "2027-01-01T00:00:00.000Z" }, "n", paths)).not.toBe(first);
    await fs.writeFile(paths[1]!, "{}");
    expect(await probeJob(record, "n", paths)).not.toBe(first);
  });
});
