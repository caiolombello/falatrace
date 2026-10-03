import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { PLAYER_SCRIPT } from "./python";
import { parsePlayerTranscript } from "./transcript";
import type { Transcript } from "../jobs/types";

export type RecordingPlayerOptions = {
  startSeconds?: number;
  transcriptPath?: string;
  transcript?: Transcript;
  warnings?: string[];
  title?: string;
};

const validatePath = (path: string, label: string): string => {
  if (typeof path !== "string" || !path || /[\0\r\n]/.test(path)) {
    throw new Error(`${label} deve ser um caminho absoluto ou uma URL HTTPS segura.`);
  }
  if (path.startsWith("/")) return path;
  let parsed: URL;
  try { parsed = new URL(path); } catch { throw new Error(`${label} deve ser um caminho absoluto ou uma URL HTTPS segura.`); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`${label} deve usar uma URL HTTPS sem usuário ou senha.`);
  }
  return parsed.toString();
};

export const normalizePlayerOptions = (
  path: string,
  options: RecordingPlayerOptions = {}
): RecordingPlayerOptions & { path: string } => {
  validatePath(path, "O vídeo");
  if (
    options.startSeconds !== undefined &&
    (!Number.isFinite(options.startSeconds) || options.startSeconds < 0)
  ) {
    throw new Error("O início da reprodução deve ser um número finito não negativo.");
  }
  if (options.transcriptPath !== undefined && (!options.transcriptPath.startsWith("/") || /[\0\r\n]/.test(options.transcriptPath))) {
    throw new Error("A transcrição deve ser um caminho absoluto local.");
  }
  return { path, ...options };
};

export const launchRecordingPlayer = async (
  path: string,
  options: RecordingPlayerOptions = {}
): Promise<void> => {
  const normalized = normalizePlayerOptions(path, options);
  let transcript = parsePlayerTranscript(normalized.transcript);
  if (normalized.transcript === undefined && normalized.transcriptPath) {
    const stat = await fs.lstat(normalized.transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error("A transcrição não é um arquivo local válido");
    try { transcript = parsePlayerTranscript(JSON.parse(await fs.readFile(normalized.transcriptPath, "utf8"))); }
    catch { transcript = parsePlayerTranscript(null); }
  }
  if (normalized.path.startsWith("/")) {
    let stat;
    try {
      stat = await fs.lstat(normalized.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("O vídeo não é um arquivo regular disponível para reprodução.");
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("O vídeo não é um arquivo regular disponível para reprodução.");
    }
  }
  const child = spawn("/usr/bin/python3", ["-c", PLAYER_SCRIPT], {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"]
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Tempo esgotado ao abrir o player."));
    }, 20_000);
    const stdout = createInterface({ input: child.stdout! });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdout.close();
      child.stdout?.destroy();
      if (error) { child.kill("SIGTERM"); reject(error); } else resolve();
    };
    stdout.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { event?: string; error?: string };
        if (message.event === "ready") finish();
        if (message.event === "error") finish(new Error(`Falha ao abrir o player: ${message.error || "erro desconhecido"}`));
      } catch {
        // Ignore non-protocol output from GTK/libmpv startup.
      }
    });
    child.stdin!.on("error", () => finish(new Error("Falha ao enviar a configuração ao player.")));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (!settled) finish(new Error(`Falha ao abrir o player (${code ?? signal ?? "processo encerrado"}).`));
    });
    child.once("spawn", () => child.unref());
    child.stdin!.end(JSON.stringify({ ...normalized, transcript: { ...transcript, warnings: normalized.warnings || [] } }));
  });
};
