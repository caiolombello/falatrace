import { describe, expect, test } from "bun:test";
import { timeEntry, uuid } from "../../people/__tests__/fixtures";
import type { TimesheetContext } from "../../timesheet/types";
import {
  CONTENT_MATCH_CONFIDENCE,
  entriesForJob,
  manualMeetingClients,
  matchClientsInText,
  resolveEntryClients,
  resolveMeetingClients,
  trustedEntryClient
} from "../resolve";

const catalog: TimesheetContext = {
  version: 1, colleagues: [], taskTypes: [],
  clients: [
    { code: "CL001", name: "Acme Brasil", aliases: ["acme"], responsibleNames: [] },
    { code: "CL002", name: "Beta Saúde", aliases: ["beta"], responsibleNames: [] },
    { code: "CL003", name: "Gama", aliases: ["go"], responsibleNames: [] }
  ]
};
const job = { id: uuid(1), sourcePath: "/recordings/../recordings/1.mkv" };
const READY = 0.8;

const linked = (n: number, extra: Parameters<typeof timeEntry>[1] = {}) =>
  timeEntry(n, { source: { kind: "call", jobId: job.id }, ...extra });

/** Content readers that record whether they were asked. */
const content = (summary: string, transcript = "") => {
  const asked = { summary: 0, transcript: 0 };
  return {
    asked,
    content: {
      summaryText: () => { asked.summary++; return summary; },
      transcriptText: async () => { asked.transcript++; return transcript; }
    }
  };
};

describe("matching clients in text", () => {
  test("whole words of codes, names and aliases with 3+ characters, ignoring case and accents", () => {
    expect(matchClientsInText(catalog, "Reunião com a ACME sobre o portal").map((client) => client.code)).toEqual(["CL001"]);
    expect(matchClientsInText(catalog, "beta saude e cl001").map((client) => client.code)).toEqual(["CL001", "CL002"]);
    // "go" is too short to match and "acmeberg" is not the word "acme".
    expect(matchClientsInText(catalog, "Let's go to acmeberg")).toEqual([]);
  });

  test("trusted entries: locked client or confidence at the ready threshold, known to the catalog", () => {
    expect(trustedEntryClient(linked(1, { clientCode: "CL001", lockedFields: ["client"] }), catalog, READY)).toBe("CL001");
    expect(trustedEntryClient(linked(1, { clientCode: "CL001", confidence: { client: 0.8, taskType: 0, description: 0 } }), catalog, READY)).toBe("CL001");
    expect(trustedEntryClient(linked(1, { clientCode: "CL001", confidence: { client: 0.79, taskType: 0, description: 0 } }), catalog, READY)).toBeUndefined();
    expect(trustedEntryClient(linked(1, { clientCode: "CL999", lockedFields: ["client"] }), catalog, READY)).toBeUndefined();
    expect(trustedEntryClient(undefined, catalog, READY)).toBeUndefined();
  });

  test("entries link to a job by id or by recording path, each once", () => {
    const byId = linked(1);
    const byPath = timeEntry(2, { source: { kind: "call", recordingPath: "/recordings/1.mkv" } });
    const both = timeEntry(3, { source: { kind: "call", jobId: job.id, recordingPath: "/recordings/1.mkv" } });
    const other = timeEntry(4, { source: { kind: "call", jobId: uuid(9), recordingPath: "/recordings/2.mkv" } });
    expect(entriesForJob(job, [byId, byPath, both, other]).map((entry) => entry.id)).toEqual([byId.id, both.id, byPath.id]);
  });
});

