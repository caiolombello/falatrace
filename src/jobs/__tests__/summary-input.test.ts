import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { hashFile } from "../store";
import { processJob } from "../pipeline";
import type { JobManifest, Transcript } from "../types";
import { fakeSummaryAnswer } from "../../summary/__tests__/v2-reply";
import { NotesStore, findNotesForJob } from "../../notes/store";
import { BUILT_IN_TEMPLATES } from "../../templates/catalog";

test("summarizes segment-only transcripts without sending an empty conversation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "summary-input-"));
  const originalFetch = globalThis.fetch;
  const manifest: JobManifest = {
    version: 1, id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-09-30T00:00:00Z",
    source: { originalName: "synthetic.wav", mediaFile: "source.wav", size: 1, sha256: "a".repeat(64) },
    transcription: { provider: "whisper-cpp", model: "fixture", language: "pt" },
    summary: { provider: "ollama", model: "fixture" }
  };
  const transcript: Transcript = {
    version: 1, provider: "whisper-cpp", model: "fixture", language: "pt",
    text: " \n", segments: [
      { start: 1, end: 2, text: " Revisar o protótipo. " },
      { start: 3, end: 4, text: "Publicar após revisão." }
    ]
  };
  let input = "";
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    input = JSON.parse(request.messages[1].content).transcript;
    return Response.json({ message: { content: JSON.stringify(fakeSummaryAnswer(request, {
      title: "Revisão do protótipo", overview: "Planejamento sintético.",
      topics: [], decisions: [], actionItems: []
    })) } });
  }) as typeof fetch;
  try {
    await fs.writeFile(join(root, "transcript.json"), JSON.stringify(transcript));
    const source=join(root,"synthetic.wav"); await fs.writeFile(source,"synthetic offline fixture"); manifest.source.sha256=await hashFile(source);
    await processJob(DEFAULT_CONFIG, manifest, source, root);
    expect(input).toBe("Revisar o protótipo.\nPublicar após revisão.");
    expect(JSON.parse(await fs.readFile(join(root, "transcript.json"), "utf8"))).toEqual(transcript);
    expect(await fs.readFile(join(root, "summary.md"), "utf8")).toContain("Planejamento sintético.");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const pipelineFixture = async (answer: (body: Record<string, any>) => Record<string, unknown>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "summary-notes-"));
  const bodies: Array<Record<string, any>> = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as Record<string, any>;
    bodies.push(body);
    return Response.json({ message: { content: JSON.stringify(answer(body)) } });
  } });
  const transcript: Transcript = {
    version: 1, provider: "whisper-cpp", model: "fixture", language: "pt", text: "",
    segments: [
      { start: 0, end: 30, text: "Good morning everyone, so today we need to decide the release date for the new app." },
      { start: 30, end: 60, text: "I think we should ship on Friday, and Maria will check the store listing before that." }
    ]
  };
  const source = join(root, "meeting.wav");
  await fs.writeFile(source, "synthetic offline fixture");
  await fs.writeFile(join(root, "transcript.json"), JSON.stringify(transcript));
  const manifest: JobManifest = {
    version: 1, id: "223e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-25T00:00:00Z",
    source: { originalName: "meeting.wav", mediaFile: "source.wav", size: 1, sha256: await hashFile(source) },
    transcription: { provider: "whisper-cpp", model: "fixture", language: "pt" },
    summary: { provider: "ollama", model: "fixture" }
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.ollamaUrl = `http://127.0.0.1:${server.port}`;
  const notesStore = new NotesStore(join(root, "notes"));
  const summaryInputs = { notes: (job: { id: string; sourcePath: string }) => findNotesForJob(job, notesStore), prefs: async () => undefined, templates: async () => [...BUILT_IN_TEMPLATES] };
  const cleanup = async () => { server.stop(true); await fs.rm(root, { recursive: true, force: true }); };
  return { root, bodies, source, manifest, config, notesStore, summaryInputs, cleanup };
};

