import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { formatSummaryMarkdown } from "../../jobs/format";
import { validateSummary, type RecordingSummary, type Transcript } from "../../jobs/types";
import { notesDigest } from "../../notes/align";
import type { NoteEntry } from "../../notes/lines";
import { NOTES_ERRORS } from "../../notes/lines";
import { NotesStore, findNotesForJob } from "../../notes/store";
import { BUILT_IN_TEMPLATES, builtInTemplate, sectionTitle } from "../../templates/catalog";
import { summaryInputLimit } from "../budget";
import { legacyChunkKey, planSummaryChunks, summarizeInChunks, type SummaryChunk } from "../chunks";
import { canonicalizeSummary } from "../context";
import { attachSummarySupport, buildSummaryEvidence } from "../evidence";
import { SUMMARY_LABELS } from "../language";
import { summarizeWithOllama } from "../ollama";
import { summarizeWithOpenAI } from "../openai";
import { LEGACY_SUMMARY_SPEC } from "../prompt";
import { SUMMARY_JSON_SCHEMA, SUMMARY_SYSTEM_PROMPT } from "../schema";
import { buildSummaryV2Request, resolveSummaryV2Request, validateStoredSummaryRequest, type SummaryV2Request } from "../v2";
import { sentNotes } from "./v2-reply";

const roots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const temporary = async () => { const root = await fs.mkdtemp(join(tmpdir(), "summary-v2-")); roots.push(root); return root; };
const MEDIA = "a".repeat(64);
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const transcriptOf = (texts: string[], step = 10): Transcript => ({
  version: 1, provider: "whisper-cpp", model: "fixture", language: "pt", text: texts.join("\n"),
  segments: texts.map((text, index) => ({ start: index * step, end: (index + 1) * step, text }))
});
const PT = transcriptOf([
  "Bom dia, pessoal. Então, hoje a gente precisa revisar o orçamento do projeto com calma.",
  "A Ana vai enviar a proposta revisada até sexta, e eu acho que isso já resolve.",
  "Combinado, então fechamos o escopo como está e seguimos depois."
]);
const EN = transcriptOf([
  "Good morning everyone. So today we need to talk about the onboarding flow and what we learned.",
  "I think the new signup page is working, but we still have to check the email copy with Maria.",
  "Okay, we agreed to keep the current flow and to send the summary to the whole team after this."
]);
const note = (id: string, offsetSeconds: number | null, text: string): NoteEntry => ({ id, createdAt: "2026-10-25T12:00:00.000Z", offsetSeconds, text });
const NOTES = { entries: [note("n000001", 12, "# Decisões"), note("n000002", 15, "Ana envia proposta sexta"), note("n000003", null, "[ ] revisar orçamento")] };

const requestFor = (transcript: Transcript, extra: Partial<Parameters<typeof buildSummaryV2Request>[0]> = {}): SummaryV2Request => buildSummaryV2Request({
  transcriptText: transcript.text, segments: transcript.segments, templates: BUILT_IN_TEMPLATES, templateDefault: "auto", detection: "ai",
  languageSetting: "auto", ...extra
});

type Captured = { format: Record<string, unknown>; system: string; user: Record<string, unknown>; body: Record<string, unknown> };
/** A fake Ollama on a free loopback port; `answer` sees each request. */
const fakeOllama = (answer: (captured: Captured, index: number) => unknown) => {
  const seen: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json() as { format: Record<string, unknown>; messages: Array<{ role: string; content: string }> };
      const captured = { format: body.format, system: body.messages[0].content, user: JSON.parse(body.messages[1].content), body };
      seen.push(captured);
      return Response.json({ message: { content: JSON.stringify(answer(captured, seen.length - 1)) } });
    }
  });
  servers.push(server);
  const config: AppConfig = structuredClone(DEFAULT_CONFIG);
  config.summary.ollamaUrl = `http://127.0.0.1:${server.port}`;
  return { config, seen };
};
const run = (config: AppConfig, transcript: Transcript, request: SummaryV2Request | undefined, cacheDir: string, extra: Record<string, unknown> = {}) => summarizeInChunks({
  transcript, mediaHash: MEDIA, maxCharacters: config.summary.maxInputCharacters, provider: "ollama", model: "fake", adapterIdentity: config.summary.ollamaUrl,
  cacheDir, request, adapter: (part: SummaryChunk, signal?: AbortSignal) => summarizeWithOllama(config, part.text, "fake", undefined, part.evidence, signal, part.request), ...extra
});
const answer = (fields: Record<string, unknown> = {}) => ({
  templateId: "general", title: "Revisão do orçamento", overview: "O time revisou o orçamento e fechou o escopo.",
  sections: [], topics: ["Orçamento"], decisions: [], actionItems: [],
  citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }], limitations: [], ...fields
});

