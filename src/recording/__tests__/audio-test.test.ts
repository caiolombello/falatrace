import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { runAudioTest } from "../audio-test";

test("the audio test records briefly into a private folder, labels tracks and deletes everything", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-audiotest-root-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const commands: string[][] = [];
    let output = "";
    const result = await runAudioTest(config, 4, {
      tempRoot: root,
      inspect: async () => ({ available: ["mic", "sink.monitor"], selected: { microphone: "mic", desktop: "sink.monitor" }, warnings: [] }),
      run: async (command, args) => {
        commands.push([command, ...args]);
        output = args[args.length - 1];
        await fs.writeFile(output, "synthetic");
        return { stdout: "", stderr: "" };
      },
      check: async (path) => {
        expect(path).toBe(output);
        return {
          durationSeconds: 4, sampledSeconds: 4, windows: [], warnings: [],
          tracks: [
            { index: 0, title: "Mixed", sourceRole: "unverified", hasSignal: true, peakDb: -10, longestSilenceSeconds: 0, windows: [] },
            { index: 1, title: "Microphone", sourceRole: "unverified", hasSignal: false, peakDb: null, longestSilenceSeconds: 4, windows: [] },
            { index: 2, title: "Desktop", sourceRole: "unverified", hasSignal: true, peakDb: -20, longestSilenceSeconds: 0, windows: [] }
          ]
        } as never;
      }
    });
    expect(commands[0][0]).toBe("ffmpeg");
    expect(commands[0].slice(-3)).toEqual(["-t", "4", output]);
    expect(result.tracks.map((track) => track.label)).toEqual(["Mistura", "Microfone", "Áudio do sistema"]);
    expect(result.warnings).toEqual(["O microfone ficou em silêncio: fale durante o teste e confira se ele não está mutado."]);
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the audio test refuses no sources, bad durations and explains unavailable devices", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const never = { tempRoot: tmpdir(), run: async () => { throw new Error("must not run"); }, check: async () => { throw new Error("x"); } } as never;
  await expect(runAudioTest(config, 30, never)).rejects.toThrow("2 a 15");
  config.capture.audioSource = "none";
  await expect(runAudioTest(config, 5, never)).rejects.toThrow("Nenhuma fonte");
  config.capture.audioSource = "both";
  await expect(runAudioTest(config, 5, { ...(never as object), inspect: async () => { throw new Error("Audio device unavailable: usb-mic (microphone)"); } } as never))
    .rejects.toThrow("Dispositivo de áudio indisponível: usb-mic, usado como microfone.");
});
