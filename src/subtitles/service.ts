import { basename, resolve } from "node:path";
import { runCommand } from "../jobs/command";
import { validateJobId } from "../jobs/types";

export const queueAlignedSubtitles = async (id: string): Promise<string> => {
  validateJobId(id);
  const name = basename(process.execPath);
  const launch = name === "bun" || name.startsWith("bun-") ? [process.execPath, resolve(import.meta.dir, "../cli/index.ts")] : [process.execPath];
  const unit = `recording-cli-subtitles-${id}`;
  await runCommand("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec",
    "--property=Nice=10", "--property=TimeoutStartSec=infinity", "--property=UMask=0077",
    "--description=Generate aligned recording subtitles", ...launch, "subtitles", "create", id], { timeoutMs: 15_000 });
  return `${unit}.service`;
};