describe("v2 summary request", () => {
  test("the notes become user items, the model completes them, and unused notes are appended, never dropped", async () => {
    const request = requestFor(PT, { notes: NOTES, templateDefault: "general" });
    expect(request.language).toBe("pt-BR");
    expect(request.selection).toMatchObject({ mode: "fixed", source: "default", confidence: 1 });
    expect(request.spec.notesIncluded).toBe(true);
    const fake = fakeOllama(() => answer({
      sections: [{ heading: "Decisões", items: [
        { text: "Ana enviará a proposta revisada até sexta.", origin: "user", noteIds: ["n000002"], segmentIds: ["s000001"], uncertainty: "clear" },
        { text: "O escopo foi fechado como está.", origin: "ai", noteIds: [], segmentIds: ["s000002"], uncertainty: "clear" }
      ] }],
      decisions: ["O escopo foi fechado como está."],
      actionItems: [{ description: "Enviar a proposta revisada", owner: "Ana", dueDate: "sexta" }],
      citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }, { section: "decision", index: 0, segmentIds: ["s000002"], uncertainty: "clear" },
        { section: "action", index: 0, segmentIds: ["s000001"], uncertainty: "clear" }]
    }));
    const summary = await run(fake.config, PT, request, join(await temporary(), "cache"));
    // The request: v2 spec as format and system prompt, the notes beside the transcript.
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].format).toEqual(JSON.parse(JSON.stringify(request.spec.schema)));
    expect(fake.seen[0].system).toBe(request.spec.system);
    expect(fake.seen[0].user.transcript).toBe(PT.text);
    expect(sentNotes(fake.seen[0].body).map((item) => item.id)).toEqual(["n000001", "n000002", "n000003"]);
    expect(sentNotes(fake.seen[0].body)[1]).toMatchObject({ text: "Ana envia proposta sexta", at: "00:15" });
    expect(sentNotes(fake.seen[0].body)[1].nearSegmentIds[0]).toBe("s000001");
    // The stored summary: legacy fields filled, sections and meta added.
    expect(summary.title).toBe("Revisão do orçamento");
    expect(summary.decisions).toEqual(["O escopo foi fechado como está."]);
    expect(summary.sections).toEqual([
      { heading: "Decisões", items: [
        { text: "Ana enviará a proposta revisada até sexta.", origin: "user", noteIds: ["n000002"], segmentIds: ["s000001"], uncertainty: "clear" },
        { text: "O escopo foi fechado como está.", origin: "ai", noteIds: [], segmentIds: ["s000002"], uncertainty: "clear" }] },
      { heading: SUMMARY_LABELS["pt-BR"].unusedNotes, items: [
        { text: "[ ] revisar orçamento", origin: "user", noteIds: ["n000003"], segmentIds: [], uncertainty: "clear" }] }
    ]);
    expect(summary.meta).toEqual({ schemaVersion: 2, specId: request.spec.id, template: { id: "general", source: "default", confidence: 1, reason: request.selection.reason },
      language: "pt-BR", notes: { count: 3, digest: notesDigest(NOTES) } });
    expect(summary.limitations).toContain(SUMMARY_LABELS["pt-BR"].limitation.notesNotUsed);
    expect(summary.support!.reviewRequired).toBe(false);
    expect(summary.support!.references.map((reference) => reference.id).sort()).toEqual(["s000000", "s000001", "s000002"]);
    // Readers keep the new fields; the markdown marks the user's items.
    expect(validateSummary(JSON.parse(JSON.stringify(summary)), "ollama", "fake")).toEqual(summary);
    const markdown = formatSummaryMarkdown(summary);
    expect(markdown).toStartWith(`# Revisão do orçamento\n\n${summary.overview}\n\n## Decisões\n\n- ✎ Ana enviará a proposta revisada até sexta. [0:10]\n- O escopo foi fechado como está. [0:20]\n\n## Notas suas que o modelo não usou\n\n- ✎ [ ] revisar orçamento\n\n## Evidências e limites`);
    expect(markdown).not.toContain("## Tópicos");
  });

  test("answers citing notes or segments that were not sent, or a template not offered, are refused", async () => {
    const request = requestFor(PT, { notes: NOTES, templateDefault: "general" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sections: [{ heading: "Decisões", items: [{ text: "Nota inventada.", origin: "user", noteIds: ["n000009"], segmentIds: [], uncertainty: "clear" }] }] }, "Summary cited a note that does not exist"],
      [{ sections: [{ heading: "Decisões", items: [{ text: "Trecho inventado.", origin: "ai", noteIds: [], segmentIds: ["s000099"], uncertainty: "clear" }] }] }, "Summary cited a transcript segment that does not exist"],
      [{ citations: [{ section: "overview", index: 0, segmentIds: ["s000042"], uncertainty: "clear" }] }, "Summary cited a transcript segment that does not exist"],
      [{ sections: [{ heading: "Decisões", items: [{ text: "Sem nota.", origin: "user", noteIds: [], segmentIds: [], uncertainty: "clear" }] }] }, "Invalid noteIds"],
      [{ templateId: "standup" }, "Summary chose a template that was not offered"],
      [{ title: undefined }, "title"]
    ];
    for (const [fields, message] of cases) {
      const fake = fakeOllama(() => answer(fields));
      const chunk = planSummaryChunks(PT, MEDIA, undefined, fake.config.summary.maxInputCharacters, undefined, undefined, "characters", { spec: request.spec, notes: request.notes })[0];
      await expect(summarizeWithOllama(fake.config, chunk.text, "fake", undefined, chunk.evidence, undefined,
        { spec: request.spec, selection: request.selection, notes: chunk.notes || [], notesInfo: request.notesInfo })).rejects.toThrow(message);
    }
    // Without notes, a user item is not even possible.
    const plain = requestFor(PT, { templateDefault: "general" });
    expect(plain.spec.notesIncluded).toBe(false);
    const fake = fakeOllama(() => answer({ sections: [{ heading: "Decisões", items: [{ text: "Sem notas.", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }] }));
    await expect(run(fake.config, PT, plain, join(await temporary(), "cache"))).rejects.toThrow("origin");
  });

  test("auto language follows the conversation; a model-choice answer is recorded as the template", async () => {
    const request = requestFor(EN);
    expect(request.language).toBe("en");
    expect(request.selection.mode).toBe("model-choice");
    expect(request.spec.system).toContain("Write every text field in English");
    expect(requestFor(PT).language).toBe("pt-BR");
    expect(requestFor(EN, { languageSetting: "es" }).language).toBe("es");
    const fake = fakeOllama((captured) => {
      const offered = (captured.format.properties as { templateId: { enum: string[] } }).templateId.enum;
      expect(offered[0]).toBe("general");
      expect(offered).toContain("one-on-one");
      return answer({ templateId: "one-on-one", title: "Onboarding flow review", overview: "The team reviewed the onboarding flow.",
        sections: [{ heading: "Next steps", items: [{ text: "Check the email copy with Maria.", origin: "ai", noteIds: [], segmentIds: ["s000001"], uncertainty: "uncertain" }] }] });
    });
    const summary = await run(fake.config, EN, request, join(await temporary(), "cache"));
    expect(summary.meta?.template).toEqual({ id: "one-on-one", source: "ai", confidence: 0.5, reason: "O modelo escolheu 1:1 pela conversa." });
    expect(summary.meta?.language).toBe("en");
    // An uncertain item asks for review, in the summary's language.
    expect(summary.support!.reviewRequired).toBe(true);
    expect(summary.limitations).toContain(SUMMARY_LABELS.en.limitation.reviewRequired);
    expect(summary.limitations).not.toContain(SUMMARY_LABELS["pt-BR"].limitation.reviewRequired);
    const markdown = formatSummaryMarkdown(summary);
    expect(markdown).toContain("## Next steps\n\n- Check the email copy with Maria. [0:10]");
    expect(markdown).toContain("## Evidence and limits\n\nReview needed: yes. Timing precision: segment.");
    expect(markdown).toContain("## Limitations");
    // Without sections, the legacy layout is kept, in English.
    const plain = formatSummaryMarkdown({ ...summary, sections: undefined, topics: [] });
    expect(plain).toContain("## Summary\n\nThe team reviewed the onboarding flow.\n\n## Topics\n\n- None identified\n\n## Decisions\n\n- None identified\n\n## Action items");
  });

  test("notes that cannot be read never stop the summary; switched-off notes are never read", async () => {
    const root = await temporary();
    const store = new NotesStore(join(root, "notes"));
    const job = { id: "123e4567-e89b-42d3-a456-426614174000", sourcePath: join(root, "meeting.mkv") };
    await store.save(job.id, { text: "Nota válida", expectedRev: 0 });
    await fs.writeFile(store.pathFor(job.id), "{", { mode: 0o600 });
    const config = structuredClone(DEFAULT_CONFIG);
    const base = { config, job, summary: {}, transcript: PT };
    const request = await resolveSummaryV2Request(base, { notes: (target) => findNotesForJob(target, store), prefs: async () => undefined, templates: async () => [...BUILT_IN_TEMPLATES] });
    expect(request.notes).toEqual([]);
    expect(request.spec.notesIncluded).toBe(false);
    expect(request.limitations).toEqual([SUMMARY_LABELS["pt-BR"].limitation.notesUnreadable]);
    await expect(findNotesForJob(job, store)).rejects.toThrow(NOTES_ERRORS.corrupted);
    const fake = fakeOllama(() => answer());
    const summary = await run(fake.config, PT, request, join(root, "cache"));
    expect(summary.limitations).toContain(SUMMARY_LABELS["pt-BR"].limitation.notesUnreadable);
    expect(summary.meta?.notes).toEqual({ count: 0, digest: notesDigest(undefined) });
    // Notes off, or the summary told not to use them: the store is not even read.
    let reads = 0;
    const notes = async () => { reads++; return { ...NOTES, version: 1 as const, id: job.id, createdAt: "2026-10-25T12:00:00.000Z", updatedAt: "2026-10-25T12:00:00.000Z", rev: 1 }; };
    for (const change of [(c: AppConfig) => { c.notes.enabled = false; }, (c: AppConfig) => { c.summary.useNotes = false; }]) {
      const copy = structuredClone(config); change(copy);
      expect((await resolveSummaryV2Request({ ...base, config: copy }, { notes, prefs: async () => undefined })).notes).toEqual([]);
    }
    expect((await resolveSummaryV2Request({ ...base, choices: { useNotes: false } }, { notes, prefs: async () => undefined })).notes).toEqual([]);
    expect(reads).toBe(0);
    expect((await resolveSummaryV2Request(base, { notes, prefs: async () => undefined })).notes.map((item) => item.id)).toEqual(["n000001", "n000002", "n000003"]);
    expect(reads).toBe(1);
  });

  test("choices for the recording override the job's bound settings, which override the current settings", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const job = { id: "123e4567-e89b-42d3-a456-426614174000", sourcePath: "/recordings/meeting.mkv" };
    const sources = (prefs?: { templateId?: string; language?: "pt-BR" | "en" | "es" }) => ({
      notes: async () => undefined, templates: async () => [...BUILT_IN_TEMPLATES],
      prefs: async () => prefs && { version: 1 as const, id: job.id, rev: 1, updatedAt: "2026-10-25T12:00:00.000Z", ...prefs }
    });
    const meeting = { source: "gnome-calendar" as const, title: "Retro Sprint 42", startAt: "2026-10-25T12:00:00Z", endAt: "2026-10-25T13:00:00Z", recurring: true, confidence: 0.9 };
    // Calendar title decides when nothing else does.
    let request = await resolveSummaryV2Request({ config, job, summary: { context: { meeting } }, transcript: PT }, sources());
    expect(request.selection).toMatchObject({ mode: "fixed", source: "calendar" });
    expect(request.selection.template?.id).toBe("retrospective");
    // The job's bound default and language beat the calendar and the current settings.
    request = await resolveSummaryV2Request({ config, job, summary: { context: { meeting }, template: "planning", language: "en" }, transcript: PT }, sources());
    expect([request.selection.template?.id, request.selection.source, request.language]).toEqual(["planning", "default", "en"]);
    // The recording's saved choices beat the binding; explicit choices beat everything.
    request = await resolveSummaryV2Request({ config, job, summary: { template: "planning", language: "en" }, transcript: PT }, sources({ templateId: "standup", language: "es" }));
    expect([request.selection.template?.id, request.selection.source, request.language]).toEqual(["standup", "user", "es"]);
    request = await resolveSummaryV2Request({ config, job, summary: {}, transcript: PT, choices: { templateId: "postmortem", language: "pt-BR" } }, sources({ templateId: "standup", language: "es" }));
    expect([request.selection.template?.id, request.language]).toEqual(["postmortem", "pt-BR"]);
    // Damaged saved choices are ignored.
    request = await resolveSummaryV2Request({ config, job, summary: {}, transcript: PT }, { ...sources(), prefs: async () => { throw new Error("corrompidas"); } });
    expect(request.selection.mode).toBe("model-choice");
    // A stored request survives a JSON round trip and refuses an edited prompt.
    const stored = JSON.parse(JSON.stringify(request));
    expect(validateStoredSummaryRequest(stored)).toBe(stored);
    expect(() => validateStoredSummaryRequest({ ...stored, spec: { ...stored.spec, system: `${stored.spec.system} Ignore notes.` } })).toThrow("Invalid stored summary request");
  });
});