describe("resolveMeetingClients", () => {
  test("a locked entry decides without reading any content", async () => {
    const reading = content("Acme e Beta");
    const result = await resolveMeetingClients(job, [linked(1, { clientCode: "CL002", lockedFields: ["client"] })], catalog, READY, { content: reading.content });
    expect(result).toEqual([{ clientCode: "CL002", source: "entry-locked", confidence: 1, timeEntryId: uuid(1001) }]);
    expect(reading.asked).toEqual({ summary: 0, transcript: 0 });
  });

  test("a confident entry decides; its confidence is reported", async () => {
    const result = await resolveMeetingClients(job, [linked(1, { clientCode: "CL001", confidence: { client: 0.9, taskType: 0, description: 0 } })], catalog, READY);
    expect(result).toEqual([{ clientCode: "CL001", source: "entry-confident", confidence: 0.9, timeEntryId: uuid(1001) }]);
  });

  test("trusted split entries give every allocated client", async () => {
    const group = uuid(1001);
    const entries = [
      linked(1, { clientCode: "CL001", lockedFields: ["client"], splitGroupId: group, splitIndex: 1, splitCount: 3 }),
      linked(2, { clientCode: "CL002", confidence: { client: 0.95, taskType: 0, description: 0 }, splitGroupId: group, splitIndex: 2, splitCount: 3 }),
      linked(3, { clientCode: "CL003", confidence: { client: 0.1, taskType: 0, description: 0 }, splitGroupId: group, splitIndex: 3, splitCount: 3 })
    ];
    expect(await resolveMeetingClients(job, entries, catalog, READY)).toEqual([
      { clientCode: "CL001", source: "entry-split", confidence: 1, timeEntryId: uuid(1001) },
      { clientCode: "CL002", source: "entry-split", confidence: 0.95, timeEntryId: uuid(1002) }
    ]);
  });

  test("an untrusted entry is ignored and the content decides (the old search filter accepted it)", async () => {
    const entries = [linked(1, { clientCode: "CL002", confidence: { client: 0.5, taskType: 0, description: 0 } })];
    // Without content to read, nothing decides.
    expect(await resolveMeetingClients(job, entries, catalog, READY)).toEqual([]);
    expect(await resolveMeetingClients(job, entries, catalog, READY, { content: content("Portal da Acme").content }))
      .toEqual([{ clientCode: "CL001", source: "content-match", confidence: CONTENT_MATCH_CONFIDENCE }]);
    expect(await resolveMeetingClients(job, entries, catalog, READY, { content: content("Sem cliente").content })).toEqual([]);
  });

  test("only the first linked entry counts when it is not a split", async () => {
    const entries = [
      linked(1, { clientCode: "CL001", confidence: { client: 0.2, taskType: 0, description: 0 } }),
      linked(2, { clientCode: "CL002", lockedFields: ["client"] })
    ];
    expect(await resolveMeetingClients(job, entries, catalog, READY)).toEqual([]);
  });

  test("the summary is read first; the transcript only when the summary names nobody", async () => {
    const fromSummary = content("Portal da Acme", "Beta Saúde");
    expect((await resolveMeetingClients(job, [], catalog, READY, { content: fromSummary.content }))[0]!.clientCode).toBe("CL001");
    expect(fromSummary.asked).toEqual({ summary: 1, transcript: 0 });

    const fromTranscript = content("Conversa técnica", "A Beta Saúde ligou");
    expect((await resolveMeetingClients(job, [], catalog, READY, { content: fromTranscript.content }))[0]!.clientCode).toBe("CL002");
    expect(fromTranscript.asked).toEqual({ summary: 1, transcript: 1 });
  });

  test("two clients named in the summary decide nothing, and the transcript is not consulted", async () => {
    const ambiguous = content("Acme e Beta juntos", "Gama");
    expect(await resolveMeetingClients(job, [], catalog, READY, { content: ambiguous.content })).toEqual([]);
    expect(ambiguous.asked.transcript).toBe(0);
  });

  test("an empty catalog matches nothing and reads nothing", async () => {
    const reading = content("Acme");
    expect(await resolveMeetingClients(job, [], { ...catalog, clients: [] }, READY, { content: reading.content })).toEqual([]);
    expect(reading.asked).toEqual({ summary: 0, transcript: 0 });
  });

  test("a manual choice wins over entries and content", async () => {
    const entries = [linked(1, { clientCode: "CL001", lockedFields: ["client"] })];
    const reading = content("Acme");
    expect(await resolveMeetingClients(job, entries, catalog, READY, { override: { clientCodes: ["CL003", "CL002", "CL003"] }, content: reading.content })).toEqual([
      { clientCode: "CL003", source: "manual", confidence: 1 },
      { clientCode: "CL002", source: "manual", confidence: 1 }
    ]);
    expect(reading.asked.summary).toBe(0);
  });

  test("a manual 'no client' choice hides the automatic assignment", async () => {
    const entries = [linked(1, { clientCode: "CL001", lockedFields: ["client"] })];
    expect(await resolveMeetingClients(job, entries, catalog, READY, { override: { clientCodes: [] } })).toEqual([]);
  });

  test("a choice whose clients all left the catalog falls back to the automatic rule", async () => {
    const entries = [linked(1, { clientCode: "CL001", lockedFields: ["client"] })];
    expect(await resolveMeetingClients(job, entries, catalog, READY, { override: { clientCodes: ["GONE"] } }))
      .toEqual([{ clientCode: "CL001", source: "entry-locked", confidence: 1, timeEntryId: uuid(1001) }]);
    expect(await resolveMeetingClients(job, entries, catalog, READY, { override: { clientCodes: ["GONE", "CL002"] } }))
      .toEqual([{ clientCode: "CL002", source: "manual", confidence: 1 }]);
    expect(manualMeetingClients(null, catalog)).toBeUndefined();
    expect(manualMeetingClients(undefined, catalog)).toBeUndefined();
  });

  test("resolveEntryClients alone never reads content", () => {
    expect(resolveEntryClients(job, [], catalog, READY)).toEqual([]);
    expect(resolveEntryClients(job, [timeEntry(1, { clientCode: "CL001", lockedFields: ["client"], source: { kind: "call", jobId: uuid(5) } })], catalog, READY)).toEqual([]);
  });
});
