import { runCommand } from "../jobs/command";
import { randomBytes } from "node:crypto";

const unverified = (): never => { throw new Error("Paid transcription not sent: audio signal could not be verified; media preserved"); };

/** Accept only the final Overall report from the owned astats instance.
 * Input/container metadata is untrusted and can contain metric-looking text. */
export const assertPaidAudioMeasurement = (stderr: string, filterId: string): void => {
  if (!/^[a-z0-9_]{1,96}$/.test(filterId)) unverified();
  const prefix = new RegExp(`^\\[astats@${filterId}\\s+@\\s+(0x[0-9a-fA-F]+)\\]\\s*(.*?)\\s*$`);
  let instance: string | undefined;
  let peak: string | undefined;
  let samples: string | undefined;
  let invalid = false;
  for (const line of stderr.split(/\r?\n/)) {
    const metric = line.match(prefix);
    if (!metric) continue;
    if (metric[2] === "Overall") {
      instance = metric[1]; peak = samples = undefined; invalid = false;
    } else if (instance === metric[1]) {
      if (metric[2].startsWith("Peak level dB:")) {
        if (peak !== undefined) invalid = true;
        peak = metric[2].slice("Peak level dB:".length).trim();
      } else if (metric[2].startsWith("Number of samples:")) {
        if (samples !== undefined) invalid = true;
        samples = metric[2].slice("Number of samples:".length).trim();
      }
    }
  }
  if (invalid || !instance || !samples || !/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(samples) ||
      !Number.isSafeInteger(Number(samples)) || Number(samples) <= 0 || !peak) return unverified();
  if (peak === "-inf") throw new Error("Paid transcription not sent: complete selected audio is digital silence; media preserved");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(peak) || !Number.isFinite(Number(peak))) unverified();
};

/** Conservative paid-dispatch preflight for the extracted mono audio.
 * No minimum duration or VAD threshold: a short or quiet utterance is valid.
 * Reject only a complete decoded stream with zero amplitude (digital silence),
 * or an unknown/unreadable measurement. Never sample just the first minute. */
export const assertPaidAudioSignal = async (audioPath: string, signal?: AbortSignal): Promise<void> => {
  // The per-run instance name cannot be supplied by media metadata.
  const filterId = `falatrace_paid_${randomBytes(12).toString("hex")}`;
  const { stderr } = await runCommand("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-i", audioPath,
    "-map", "0:a:0", "-vn", "-af", `astats@${filterId}=metadata=0:reset=0`, "-f", "null", "-"], { signal });
  assertPaidAudioMeasurement(stderr, filterId);
};
