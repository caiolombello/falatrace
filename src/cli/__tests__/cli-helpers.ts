import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "../../jobs/types";
import type { CliIO, Interrupt } from "../shared";

/** Collects what a command prints. */
export const captureIO = (): { io: CliIO; out: () => string; err: () => string } => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => { out.push(text); }, err: (text) => { err.push(text); } }, out: () => out.join(""), err: () => err.join("") };
};

/** An interrupt the test triggers by hand. */
export const manualInterrupt = (): { interrupt: () => Interrupt; fire: () => void; disposed: () => number } => {
  const controller = new AbortController();
  let disposed = 0;
  return { interrupt: () => ({ signal: controller.signal, dispose: () => { disposed += 1; } }), fire: () => controller.abort(), disposed: () => disposed };
};

export const tempRoot = (prefix: string): Promise<string> => fs.mkdtemp(join(tmpdir(), prefix));

/** A job store with only the jobs given; others are missing (ENOENT) like the real store. */
export const fakeJobs = (jobs: Array<Partial<JobRecord> & { id: string }>): { get(id: string): Promise<JobRecord> } => ({
  get: async (id) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) throw Object.assign(new Error(`ENOENT: ${id}`), { code: "ENOENT" });
    return job as JobRecord;
  }
});
