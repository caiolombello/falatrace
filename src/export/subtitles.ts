import type { ExportSnapshot } from "./snapshot";

export type ExportCue = { index: number; id: string; canonicalId?: string; start: number; end: number; startMs: number; endMs: number; text: string; speakerId?: string; label?: string };
const scalarText = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
export const assertScalarText = (text: string): void => { if (!scalarText(text)) throw new Error("Texto contém um caractere Unicode incompleto"); };

const payload = (text: string, id: string): string => {
  assertScalarText(text);
  const normalized = text.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(normalized) || normalized.split("\n").some(line => !line.trim())) throw new Error(`Legenda ${id}: texto contém controle ou linha vazia não representável`);
  // Literal text, including markup-looking input and timestamp arrows.
  return normalized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

export const subtitleTimestamp = (milliseconds: number, separator: "," | "."): string => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(milliseconds % 1_000).padStart(3, "0")}`;
};

export const subtitleCues = (snapshot: ExportSnapshot): { cues: ExportCue[]; omitted: string[] } => {
  if (!["segment", "word"].includes(snapshot.timingQuality)) throw new Error(`Legendas recusadas: precisão temporal ${snapshot.timingQuality}; não há alinhamento suficiente`);
  if (snapshot.track === "transcript" && snapshot.reviewed.segments.some(segment => segment.humanEdited)) throw new Error("Legendas recusadas: texto corrigido ainda não tem alinhamento acústico verificado; exporte JSON/Markdown ou escolha a faixa de diarização");
  const rows = snapshot.track === "transcript" ? snapshot.reviewed.segments.map(segment => ({
    id: segment.id, canonicalId: segment.canonicalId, start: segment.start, end: segment.end, text: segment.text,
    speakerId: segment.speakerId,
    label: segment.humanSpeakerEdited && segment.speakerId && snapshot.diarization?.labels[segment.speakerId] || segment.speakerId
  })) : snapshot.diarization!.turns.map(turn => ({ id: turn.id, start: turn.start, end: turn.end, text: turn.text,
    speakerId: turn.speaker, label: turn.label || (turn.speaker ? snapshot.diarization!.labels[turn.speaker] : undefined) }));
  const omitted: string[] = [];
  const ids = new Set<string>();
  const cues: ExportCue[] = [];
  for (const row of rows) {
    if (!/^[st]\d{6}$/.test(row.id) || ids.has(row.id)) throw new Error("ID de legenda inválido ou repetido");
    ids.add(row.id);
    if (!row.text.trim()) { omitted.push(row.id); continue; }
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start) throw new Error(`Legenda ${row.id}: intervalo inválido`);
    const startMs = Math.round(row.start * 1000), endMs = Math.round(row.end * 1000);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) throw new Error(`Legenda ${row.id}: intervalo não representável em milissegundos`);
    if (snapshot.track === "diarization" && row.end > snapshot.diarization!.original.duration) throw new Error(`Legenda ${row.id}: intervalo ultrapassa a duração da diarização`);
    if (row.label && /[\u0000-\u001F\u007F-\u009F]/.test(row.label)) throw new Error(`Legenda ${row.id}: nome de falante inválido`);
    payload((row.label ? `${row.label}: ` : "") + row.text, row.id);
    cues.push({ ...row, startMs, endMs, index: 0 });
  }
  if (!cues.length) throw new Error("Legendas recusadas: não há falas temporizadas com texto");
  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  cues.forEach((cue, index) => { cue.index = index + 1; });
  return { cues, omitted };
};

export const renderSubtitles = (snapshot: ExportSnapshot, format: "srt" | "vtt", snapshotSha256: string): { content: string; cues: ExportCue[]; omitted: string[] } => {
  const { cues, omitted } = subtitleCues(snapshot);
  const header = format === "vtt" ? `WEBVTT\n\nNOTE FalaTrace snapshot-sha256=${snapshotSha256} revision=${snapshot.revision.revision} track=${snapshot.track}\n\n` : "";
  const content = header + cues.map(cue => `${format === "srt" ? cue.index : cue.id}\n${subtitleTimestamp(cue.startMs, format === "srt" ? "," : ".")} --> ${subtitleTimestamp(cue.endMs, format === "srt" ? "," : ".")}\n${payload((cue.label ? `${cue.label}: ` : "") + cue.text, cue.id)}\n`).join("\n");
  return { content, cues, omitted };
};
