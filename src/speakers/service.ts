import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { JobStore, hashFile } from "../jobs/store";
import { runCommand } from "../jobs/command";
import { type JobRecord, type Transcript, validateJobId } from "../jobs/types";
import { buildLibrary } from "../tui/library";
import { playLibraryEntry } from "../tui/media";
import { acquireSingleton } from "../runtime/singleton";
import { withHeavyAdmission, cliAdmissionWait } from "../runtime/heavy-admission";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { transientCommand, transientUnitEnvironment } from "../runtime/systemd-units";
import { readCanonicalTranscript } from "../diarization/service";
import type { DiarizationResult } from "../diarization/store";
import {
  OPENAI_CONVERSATION_INPUT_BYTES, buildConversationInput, completeWithConfiguredModel, conversationDestination, destinationKey,
  suggestFromConversation, type ConversationComplete, type ConversationEvidence, type ConversationSpeaker, type ConversationTurn
} from "./conversation";
import { buildMicrophoneRecord, readDiarizationContext, type DiarizationContext, type MicrophoneDependencies } from "./record";
import { SpeakerSuggestionStore, type ConversationRecord, type MicrophoneRecord, type SpeakerSuggestionRecord } from "./store";
import { SPEAKER_MESSAGES, safeSpeakerMessage } from "./messages";

const SHA256 = /^[a-f0-9]{64}$/;
export const speakerSuggestionUnit = (id: string): string => `recording-cli-speakers-${validateJobId(id)}.service`;
const unitActive = async (id: string, run: typeof runCommand = runCommand): Promise<boolean> => {
  const result = await run("systemctl", ["--user", "show", speakerSuggestionUnit(id), "--property=ActiveState"], { timeoutMs: 5000 }).catch(() => ({ stdout: "" }));
  return /^ActiveState=(active|activating)$/m.test(result.stdout);
};

/** Turn IDs follow the reviewed view (tNNNNNN by diarizer order), so evidence can be found in the Studio. */
export const conversationTurns = (result: DiarizationResult): ConversationTurn[] =>
  result.turns.map((turn, index) => ({ id: `t${String(index).padStart(6, "0")}`, speaker: turn.speaker, text: turn.text }));

export type SpeakerSuggestionDependencies = {
  getJob?: (id: string) => Promise<JobRecord>;
  readCanonical?: (job: JobRecord) => Promise<Transcript>;
  store?: SpeakerSuggestionStore;
  /** Resolves and verifies the original media; defaults to the library lookup the diarizer uses. */
  mediaPath?: (config: AppConfig, job: JobRecord) => Promise<string>;
  microphone?: MicrophoneDependencies;
  complete?: ConversationComplete;
  unitActive?: (id: string) => Promise<boolean>;
  run?: typeof runCommand;
};
export type SuggestOptions = { conversation?: boolean; consentKey?: string; signal?: AbortSignal };

const localMediaPath = async (config: AppConfig, job: JobRecord): Promise<string> => {
  const entry = (await buildLibrary(config)).find((item) => item.sourcePath === job.sourcePath);
  if (!entry) throw new Error(SPEAKER_MESSAGES.mediaUnavailable);
  const media = await playLibraryEntry(config, entry, job, { launch: async () => undefined });
  const stat = await fs.lstat(media.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.source.size || await hashFile(media.path) !== job.source.sha256) throw new Error(SPEAKER_MESSAGES.mediaChanged);
  return media.path;
};

const microphoneFor = async (config: AppConfig, job: JobRecord, context: DiarizationContext, store: SpeakerSuggestionStore, dependencies: SpeakerSuggestionDependencies): Promise<MicrophoneRecord> => {
  let path: string;
  try { path = await (dependencies.mediaPath || localMediaPath)(config, job); }
  catch (error) { return { generatedAt: new Date().toISOString(), state: "failed", message: safeSpeakerMessage(error, SPEAKER_MESSAGES.mediaUnavailable) }; }
  await store.diarization.ensureRoot();
  return buildMicrophoneRecord(path, context.result.turns, store.root, dependencies.microphone);
};

const conversationFor = async (
  config: AppConfig, context: DiarizationContext, microphone: MicrophoneRecord | undefined, dependencies: SpeakerSuggestionDependencies, signal?: AbortSignal
): Promise<ConversationRecord> => {
  const destination = conversationDestination(config);
  const base = { generatedAt: new Date().toISOString(), provider: destination.provider, model: destination.model, endpoint: destination.endpoint, external: destination.external };
  const self = microphone?.state === "ready" ? new Set(microphone.selfSpeakers) : new Set<string>();
  const selfName = microphone?.state === "ready" ? microphone.selfName : undefined;
  const speakers: ConversationSpeaker[] = Object.keys(context.result.labels).sort().map((id) => ({ id, ...(self.has(id) && selfName ? { knownAs: selfName } : {}) }));
  const turns = conversationTurns(context.result);
  try {
    const budget = destination.provider === "openai" ? { max: OPENAI_CONVERSATION_INPUT_BYTES, unit: "utf8-bytes" as const } : { max: config.summary.maxInputCharacters, unit: "characters" as const };
    const input = buildConversationInput(turns, speakers, budget);
    const suggestions = await suggestFromConversation(destination, input, turns, speakers, dependencies.complete || completeWithConfiguredModel(config), signal);
    return { ...base, state: "ready", partial: input.partial, sentTurns: input.sentTurns, totalTurns: input.totalTurns, inputBytes: input.bytes, suggestions };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...base, state: "failed", message: safeSpeakerMessage(error) };
  }
};

