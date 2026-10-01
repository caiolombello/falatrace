import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateJobId } from "../jobs/types";
import { writeJsonAtomic } from "../jobs/store";
import type { CanonicalAlignment } from "./alignment";
import { DIARIZATION_MODEL, type DiarizationTurn } from "./openai";

const SHA256 = /^[a-f0-9]{64}$/;
const SPEAKER = /^S\d{2,4}$/;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
export type DiarizationResult = {
  version: 1; jobId: string; mediaSha256: string; transcriptSha256: string;
  provider: "openai"; model: string; generatedAt: string; duration: number;
  labels: Record<string, string>; acousticValidation: "pending";
  ignoredZeroDurationTurns?: number;
  ignoredEmptyTextTurns?: number;
  audioEncoding?: { codec: "opus"; sampleRate: number; channels: number; targetBitrate: number; rateControl: "vbr" | "cbr" };
  turns: DiarizationTurn[]; alignment: CanonicalAlignment;
};
export type DiarizationStatus = { state: "idle" | "running" | "ready" | "review" | "failed"; message?: string; speakerCount?: number; matchedTokenRatio?: number };
export type DiarizationOperation = { version: 1; jobId: string; state: "running" | "failed"; startedAt: string; message?: string };

export const transcriptChecksum = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const validSpeakerLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);

export const validateDiarizationResult = (value: unknown): DiarizationResult => {
  if (!value || typeof value !== "object") throw new Error("Diarização inválida");
  const result = value as DiarizationResult;
  validateJobId(result.jobId);
  if (result.version !== 1 || !SHA256.test(result.mediaSha256) || !SHA256.test(result.transcriptSha256) ||
    result.provider !== "openai" || result.model !== DIARIZATION_MODEL || result.acousticValidation !== "pending" ||
    typeof result.generatedAt !== "string" || !Number.isFinite(Date.parse(result.generatedAt)) ||
    !Number.isFinite(result.duration) || result.duration <= 0 ||
    !result.labels || typeof result.labels !== "object" || Array.isArray(result.labels) ||
    !Array.isArray(result.turns) || !result.turns.length || result.turns.length > 100_000) throw new Error("Diarização inválida");
  const labels = Object.entries(result.labels);
  for (const count of [result.ignoredZeroDurationTurns, result.ignoredEmptyTextTurns]) if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 100_000)) throw new Error("Normalização de falas inválida");
  if (result.audioEncoding && (result.audioEncoding.codec !== "opus" || result.audioEncoding.sampleRate !== 24000 || result.audioEncoding.channels !== 1 || ![40000, 48000].includes(result.audioEncoding.targetBitrate) || !["vbr", "cbr"].includes(result.audioEncoding.rateControl))) throw new Error("Perfil de áudio inválido");
  if (!labels.length || labels.length > 100 || labels.some(([id, label]) => !SPEAKER.test(id) || !validSpeakerLabel(label))) throw new Error("Falantes inválidos");
  const safeRange = (item: { start: number; end: number }): boolean =>
    Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end >= item.start && item.end <= result.duration + 1;
  for (const turn of result.turns) {
    if (!turn || !safeRange(turn) || turn.end === turn.start || !Object.prototype.hasOwnProperty.call(result.labels, turn.speaker) || typeof turn.text !== "string" || turn.text.length > 10_000) throw new Error("Fala inválida");
  }
  const alignment = result.alignment;
  if (!alignment || typeof alignment.text !== "string" || alignment.text.length > 10_000_000 ||
    transcriptChecksum(alignment.text) !== result.transcriptSha256 ||
    !Number.isFinite(alignment.matchedTokenRatio) || alignment.matchedTokenRatio < 0 || alignment.matchedTokenRatio > 1 ||
    !Number.isSafeInteger(alignment.unassignedTokenCount) || alignment.unassignedTokenCount < 0 ||
    !Array.isArray(alignment.segments) || alignment.segments.length > 100_000) throw new Error("Alinhamento inválido");
  let offset = 0;
  for (const segment of alignment.segments) {
    if (!segment || !safeRange(segment) || !Number.isSafeInteger(segment.charStart) || !Number.isSafeInteger(segment.charEnd) ||
      segment.charStart !== offset || segment.charEnd <= segment.charStart || segment.charEnd > alignment.text.length ||
      segment.text !== alignment.text.slice(segment.charStart, segment.charEnd) ||
      (segment.speaker !== undefined && !Object.prototype.hasOwnProperty.call(result.labels, segment.speaker)) ||
      (segment.reviewRequired !== undefined && typeof segment.reviewRequired !== "boolean")) throw new Error("Trecho alinhado inválido");
    offset = segment.charEnd;
  }
  if (offset !== alignment.text.length) throw new Error("O alinhamento não preservou todo o texto");
  return result;
};

export class DiarizationStore {
  constructor(readonly root = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "recording-cli", "diarization")) {}
  async ensureRoot(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(this.root) !== resolve(this.root)) throw new Error("Diretório de diarização inseguro");
    return this.root;
  }
  resultPath(id: string): string { return join(this.root, `${validateJobId(id)}.json`); }
  private async readJson(path: string): Promise<unknown> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error("Arquivo de diarização inválido");
    return JSON.parse(await fs.readFile(path, "utf8"));
  }
  async read(id: string, mediaSha256: string, canonicalText: string): Promise<DiarizationResult | undefined> {
    const path = this.resultPath(id);
    try {
      const result = validateDiarizationResult(await this.readJson(path));
      return result.jobId === id && result.mediaSha256 === mediaSha256 && result.transcriptSha256 === transcriptChecksum(canonicalText) ? result : undefined;
    } catch { return undefined; }
  }
  async save(result: DiarizationResult): Promise<void> {
    validateDiarizationResult(result);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_BYTES) throw new Error("Diarização excedeu o limite permitido");
    await this.ensureRoot();
    await writeJsonAtomic(this.resultPath(result.jobId), result);
  }
  async readOperation(id: string): Promise<DiarizationOperation | undefined> {
    const path = join(this.root, `${validateJobId(id)}.state.json`);
    try {
      const value = await this.readJson(path) as DiarizationOperation;
      if (value?.version !== 1 || value.jobId !== id || !["running", "failed"].includes(value.state) || !Number.isFinite(Date.parse(value.startedAt)) ||
        (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500 || /[\x00-\x1f\x7f]/.test(value.message)))) return undefined;
      return value;
    } catch { return undefined; }
  }
  async writeOperation(operation: DiarizationOperation): Promise<void> {
    await this.ensureRoot();
    await writeJsonAtomic(join(this.root, `${validateJobId(operation.jobId)}.state.json`), operation);
  }
}
