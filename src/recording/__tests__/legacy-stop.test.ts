import { expect, test } from "bun:test";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobRecord } from "../../jobs/types";
import { LEGACY_NOT_QUEUED, stopLegacyRecording } from "../legacy-stop";
import { clearState, readState, writeState } from "../state";

assertQaIsolation();

const legacy = { backend: "wf-recorder" as const, outputPath: "/synthetic/recordings/call.mkv", startedAt: "2026-10-06T10:00:00.000Z" };

test("a stopped legacy recording that cannot be queued is returned with the way to process it", async () => {
  await writeState(legacy);
  try {
    const result = await stopLegacyRecording(structuredClone(DEFAULT_CONFIG), {
      enqueue: async () => { throw new Error("ENOSPC: no space left on device"); }
    });
    // wf-recorder clears its state when it stops: stopping again could not retry the queueing.
    expect(await readState()).toBeNull();
    expect(result).toMatchObject({ videoPath: legacy.outputPath, job: null, warning: LEGACY_NOT_QUEUED });
  } finally {
    await clearState();
  }
});

test("a stopped legacy recording that is queued carries its job and no warning", async () => {
  await writeState(legacy);
  try {
    const job = { id: "123e4567-e89b-42d3-a456-426614174000" } as JobRecord;
    const result = await stopLegacyRecording(structuredClone(DEFAULT_CONFIG), { enqueue: async () => job });
    expect(result?.job).toBe(job);
    expect(result?.warning).toBeUndefined();
  } finally {
    await clearState();
  }
});
