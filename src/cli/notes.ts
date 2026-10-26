import { JobStore } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { findNotesForJob, type MeetingNotes, NOTE_LIMITS, NotesStore, normalizeNotesId, notesText } from "../notes";
import { NOTES_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, integerOption, parseArgs, printJson, processIO, readStdinText } from "./shared";

export { NOTES_HELP };

export type NotesCliDeps = {
  io: CliIO;
  store: () => NotesStore;
  jobs: () => { get(id: string): Promise<JobRecord> };
  /** Notes of a job found by its recording file (a capture's notes saved under the capture id). */
  findForJob: (job: JobRecord, store: NotesStore) => Promise<MeetingNotes | undefined>;
  readStdin: () => Promise<string>;
};

export const defaultNotesCliDeps = (): NotesCliDeps => ({
  io: processIO,
  store: () => new NotesStore(),
  jobs: () => new JobStore(),
  findForJob: (job, store) => findNotesForJob(job, store),
  // The notepad text may carry trailing blank lines; the store splits it into lines anyway.
  readStdin: () => {
    if (process.stdin.isTTY) process.stderr.write(`${CLI_MESSAGES.notesStdinHint}\n`);
    return readStdinText(NOTE_LIMITS.maxInputChars * 4);
  }
});

type Target = { id: string; notes?: MeetingNotes; job?: JobRecord };

const missingJob = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Which notes an id means: the notes saved under it (a capture id or a job id), else the notes of
 * that job's recording (saved under the capture id), else new notes for that job.
 */
const resolveTarget = async (rawId: string | undefined, deps: NotesCliDeps, store: NotesStore): Promise<Target> => {
  if (!rawId) throw new Error(CLI_USAGE.notes);
  const id = normalizeNotesId(rawId);
  const own = await store.read(id);
  if (own) return { id, notes: own };
  let job: JobRecord | undefined;
  try { job = await deps.jobs().get(id); } catch (error) { if (!missingJob(error)) throw error; }
  if (!job) return { id };
  const found = await deps.findForJob(job, store);
  return found ? { id: found.id, notes: found, job } : { id, job };
};

export const runNotesCli = async (args: string[], deps: NotesCliDeps = defaultNotesCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(NOTES_HELP); return; }
  const store = deps.store();
  if (subcommand === "show") {
    const parsed = parseArgs(rest, { flags: ["--json"] });
    const target = await resolveTarget(parsed.positionals[0], deps, store);
    if (parsed.flags.has("--json")) { printJson(io, target.notes ?? null); return; }
    const text = notesText(target.notes);
    io.out(text ? `${text}\n` : "");
    return;
  }
  if (subcommand === "path") {
    const parsed = parseArgs(rest);
    const target = await resolveTarget(parsed.positionals[0], deps, store);
    io.out(`${store.pathFor(target.id)}\n`);
    return;
  }
  if (subcommand === "edit") {
    const parsed = parseArgs(rest, { values: ["--rev"] });
    const expected = integerOption(parsed, "--rev", 0, Number.MAX_SAFE_INTEGER, CLI_MESSAGES.revInvalid);
    const target = await resolveTarget(parsed.positionals[0], deps, store);
    // Read before saving: the revision check then catches a Studio save made while the text was typed.
    const text = await deps.readStdin();
    const saved = await store.save(target.id, {
      text,
      expectedRev: expected ?? target.notes?.rev ?? 0,
      // Notes added after processing belong to the job's recording, so later jobs of the same file find them.
      ...(!target.notes?.sourcePath && target.job?.sourcePath ? { sourcePath: target.job.sourcePath } : {})
    });
    const output = notesText(saved);
    io.out(output ? `${output}\n` : "");
    return;
  }
  throw new Error(CLI_USAGE.notes);
};
