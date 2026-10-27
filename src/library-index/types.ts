/**
 * Contracts of the library index: per-recording facts (title, people, decisions, actions)
 * and searchable text chunks, derived from artifacts on disk and rebuilt when they change.
 * People, client, action and brief pages, chat retrieval and the pre-meeting brief all read
 * through LibraryIndexReader; none of them is a source of truth.
 */

export type FactSpeaker = { speakerId: string; label: string; confirmed: boolean };
export type FactAttendee = { name: string; self: boolean };
export type FactClient = { code: string; name: string; source: "entry-locked" | "entry-confident" | "entry-split" | "content-match" | "manual"; confidence: number };
export type FactDecision = { index: number; text: string; segmentIds: string[] };
export type FactAction = { index: number; text: string; owner: string; dueDate: string; segmentIds: string[]; origin: "model" | "note" };

export type JobFacts = {
  version: 1;
  jobId: string;
  mediaSha256: string;
  sourcePath: string;
  title: string;
  /** ISO time the meeting started: calendar start when known, else the job creation time. */
  date: string;
  durationSeconds?: number;
  /** Hash of everything the facts were built from; a different value means rebuild. */
  fingerprint: string;
  transcriptArtifactSha256?: string;
  summaryArtifactSha256?: string;
  /** Human revision the facts reflect (0 when none). */
  revision: number;
  template?: { id: string; source: string };
  language?: string;
  speakers: FactSpeaker[];
  attendees: FactAttendee[];
  calendar?: { title: string; eventIdHash?: string; seriesIdHash?: string; recurring: boolean };
  clients: FactClient[];
  overview: string;
  topics: string[];
  decisions: FactDecision[];
  actions: FactAction[];
  noteCount: number;
};

export type IndexChunk = {
  /** `${jobId}:${first}-${last}` for segments, `${jobId}:summary:${n}` or `${jobId}:note:${id}` otherwise. */
  chunkId: string;
  jobId: string;
  kind: "segments" | "summary" | "note";
  segmentIds: string[];
  start?: number;
  end?: number;
  speakers?: string[];
  text: string;
};

export type ChunkHit = { chunk: IndexChunk; score: number };

export interface LibraryIndexReader {
  /** Facts of every indexed recording, newest first. */
  listFacts(): Promise<JobFacts[]>;
  getFacts(jobId: string): Promise<JobFacts | undefined>;
  /** Ranked chunks for a question, optionally limited to some recordings. */
  search(query: string, options?: { jobIds?: string[]; limit?: number; signal?: AbortSignal }): Promise<ChunkHit[]>;
}

/** Where calendar details of a recording are kept when its job is created (written by the enqueue step). */
export type CalendarLink = {
  version: 1;
  jobId: string;
  mediaSha256: string;
  source: "google-calendar" | "gnome-calendar" | "kde-calendar";
  /** sha256 of the event id with a per-installation salt; never the raw id. */
  eventIdHash?: string;
  seriesIdHash?: string;
  title: string;
  startAt: string;
  endAt: string;
  recurring: boolean;
  /** Names only, never e-mails. */
  attendees: FactAttendee[];
  capturedAt: string;
};