test("the original pipeline sends the notes typed in the meeting and writes a v2 summary in the conversation's language", async () => {
  const f = await pipelineFixture((body) => {
    const notes = JSON.parse(body.messages[1].content).notes;
    return fakeSummaryAnswer(body, {
      title: "Release date for the new app", overview: "The team set the release for Friday.",
      sections: [{ heading: "Decisions", items: [
        { text: notes[0].text, origin: "user", noteIds: [notes[0].id], segmentIds: ["s000001"], uncertainty: "clear" },
        { text: "Maria checks the store listing first.", origin: "ai", noteIds: [], segmentIds: ["s000001"], uncertainty: "clear" }] }],
      topics: ["Release"], decisions: ["Ship on Friday."], actionItems: [],
      citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }, { section: "decision", index: 0, segmentIds: ["s000001"], uncertainty: "clear" }]
    });
  });
  try {
    await f.notesStore.save(f.manifest.id, { text: "ship on friday\nask Maria about screenshots", expectedRev: 0, now: new Date("2026-10-25T00:00:40Z"), mediaStartedAt: "2026-10-25T00:00:00Z" });
    await processJob(f.config, f.manifest, f.source, f.root, { summaryInputs: f.summaryInputs });
    expect(f.bodies).toHaveLength(1);
    const sent = JSON.parse(f.bodies[0].messages[1].content);
    expect(sent.notes.map((note: { text: string }) => note.text)).toEqual(["ship on friday", "ask Maria about screenshots"]);
    expect(f.bodies[0].format.properties.templateId.enum[0]).toBe("general");
    const summary = JSON.parse(await fs.readFile(join(f.root, "summary.json"), "utf8"));
    expect(summary.meta).toMatchObject({ schemaVersion: 2, language: "en", notes: { count: 2 } });
    expect(summary.sections.map((section: { heading: string }) => section.heading)).toEqual(["Decisions", "Your notes the model did not use"]);
    const markdown = await fs.readFile(join(f.root, "summary.md"), "utf8");
    expect(markdown).toContain("## Decisions\n\n- ✎ ship on friday [0:30]\n- Maria checks the store listing first. [0:30]");
    expect(markdown).toContain("## Your notes the model did not use\n\n- ✎ ask Maria about screenshots");
    expect(markdown).toContain("Some of your notes do not appear in the summary");
  } finally { await f.cleanup(); }
});

test("damaged notes never stop the pipeline; a language bound in the job's manifest wins over the conversation", async () => {
  const f = await pipelineFixture((body) => fakeSummaryAnswer(body, { title: "Fecha de lanzamiento", overview: "El equipo fijó el lanzamiento para el viernes.", topics: [], decisions: [], actionItems: [] }));
  try {
    await f.notesStore.save(f.manifest.id, { text: "nota", expectedRev: 0 });
    await fs.writeFile(f.notesStore.pathFor(f.manifest.id), "{", { mode: 0o600 });
    f.manifest.summary.language = "es";
    await processJob(f.config, f.manifest, f.source, f.root, { summaryInputs: f.summaryInputs });
    expect(JSON.parse(f.bodies[0].messages[1].content).notes).toBeUndefined();
    expect(f.bodies[0].messages[0].content).toContain("Write every text field in Spanish");
    const summary = JSON.parse(await fs.readFile(join(f.root, "summary.json"), "utf8"));
    expect(summary.meta.language).toBe("es");
    expect(summary.limitations).toContain("No se pudieron leer tus notas de esta reunión; el resumen usa solo la transcripción y el archivo de notas se conservó.");
    expect(await fs.readFile(f.notesStore.pathFor(f.manifest.id), "utf8")).toBe("{");
    expect(await fs.readFile(join(f.root, "summary.md"), "utf8")).toContain("## Resumen\n\nEl equipo fijó el lanzamiento para el viernes.\n\n## Temas\n\n- Ninguno identificado");
  } finally { await f.cleanup(); }
});
