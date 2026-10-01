import { createHash } from "node:crypto";
import type { Transcript } from "../jobs/types";

export type VisualRequest = {
  timestampSeconds: number;
  reason: "visual-reference" | "transcript-gap" | "user-request";
  question: string;
  segmentIds: string[];
};
export type VisualPlan = {
  version: 1; mediaSha256: string; durationSeconds: number; round: number;
  maxDimension: number; maxBytesPerFrame: number; maxTotalBytes: number;
  requests: VisualRequest[]; key: string;
};
export const planVisualEvidence = (
  mediaSha256: string, transcript: Transcript, durationSeconds: number, input: unknown,
  options: { round?: number; usedTimestamps?: number[] } = {}
): VisualPlan => {
  if (!/^[a-f0-9]{64}$/.test(mediaSha256) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) throw new Error("Invalid visual source identity/duration");
  const round = options.round ?? 1;
  if (!Number.isSafeInteger(round) || round < 1 || round > 2) throw new Error("Visual evidence is limited to two rounds");
  const used = options.usedTimestamps || [];
  if (used.length > 8 || used.some((time) => !Number.isFinite(time) || time < 0 || time >= durationSeconds) || new Set(used).size !== used.length) throw new Error("Invalid visual budget history");
  if (!Array.isArray(input) || input.length > 8) throw new Error("Visual requests must be an array with at most eight items");
  const segments = new Set(transcript.segments.map((_, index) => `s${String(index).padStart(6,"0")}`));
  const requests: VisualRequest[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["timestampSeconds","reason","question","segmentIds"].includes(key))) throw new Error("Unsupported visual request fields");
    const request = raw as VisualRequest;
    if (typeof request.timestampSeconds !== "number" || !Number.isFinite(request.timestampSeconds) || request.timestampSeconds < 0 || request.timestampSeconds >= durationSeconds ||
        !["visual-reference","transcript-gap","user-request"].includes(request.reason) ||
        typeof request.question !== "string" || !request.question.trim() || request.question.length > 1000 || /[\x00-\x1f\x7f]/.test(request.question) ||
        !Array.isArray(request.segmentIds) || request.segmentIds.length > 8 || request.segmentIds.some((id) => !segments.has(id)) ||
        new Set(request.segmentIds).size !== request.segmentIds.length || (request.reason !== "user-request" && request.segmentIds.length === 0)) throw new Error("Invalid visual evidence request");
    const timestampSeconds = Math.round(request.timestampSeconds * 1000) / 1000;
    if (timestampSeconds >= durationSeconds) throw new Error("Rounded visual timestamp is outside the recording");
    if (used.some((time) => Math.abs(time-timestampSeconds) < .25) || requests.some((item) => Math.abs(item.timestampSeconds-timestampSeconds) < .25)) continue;
    requests.push({ timestampSeconds, reason: request.reason, question: request.question, segmentIds: [...request.segmentIds] });
  }
  if (used.length + requests.length > 8) throw new Error("Visual evidence exceeds the eight-frame cumulative budget");
  const data = { version: 1 as const, mediaSha256, durationSeconds, round, maxDimension: 1280, maxBytesPerFrame: 2*1024*1024, maxTotalBytes: 8*1024*1024, requests };
  return { ...data, key: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
};
