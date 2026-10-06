import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import type {
  AppConfig,
  ExecutionTarget,
  SummaryProvider,
  TranscriptionProvider
} from "../config/defaults";
import { TRANSCRIPTION_PROMPT_MAX_LENGTH } from "../config/defaults";
import {
  buildTranscriptionContextPrompt,
  buildTranscriptionKeywords,
  loadTimesheetContext
} from "../timesheet/context";
import { buildSummaryClientHints } from "../summary/context";
import { acquireSingleton } from "../runtime/singleton";
import {
  JOB_VERSION,
  type JobManifest,
  type JobRecord,
  type JobState,
  type MeetingContext,
  validateJobId,
  validateJobRecord,
  validateMediaExtension
} from "./types";

const getXdgPath = (environmentName: string, fallback: string): string =>
  process.env[environmentName] || join(homedir(), fallback);

export const getDefaultJobStateDir = (): string =>
  join(getXdgPath("XDG_STATE_HOME", ".local/state"), "recording-cli", "jobs");

export const getDefaultJobDataDir = (): string =>
  join(getXdgPath("XDG_DATA_HOME", ".local/share"), "recording-cli", "jobs");

export const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolvePromise);
  });
  return hash.digest("hex");
};

export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, path);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export type EnqueueOptions = {
  recordingId?: string;
  /** The SHA-256 the person consented to; a source with other bytes is refused before any job exists. */
  expectedSha256?: string;
  target?: ExecutionTarget;
  transcriptionProvider?: TranscriptionProvider;
  summaryProvider?: SummaryProvider;
  meetingContext?: MeetingContext;
};

export const mergeTranscriptionPrompt = (
  configuredPrompt: string,
  contextPrompt: string
): string => {
  const parts = [configuredPrompt.trim(), contextPrompt.trim()].filter(Boolean);
  return parts.join("\n\n").slice(0, TRANSCRIPTION_PROMPT_MAX_LENGTH);
};

export class JobStore {
  constructor(
    readonly stateDir = getDefaultJobStateDir(),
    readonly dataDir = getDefaultJobDataDir()
  ) {}

