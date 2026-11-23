import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { probeMedia } from "../jobs/media";
import { runCommandDirect } from "../jobs/command";
import { captureMediaStartedAt, type RecordingSession } from "./session";

export function audioPartPath(session: RecordingSession, index: number): string {
  return join(dirname(session.outputPath), `audio-part-${index}.mka`);
}

/** Keep the wall-clock offsets of later parts for notes. Copy every FLAC track
 * into a new container only after Stop. Originals remain recoverable on failure. */
export async function joinAudioParts(session: RecordingSession): Promise<string> {
  const starts = [Date.parse(captureMediaStartedAt(session)), ...(session.audioPartStarts ?? [])];
  const directory = dirname(session.outputPath);
  const parts: { path: string; duration: number; start: number; size: number }[] = [];
  for (const [index, start] of starts.entries()) {
    const path = audioPartPath(session, index);
    const stat = await fs.stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    // A restart may have failed before its first packet.
    if (!stat?.size && index === starts.length - 1) break;
    if (!stat?.isFile()) throw Error("Um trecho de áudio está indisponível.");
    parts.push({ path, duration: await probeMedia(path), start, size: stat.size });
  }
  if (parts.length === 1) return session.outputPath;
  if (!parts.length) throw Error("Nenhum trecho de áudio disponível para finalizar.");
  const space = await fs.statfs(directory);
  if (space.bavail * space.bsize < parts.reduce((size, part) => size + part.size, 0)) {
    throw Error("Espaço insuficiente para unir a gravação. Os trechos estão preservados.");
  }
  const files: string[] = [];
  const chapters = [";FFMETADATA1"];
  let elapsed = 0;
  for (const [i, part] of parts.entries()) {
    if (i > 0) {
      const ms = Math.round(elapsed * 1000);
      chapters.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${ms}`, `END=${ms + 1}`, "title=Retomada após troca de áudio");
    }
    files.push(`file '${basename(part.path)}'`);
    const next = parts[i + 1];
    const duration = next ? Math.max(part.duration, (next.start - part.start) / 1000) : part.duration;
    if (next) files.push(`duration ${duration}`);
    elapsed += duration;
  }
  const nonce = randomUUID();
  const manifest = join(directory, `audio-${nonce}.ffconcat`);
  const temporary = join(directory, `joined-${nonce}.mka`);
  const output = session.outputPath;
  const metadata = join(directory, `audio-${nonce}.ffmeta`);
  try {
    await fs.writeFile(manifest, ["ffconcat version 1.0", ...files].join("\n") + "\n", { flag: "wx", mode: 0o600 });
    await fs.writeFile(metadata, chapters.join("\n") + "\n", { flag: "wx", mode: 0o600 });
    await runCommandDirect("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-n", "-f", "concat", "-safe", "1",
      "-i", manifest, "-f", "ffmetadata", "-i", metadata, "-map", "0", "-map_chapters", "1", "-c", "copy", temporary]);
    const actual = await probeMedia(temporary);
    if (Math.abs(actual - elapsed) > 0.25) {
      throw Error("A duração da gravação unida diverge dos trechos. Os arquivos originais foram preservados.");
    }
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, output);
    return output;
  } finally {
    await Promise.all([manifest, metadata, temporary].map(path => fs.rm(path, { force: true })));
  }
}
