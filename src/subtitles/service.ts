import { basename, resolve } from "node:path";
import { runCommand } from "../jobs/command";
import { validateJobId } from "../jobs/types";
import { getServiceLaunchCommand } from "../runtime/launcher";

export const queueAlignedSubtitles = async (id: string): Promise<string> => {
  validateJobId(id);
  const launch = getServiceLaunchCommand();
  const unit = `recording-cli-subtitles-${id}`;
  await runCommand("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec",
    "--property=Nice=10", "--property=TimeoutStartSec=infinity", "--property=UMask=0077",
    "--description=Generate aligned recording subtitles", ...launch, "subtitles", "create", id], { timeoutMs: 15_000 });
  return `${unit}.service`;
};
