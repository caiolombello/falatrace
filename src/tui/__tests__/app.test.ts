import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../../jobs/types";
import type { TimeEntry } from "../../timesheet/types";
import type { AppConfig } from "../../config/defaults";
import type { LibraryEntry } from "../library";
import {
  buildHelpLines,
  buildLibraryActionLine,
  buildLibraryHeader,
  enqueueSelectedRecording,
  findLinkedTimeEntries,
  formatJobStatus,
  formatJobContent,
  formatLinkedClient,
  formatLinkedDuration,
  formatLibraryEntryName,
  formatStorageLocation,
  formatTimeEntryStatus,
  getTuiLayout,
  isProcessKey,
  isRetryKey,
  parseEditorCommand,
  selectInitialArtifactView,
  sanitizeTerminalText
} from "../app";

const timeEntry = (
  overrides: Partial<TimeEntry> = {}
): TimeEntry => ({
  version: 1,
  id: "123e4567-e89b-42d3-a456-426614174001",
  createdAt: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T13:00:00.000Z",
  activityDate: "2026-07-29",
  hours: 1.5,
  clientCode: "CL008",
  source: {
    kind: "call",
    recordingPath: "/recordings/meeting.mkv",
    jobId: "123e4567-e89b-42d3-a456-426614174000"
  },
  status: "ready",
  classificationStatus: "completed",
  classificationSource: "openai",
  confidence: {
    client: 0.9,
    taskType: 0.9,
    description: 0.9
  },
  evidence: [],
  lockedFields: [],
  ...overrides
});

