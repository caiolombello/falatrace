import { formatSummaryMarkdown } from "../jobs/format";
import { canonicalJson, digest, MAX_EXPORT_BYTES, type ExportSnapshot, type ExportFormat } from "./snapshot";
import { assertScalarText, renderSubtitles, type ExportCue } from "./subtitles";

export type RenderedExport = { format: ExportFormat; track: ExportSnapshot["track"]; content: string; sha256: string; snapshotSha256: string; bytes: number; warnings: string[]; cues: ExportCue[]; omitted: string[] };
const literalBlock = (text: string): string => {
  assertScalarText(text);
  let width = 3;
  for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "`".repeat(width);
  return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
};

const renderMarkdown = (snapshot: ExportSnapshot, hash: string): string => {
  const lines = ["# Exportação FalaTrace", "", `Job: ${snapshot.jobId}`, `Faixa: ${snapshot.track}`, `Revisão humana: ${snapshot.revision.revision}`, `Snapshot SHA-256: ${hash}`,
    `Mídia SHA-256: ${snapshot.source.mediaSha256}`, `Artefato original SHA-256: ${snapshot.source.transcriptSha256}`,
    `Proveniência: ${snapshot.source.origin}/${snapshot.source.receipt}`, `Precisão temporal: ${snapshot.timingQuality}`, "", "## Limites", "", ...snapshot.warnings.map(warning => `- ${warning}`),
    "", "## Texto revisado completo", "", literalBlock(snapshot.reviewed.text), "", "## Texto original completo", "", literalBlock(snapshot.original.transcript.text), "", "## Segmentos revisados", ""];
  for (const segment of snapshot.reviewed.segments) {
    lines.push(`### ${segment.id}`, "", `ID original: ${segment.canonicalId}`, `Intervalo original em segundos: ${segment.start}–${segment.end}`, `Texto humano alterado: ${segment.humanEdited ? "sim" : "não"}`,
      `Falante: ${segment.speakerId || "incerto"}`, "", literalBlock(segment.text), "");
  }
  if (snapshot.diarization) {
    lines.push("## Falantes e texto da diarização", "", "A linha do tempo abaixo pertence ao diarizador; ela não é alinhamento do texto canônico.", "");
    for (const turn of snapshot.diarization.turns) lines.push(`### ${turn.id} · ${turn.start}–${turn.end} segundos`, "", literalBlock(`${turn.speaker || "incerto"} (${turn.label || "sem nome"}): ${turn.text}`), "");
  }
  if (snapshot.reviewed.notes.length) lines.push("## Notas humanas", "", ...snapshot.reviewed.notes.flatMap(note => [literalBlock(note), ""]));
  if (snapshot.summary.reviewed) lines.push("## Resumo de modelo da revisão atual", "", literalBlock(formatSummaryMarkdown(snapshot.summary.reviewed)), "", literalBlock(JSON.stringify(snapshot.summary.provenance, null, 2)), "");
  lines.push(`## Resumo original · ${snapshot.summary.originalState || snapshot.summary.state}`, "");
  if (snapshot.summary.original) lines.push(literalBlock(formatSummaryMarkdown(snapshot.summary.original)), "");
  else lines.push("Resumo indisponível.", "");
  return `${lines.join("\n")}\n`;
};

export const renderExport = (snapshot: ExportSnapshot, format: ExportFormat): RenderedExport => {
  const json = canonicalJson(snapshot);
  if (Buffer.byteLength(json, "utf8") > MAX_EXPORT_BYTES) throw new Error("Snapshot de exportação excedeu o limite de 64 MiB");
  // JSON escapes lone surrogates; reject them rather than letting text formats replace data.
  const check = (value: unknown): void => { if (typeof value === "string") assertScalarText(value); else if (Array.isArray(value)) value.forEach(check); else if (value && typeof value === "object") Object.values(value).forEach(check); };
  check(snapshot);
  const snapshotSha256 = digest(json);
  let content: string; let cues: ExportCue[] = [], omitted: string[] = [];
  if (format === "json") content = json;
  else if (format === "markdown") content = renderMarkdown(snapshot, snapshotSha256);
  else if (format === "srt" || format === "vtt") ({ content, cues, omitted } = renderSubtitles(snapshot, format, snapshotSha256));
  else throw new Error("Formato de exportação inválido");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EXPORT_BYTES) throw new Error("Exportação excedeu o limite de 64 MiB");
  const warnings = [...snapshot.warnings];
  if (format === "srt" || format === "vtt") warnings.push("Legendas representam os trechos temporizados desta faixa; texto completo e lacunas são preservados no snapshot JSON.");
  if (omitted.length) warnings.push(`Segmentos vazios omitidos das legendas: ${omitted.length}; IDs registrados no manifesto.`);
  if (format === "srt") warnings.push("IDs, proveniência e limites temporais estão no manifesto JSON companheiro; interpretação de marcação depende do leitor SRT.");
  if ((format === "srt" || format === "vtt") && cues.some(cue => /\r/.test(cue.text))) warnings.push("Quebras CR/CRLF representadas por LF nas legendas; texto original preservado no snapshot JSON.");
  return { format, track: snapshot.track, content, sha256: digest(content), snapshotSha256, bytes, warnings, cues, omitted };
};
