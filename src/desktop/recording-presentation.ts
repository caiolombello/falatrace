import type { LibraryEntry } from "../tui/library";
import type { readArtifactStates } from "../jobs/transcript-access";

type ArtifactStates = Awaited<ReturnType<typeof readArtifactStates>>;

/** Presentation only: never derive a meeting subject or change source metadata. */
export const recordingPresentation = (
  entry: LibraryEntry, artifacts?: ArtifactStates, timeZone?: string
): { title: string; artifactStatus: string; hasMeetingTitle: boolean } => {
  const hasMeetingTitle = Boolean(entry.meetingTitle?.trim());
  // Prefer the library's media timestamp over a job queued later. Old jobs and
  // missing media can fall back to their existing creation date; no migration.
  const timestamps = [entry.modifiedAt, Date.parse(entry.jobs[0]?.createdAt || ""), Date.parse(entry.archive?.createdAt || "")];
  const timestamp = timestamps.find(value => Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()));
  const date = timestamp === undefined ? "data indisponível" : new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", ...(timeZone ? { timeZone } : {})
  }).format(timestamp);
  const transcript = artifacts?.transcript.state === "ready" ? "Transcrição pronta"
    : "Transcrição indisponível";
  const summary = artifacts?.summary.state === "ready" ? "Resumo pronto"
    : "Resumo indisponível";
  return {
    title: hasMeetingTitle ? entry.meetingTitle! : `Gravação — ${date}`,
    artifactStatus: `${transcript} · ${summary}`,
    hasMeetingTitle
  };
};
