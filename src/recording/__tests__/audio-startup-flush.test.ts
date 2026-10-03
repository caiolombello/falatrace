import { expect, test } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { buildCaptureCommand, type AudioSources } from "../capture";

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
const DEADLINE_MS = 2500;
const inputLabels = { desktop: "synthetic-desktop.monitor", microphone: "synthetic-microphone" };
const silent = "anullsrc=r=48000:cl=stereo";
const quiet = (frequency: number): string => `sine=frequency=${frequency}:sample_rate=48000,volume=0.01,aformat=channel_layouts=stereo`;
const processStart = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
type Owned = { child: ChildProcess; pid: number; start: string; close: Promise<number | null>; closed: boolean; stderr: string };

function syntheticInputs(args: string[], expressions: Record<string, string>): string[] {
  let replacements = 0;
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" && args[i + 1] === "pulse") {
      if (args[i + 2] !== "-i" || !Object.prototype.hasOwnProperty.call(expressions, args[i + 3])) throw new Error("Unexpected Pulse input in the real capture command");
      result.push("-re", "-t", "3", "-f", "lavfi", "-i", expressions[args[i + 3]]); i += 3; replacements++;
    } else result.push(args[i]);
  }
  if (replacements !== Object.keys(expressions).length || result.includes("pulse") || Object.keys(expressions).some(name => result.includes(name))) throw new Error("Synthetic replacement did not cover exactly the requested inputs");
  return result;
}

