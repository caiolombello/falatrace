import type { AppConfig } from "../config/defaults";
import { type RecordingSession, RecordingSessionStore } from "../recording/session";
import { LIVE_MESSAGES, LiveError, validateLiveSessionId } from "./store";
import type { LiveSessionInput } from "./tap";
import { type LiveWorkerDeps, type LiveWorkerResult, runLiveWorker } from "./worker";

export {
  defaultLiveDir,
  LIVE_KNOWN_ERRORS,
  LIVE_MAX_LINES,
  LIVE_MESSAGES,
  LIVE_PAGE_DEFAULT,
  LIVE_PAGE_MAX,
  LIVE_STATES,
  LIVE_STATUS_HEARTBEAT_MS,
  LIVE_TEXT_MAX_LENGTH,
  LIVE_TRANSCRIPT_MAX_BYTES,
  LiveError,
  type LiveLine,
  type LiveState,
  type LiveStatus,
  LiveStore,
  type LiveTranscriptPage,
  type LiveTranscriptView,
  liveStatusStaleAfterMs,
  normalizeLiveText,
  readLiveTranscript,
  sharedLiveStore,
  validateLiveLine,
  validateLiveSessionId,
  validateLiveStatus
} from "./store";
export {
  buildLiveTapCommand,
  clearChunkDir,
  LIVE_CHUNK_PATTERN,
  LIVE_SEGMENT_LIST,
  type LiveProcess,
  type LiveProcessExit,
  type LiveSessionInput,
  type LiveSpawn,
  type LiveTapCommand,
  type LiveTapOptions,
  parseSegmentList,
  readSegmentList,
  resolveLiveSources,
  type SegmentListEntry,
  spawnLiveProcess,
  stopLiveProcess
} from "./tap";
export {
  analyzeWav,
  type ChunkLevel,
  cleanLiveText,
  isSilentChunk,
  LIVE_COST_PER_HOUR,
  LIVE_ENDPOINTS,
  LIVE_GROQ_MIN_CHUNK_SECONDS,
  LIVE_SILENCE,
  type LiveChunkInput,
  type LiveFailureKind,
  type LiveSegment,
  LiveTranscribeError,
  type LiveTranscribeDeps,
  liveChunkSeconds,
  liveLanguage,
  liveProviderKey,
  measureWavLevel,
  parseGroqResponse,
  transcribeLiveChunk,
  validateLiveEndpoint
} from "./transcribe";
export {
  buildLiveUnitArgs,
  type LiveUnitDeps,
  type LiveUnitOptions,
  liveUnitActive,
  liveUnitName,
  startLiveUnit,
  stopLiveUnit
} from "./unit";
export { LIVE_BEHIND_BACKLOG, LIVE_BEHIND_RTF, type LiveWorkerDeps, type LiveWorkerOptions, type LiveWorkerResult, runLiveWorker } from "./worker";

/** The fields of a recording session the worker reads; `mediaStartedAt` is used once the session records it. */
export const liveSessionFromRecording = (session: RecordingSession): LiveSessionInput => {
  const mediaStartedAt = (session as RecordingSession & { mediaStartedAt?: unknown }).mediaStartedAt;
  return {
    startedAt: session.startedAt,
    ...(typeof mediaStartedAt === "string" && Number.isFinite(Date.parse(mediaStartedAt)) ? { mediaStartedAt } : {}),
    ...(session.audio ? { audio: { ...session.audio } } : {}),
    backend: session.backend
  };
};

const isActiveRecording = (session: RecordingSession | null, sessionId: string): session is RecordingSession =>
  session !== null && session.id === sessionId && session.phase !== "stopped";

/**
 * Entry point for `live run --session <id>`: reads the current capture session, refuses when it is not
 * this one or already stopped, and runs the worker until `signal` aborts or the capture ends.
 */
export const runLiveSession = async (options: {
  config: AppConfig;
  sessionId: string;
  signal?: AbortSignal;
  deps?: LiveWorkerDeps;
  sessions?: Pick<RecordingSessionStore, "read">;
}): Promise<LiveWorkerResult> => {
  const sessionId = validateLiveSessionId(options.sessionId);
  const sessions = options.sessions ?? new RecordingSessionStore();
  const recording = await sessions.read();
  if (!isActiveRecording(recording, sessionId)) throw new LiveError(LIVE_MESSAGES.sessionEnded);
  const external = options.deps?.shouldContinue;
  return runLiveWorker({
    config: options.config,
    sessionId,
    session: liveSessionFromRecording(recording),
    signal: options.signal,
    deps: {
      ...options.deps,
      shouldContinue: async () => isActiveRecording(await sessions.read(), sessionId) && (external ? await external() : true)
    }
  });
};
