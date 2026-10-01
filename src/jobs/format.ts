import type { RecordingSummary, Transcript } from "./types";

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
  for (const segment of transcript.segments) {
    const speaker = segment.speaker ? ` ${segment.speaker}:` : "";
    lines.push(`[${formatTimestamp(segment.start)}]${speaker} ${segment.text.trim()}`);
  }
  if (transcript.segments.length === 0 && transcript.text) {
    lines.push(transcript.text);
  }
  return `${lines.join("\n").trim()}\n`;
};

export const formatSummaryMarkdown = (summary: RecordingSummary): string => {
  const lines = [
    `# ${summary.title}`,
    "",
    "## Resumo",
    "",
    summary.overview,
    "",
    "## Tópicos",
    ""
  ];
  lines.push(...(summary.topics.length > 0 ? summary.topics.map((item) => `- ${item}`) : ["- Nenhum identificado"]));
  lines.push("", "## Decisões", "");
  lines.push(...(summary.decisions.length > 0 ? summary.decisions.map((item) => `- ${item}`) : ["- Nenhuma identificada"]));
  lines.push("", "## Ações", "");
  lines.push(
    ...(summary.actionItems.length > 0
      ? summary.actionItems.map((item) => {
          const details = [item.owner && `responsável: ${item.owner}`, item.dueDate && `prazo: ${item.dueDate}`]
            .filter(Boolean)
            .join(", ");
          return `- ${item.description}${details ? ` (${details})` : ""}`;
        })
      : ["- Nenhuma identificada"])
  );
  if (summary.support) {
    lines.push("", "## Evidências e limites", "",
      `Revisão necessária: ${summary.support.reviewRequired ? "sim" : "não sinalizada (não garante correção semântica)"}. Precisão temporal: ${summary.support.timingQuality}.`,
      `Mídia SHA-256: ${summary.support.mediaSha256}`, `Transcrição SHA-256: ${summary.support.transcriptSha256}`);
    for (const citation of summary.citations || []) {
      const refs = citation.segmentIds.map((id) => summary.support!.references.find((reference) => reference.id === id)).filter((reference) => reference !== undefined);
      lines.push(`- ${citation.section}[${citation.index}]: ${refs.map((ref) => `${ref.id} [${formatTimestamp(ref.start)}–${formatTimestamp(ref.end)}]`).join(", ")} (${citation.uncertainty})`);
    }
    lines.push(...(summary.limitations || []).map((limitation) => `- ${limitation}`));
  }
  return `${lines.join("\n").trim()}\n`;
};
