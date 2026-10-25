import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { notifyJobOutcome, readyJobDetails } from "../notify";
import type { JobRecord } from "../types";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const job = (state: JobRecord["state"]) => ({
  id: ID, state,
  sourcePath: "/home/u/Videos/Recordings/2026-10-05_14-30_daily-123e4567/recording.mka"
}) as JobRecord;

/** A runner whose notify-send knows buttons (`--action`) or not (libnotify 0.7.9). */
const runner = (actions: boolean) => {
  const runs: string[][] = [];
  const run = async (command: string, args: string[]) => {
    runs.push([command, ...args]);
    if (command === "notify-send" && args[0] === "--help") return { stdout: actions ? "  -A, --action=[NAME=]Text...\n" : "  -u, --urgency=LEVEL\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, runs, systemdRuns: () => runs.filter((call) => call[0].endsWith("systemd-run")) };
};

test("without notification buttons, finished and failed jobs notify with the folder name only, as before", async () => {
  const { run, systemdRuns } = runner(false);
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), run as never);
  await notifyJobOutcome(DEFAULT_CONFIG, job("failed"), run as never);
  await notifyJobOutcome(DEFAULT_CONFIG, job("pending"), run as never);
  const runs = systemdRuns();
  expect(runs).toHaveLength(2);
  expect(runs[0].slice(-2)).toEqual(["Gravação processada", "2026-10-05_14-30_daily-123e4567: transcrição e resumo prontos no FalaTrace Studio."]);
  expect(runs[1].slice(-2)[0]).toBe("Processamento falhou");
  expect(runs[0]).toContain("notify-send");
});

test("with buttons, a finished job starts the clickable 'notes ready' helper without waiting; a failure stays a plain notice", async () => {
  const { run, systemdRuns } = runner(true);
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), run as never);
  await notifyJobOutcome(DEFAULT_CONFIG, job("failed"), run as never);
  const [ready, failed] = systemdRuns();
  expect(ready).toContain(`--unit=recording-cli-ready-${ID}`);
  expect(ready).not.toContain("--wait");
  expect(ready.slice(-4)).toEqual(["notify", "ready", "--job", ID]);
  expect(failed.slice(-2)[0]).toBe("Processamento falhou");
});

test("a helper that cannot start falls back to the plain notice; notifications can be turned off and never break processing", async () => {
  const runs: string[][] = [];
  const failingHelper = async (command: string, args: string[]) => {
    runs.push([command, ...args]);
    if (command === "notify-send") return { stdout: "--action", stderr: "" };
    if (args.some((arg) => arg.startsWith("--unit=recording-cli-ready-"))) throw new Error("systemd-run failed with code 1: no bus");
    return { stdout: "", stderr: "" };
  };
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), failingHelper as never);
  expect(runs[runs.length - 1].slice(-2)[0]).toBe("Gravação processada");
  const config = structuredClone(DEFAULT_CONFIG);
  config.processing.notifyOnCompletion = false;
  let calls = 0;
  await notifyJobOutcome(config, job("completed"), (async () => { calls += 1; return { stdout: "", stderr: "" }; }) as never);
  expect(calls).toBe(0);
  await notifyJobOutcome(DEFAULT_CONFIG, job("completed"), (async () => { throw new Error("no session bus"); }) as never);
});

test("the notice's title and counts come from the job: calendar title first, then the summary's", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-ready-"));
  try {
    const record = { ...job("completed"), artifactDir: root, summary: { provider: "ollama", model: "m", context: { meeting: { title: "Planejamento Q4" } } } } as unknown as JobRecord;
    const store = { get: async (id: string) => { expect(id).toBe(ID); return record; } };
    expect(await readyJobDetails(ID, store as never)).toEqual({ title: "Planejamento Q4" });
    await fs.writeFile(join(root, "summary.json"), JSON.stringify({ title: "Resumo do modelo", actionItems: [{}, {}, {}], decisions: ["a"] }));
    expect(await readyJobDetails(ID, store as never)).toEqual({ title: "Planejamento Q4", actions: 3, decisions: 1 });
    const untitled = { ...record, summary: { provider: "ollama", model: "m" } } as unknown as JobRecord;
    expect(await readyJobDetails(ID, { get: async () => untitled } as never)).toEqual({ title: "Resumo do modelo", actions: 3, decisions: 1 });
    await fs.writeFile(join(root, "summary.json"), "not json");
    expect(await readyJobDetails(ID, { get: async () => untitled } as never)).toEqual({ title: "2026-10-05_14-30_daily-123e4567" });
    await expect(readyJobDetails("../x", store as never)).rejects.toThrow("Invalid job id");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
