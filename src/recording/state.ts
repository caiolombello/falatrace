import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RecordingBackend } from "../config/defaults";

const STATE_DIR = join(homedir(), ".config", "recording-cli");
const STATE_PATH = join(STATE_DIR, "state.json");

export type RecordingState = {
  backend: RecordingBackend;
  pid?: number;
  videoPid?: number;
  outputPath: string;
  audioPath?: string;
  videoPath?: string;
  startedAt: string;
};

export const getStatePath = (): string => STATE_PATH;

export const readState = async (): Promise<RecordingState | null> => {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw) as RecordingState;
  } catch {
    return null;
  }
};

export const writeState = async (state: RecordingState): Promise<void> => {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
};

export const clearState = async (): Promise<void> => {
  try {
    await fs.unlink(STATE_PATH);
  } catch {
    // ignore missing state
  }
};
