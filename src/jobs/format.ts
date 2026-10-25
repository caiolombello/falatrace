import type { RecordingSummary, SummarySection, Transcript } from "./types";
import { SUMMARY_LABELS, type SummaryLabels } from "../summary/language";

const formatTimestamp = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
};

export const formatTranscriptMarkdown = (transcript: Transcript): string => {
  const lines = ["# Transcrição", ""];
  // Segment text need not cover canonical gaps, tails or the reading order.
  if (transcript.text) lines.push("## Texto completo", "", transcript.text, "");
  if (transcript.segments.length) lines.push("## Trechos", "");
  for (const segment of transcript.segments) {
    const speaker = segment.speaker ? ` ${segment.speaker}:` : "";
    lines.push(`[${formatTimestamp(segment.start)}]${speaker} ${segment.text.trim()}`);
  }
  return `${lines.join("\n").trim()}\n`;
};

// A user's own note in a v2 summary; AI items carry no mark.
export const USER_ITEM_MARK = "✎ ";

const sectionLines = (summary: RecordingSummary, sections: readonly SummarySection[]): string[] => {
  const references = new Map((summary.support?.references || []).map((reference) => [reference.id, reference]));
  const lines: string[] = [];
  for (const section of sections) {
    if (!section.items.length) continue;
    lines.push("", `## ${section.heading}`, "");
    for (const item of section.items) {
      // The earliest cited segment, as [m:ss], is what the Studio turns into a seekable line.
      const starts = item.segmentIds.map((id) => references.get(id)?.start).filter((start): start is number => start !== undefined);
      const at = starts.length ? ` [${formatTimestamp(Math.min(...starts))}]` : "";
      lines.push(`- ${item.origin === "user" ? USER_ITEM_MARK : ""}${item.text.replace(/\s+/g, " ").trim()}${at}`);
    }
  }
  return lines;
};

const evidenceLines = (summary: RecordingSummary, labels: SummaryLabels): string[] => {
  if (!summary.support) return [];
  const lines = ["", `## ${labels.evidence}`, "",
    `${labels.reviewNeeded}: ${summary.support.reviewRequired ? labels.yes : labels.notFlagged}. ${labels.timing}: ${summary.support.timingQuality}.`,
    `${labels.mediaSha256}: ${summary.support.mediaSha256}`, `${labels.transcriptSha256}: ${summary.support.transcriptSha256}`];
  for (const citation of summary.citations || []) {
    const refs = citation.segmentIds.map((id) => summary.support!.references.find((reference) => reference.id === id)).filter((reference) => reference !== undefined);
    lines.push(`- ${citation.section}[${citation.index}]: ${refs.map((ref) => `${ref.id} [${formatTimestamp(ref.start)}–${formatTimestamp(ref.end)}]`).join(", ")} (${citation.uncertainty})`);
  }
  return lines;
};

/** Markdown of a summary, in the summary's language (pt-BR for summaries made before v2, byte for
 * byte as before). A v2 summary shows its template sections: the user's notes marked with "✎ ",
 * what the model added plain, each line with the time of its first cited segment. */
export const formatSummaryMarkdown = (summary: RecordingSummary): string => {
  const labels = SUMMARY_LABELS[summary.meta?.language ?? "pt-BR"];
  const sections = summary.sections || [];
  // Model-written sections replace the legacy lists; a summary whose only section is the notes
  // the model did not use keeps the legacy layout and lists those notes after it.
  const modelSections = sections.some((section) => section.items.length && section.heading !== labels.unusedNotes);
  if (modelSections) {
    const lines = [`# ${summary.title}`, "", summary.overview, ...sectionLines(summary, sections), ...evidenceLines(summary, labels)];
    if (summary.limitations?.length) lines.push("", `## ${labels.limitations}`, "", ...summary.limitations.map((limitation) => `- ${limitation}`));
    return `${lines.join("\n").trim()}\n`;
  }
  const lines = [
    `# ${summary.title}`,
    "",
    `## ${labels.summary}`,
    "",
    summary.overview,
    "",
    `## ${labels.topics}`,
    ""
  ];
  lines.push(...(summary.topics.length > 0 ? summary.topics.map((item) => `- ${item}`) : [`- ${labels.noneFound}`]));
  lines.push("", `## ${labels.decisions}`, "");
  lines.push(...(summary.decisions.length > 0 ? summary.decisions.map((item) => `- ${item}`) : [`- ${labels.noneFoundFeminine}`]));
  lines.push("", `## ${labels.actions}`, "");
  lines.push(
    ...(summary.actionItems.length > 0
      ? summary.actionItems.map((item) => {
          const details = [item.owner && `${labels.owner}: ${item.owner}`, item.dueDate && `${labels.dueDate}: ${item.dueDate}`]
            .filter(Boolean)
            .join(", ");
          return `- ${item.description}${details ? ` (${details})` : ""}`;
        })
      : [`- ${labels.noneFoundFeminine}`])
  );
  lines.push(...sectionLines(summary, sections), ...evidenceLines(summary, labels));
  if (summary.limitations?.length) lines.push("", `## ${labels.limitations}`, "", ...summary.limitations.map((limitation) => `- ${limitation}`));
  return `${lines.join("\n").trim()}\n`;
};
