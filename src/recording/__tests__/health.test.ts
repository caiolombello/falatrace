import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../jobs/command";
import { checkRecordingAudio } from "../health";

test("reports a silent transcription track separately from an audible isolated track", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-health-"));
  try {
    const path = join(root, "audio.mka");
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "0.2",
      "-map", "0:a", "-map", "1:a", "-c:a", "flac", path]);
    const report = await checkRecordingAudio(path);
    expect(report.tracks).toHaveLength(2);
    expect(report.tracks[0].hasSignal).toBe(false);
    expect(report.tracks[1].hasSignal).toBe(true);
    expect(report.warnings.join(" ")).toContain("transcription");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
