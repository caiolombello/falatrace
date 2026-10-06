import { loadConfig } from "../config/load";
import {
  WHISPER_MODELS, downloadWhisperModel, findWhisperModel, isVerifiedWhisperModel, pullOllamaModel,
  whisperModelsDir, writeDownloadState
} from "../models/downloads";

export const MODELS_HELP = `Models (explicit downloads only):
  models list                    Whisper models with size, SHA-256 and install state
  models download <id>           Download and verify one Whisper model (see models list)
  models ollama-pull <model>     Ask the local Ollama server to pull a model
`;

const formatBytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;

export const runModelsCli = async (args: string[]): Promise<void> => {
  const [, subcommand, target] = args;
  if (subcommand === "list" || !subcommand) {
    const directory = whisperModelsDir();
    const { join } = await import("node:path");
    const models = await Promise.all(WHISPER_MODELS.map(async (model) => {
      const installed = await isVerifiedWhisperModel(model, join(directory, model.file));
      return { id: model.id, file: model.file, size: formatBytes(model.bytes), sha256: model.sha256, installed, recommended: !!model.recommended };
    }));
    console.log(JSON.stringify({ directory, models }, null, 2));
    return;
  }
  if (subcommand === "download") {
    const model = findWhisperModel(target);
    const directory = whisperModelsDir();
    let last = 0;
    // Cancelling stops the unit with SIGTERM: abort the transfer so the partial file is removed.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      const { path, verified } = await downloadWhisperModel(model.id, {
        fetch,
        directory,
        signal: controller.signal,
        onProgress: async (received) => {
          await writeDownloadState({ kind: "whisper", id: model.id, state: "running", receivedBytes: received, totalBytes: model.bytes });
          if (process.stderr.isTTY && received - last > 32 * 1024 * 1024) {
            last = received;
            process.stderr.write(`\r${formatBytes(received)} / ${formatBytes(model.bytes)}`);
          }
        }
      });
      await writeDownloadState({ kind: "whisper", id: model.id, state: "completed", receivedBytes: model.bytes, totalBytes: model.bytes, path, verified });
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(JSON.stringify({ id: model.id, path, verified: true }));
    } catch (error) {
      const message = controller.signal.aborted ? "Download cancelado." : (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await writeDownloadState({ kind: "whisper", id: model.id, state: "failed", receivedBytes: 0, totalBytes: model.bytes, error: message });
      throw error;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
    return;
  }
  if (subcommand === "ollama-pull") {
    if (!target) throw new Error("Informe o modelo, por exemplo: models ollama-pull qwen3.5:9b");
    const { config } = await loadConfig();
    try {
      await pullOllamaModel(config.summary.ollamaUrl, target, {
        fetch,
        onProgress: (completed, total) => writeDownloadState({ kind: "ollama", id: target, state: "running", receivedBytes: completed, totalBytes: total })
      });
      await writeDownloadState({ kind: "ollama", id: target, state: "completed", receivedBytes: 0, totalBytes: null });
      console.log(JSON.stringify({ model: target, pulled: true }));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await writeDownloadState({ kind: "ollama", id: target, state: "failed", receivedBytes: 0, totalBytes: null, error: message });
      throw error;
    }
    return;
  }
  throw new Error("Use: models list | models download <id> | models ollama-pull <model>");
};
