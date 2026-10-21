import { promises as fs } from "node:fs";
import { join } from "node:path";
import { validateJobId } from "../jobs/types";
import { writeJsonAtomic } from "../jobs/store";
import { DiarizationStore, validSpeakerLabel } from "../diarization/store";
import type { MicrophoneReason, SpeakerMicrophoneShare } from "./microphone";
import type { ConversationSuggestion } from "./conversation";

// Suggestions live beside the diarization they describe and bind to its exact file
// hash: a new diarization makes them stale. They never change a label by themselves;
// applying one is an ordinary human revision.

const SHA256 = /^[a-f0-9]{64}$/;
const SPEAKER = /^S\d{2,4}$/;
const TURN = /^t\d{6}$/;
const MAX_BYTES = 2 * 1024 * 1024;

export type MicrophoneRecord = { generatedAt: string } & (
  | { state: "ready"; layout: "titled" | "ordered"; selfSpeakers: string[]; selfName?: string; speakers: SpeakerMicrophoneShare[]; reason?: Extract<MicrophoneReason, "no-desktop-audio" | "no-microphone-speech" | "no-match" | "ambiguous"> }
  | { state: "unavailable"; reason: Extract<MicrophoneReason, "no-separate-tracks" | "unrecognized-tracks"> }
  | { state: "failed"; message: string }
);
export type ConversationRecord = { generatedAt: string; provider: "openai" | "ollama"; model: string; endpoint: string; external: boolean } & (
  | { state: "ready"; partial: boolean; sentTurns: number; totalTurns: number; inputBytes: number; suggestions: ConversationSuggestion[]; participants?: number }
  | { state: "failed"; message: string }
);
/** Whether computing this recording's voice signatures failed; the signatures live in their own file. */
export type VoiceStatusRecord = { generatedAt: string; state: "ready" | "failed"; message?: string };
export type SpeakerSuggestionRecord = {
  version: 1; jobId: string; mediaSha256: string; transcriptSha256: string; diarizationSha256: string;
  microphone?: MicrophoneRecord; conversation?: ConversationRecord; voice?: VoiceStatusRecord;
};
export type SpeakerSuggestionBinding = Pick<SpeakerSuggestionRecord, "jobId" | "mediaSha256" | "transcriptSha256" | "diarizationSha256">;
export type SpeakerSuggestionOperation = { version: 1; jobId: string; state: "running" | "failed"; startedAt: string; conversation: boolean; message?: string };

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/\p{Cc}/u.test(value);
const date = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400;

const validMicrophone = (value: unknown): value is MicrophoneRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!date(record.generatedAt)) return false;
  if (record.state === "failed") return text(record.message, 500);
  if (record.state === "unavailable") return ["no-separate-tracks", "unrecognized-tracks"].includes(record.reason as string);
  if (record.state !== "ready" || !["titled", "ordered"].includes(record.layout as string)) return false;
  if (record.reason !== undefined && !["no-desktop-audio", "no-microphone-speech", "no-match", "ambiguous"].includes(record.reason as string)) return false;
  if (record.selfName !== undefined && !validSpeakerLabel(record.selfName)) return false;
  if (!Array.isArray(record.selfSpeakers) || record.selfSpeakers.length > 2 || record.selfSpeakers.some((id) => typeof id !== "string" || !SPEAKER.test(id))) return false;
  return Array.isArray(record.speakers) && record.speakers.length <= 100 && record.speakers.every((item) => {
    const share = item as Record<string, unknown> | null;
    return !!share && typeof share.speakerId === "string" && SPEAKER.test(share.speakerId) && seconds(share.localSeconds) && seconds(share.remoteSeconds) &&
      typeof share.localShare === "number" && share.localShare >= 0 && share.localShare <= 1;
  });
};

