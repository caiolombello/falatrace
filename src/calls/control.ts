import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../jobs/store";
import { getCallStatusPath } from "./status";

export type AutomationState = { version: 1; paused: boolean; updatedAt?: string };

export const getAutomationStatePath = (): string =>
  join(dirname(getCallStatusPath()), "automation.json");

export const readAutomationState = async (path = getAutomationStatePath()): Promise<AutomationState> => {
  try {
    const state = JSON.parse(await fs.readFile(path, "utf8")) as AutomationState;
    if (state?.version !== 1 || typeof state.paused !== "boolean" ||
      (state.updatedAt !== undefined && !Number.isFinite(Date.parse(state.updatedAt)))) {
      throw new Error("Estado da automação inválido; retome ou suspenda a automação explicitamente.");
    }
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, paused: false };
    throw err;
  }
};

export const setAutomationPaused = async (paused: boolean, path = getAutomationStatePath()): Promise<AutomationState> => {
  if (typeof paused !== "boolean") throw new Error("O estado de pausa deve ser booleano.");
  const state: AutomationState = { version: 1, paused, updatedAt: new Date().toISOString() };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, state);
  return state;
};