  async enqueue(config: AppConfig, filePath: string, options: EnqueueOptions = {}): Promise<JobRecord> {
    if (!options.recordingId) return this.createJob(config, filePath, options);
    validateJobId(options.recordingId);
    const lockKey = createHash("sha256").update(`${this.stateDir}:${options.recordingId}`).digest("hex").slice(0, 32);
    const lease = await acquireSingleton(`enqueue-${lockKey}`);
    try {
      const existing = await this.get(options.recordingId).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (existing) {
        if (existing.sourcePath !== resolve(filePath) || existing.source.sha256 !== await hashFile(filePath)) {
          throw new Error("Recording id already belongs to different media");
        }
        await fs.mkdir(this.getWorkDir(existing.id), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(join(this.getWorkDir(existing.id), "manifest.json"), this.toManifest(existing));
        return existing;
      }
      return await this.createJob(config, filePath, options);
    } finally {
      await lease.release();
    }
  }

  private async createJob(config: AppConfig, filePath: string, options: EnqueueOptions): Promise<JobRecord> {
    const sourcePath = resolve(filePath);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("Recording source must be a non-empty regular file");
    }
    const extension = validateMediaExtension(sourcePath);
    const id = options.recordingId || randomUUID();
    const now = new Date().toISOString();
    const target = options.target || config.processing.defaultTarget;
    const transcriptionProvider = options.transcriptionProvider || config.transcription.provider;
    const summaryProvider = options.summaryProvider || config.summary.provider;
    const timesheetContext = config.timesheet.enabled
      ? await loadTimesheetContext(config).catch(() => undefined)
      : undefined;
    const contextPrompt =
      timesheetContext && transcriptionProvider === "openai"
        ? buildTranscriptionContextPrompt(timesheetContext)
        : "";
    const meetingPrompt = options.meetingContext
      ? `Título provável do evento de calendário: ${JSON.stringify(options.meetingContext.title)}.`
      : "";
    const summaryClients = timesheetContext
      ? buildSummaryClientHints(timesheetContext)
      : [];
    const transcriptionPrompt = mergeTranscriptionPrompt(
      config.transcription.openaiPrompt,
      [meetingPrompt, contextPrompt].filter(Boolean).join("\n")
    );
    const gptTranscribe =
      transcriptionProvider === "openai" &&
      config.transcription.openaiModel === "gpt-transcribe";
    const transcriptionKeywords =
      gptTranscribe && timesheetContext
        ? buildTranscriptionKeywords(timesheetContext)
        : [];
    const artifactDir = join(dirname(sourcePath), `${parse(sourcePath).name}.recording`, id);
    const sha256 = await hashFile(sourcePath);
    if (options.expectedSha256 && sha256 !== options.expectedSha256) {
      throw new Error("A gravação ou as configurações mudaram. Revise o destino de novo.");
    }
    const verifiedStat = await fs.stat(sourcePath);
    if (!verifiedStat.isFile() || verifiedStat.size !== stat.size) {
      throw new Error("Recording source changed while the job was being created");
    }
    const record: JobRecord = {
      version: JOB_VERSION,
      id,
      createdAt: now,
      source: {
        originalName: basename(sourcePath),
        mediaFile: `source${extension}`,
        size: stat.size,
        sha256
      },
      transcription: {
        provider: transcriptionProvider,
        model:
          transcriptionProvider === "openai"
            ? config.transcription.openaiModel
            : transcriptionProvider === "gemini"
              ? config.transcription.geminiModel
              : basename(config.transcription.whisperCpp.modelPath),
        language: config.transcription.language,
        ...(gptTranscribe && config.transcription.expectedLanguages.length > 0
          ? { languages: config.transcription.expectedLanguages }
          : {}),
        ...(transcriptionKeywords.length > 0
          ? { keywords: transcriptionKeywords }
          : {}),
        ...(transcriptionProvider === "openai" && transcriptionPrompt
          ? { prompt: transcriptionPrompt }
          : {})
      },
      summary: {
        provider: summaryProvider,
        model: summaryProvider === "openai" ? config.summary.openaiModel : config.summary.ollamaModel,
        ...(options.meetingContext || summaryClients.length > 0
          ? {
              context: {
                ...(options.meetingContext
                  ? { meeting: options.meetingContext }
                  : {}),
                ...(summaryClients.length > 0
                  ? { clients: summaryClients }
                  : {})
              }
            }
          : {})
      },
      sourcePath,
      artifactDir,
      target,
      state: "pending",
      updatedAt: now
    };
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(join(this.dataDir, id), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.dataDir, id, "manifest.json"), this.toManifest(record));
    await this.write(record);
    return record;
  }

  async get(id: string): Promise<JobRecord> {
    validateJobId(id);
    const raw = await fs.readFile(join(this.stateDir, `${id}.json`), "utf-8");
    return validateJobRecord(JSON.parse(raw));
  }

  async list(): Promise<JobRecord[]> {
    try {
      const names = (await fs.readdir(this.stateDir)).filter((name) => name.endsWith(".json"));
      const records = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async update(id: string, state: JobState, changes: Pick<JobRecord, "error"> = {}): Promise<JobRecord> {
    const record = await this.get(id);
    const updated: JobRecord = {
      ...record,
      state,
      updatedAt: new Date().toISOString(),
      error: changes.error
    };
    await this.write(updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    validateJobId(id);
    await fs.rm(join(this.dataDir, id), { recursive: true, force: true });
    await fs.rm(join(this.stateDir, `${id}.json`), { force: true });
  }

  async removeWorkData(id: string): Promise<void> {
    await fs.rm(join(this.dataDir, validateJobId(id)), { recursive: true, force: true });
  }

  getWorkDir(id: string): string {
    return join(this.dataDir, validateJobId(id));
  }

  toManifest(record: JobRecord): JobManifest {
    return {
      version: record.version,
      id: record.id,
      createdAt: record.createdAt,
      source: record.source,
      transcription: record.transcription,
      summary: record.summary
    };
  }

  private async write(record: JobRecord): Promise<void> {
    await writeJsonAtomic(join(this.stateDir, `${record.id}.json`), record);
  }
}
