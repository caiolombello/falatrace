/** Granularity of existing source intervals, never an alignment estimate. */
export type TimingQuality = "word" | "segment" | "approximate-block" | "none" | "unknown";

type TimedSource = { provider?: unknown; model?: unknown; segments?: unknown; words?: unknown };
const hasIntervals = (value: unknown): boolean => Array.isArray(value) && value.some(item =>
  item && typeof item === "object" && typeof item.start === "number" && typeof item.end === "number" &&
  Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start);

export const sourceTimingQuality = (source: TimedSource): TimingQuality => {
  if (!hasIntervals(source.segments) && !hasIntervals(source.words)) return "none";
  if (source.provider === "whisper-cpp") return "segment";
  if (source.provider === "gemini") return hasIntervals(source.words) ? "word" : "unknown";
  const model = typeof source.model === "string" ? source.model : "";
  if (source.provider === "openai") return /^gpt-4o-transcribe-diarize/.test(model) ? "segment" : "approximate-block";
  // Older player-only tracks have no provider. Recognize only known producers.
  if (source.provider === undefined) {
    if (model === "diarization" || /^gpt-4o-transcribe-diarize/.test(model) || /whisper|ggml/i.test(model)) return "segment";
    if (/^gpt/i.test(model)) return "approximate-block";
  }
  return "unknown";
};
