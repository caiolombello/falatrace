import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../../jobs/types";
import type { TimeEntry } from "../../timesheet/types";
import type { LibraryEntry } from "../library";
import {
  cycleLibraryStateFilter,
  filterLibraryEntries,
  libraryStateFilterLabel,
  normalizeSearchText,
  type LibraryStateFilter
} from "../search";

const job = (state: JobRecord["state"]): JobRecord => ({
  state
} as JobRecord);

const entry = (
  relativePath: string,
  modifiedAt: number,
  overrides: Partial<LibraryEntry> = {}
): LibraryEntry => ({
  sourcePath: `/recordings/${relativePath}`,
  relativePath,
  sourceExists: true,
  size: 1,
  modifiedAt,
  jobs: [],
  ...overrides
});

const allocation = (
  recordingPath: string,
  clientCode: string,
  clientName: string
): TimeEntry => ({
  version: 1,
  id: crypto.randomUUID(),
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
  activityDate: "2026-09-07",
  clientCode,
  clientName,
  source: { kind: "call", recordingPath },
  status: "ready",
  classificationStatus: "completed",
  classificationSource: "openai",
  confidence: { client: 1, taskType: 1, description: 1 },
  evidence: [],
  lockedFields: []
});

describe("library search and state filters", () => {
  test("matches title, path, client and local date without accents", () => {
    const review = entry("2026-09-07/revisao.mkv", new Date(2026, 8, 7, 9, 30).getTime(), {
      meetingTitle: "Revisão de segurança"
    });
    const daily = entry("2026-09-06/daily.mkv", new Date(2026, 8, 6, 9).getTime());
    const entries = [review, daily];
    const allocations = [allocation(review.sourcePath, "RC", "Example-client")];

    expect(normalizeSearchText("Revisão")).toBe("revisao");
    expect(filterLibraryEntries(entries, allocations, { query: "revisao", state: "all" })).toEqual([review]);
    expect(filterLibraryEntries(entries, allocations, { query: "example-client", state: "all" })).toEqual([review]);
    expect(filterLibraryEntries(entries, allocations, { query: "07/09/2026", state: "all" })).toEqual([review]);
    expect(filterLibraryEntries(entries, allocations, { query: "daily.mkv", state: "all" })).toEqual([daily]);
  });

  test("combines tokenized search with the selected processing state", () => {
    const pending = entry("daily-example-client.mkv", Date.now(), { jobs: [job("pending")] });
    const failed = entry("retro-example-client.mkv", Date.now(), { jobs: [job("failed")] });
    const completed = entry("daily-internal.mkv", Date.now(), { jobs: [job("completed")] });
    const unprocessed = entry("notes-example-client.mkv", Date.now());

    expect(filterLibraryEntries(
      [pending, failed, completed, unprocessed],
      [],
      { query: "example-client", state: "active" }
    )).toEqual([pending]);
    expect(filterLibraryEntries(
      [pending, failed, completed, unprocessed],
      [],
      { query: "", state: "no-job" }
    )).toEqual([unprocessed]);
  });

  test("cycles through visible state filters and returns to the clear state", () => {
    const order: LibraryStateFilter[] = [];
    let current: LibraryStateFilter = "all";
    for (let index = 0; index < 5; index += 1) {
      current = cycleLibraryStateFilter(current);
      order.push(current);
    }

    expect(order).toEqual(["no-job", "active", "completed", "failed", "all"]);
    expect(libraryStateFilterLabel("active")).toBe("em andamento");
    expect(libraryStateFilterLabel("all")).toBe("todos");
  });
});
