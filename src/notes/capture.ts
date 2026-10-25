// Notes typed during a capture are placed on the media timeline of that capture. The reference
// comes from the capture session: its first media (or its start, for sessions of older versions),
// its end once stopped, and its recording file, so a job created later for the same media finds them.
import { captureMediaStartedAt, type RecordingSession } from "../recording/session";

export type NotesCaptureReference = {
  /** The notes id: the capture session id, which becomes the job id when the capture is enqueued. */
  id: string;
  mediaStartedAt: string;
  /** Only once the capture stopped: notes typed long after it are not placed on the timeline. */
  mediaEndedAt?: string;
  sourcePath: string;
};

/** What `NotesStore.save(id, { text, expectedRev, ...rest })` needs to know about the capture. */
export const notesCaptureReference = (
  session: Pick<RecordingSession, "id" | "startedAt" | "mediaStartedAt" | "endedAt" | "phase" | "outputPath">
): NotesCaptureReference => ({
  id: session.id,
  mediaStartedAt: captureMediaStartedAt(session),
  ...(session.phase === "stopped" && session.endedAt ? { mediaEndedAt: session.endedAt } : {}),
  sourcePath: session.outputPath
});
