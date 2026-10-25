import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactAction, FactAttendee, FactSpeaker, JobFacts, LibraryIndexReader } from "../../library-index/types";
import type { TimeEntry } from "../../timesheet/types";

/** Shared fixtures for the people, clients, actions and brief tests. */

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const mediaSha = (n: number | string): string => createHash("sha256").update(`media-${n}`).digest("hex");

const roots: string[] = [];
export const tempDir = async (prefix = "people-"): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
export const removeTempDirs = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
};

export const speaker = (label: string, confirmed = true, speakerId = "S01"): FactSpeaker => ({ speakerId, label, confirmed });
export const attendee = (name: string, self = false): FactAttendee => ({ name, self });
export const action = (index: number, text: string, extra: Partial<FactAction> = {}): FactAction =>
  ({ index, text, owner: "", dueDate: "", segmentIds: [], origin: "model", ...extra });

/** Facts of recording `n`; the date defaults to 2026-10-<n> so a larger n is newer. */
export const facts = (n: number, extra: Partial<JobFacts> = {}): JobFacts => ({
  version: 1,
  jobId: uuid(n),
  mediaSha256: mediaSha(n),
  sourcePath: `/recordings/${n}.mkv`,
  title: `Reunião ${n}`,
  date: `2026-10-${String(n).padStart(2, "0")}T13:00:00.000Z`,
  fingerprint: `fp-${n}`,
  revision: 0,
  speakers: [],
  attendees: [],
  clients: [],
  overview: "",
  topics: [],
  decisions: [],
  actions: [],
  noteCount: 0,
  ...extra
});

/** In-memory LibraryIndexReader; listFacts returns newest first like the real index. */
export const fakeReader = (items: JobFacts[] | (() => JobFacts[])): LibraryIndexReader & { calls: number } => {
  const reader = {
    calls: 0,
    listFacts: async () => {
      reader.calls++;
      const list = typeof items === "function" ? items() : items;
      return [...list].sort((a, b) => b.date.localeCompare(a.date));
    },
    getFacts: async (jobId: string) => (typeof items === "function" ? items() : items).find((item) => item.jobId === jobId),
    search: async () => []
  };
  return reader;
};

export const timeEntry = (n: number, extra: Partial<TimeEntry> = {}): TimeEntry => ({
  version: 1,
  id: uuid(1000 + n),
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  activityDate: "2026-10-01",
  source: { kind: "call" },
  status: "draft",
  classificationStatus: "completed",
  confidence: { client: 0, taskType: 0, description: 0 },
  evidence: [],
  lockedFields: [],
  ...extra
});

export const fixedClock = (iso = "2026-10-25T12:00:00.000Z") => {
  let current = Date.parse(iso);
  return { now: () => new Date(current), advance: (ms: number) => { current += ms; } };
};