describe("TUI input handling", () => {
  test("parses an editor command without invoking a shell", () => {
    expect(parseEditorCommand("zed --wait")).toEqual(["zed", "--wait"]);
    expect(parseEditorCommand("'editor with spaces' --flag")).toEqual(["editor with spaces", "--flag"]);
  });

  test("rejects malformed editor commands", () => {
    expect(() => parseEditorCommand("zed 'unfinished")).toThrow("unfinished");
    expect(() => parseEditorCommand("zed\n--wait")).toThrow("invalid");
  });

  test("removes terminal control sequences from displayed content", () => {
    expect(sanitizeTerminalText("safe\u001b[2Jtext\u0000")).toBe("safe[2Jtext");
  });

  test("shows the failure reason before unavailable artifacts", () => {
    expect(
      formatJobContent(
        {
          id: "123e4567-e89b-42d3-a456-426614174000",
          state: "failed",
          error: "overview must be non-empty"
        },
        "Resumo ainda não disponível."
      )
    ).toContain("Motivo: overview must be non-empty");
  });

  test("reserves uppercase R for retry without replacing lowercase refresh", () => {
    expect(isRetryKey({ name: "r", sequence: "R", shift: true })).toBe(true);
    expect(isRetryKey({ name: "r", sequence: "r" })).toBe(false);
  });

  test("reserves uppercase P for processing without replacing playback", () => {
    expect(isProcessKey({ name: "p", sequence: "P", shift: true })).toBe(true);
    expect(isProcessKey({ name: "p", sequence: "p" })).toBe(false);
  });

  test("opens the summary first and falls back when only a transcript exists", () => {
    expect(selectInitialArtifactView({ transcript: true, summary: true })).toBe("summary");
    expect(selectInitialArtifactView({ transcript: true, summary: false })).toBe("transcript");
    expect(selectInitialArtifactView({ transcript: false, summary: false })).toBe("summary");
  });

  test("shows the AI meeting title while preserving the physical path", () => {
    expect(
      formatLibraryEntryName({
        sourceExists: true,
        relativePath: "2026-07-28/meeting.mkv",
        meetingTitle: "Revisão de alertas da Example Vet"
      })
    ).toBe(
      "Revisão de alertas da Example Vet · 2026-07-28/meeting.mkv"
    );
  });

  test("distinguishes local, archived, and missing recording storage", () => {
    const remoteJob = {
      target: "remote",
      state: "completed"
    } as JobRecord;
    expect(formatStorageLocation({
      sourceExists: true,
      jobs: [remoteJob]
    })).toBe("local + vaio");
    expect(formatStorageLocation({
      sourceExists: false,
      jobs: [remoteJob]
    })).toBe("somente no vaio");
    expect(formatStorageLocation({
      sourceExists: false,
      jobs: []
    })).toBe("arquivo ausente");
  });

  test("uses distinct Portuguese processing states without depending on color", () => {
    expect(formatJobStatus()).toBe("[–] Sem job");
    expect(formatJobStatus({ state: "pending" })).toBe("[·] Pendente");
    expect(formatJobStatus({ state: "queued" })).toBe("[→] Na fila");
    expect(formatJobStatus({ state: "processing" })).toBe("[~] Processando");
    expect(formatJobStatus({ state: "completed" })).toBe("[✓] Concluído");
    expect(formatJobStatus({ state: "failed" })).toBe("[!] Falhou");
  });

  test("marks AI client suggestions, manual confirmation, and stale allocations", () => {
    const suggested = timeEntry();
    const confirmed = timeEntry({ lockedFields: ["client"] });

    expect(formatLinkedClient([suggested])).toBe("~CL008");
    expect(formatLinkedClient([confirmed])).toBe("=CL008");
    expect(formatLinkedDuration([suggested])).toBe("1h30");
    expect(
      formatTimeEntryStatus([suggested], {
        id: "123e4567-e89b-42d3-a456-426614174099"
      })
    ).toBe("[↺] Desatualizado");
  });

  test("links allocations to a recording without mixing another source", () => {
    const linked = timeEntry();
    const other = timeEntry({
      id: "123e4567-e89b-42d3-a456-426614174002",
      source: {
        kind: "call",
        recordingPath: "/recordings/other.mkv"
      }
    });

    expect(
      findLinkedTimeEntries(
        { sourcePath: "/recordings/meeting.mkv" },
        [linked, other]
      )
    ).toEqual([linked]);
  });

  test("keeps contextual help within an 80-column terminal", () => {
    const lines = buildHelpLines("library", 80);

    expect(lines).toContain("R           Repetir um job com falha");
    expect(lines).toContain("p           Reproduzir no player no trecho selecionado");
    expect(lines).toContain("l           Liberar somente o espaço do vídeo local");
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.join("\n")).toContain("~ sugestão automática");
  });

  test("keeps at least six recordings visible in an 80 by 24 terminal", () => {
    const layout = getTuiLayout(80, 24);

    expect(layout.rowsPerEntry).toBe(1);
    expect(layout.visibleEntries).toBeGreaterThanOrEqual(6);
    expect(layout.contentHeight).toBeGreaterThanOrEqual(3);
  });

  test("shows search, selected processing and retry without truncation at 80 columns", () => {
    const actions = buildLibraryActionLine(true);

    expect(actions).toContain("/ lista");
    expect(actions).toContain("b texto");
    expect(actions).toContain("P job");
    expect(actions).toContain("R retry");
    expect(actions.length).toBeLessThanOrEqual(80);
  });

  test("keeps counts and the active filter visible with a long search at 80 columns", () => {
    const header = buildLibraryHeader(
      3,
      174,
      "failed",
      "uma busca deliberadamente extensa para testar a largura",
      80
    );

    expect(header).toContain("3/174 gravações");
    expect(header).toContain("filtro com falha");
    expect(header).toContain("busca");
    expect(header.length).toBeLessThanOrEqual(80);
  });

  test("enqueues only the selected recording when no job exists", async () => {
    const paths: string[] = [];
    const selected = {
      sourcePath: "/recordings/selected.mkv",
      sourceExists: true
    } as LibraryEntry;
    const pending = { id: "selected-job", state: "pending" } as JobRecord;
    const store = {
      enqueue: async (_config: AppConfig, path: string) => {
        paths.push(path);
        return pending;
      }
    };

    expect(await enqueueSelectedRecording(
      {} as AppConfig,
      store,
      selected,
      async () => undefined
    )).toBe(pending);
    expect(paths).toEqual([selected.sourcePath]);
  });

  test("refuses to enqueue the recording that is still active", async () => {
    let enqueued = false;
    const selected = {
      sourcePath: "/recordings/growing.mkv",
      sourceExists: true
    } as LibraryEntry;

    await expect(enqueueSelectedRecording(
      {} as AppConfig,
      { enqueue: async () => { enqueued = true; return {} as JobRecord; } },
      selected,
      async () => selected.sourcePath
    )).rejects.toThrow("ainda está em andamento");
    expect(enqueued).toBe(false);
  });
});
