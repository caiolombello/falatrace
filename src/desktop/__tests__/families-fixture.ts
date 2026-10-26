import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { createAppServices } from "../../app/context";
import type { ChatProvider, ChatRequest } from "../../assistant/types";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { JobStore } from "../../jobs/store";
import { type JobRecord, type Transcript, validateSummary } from "../../jobs/types";
import { calendarLinksDir } from "../../library-index/build";
import { NotesStore, notesDigest } from "../../notes";
import { attachSummarySupport, buildSummaryEvidence } from "../../summary/evidence";
import { SUMMARY_LABELS } from "../../summary/language";
import { buildLibrary } from "../../tui/library";
import type { BridgeContext, BridgeDeps } from "../bridge-context";
import type { BridgeCall } from "../bridge-family";
import { StudioServices } from "../studio-services";

/** A provider that answers at once, citing the second segment; nothing leaves the process. */
export const fakeProvider = (external = true, answer = "Decidiram adiar o lançamento para março [[s000001]]."): ChatProvider & { requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  return {
    requests,
    destination: { kind: "api", id: "fake", label: "Fake · synthetic-model", endpoint: "https://provider.invalid/v1", model: "synthetic-model", external },
    check: async () => ({ ready: true }),
    run: async (request) => {
      requests.push(request);
      request.onDelta?.(answer);
      return { text: answer, stopReason: "end" };
    }
  };
};

export type FamilyFixture = Awaited<ReturnType<typeof familyFixture>>;

/**
 * One completed recording with a v2 summary (sections, a decision, an action), meeting notes, a
 * calendar link with attendees, and the bridge context over an isolated HOME (the offline harness).
 */
export const familyFixture = async (options: { provider?: ChatProvider; deps?: BridgeDeps; config?: (config: AppConfig) => void } = {}) => {
  const root = await fs.mkdtemp(join(process.env.TMPDIR!, "families-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.recordingsDir = join(root, "recordings");
  config.timesheet.contextPath = join(root, "timesheet-context.json");
  config.processing.autoEnqueue = false;
  config.callDetection.enabled = false;
  config.summary.provider = "ollama";
  options.config?.(config);
  await fs.mkdir(config.recordingsDir, { recursive: true, mode: 0o700 });
  const source = join(config.recordingsDir, `2026-10-20_10-00_Planejamento-${randomUUID().slice(0, 8)}.mkv`);
  await fs.writeFile(source, `synthetic-media-${randomUUID()}`, { mode: 0o600 });
  const jobs = new JobStore();
  const created = await jobs.enqueue(config, source);
  const job: JobRecord = await jobs.update(created.id, "completed");
  await fs.mkdir(job.artifactDir, { recursive: true, mode: 0o700 });
  const segments = [
    { start: 0, end: 4, text: "Bom dia, Ana." },
    { start: 4, end: 10, text: "Decidimos adiar o lançamento para março." },
    { start: 10, end: 16, text: "Bruno vai mandar a ata do orçamento até sexta." }
  ];
  const transcript: Transcript = { version: 1, provider: job.transcription.provider, model: job.transcription.model, language: job.transcription.language,
    text: segments.map((segment) => segment.text).join(" "), segments };
  await fs.writeFile(join(job.artifactDir, "transcript.json"), JSON.stringify(transcript), { mode: 0o600 });
  // Notes typed during the meeting: the second line 12 s into the media.
  const mediaStartedAt = new Date(Date.parse(job.createdAt) - 60_000).toISOString();
  const notesStore = new NotesStore();
  await notesStore.save(job.id, { text: "# Pauta", expectedRev: 0, mediaStartedAt, now: new Date(Date.parse(mediaStartedAt) + 2_000) });
  const notes = await notesStore.save(job.id, { text: "# Pauta\n- [ ] Bruno manda a ata", expectedRev: 1, now: new Date(Date.parse(mediaStartedAt) + 12_000) });
  const labels = SUMMARY_LABELS["pt-BR"];
  const summary = attachSummarySupport(validateSummary({
    title: "Planejamento do lançamento", overview: "Reunião sobre o lançamento.", topics: ["Lançamento"],
    decisions: ["Adiar o lançamento para março."], actionItems: [{ description: "Bruno manda a ata", owner: "Bruno", dueDate: "sexta" }],
    citations: [{ section: "overview", index: 0, segmentIds: ["s000001"], uncertainty: "clear" }],
    sections: [
      { heading: "Decisões", items: [{ text: "Adiar o lançamento para março.", origin: "ai", noteIds: [], segmentIds: ["s000001"], uncertainty: "clear" }] },
      { heading: "Próximos passos", items: [{ text: "Bruno manda a ata", origin: "user", noteIds: ["n000002"], segmentIds: ["s000002"], uncertainty: "uncertain" }] },
      { heading: labels.unusedNotes, items: [{ text: "Pauta", origin: "user", noteIds: ["n000001"], segmentIds: [], uncertainty: "clear" }] }
    ],
    meta: { schemaVersion: 2, specId: "v2:0123456789ab", template: { id: "planning", source: "calendar", confidence: 0.8, reason: "Título da agenda: planejamento." },
      language: "pt-BR", notes: { count: 2, digest: notesDigest(notes) } }
  }, job.summary.provider, job.summary.model), buildSummaryEvidence(transcript, job.source.sha256));
  await fs.writeFile(join(job.artifactDir, "summary.json"), JSON.stringify(summary), { mode: 0o600 });
  // Calendar details kept beside the job (names only).
  await fs.mkdir(calendarLinksDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(calendarLinksDir(), `${job.id}.json`), JSON.stringify({
    version: 1, jobId: job.id, mediaSha256: job.source.sha256, source: "google-calendar", title: "Planejamento do lançamento",
    startAt: "2026-10-20T13:00:00.000Z", endAt: "2026-10-20T14:00:00.000Z", recurring: false,
    attendees: [{ name: "Ana Souza", self: false }, { name: "Bruno Lima", self: false }, { name: "Pessoa Dona", self: true }], capturedAt: "2026-10-20T13:00:00.000Z"
  }), { mode: 0o600 });
  const provider = options.provider ?? fakeProvider();
  const studio = new StudioServices({
    loadConfig: async () => config,
    create: (current) => createAppServices(current, { assistant: { providerFactory: () => provider } }),
    presence: async () => null
  });
  let invalidations = 0;
  const context: BridgeContext = {
    studio,
    library: {
      load: async () => ({ config, entries: await buildLibrary(config, new JobStore()) }),
      find: async (key) => {
        const entry = (await buildLibrary(config, new JobStore())).find((item) => item.sourcePath === resolve(key));
        if (!entry) throw new Error("Gravação não encontrada na biblioteca");
        return { config, entry };
      },
      invalidate: () => { invalidations += 1; }
    },
    deps: { provider: () => provider, ...options.deps }
  };
  const services = await studio.services();
  await services.index.refresh({ jobIds: [job.id] });
  await studio.snapshot(services);
  // As after the Studio's startup refresh: pages read the index without starting another one.
  studio.markRefreshed();
  return {
    root, config, source, job, notes, summary, transcript, studio, context, provider, services,
    get invalidations() { return invalidations; },
    call: (op: string, payload: Record<string, unknown> = {}, key?: string): BridgeCall => ({ id: 1, op, ...(key === undefined ? {} : { key }), payload }),
    async cleanup() {
      await studio.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
};
