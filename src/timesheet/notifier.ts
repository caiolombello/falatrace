import { runCommand } from "../jobs/command";
import type { TimeEntry } from "./types";

const notify = async (title: string, body: string): Promise<void> => {
  await runCommand("notify-send", [
    "--app-name=FalaTrace",
    "--icon=appointment-new-symbolic",
    title.slice(0, 200),
    body.slice(0, 500)
  ], { timeoutMs: 5_000 });
};

export const notifyTimeEntryClassified = async (
  entry: TimeEntry
): Promise<void> => {
  if (entry.status === "ready") {
    await notify(
      "Apontamento de horas pronto",
      `${entry.clientCode} · ${entry.taskTypeName} · ${(entry.hours || 0).toFixed(2)} h`
    );
    return;
  }
  await notify(
    "Apontamento precisa de revisão",
    `${entry.activityDate} · ${entry.hours?.toFixed(2) || "?"} h · abra a TUI para completar`
  );
};
