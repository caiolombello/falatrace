import { basename, resolve } from "node:path";
import { runCommand } from "../jobs/command";
import { validateJobId } from "../jobs/types";
import { getServiceLaunchCommand } from "../runtime/launcher";
import { transientUnitEnvironment } from "../runtime/systemd-units";

export const queueAlignedSubtitles = async (id: string, run: typeof runCommand = runCommand): Promise<string> => {
  validateJobId(id);
  const launch = getServiceLaunchCommand();
  const unit = `recording-cli-subtitles-${id}`;
  // The unit reads the job this process sees: same PATH and XDG directories.
  await run("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec",
    "--property=Nice=10", "--property=TimeoutStartSec=infinity", "--property=UMask=0077",
    "--description=Generate aligned recording subtitles", ...transientUnitEnvironment(), "--", ...launch, "subtitles", "create", id], { timeoutMs: 15_000 });
  return `${unit}.service`;
};