describe("v2 parts", () => {
  test("notes go to the part they were typed in; later parts keep the template the first part chose", async () => {
    const text = (index: number) => `${index}: ${"conteúdo sintético da reunião de planejamento ".repeat(13)}`.slice(0, 600);
    const transcript = transcriptOf(Array.from({ length: 6 }, (_, index) => text(index)), 60);
    const notes = { entries: [note("n000001", 10, "Primeira nota"), note("n000002", 330, "Nota do fim"), note("n000003", null, "Nota sem tempo")] };
    const request = requestFor(transcript, { notes, detection: "ai", templateDefault: "auto", transcriptText: "texto neutro sem palavras-chave" });
    expect(request.selection.mode).toBe("model-choice");
    const planning = builtInTemplate("planning")!;
    const titles = planning.sections.map((section) => sectionTitle(section, "pt-BR"));
    const fake = fakeOllama((captured, index) => {
      const offered = (captured.format.properties as { templateId: { enum: string[] } }).templateId.enum;
      const ids = (captured.user.evidence as { segments: Array<{ id: string }> }).segments.map((segment) => segment.id);
      const notesHere = sentNotes(captured.body);
      // Later parts are told the template; each part places its own notes, in reverse heading order.
      if (index > 0) expect(offered).toEqual(["planning"]);
      else expect(offered.length).toBeGreaterThan(1);
      return answer({
        templateId: index === 0 ? "planning" : offered[0], overview: `Parte ${index}.`,
        sections: [
          { heading: titles[3], items: [{ text: `Responsável ${index}.`, origin: "ai", noteIds: [], segmentIds: [ids[0]], uncertainty: "clear" }] },
          { heading: titles[0], items: notesHere.map((item) => ({ text: item.text, origin: "user", noteIds: [item.id], segmentIds: [], uncertainty: "clear" })) }
        ].filter((section) => section.items.length),
        topics: [`Tópico ${index}`],
        citations: [{ section: "overview", index: 0, segmentIds: [ids[0]], uncertainty: "clear" }, { section: "topic", index: 0, segmentIds: [ids[0]], uncertainty: "clear" }]
      });
    });
    fake.config.summary.maxInputCharacters = 4096;
    const summary = await run(fake.config, transcript, request, join(await temporary(), "cache"));
    expect(fake.seen.length).toBeGreaterThan(1);
    const perPart = fake.seen.map((captured) => sentNotes(captured.body).map((item) => item.id));
    expect(perPart[0]).toEqual(["n000001", "n000003"]);
    expect(perPart[perPart.length - 1]).toEqual(["n000002"]);
    expect(perPart.flat().sort()).toEqual(["n000001", "n000002", "n000003"]);
    // Merged by heading in template order, every note once, topics and citations offset.
    expect(summary.sections!.map((section) => section.heading)).toEqual([titles[0], titles[3]]);
    expect(summary.sections![0].items.map((item) => item.noteIds[0])).toEqual(["n000001", "n000003", "n000002"]);
    expect(summary.sections![1].items).toHaveLength(fake.seen.length);
    expect(summary.topics).toEqual(fake.seen.map((_, index) => `Tópico ${index}`));
    expect(summary.citations!.filter((citation) => citation.section === "topic").map((citation) => citation.index)).toEqual(fake.seen.map((_, index) => index));
    expect(summary.limitations).toContain(SUMMARY_LABELS["pt-BR"].limitation.chunked);
    expect(summary.limitations).not.toContain(SUMMARY_LABELS["pt-BR"].limitation.notesNotUsed);
    expect(summary.meta?.template).toMatchObject({ id: "planning", source: "ai" });
    expect(summary.support!.reviewRequired).toBe(true);
  });

  test("legacy plans and keys are unchanged; v2 keys follow the spec and the notes", () => {
    const evidence = buildSummaryEvidence(PT, MEDIA, 8000);
    const [legacy] = planSummaryChunks(PT, MEDIA, undefined, 24_000);
    expect(legacy.key).toBe(sha({ text: PT.text, source: evidence, context: undefined, maxCharacters: 24_000 }));
    expect(legacy.key).toBe(legacyChunkKey(PT.text, evidence, undefined, 24_000));
    expect(legacy.notes).toBeUndefined();
    expect(planSummaryChunks(PT, MEDIA, undefined, 24_000, undefined, undefined, "characters", { spec: LEGACY_SUMMARY_SPEC })).toEqual([legacy]);
    const request = requestFor(PT, { notes: NOTES });
    const [first] = planSummaryChunks(PT, MEDIA, undefined, 24_000, undefined, undefined, "characters", { spec: request.spec, notes: request.notes });
    const edited = requestFor(PT, { notes: { entries: [...NOTES.entries.slice(0, 2), note("n000003", null, "[x] revisar orçamento")] } });
    const [second] = planSummaryChunks(PT, MEDIA, undefined, 24_000, undefined, undefined, "characters", { spec: edited.spec, notes: edited.notes });
    expect(first.key).not.toBe(legacy.key);
    expect(second.key).not.toBe(first.key);
    expect(first.notes!.map((item) => item.id)).toEqual(["n000001", "n000002", "n000003"]);
  });

  test("a part summarized before v2 is reused instead of asking the model again", async () => {
    const root = await temporary();
    let calls = 0;
    const legacyAnswer = async (): Promise<RecordingSummary> => { calls++; return { version: 1, provider: "openai", model: "gpt-fixture", title: "Revisão", overview: "Resumo antigo.", topics: [], decisions: [], actionItems: [] }; };
    const base = { transcript: PT, mediaHash: MEDIA, provider: "openai" as const, model: "gpt-fixture", adapterIdentity: "openai-chat", cacheDir: join(root, "cache"), maxCharacters: 24_000 };
    await summarizeInChunks({ ...base, adapter: legacyAnswer });
    expect(calls).toBe(1);
    const request = requestFor(EN, { languageSetting: "en", notes: { entries: [note("n000001", 5, "A note")] } });
    const reused = await summarizeInChunks({ ...base, adapter: legacyAnswer, request });
    expect(calls).toBe(1);
    expect(reused.overview).toBe("Resumo antigo.");
    // The note the old part never saw is kept, in the summary's language, and pt-BR phrases are carried over.
    expect(reused.sections).toEqual([{ heading: SUMMARY_LABELS.en.unusedNotes, items: [{ text: "A note", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }]);
    expect(reused.limitations).toContain(SUMMARY_LABELS.en.limitation.reviewRequired);
    expect(reused.limitations).not.toContain(SUMMARY_LABELS["pt-BR"].limitation.reviewRequired);
    expect(reused.meta).toMatchObject({ schemaVersion: 2, language: "en", specId: request.spec.id });
    // Only unused notes as sections: the legacy layout stays and lists them after it.
    const markdown = formatSummaryMarkdown(reused);
    expect(markdown).toContain("## Summary\n\nResumo antigo.");
    expect(markdown).toContain(`## ${SUMMARY_LABELS.en.unusedNotes}\n\n- ✎ A note`);
  });
});

describe("v2 providers and readers", () => {
  test("OpenAI asks for the strict v2 schema and reserves room for the larger prompt", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.openai.apiKey = "synthetic-not-a-real-key";
    const request = requestFor(PT, { notes: NOTES, templateDefault: "general" });
    expect(summaryInputLimit(config, "openai", "gpt-4o-mini", request.spec).max).toBeLessThan(summaryInputLimit(config, "openai", "gpt-4o-mini").max);
    expect(summaryInputLimit(config, "openai", "gpt-4o-mini", LEGACY_SUMMARY_SPEC)).toEqual(summaryInputLimit(config, "openai", "gpt-4o-mini"));
    const original = globalThis.fetch;
    let body: Record<string, any> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: "fixture",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer({ citations: [] })), refusal: null } }] });
    }) as unknown as typeof fetch;
    try {
      const evidence = buildSummaryEvidence(PT, MEDIA, 8000);
      const summary = await summarizeWithOpenAI(config, PT.text, "gpt-4o-mini", undefined, evidence, undefined,
        { spec: request.spec, selection: request.selection, notes: request.notes, notesInfo: request.notesInfo });
      expect(body.response_format.json_schema).toEqual({ name: "recording_summary_v2", strict: true, schema: JSON.parse(JSON.stringify(request.spec.schema)) });
      expect(body.messages[0].content).toBe(request.spec.system);
      expect(JSON.parse(body.messages[1].content).notes).toHaveLength(3);
      expect(summary.meta?.specId).toBe(request.spec.id);
      // The legacy request is untouched.
      await summarizeWithOpenAI(config, PT.text, "gpt-4o-mini", undefined, evidence).catch(() => undefined);
      expect(body.response_format.json_schema).toEqual({ name: "recording_summary", strict: true, schema: JSON.parse(JSON.stringify(SUMMARY_JSON_SCHEMA)) });
      expect(body.messages[0].content).toBe(SUMMARY_SYSTEM_PROMPT);
    } finally { globalThis.fetch = original; }
  });

  test("stored sections and metadata are validated field by field and checked against their references", () => {
    const evidence = buildSummaryEvidence(PT, MEDIA, 8000);
    const base: RecordingSummary = { version: 1, provider: "ollama", model: "fake", title: "Título", overview: "Resumo.", topics: [], decisions: [], actionItems: [],
      citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }],
      sections: [{ heading: "Decisões", items: [{ text: "Item.", origin: "ai", noteIds: [], segmentIds: ["s000002"], uncertainty: "clear" }] }],
      meta: { schemaVersion: 2, specId: "v2:0123456789ab", template: { id: "general", source: "fallback", confidence: 0, reason: "Sem sinal claro." }, language: "pt-BR", notes: { count: 0, digest: "b".repeat(64) } } };
    const supported = attachSummarySupport(base, evidence);
    expect(supported.support!.references.map((reference) => reference.id)).toEqual(["s000000", "s000002"]);
    expect(validateSummary({ ...supported, unknown: true }, "ollama", "fake")).toEqual(supported);
    expect(() => attachSummarySupport({ ...base, sections: [{ heading: "X", items: [{ ...base.sections![0].items[0], segmentIds: ["s000009"] }] }] }, evidence)).toThrow("does not exist");
    // An item whose reference is gone fails like a legacy citation.
    expect(() => validateSummary({ ...supported, support: { ...supported.support!, references: supported.support!.references.slice(0, 1) } }, "ollama", "fake")).toThrow("supporting reference");
    const invalid: unknown[] = [
      { ...base, sections: [{ heading: "", items: [] }] },
      { ...base, sections: [{ heading: "Linha\nquebrada", items: [] }] },
      { ...base, sections: [{ heading: "X", items: [{ text: "Sem nota", origin: "user", noteIds: [], segmentIds: [], uncertainty: "clear" }] }] },
      { ...base, sections: [{ heading: "X", items: [{ text: "IA com nota", origin: "ai", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }] },
      { ...base, sections: [{ heading: "X", items: [{ text: "x", origin: "ai", noteIds: [], segmentIds: ["s1"], uncertainty: "clear" }] }] },
      { ...base, meta: { ...base.meta, schemaVersion: 1 } },
      { ...base, meta: { ...base.meta, specId: "v1:legacy" } },
      { ...base, meta: { ...base.meta, language: "fr" } },
      { ...base, meta: { ...base.meta, template: { ...base.meta!.template, id: "auto" } } },
      { ...base, meta: { ...base.meta, template: { ...base.meta!.template, confidence: 2 } } },
      { ...base, meta: { ...base.meta, notes: { count: -1, digest: "b".repeat(64) } } }
    ];
    for (const value of invalid) expect(() => validateSummary(value, "ollama", "fake")).toThrow();
    // Client names: canonical in AI items, the user's own items kept as written.
    const clients = { clients: [{ code: "C1", name: "Example Alpha", aliases: ["Alias Co"] }] };
    const canonical = canonicalizeSummary({ ...base, sections: [{ heading: "Alias Co", items: [
      { text: "Alias Co aprovou.", origin: "ai", noteIds: [], segmentIds: [], uncertainty: "clear" },
      { text: "Ligar para Alias Co", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }] }, clients, "ollama", "fake");
    expect(canonical.sections![0]).toEqual({ heading: "Alias Co", items: [
      { text: "Example Alpha aprovou.", origin: "ai", noteIds: [], segmentIds: [], uncertainty: "clear" },
      { text: "Ligar para Alias Co", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] });
    expect(canonical.meta).toEqual(base.meta);
  });

  test("a summary made before v2 renders byte for byte as before", () => {
    const legacy: RecordingSummary = { version: 1, provider: "ollama", model: "fake", title: "Título", overview: "Resumo antigo.", topics: [], decisions: ["Decidido."],
      actionItems: [{ description: "Enviar", owner: "Ana", dueDate: "sexta" }], citations: [{ section: "decision", index: 0, segmentIds: ["s000001"], uncertainty: "clear" }],
      limitations: ["Limite."], support: { version: 1, mediaSha256: MEDIA, transcriptSha256: "c".repeat(64), timingQuality: "segment", reviewRequired: false, references: [{ id: "s000001", start: 10, end: 20 }] } };
    expect(formatSummaryMarkdown(legacy)).toBe([
      "# Título", "", "## Resumo", "", "Resumo antigo.", "", "## Tópicos", "", "- Nenhum identificado", "", "## Decisões", "", "- Decidido.", "", "## Ações", "",
      "- Enviar (responsável: Ana, prazo: sexta)", "", "## Evidências e limites", "",
      "Revisão necessária: não sinalizada (não garante correção semântica). Precisão temporal: segment.", `Mídia SHA-256: ${MEDIA}`, `Transcrição SHA-256: ${"c".repeat(64)}`,
      "- decision[0]: s000001 [0:10–0:20] (clear)", "", "## Limitações", "", "- Limite.", ""].join("\n"));
  });
});
