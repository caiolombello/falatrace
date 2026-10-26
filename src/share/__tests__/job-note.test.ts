import { expect, test } from "bun:test";
import type { ListedAction } from "../../actions/list";
import type { JobRecord, RecordingSummary } from "../../jobs/types";
import type { MeetingSource } from "../../library-index/build";
import type { JobFacts } from "../../library-index/types";
import { buildShareNote, buildShareNoteWithLanguage, shareLanguageOf } from "../job-note";
import { renderShare, SHARE_LIMITS } from "../render";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const job = { id: JOB, sourcePath: "/recordings/meeting.mkv", source: { sha256: "d".repeat(64) } } as JobRecord;

const summary: RecordingSummary = {
  version: 1, provider: "ollama", model: "synthetic", title: "Revisão", overview: "Lançamento aprovado.", topics: ["Lançamento"],
  decisions: ["Lançar em março"],
  actionItems: [{ description: "Mandar proposta", owner: "Ana", dueDate: "2026-11-01" }, { description: "Revisar contrato", owner: "", dueDate: "" }],
  sections: [{ heading: "Decisões", items: [{ text: "Lançar em março", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }],
  meta: { schemaVersion: 2, specId: "v2:abc", template: { id: "planning", source: "ai", confidence: 0.8, reason: "x" }, language: "en", notes: { count: 1, digest: "e".repeat(64) } }
};

const source = (overrides: Partial<MeetingSource> = {}): MeetingSource => ({
  job, title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z", language: "pt", transcriptSha256: "f".repeat(64), summaryOrigin: "original", revision: 0,
  summary, notes: [{ id: "n000001", text: "Decidimos lançar em março", offsetSeconds: 30 }], notesDigest: "e".repeat(64),
  speakers: [{ speakerId: "S01", label: "Ana Souza", confirmed: true }, { speakerId: "S02", label: "Falante 2", confirmed: false }],
  segments: [{ id: "s000000", start: 5, end: 9, speaker: "Ana Souza", text: "Vamos lançar em março." }, { id: "s000001", start: 3_700, end: 3_705, text: "Fechado." }],
  calendar: {
    version: 1, jobId: JOB, mediaSha256: "d".repeat(64), source: "google-calendar", title: "Revisão semanal", startAt: "2026-10-25T12:00:00.000Z",
    endAt: "2026-10-25T13:00:00.000Z", recurring: true, attendees: [{ name: "Bruno Lima", self: false }], capturedAt: "2026-10-25T13:01:00.000Z"
  },
  ...overrides
});

const listed = (text: string, status: ListedAction["status"], matchState: ListedAction["matchState"] = "current"): ListedAction => ({
  actionId: "11111111-1111-4111-8111-111111111111", mediaSha256: "d".repeat(64), jobId: JOB, title: "Revisão", date: "2026-10-25T12:00:00.000Z",
  text, owner: "Ana", dueDate: "2026-11-01", status, origin: "model", segmentIds: [], matchState, rev: 1, ownerPersonIds: [], clientCodes: []
});

test("a share note gathers the summary, the notes, people, client, action states and the transcript", async () => {
  const facts = { clients: [{ code: "ACME", name: "Acme", source: "manual", confidence: 1 }], speakers: [{ speakerId: "S01", label: "Ana Souza", confirmed: true }], attendees: [{ name: "Bruno Lima", self: false }] } as unknown as JobFacts;
  const note = await buildShareNote(job, {
    readSource: async () => source(),
    facts: async () => facts,
    actions: async () => [listed("Mandar proposta", "done"), listed("Revisar contrato", "dismissed"), listed("Antiga", "open", "orphaned")]
  });
  expect(note).toMatchObject({
    jobId: JOB, title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z", people: ["Ana Souza", "Bruno Lima"], client: "Acme", template: "planning",
    overview: "Lançamento aprovado.", decisions: ["Lançar em março"], notes: ["Decidimos lançar em março"], link: `falatrace://recording/${JOB}`,
    sections: [{ heading: "Decisões", items: [{ text: "Lançar em março", origin: "user" }] }],
    // Dismissed and orphaned actions stay out; the done one is checked.
    actions: [{ text: "Mandar proposta", owner: "Ana", dueDate: "2026-11-01", done: true }]
  });
  expect(note.transcript).toEqual([{ at: "00:05", speaker: "Ana Souza", text: "Vamos lançar em março." }, { at: "1:01:40", text: "Fechado." }]);
  const markdown = renderShare(note, { frontmatter: true, language: "pt-BR", include: "full" }).markdown;
  expect(markdown).toContain("- [x] Mandar proposta");
  expect(markdown).toContain("Vamos lançar em março.");
});

test("actions the person dismissed stay out even when all of them were dismissed", async () => {
  const note = await buildShareNote(job, {
    readSource: async () => source(),
    actions: async () => [listed("Mandar proposta", "dismissed"), listed("Revisar contrato", "dismissed"), listed("Antiga", "done", "orphaned")]
  });
  expect(note.actions).toEqual([]);
  expect(renderShare(note, { frontmatter: false, language: "pt-BR", include: "summary" }).markdown).not.toContain("Mandar proposta");
});

test("a summary merged from many parts, with an overview past the share limit, still shares (cut to the limit)", async () => {
  const paragraph = `${"Parte da reunião com decisões e próximos passos. ".repeat(40).trim()}`;
  const overview = Array.from({ length: 30 }, () => paragraph).join("\n\n");
  expect(overview.length).toBeGreaterThan(SHARE_LIMITS.overview * 2);
  const note = await buildShareNote(job, { readSource: async () => source({ summary: { ...summary, overview } }) });
  expect(note.overview.length).toBeGreaterThan(0);
  expect(note.overview.length).toBeLessThanOrEqual(SHARE_LIMITS.overview);
  expect(note.overview.startsWith("Parte da reunião")).toBe(true);
});

test("without index facts or action states, the note falls back to what the recording itself says", async () => {
  const { note, language } = await buildShareNoteWithLanguage(job, { readSource: async () => source({ summary: { ...summary, sections: undefined, meta: undefined } }) });
  expect(note.people).toEqual(["Ana Souza", "Bruno Lima"]);
  expect(note.client).toBeUndefined();
  expect(note.template).toBeUndefined();
  expect(note.sections).toBeUndefined();
  expect(note.actions).toEqual([
    { text: "Mandar proposta", owner: "Ana", dueDate: "2026-11-01", done: false }, { text: "Revisar contrato", owner: "", dueDate: "", done: false }
  ]);
  // No summary language: the conversation's language decides.
  expect(language).toBe("pt-BR");
  expect(shareLanguageOf({ summary, language: "pt" })).toBe("en");
  expect(shareLanguageOf({ summary: null, language: "es-419" })).toBe("es");
  const empty = await buildShareNote(job, { readSource: async () => source({ summary: null, notes: [] }) });
  expect(empty).toMatchObject({ overview: "", decisions: [], actions: [] });
  expect(empty.notes).toBeUndefined();
});