const suggestOwned = async (config: AppConfig, id: string, options: SuggestOptions, dependencies: SpeakerSuggestionDependencies): Promise<SpeakerSuggestionRecord> => {
  validateJobId(id);
  const lease = await acquireSingleton(`speakers-${id}`);
  const store = dependencies.store || new SpeakerSuggestionStore();
  const startedAt = new Date().toISOString();
  try {
    const job = await (dependencies.getJob || ((jobId) => new JobStore().get(jobId)))(id);
    const canonical = await (dependencies.readCanonical || readCanonicalTranscript)(job);
    const context = await readDiarizationContext(job, canonical, store.diarization);
    if (!context) throw new Error(SPEAKER_MESSAGES.needsDiarization);
    if (options.conversation && options.consentKey !== undefined && options.consentKey !== destinationKey(conversationDestination(config))) throw new Error(SPEAKER_MESSAGES.destinationChanged);
    await store.writeOperation({ version: 1, jobId: id, state: "running", startedAt, conversation: !!options.conversation });
    const existing = await store.read(context.binding);
    const microphone = existing?.microphone && existing.microphone.state !== "failed" ? existing.microphone : await microphoneFor(config, job, context, store, dependencies);
    const conversation = options.conversation ? await conversationFor(config, context, microphone, dependencies, options.signal) : existing?.conversation;
    // The diarization may have been replaced meanwhile; never attach results to a newer one.
    const latest = await readDiarizationContext(job, canonical, store.diarization);
    if (latest?.binding.diarizationSha256 !== context.binding.diarizationSha256) throw new Error(SPEAKER_MESSAGES.interrupted);
    const record: SpeakerSuggestionRecord = { version: 1, ...context.binding, microphone, ...(conversation ? { conversation } : {}) };
    await store.save(record);
    await store.clearOperation(id);
    return record;
  } catch (error) {
    const message = safeSpeakerMessage(error);
    await store.writeOperation({ version: 1, jobId: id, state: "failed", startedAt, conversation: !!options.conversation, message }).catch(() => undefined);
    throw new Error(message);
  } finally { await lease.release(); }
};

/** Microphone always (local); the conversation only when explicitly requested. */
export const suggestSpeakerNames = (config: AppConfig, id: string, options: SuggestOptions = {}, dependencies: SpeakerSuggestionDependencies = {}) =>
  withHeavyAdmission("diarization", id, () => suggestOwned(config, id, options, dependencies), { signal: options.signal, onWait: cliAdmissionWait });

export const queueSpeakerSuggestions = async (
  config: AppConfig, id: string, options: { conversation?: boolean; consentKey?: string } = {}, dependencies: SpeakerSuggestionDependencies = {}
): Promise<{ id: string; status: "queued"; unit: string }> => {
  validateJobId(id);
  if (options.conversation && (typeof options.consentKey !== "string" || !SHA256.test(options.consentKey))) throw new Error(SPEAKER_MESSAGES.consentRequired);
  if (options.conversation && options.consentKey !== destinationKey(conversationDestination(config))) throw new Error(SPEAKER_MESSAGES.destinationChanged);
  const lease = await acquireSingleton(`speakers-queue-${id}`);
  const store = dependencies.store || new SpeakerSuggestionStore();
  try {
    const job = await (dependencies.getJob || ((jobId) => new JobStore().get(jobId)))(id);
    const canonical = await (dependencies.readCanonical || readCanonicalTranscript)(job);
    if (!await readDiarizationContext(job, canonical, store.diarization)) throw new Error(SPEAKER_MESSAGES.needsDiarization);
    const unit = speakerSuggestionUnit(id);
    if (await (dependencies.unitActive || unitActive)(id)) return { id, status: "queued", unit };
    const startedAt = new Date().toISOString();
    await store.writeOperation({ version: 1, jobId: id, state: "running", startedAt, conversation: !!options.conversation });
    try {
      await (dependencies.run || runCommand)("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec", "--property=Nice=10",
        "--property=RuntimeMaxSec=3600", "--property=TimeoutStopSec=30", "--property=UMask=0077", "--property=MemoryMax=1G",
        `--property=EnvironmentFile=-${join(homedir(), ".config/recording-cli/worker.env")}`,
        ...transientUnitEnvironment(), "--description=Suggest recording speaker names", "--",
        ...transientCommand([...getServiceLaunchCommand(), "speakers", "suggest", id, ...(options.conversation ? ["--conversation", "--consent-key", options.consentKey!] : [])])], { timeoutMs: 15_000 });
    } catch {
      await store.writeOperation({ version: 1, jobId: id, state: "failed", startedAt, conversation: !!options.conversation, message: SPEAKER_MESSAGES.startFailed });
      throw new Error(SPEAKER_MESSAGES.startFailed);
    }
    return { id, status: "queued", unit };
  } finally { await lease.release(); }
};

