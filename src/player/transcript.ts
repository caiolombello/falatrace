import { sourceTimingQuality } from "../transcript/timing";

export type PlayerTranscript = {
  text: string;
  timing: "segment" | "block" | "none";
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
  reviewRequired?: boolean;
};

export const parsePlayerTranscript = (value: unknown): PlayerTranscript => {
  if (!value || typeof value !== "object") return { text: "", timing: "none", segments: [] };
  const raw = value as Record<string, unknown>;
  let reviewRequired = false;
  const segments = (Array.isArray(raw.segments) ? raw.segments : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const segment = item as Record<string, unknown>;
    if (typeof segment.start !== "number" || typeof segment.end !== "number" ||
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start ||
      typeof segment.text !== "string" || !segment.text.trim()) return [];
    const speaker = segment.speaker;
    if (speaker !== undefined && (typeof speaker !== "string" || speaker.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(speaker))) {
      reviewRequired = true;
      return [{ start: segment.start, end: segment.end, text: segment.text.trim() }];
    }
    return [{ start: segment.start, end: segment.end, text: segment.text.trim(), ...(speaker ? { speaker } : {}) }];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const text = typeof raw.text === "string" ? raw.text.trim() : segments.map((segment) => segment.text).join(" ");
  const quality = sourceTimingQuality({ ...raw, segments });
  const timing = segments.length === 0 ? "none" : quality === "approximate-block" ? "block" : ["word", "segment"].includes(quality) ? "segment" : "none";
  return { text, timing, segments, ...(reviewRequired ? { reviewRequired: true } : {}) };
};
