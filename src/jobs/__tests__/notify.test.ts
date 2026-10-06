import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { notifyJobOutcome } from "../notify";
import type { JobRecord } from "../types";

const job = (state: JobRecord["state"]) => ({
  id: "123e4567-e89b-42d3-a456-426614174000", state,
  sourcePath: "/home/u/Videos/Recordings/2026-10-05_14-30_daily-123e4567/recording.mka"
}) as JobRecord;

test("finished and failed jobs notify with the folder name only", async () => {
  const runs: string[][] = [];
  const run = async (command: string, args: string[]) => { runs.push([command, ...args]); return { stdout: "", stderr: "" }; };
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), run as never);
  await notifyJobOutcome(DEFAULT_CONFIG, job("failed"), run as never);
  await notifyJobOutcome(DEFAULT_CONFIG, job("pending"), run as never);
  expect(runs).toHaveLength(2);
  expect(runs[0].slice(-2)).toEqual(["Gravação processada", "2026-10-05_14-30_daily-123e4567: transcrição e resumo prontos no FalaTrace Studio."]);
  expect(runs[1].slice(-2)[0]).toBe("Processamento falhou");
  expect(runs[0]).toContain("notify-send");
});

test("notifications can be turned off and their failures never break processing", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.processing.notifyOnCompletion = false;
  let calls = 0;
  await notifyJobOutcome(config, job("completed"), (async () => { calls += 1; return { stdout: "", stderr: "" }; }) as never);
  expect(calls).toBe(0);
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), (async () => { throw new Error("no session bus"); }) as never);
});