export type SpeakerSuggestionItem = {
  speakerId: string; source: "microphone" | "conversation"; self: boolean;
  /** Absent for the owner when the account has no full name; the Studio shows "Você". */
  name?: string; localShare?: number; evidence?: ConversationEvidence[];
};
export type SpeakerSuggestionView = {
  state: "unavailable" | "idle" | "running" | "ready" | "failed";
  message?: string;
  items: SpeakerSuggestionItem[];
  microphone?: { state: MicrophoneRecord["state"]; message?: string };
  conversation?: { state: ConversationRecord["state"]; message?: string; provider: string; model: string; external: boolean; generatedAt: string; partial?: boolean; sentTurns?: number; totalTurns?: number };
  destination: { provider: "openai" | "ollama"; model: string; endpoint: string; external: boolean; consentKey: string };
};

const microphoneMessage = (record: MicrophoneRecord): string | undefined =>
  record.state === "failed" ? record.message : record.state === "unavailable" ? SPEAKER_MESSAGES[record.reason] : record.reason ? SPEAKER_MESSAGES[record.reason] : undefined;

export const buildSuggestionItems = (record: SpeakerSuggestionRecord): SpeakerSuggestionItem[] => {
  const items: SpeakerSuggestionItem[] = [];
  const microphone = record.microphone;
  if (microphone?.state === "ready") {
    for (const speakerId of microphone.selfSpeakers) {
      const share = microphone.speakers.find((speaker) => speaker.speakerId === speakerId);
      items.push({ speakerId, source: "microphone", self: true, ...(microphone.selfName ? { name: microphone.selfName } : {}), ...(share ? { localShare: share.localShare } : {}) });
    }
  }
  if (record.conversation?.state === "ready") {
    for (const suggestion of record.conversation.suggestions) items.push({ speakerId: suggestion.speakerId, source: "conversation", self: false, name: suggestion.name, evidence: suggestion.evidence });
  }
  return items.sort((a, b) => a.speakerId.localeCompare(b.speakerId) || a.source.localeCompare(b.source));
};

export const readSpeakerSuggestionView = async (
  config: AppConfig, job: JobRecord, canonical: Transcript, dependencies: Pick<SpeakerSuggestionDependencies, "store" | "unitActive"> = {}
): Promise<SpeakerSuggestionView> => {
  const destination = conversationDestination(config);
  const base = { items: [] as SpeakerSuggestionItem[], destination: { ...destination, consentKey: destinationKey(destination) } };
  const store = dependencies.store || new SpeakerSuggestionStore();
  const context = await readDiarizationContext(job, canonical, store.diarization);
  if (!context) return { state: "unavailable", ...base };
  const [record, operation] = await Promise.all([store.read(context.binding), store.readOperation(job.id)]);
  const details = record ? {
    items: buildSuggestionItems(record),
    ...(record.microphone ? { microphone: { state: record.microphone.state, ...(microphoneMessage(record.microphone) ? { message: microphoneMessage(record.microphone) } : {}) } } : {}),
    ...(record.conversation ? { conversation: {
      state: record.conversation.state, provider: record.conversation.provider, model: record.conversation.model, external: record.conversation.external, generatedAt: record.conversation.generatedAt,
      ...(record.conversation.state === "failed" ? { message: record.conversation.message } : {
        partial: record.conversation.partial, sentTurns: record.conversation.sentTurns, totalTurns: record.conversation.totalTurns,
        ...(record.conversation.suggestions.length ? {} : { message: SPEAKER_MESSAGES.conversationEmpty }) })
    } } : {})
  } : {};
  if (operation?.state === "running") {
    if (await (dependencies.unitActive || unitActive)(job.id)) return { state: "running", message: SPEAKER_MESSAGES.running, ...base, ...details };
    return { state: "failed", message: SPEAKER_MESSAGES.interrupted, ...base, ...details };
  }
  if (operation?.state === "failed") return { state: "failed", message: operation.message || SPEAKER_MESSAGES.failed, ...base, ...details };
  if (!record) return { state: "idle", ...base };
  return { state: "ready", message: SPEAKER_MESSAGES.ready, ...base, ...details };
};