const validConversation = (value: unknown): value is ConversationRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!date(record.generatedAt) || !["openai", "ollama"].includes(record.provider as string) || !text(record.model, 200) || !text(record.endpoint, 300) || typeof record.external !== "boolean") return false;
  if (record.state === "failed") return text(record.message, 500);
  if (record.state !== "ready" || typeof record.partial !== "boolean" || !count(record.sentTurns) || !count(record.totalTurns) || !count(record.inputBytes) ||
    (record.participants !== undefined && (!count(record.participants) || (record.participants as number) > 50))) return false;
  return Array.isArray(record.suggestions) && record.suggestions.length <= 100 && record.suggestions.every((item) => {
    const suggestion = item as Record<string, unknown> | null;
    return !!suggestion && typeof suggestion.speakerId === "string" && SPEAKER.test(suggestion.speakerId) && validSpeakerLabel(suggestion.name) &&
      Array.isArray(suggestion.evidence) && suggestion.evidence.length >= 1 && suggestion.evidence.length <= 3 &&
      suggestion.evidence.every((entry) => !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).turnId === "string" &&
        TURN.test((entry as Record<string, string>).turnId) && text((entry as Record<string, unknown>).quote, 200));
  });
};

export const validateSpeakerSuggestionRecord = (value: unknown): SpeakerSuggestionRecord => {
  const record = value as SpeakerSuggestionRecord;
  if (!record || typeof record !== "object" || record.version !== 1) throw new Error("Sugestões de falantes inválidas");
  validateJobId(record.jobId);
  if (![record.mediaSha256, record.transcriptSha256, record.diarizationSha256].every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
    (record.microphone !== undefined && !validMicrophone(record.microphone)) ||
    (record.conversation !== undefined && !validConversation(record.conversation)) ||
    (record.voice !== undefined && (!record.voice || !date(record.voice.generatedAt) || !["ready", "failed"].includes(record.voice.state) ||
      (record.voice.message !== undefined && !text(record.voice.message, 500))))) throw new Error("Sugestões de falantes inválidas");
  return record;
};

export class SpeakerSuggestionStore {
  readonly diarization: DiarizationStore;
  constructor(diarization = new DiarizationStore()) { this.diarization = diarization; }
  get root(): string { return this.diarization.root; }
  path(id: string): string { return join(this.root, `${validateJobId(id)}.speakers.json`); }
  operationPath(id: string): string { return join(this.root, `${validateJobId(id)}.speakers.state.json`); }
  private async readJson(path: string): Promise<unknown> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("Arquivo de sugestões inválido");
    return JSON.parse(await fs.readFile(path, "utf8"));
  }
  /** Returns the record only when it describes this exact diarization. */
  async read(binding: SpeakerSuggestionBinding): Promise<SpeakerSuggestionRecord | undefined> {
    try {
      const record = validateSpeakerSuggestionRecord(await this.readJson(this.path(binding.jobId)));
      return record.jobId === binding.jobId && record.mediaSha256 === binding.mediaSha256 && record.transcriptSha256 === binding.transcriptSha256 &&
        record.diarizationSha256 === binding.diarizationSha256 ? record : undefined;
    } catch { return undefined; }
  }
  async save(record: SpeakerSuggestionRecord): Promise<void> {
    validateSpeakerSuggestionRecord(record);
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new Error("Sugestões de falantes excederam o limite permitido");
    await this.diarization.ensureRoot();
    await writeJsonAtomic(this.path(record.jobId), record);
  }
  async readOperation(id: string): Promise<SpeakerSuggestionOperation | undefined> {
    try {
      const value = await this.readJson(this.operationPath(id)) as SpeakerSuggestionOperation;
      if (value?.version !== 1 || value.jobId !== id || !["running", "failed"].includes(value.state) || !date(value.startedAt) ||
        typeof value.conversation !== "boolean" || (value.message !== undefined && !text(value.message, 500))) return undefined;
      return value;
    } catch { return undefined; }
  }
  async writeOperation(operation: SpeakerSuggestionOperation): Promise<void> {
    await this.diarization.ensureRoot();
    await writeJsonAtomic(this.operationPath(operation.jobId), operation);
  }
  async clearOperation(id: string): Promise<void> { await fs.rm(this.operationPath(id), { force: true }); }
}