function begin(args: string[], outputChunks?: Buffer[]): Owned {
  const child = spawn("/usr/bin/ffmpeg", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("Synthetic FFmpeg failed to spawn");
  let owned!: Owned;
  const close = new Promise<number | null>(done => {
    child.once("close", code => { owned.closed = true; done(code); });
    child.once("error", () => { owned.closed = true; done(-1); });
  });
  owned = { child, pid: child.pid, start: processStart(child.pid), close, closed: false, stderr: "" };
  child.stdout!.on("data", b => outputChunks?.push(Buffer.from(b)));
  child.stderr!.on("data", b => { if (owned.stderr.length < 16384) owned.stderr += b.toString().slice(0, 16384 - owned.stderr.length); });
  return owned;
}

function signal(owned: Owned, value: NodeJS.Signals): void {
  if (owned.closed || owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  if (processStart(owned.pid) !== owned.start) throw new Error("Synthetic FFmpeg identity changed; refusing to signal");
  if (!owned.child.kill(value)) throw new Error("Synthetic FFmpeg signal was not accepted");
}

async function finalize(owned: Owned): Promise<number | null> {
  for (const value of ["SIGINT", "SIGTERM", "SIGKILL"] as NodeJS.Signals[]) {
    if (owned.closed) break;
    signal(owned, value);
    await Promise.race([owned.close, pause(1000)]);
  }
  if (!owned.closed) throw new Error("Own synthetic FFmpeg cleanup did not complete");
  return owned.close;
}

async function collect(command: "ffprobe" | "ffmpeg", args: string[], binary = false): Promise<string | Buffer> {
  if (command === "ffmpeg") {
    const chunks: Buffer[] = [], owned = begin(args, chunks);
    try {
      const result = await Promise.race([owned.close.then(code => ({ code })), pause(5000).then(() => ({ code: -1 }))]);
      if (result.code !== 0) throw new Error("Synthetic decoder failed");
      return Buffer.concat(chunks);
    } finally { if (!owned.closed) await finalize(owned); }
  }
  const child = spawn("/usr/bin/ffprobe", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("Synthetic ffprobe failed to spawn");
  const start = processStart(child.pid), chunks: Buffer[] = [];
  let closed = false;
  const ending = new Promise<number | null>(done => { child.once("close", code => { closed = true; done(code); }); child.once("error", () => { closed = true; done(-1); }); });
  child.stdout!.on("data", b => chunks.push(Buffer.from(b))); child.stderr!.on("data", () => {});
  try {
    const result = await Promise.race([ending.then(code => ({ code })), pause(5000).then(() => ({ code: -1 }))]);
    if (result.code !== 0) throw new Error("Synthetic ffprobe failed");
    const b = Buffer.concat(chunks); return binary ? b : b.toString();
  } finally {
    if (!closed) {
      if (processStart(child.pid) !== start) throw new Error("Synthetic ffprobe identity changed");
      child.kill("SIGKILL"); await Promise.race([ending, pause(1000)]);
      if (!closed) throw new Error("Own synthetic ffprobe cleanup did not complete");
    }
  }
}

const rms = (b: Buffer): number => {
  if (!b.length || b.length % 4) throw new Error("Malformed synthetic decoded PCM");
  let energy = 0;
  for (let i = 0; i < b.length; i += 4) { const value = b.readFloatLE(i); if (!Number.isFinite(value)) throw new Error("Nonfinite synthetic PCM"); energy += value * value; }
  return Math.sqrt(energy / (b.length / 4));
};
const pcmHash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const withoutFlushOption = (args: string[]): string[] => {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-flush_packets") { if (!/^[01]$/.test(args[i + 1])) throw new Error("Unexpected flush option value"); i++; }
    else result.push(args[i]);
  }
  return result;
};
const decode = async (output: string, index: number): Promise<Buffer> => await collect("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", output, "-map", `0:a:${index}`, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], true) as Buffer;

type Scenario = { name: string; sources: AudioSources; expressions: Record<string, string>; titles: string[]; silence: boolean };
const scenarios: Scenario[] = [
  { name: "silence", sources: { desktop: inputLabels.desktop }, expressions: { [inputLabels.desktop]: silent }, titles: ["desktop"], silence: true },
  { name: "quiet-tone", sources: { desktop: inputLabels.desktop }, expressions: { [inputLabels.desktop]: quiet(440) }, titles: ["desktop"], silence: false },
  { name: "two-input-three-track", sources: { microphone: inputLabels.microphone, desktop: inputLabels.desktop }, expressions: { [inputLabels.microphone]: quiet(440), [inputLabels.desktop]: quiet(660) }, titles: ["Mixed", "Microphone", "Desktop"], silence: false },
];

for (const scenario of scenarios) test(`real audio command exposes startup media while alive: ${scenario.name}`, async () => {
  if (process.env.FALATRACE_QA_ISOLATED !== "1" || !process.env.TMPDIR?.startsWith(`${process.env.FALATRACE_QA_ROOT}/`)) throw new Error("Run this test through scripts/test-offline.sh only");
  const tmp = await fs.mkdtemp(join(process.env.TMPDIR, "startup-flush-")), output = join(tmp, "recording.mka");
  let owned: Owned | undefined, baselineOwned: Owned | undefined, observedWhileAlive = false, firstVisibleMs: number | null = null, stopped = false;
  const receipt: Record<string, unknown> = { kind: "offline-native-synthetic-startup-flush", scenario: scenario.name, visibilityDeadlineMs: DEADLINE_MS, inputSubstitutionOnly: true, devices: 0, serviceCalls: 0, providerCalls: 0 };
  try {
    const command = buildCaptureCommand("audio", { ...DEFAULT_CONFIG.capture, audioSource: scenario.titles.length === 3 ? "both" : "desktop" }, scenario.sources, output, join(tmp, "unused-token"));
    expect(command.command).toBe("ffmpeg");
    const args = syntheticInputs(command.args, scenario.expressions);
    // No output argument/format/muxer/codec is changed by the test.
    const outputStart = command.args.indexOf("-c:a");
    expect(args.slice(args.indexOf("-c:a"))).toEqual(command.args.slice(outputStart));
    const startedAt = Date.now(); owned = begin(args);
    while (Date.now() - startedAt < DEADLINE_MS) {
      if (owned.closed || owned.child.exitCode !== null || owned.child.signalCode !== null) throw new Error("Synthetic capture exited before the readiness deadline");
      const positive = await fs.stat(output).then(s => s.isFile() && s.size > 0).catch(() => false);
      if (positive && !owned.closed && owned.child.exitCode === null && owned.child.signalCode === null && processStart(owned.pid) === owned.start) {
        observedWhileAlive = true; firstVisibleMs ??= Date.now() - startedAt;
      }
      await pause(25);
    }
    const code = await Promise.race([owned.close, pause(2500).then(() => -1)]); stopped = owned.closed;
    expect(code).toBe(0); expect(stopped).toBe(true);
    const probe = JSON.parse(await collect("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]) as string);
    const streams = probe.streams.filter((s: any) => s.codec_type === "audio");
    expect(streams).toHaveLength(scenario.titles.length);
    expect(streams.map((s: any) => s.codec_name)).toEqual(scenario.titles.map(() => "flac"));
    expect(streams.map((s: any) => s.sample_rate)).toEqual(scenario.titles.map(() => "48000"));
    expect(streams.map((s: any) => s.tags?.title)).toEqual(scenario.titles);
    const duration = Number(probe.format.duration);
    expect(duration).toBeCloseTo(3, 2);
    const values: number[] = [], sampleCounts: number[] = [], pcmHashes: string[] = [];
    for (let i = 0; i < streams.length; i++) {
      const pcm = await decode(output, i);
      values.push(rms(pcm)); sampleCounts.push(pcm.length / 4); pcmHashes.push(pcmHash(pcm));
      expect(pcm.length / 4).toBe(144000);
    }
    if (scenario.silence) expect(values[0]).toBe(0);
    else for (const value of values) { expect(value).toBeGreaterThan(0.0005); expect(value).toBeLessThan(0.002); }
    if (streams.length === 3) { expect(values[0]).toBeGreaterThan(values[1] * 1.15); expect(values[0]).toBeGreaterThan(values[2] * 1.15); }
    // Control keeps the same real builder, synthetic inputs and duration, omitting
    // only the proposed flush output option; its decoded PCM must match exactly.
    const baselineOutput=join(tmp,"baseline.mka");
    const baselineCommand=buildCaptureCommand("audio",{...DEFAULT_CONFIG.capture,audioSource:scenario.titles.length===3?"both":"desktop"},scenario.sources,baselineOutput,join(tmp,"unused-token"));
    baselineOwned=begin(withoutFlushOption(syntheticInputs(baselineCommand.args,scenario.expressions)));
    const baselineCode=await Promise.race([baselineOwned.close,pause(5000).then(()=>-1)]);expect(baselineCode).toBe(0);
    const baselineProbe=JSON.parse(await collect("ffprobe",["-v","error","-show_streams","-show_format","-of","json",baselineOutput])as string);
    expect(baselineProbe.streams.map((s:any)=>({codec:s.codec_name,rate:s.sample_rate,title:s.tags?.title}))).toEqual(streams.map((s:any)=>({codec:s.codec_name,rate:s.sample_rate,title:s.tags?.title})));
    expect(Number(baselineProbe.format.duration)).toBe(duration);
    const baselineHashes:string[]=[];
    for(let i=0;i<streams.length;i++){const pcm=await decode(baselineOutput,i);expect(pcm.length/4).toBe(sampleCounts[i]);expect(rms(pcm)).toBe(values[i]);baselineHashes.push(pcmHash(pcm));}
    expect(baselineHashes).toEqual(pcmHashes);
    Object.assign(receipt, { observedPositiveFileWhileAlive: observedWhileAlive, firstVisibleMs, codec: "flac", sampleRate: 48000, trackTitles: scenario.titles, durationSeconds: duration, decodedSampleCounts: sampleCounts, rms: values, pcmSha256:pcmHashes, baselinePcmExactlyEqual:true, integrityVerified: true });
    // Assert readiness after integrity validation so RED identifies delayed visibility,
    // independently of valid container finalization and synthetic audio integrity.
    expect(observedWhileAlive).toBe(true);
  } finally {
    if (owned && !owned.closed) await finalize(owned);
    if(baselineOwned&&!baselineOwned.closed)await finalize(baselineOwned);
    stopped = (!owned || owned.closed)&&(!baselineOwned||baselineOwned.closed);
    if (stopped) await fs.rm(tmp, { recursive: true, force: true });
    Object.assign(receipt, { ownCaptureStopped: stopped, temporaryFilesRemoved: await fs.lstat(tmp).then(() => false).catch((e: any) => e.code === "ENOENT") });
    console.log(JSON.stringify(receipt));
    expect(stopped).toBe(true); expect(receipt.temporaryFilesRemoved).toBe(true);
  }
}, 15000);
