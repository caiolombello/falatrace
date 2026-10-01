import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { hashFile } from "../jobs/store";
import { runCommand } from "../jobs/command";
import { acquireSingleton } from "../runtime/singleton";
import type { VisualPlan } from "./plan";

export type VisualResult = {
  version: 1; key: string; mediaSha256: string; round: number;
  frames: Array<{ file: string; timestampSeconds: number; sha256: string; bytes: number }>;
  totalBytes: number; reused: boolean;
};

const assertPlan = (plan: VisualPlan): void => {
  const {key,...data} = plan;
  if (!/^[a-f0-9]{64}$/.test(key) || createHash("sha256").update(JSON.stringify(data)).digest("hex") !== key ||
      data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.mediaSha256) || ![1,2].includes(data.round) ||
      data.maxDimension !== 1280 || data.maxBytesPerFrame !== 2*1024*1024 || data.maxTotalBytes !== 8*1024*1024 ||
      !Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0 || data.durationSeconds > 86400 ||
      !Array.isArray(data.requests) || data.requests.length > 8 || data.requests.some((request, index) => !Number.isFinite(request.timestampSeconds) || request.timestampSeconds < 0 || request.timestampSeconds >= data.durationSeconds || data.requests.slice(0,index).some((previous) => Math.abs(previous.timestampSeconds-request.timestampSeconds) < .25))) throw new Error("Visual plan is invalid or modified");
};

export const readCache = async (directory: string, plan: VisualPlan): Promise<VisualResult | undefined> => {
  try {
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Unsafe visual cache");
    const manifest = join(directory,"frames.json"); const stat = await fs.lstat(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64000) throw new Error("Invalid visual cache manifest");
    const result = JSON.parse(await fs.readFile(manifest,"utf8")) as VisualResult;
    if (result.key !== plan.key || result.mediaSha256 !== plan.mediaSha256 || result.round !== plan.round || !Array.isArray(result.frames) || result.frames.length !== plan.requests.length) throw new Error("Visual cache identity mismatch");
    let total = 0;
    for (const [index,frame] of result.frames.entries()) {
      if (frame.file !== `frame-${index}.jpg` || frame.timestampSeconds !== plan.requests[index].timestampSeconds) throw new Error("Invalid cached frame");
      const path = join(directory,frame.file); const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > plan.maxBytesPerFrame || stat.size !== frame.bytes || await hashFile(path) !== frame.sha256) throw new Error("Cached frame checksum mismatch");
      total += stat.size;
    }
    if (total > plan.maxTotalBytes || result.totalBytes !== total) throw new Error("Visual cache byte budget mismatch");
    return { ...result, reused: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await fs.lstat(directory).catch(() => undefined))) return undefined;
    throw error;
  }
};

const extractVisualEvidenceOwned = async (
  plan: VisualPlan, sourcePath: string, outputRoot: string,
  options: { signal?: AbortSignal; run?: typeof runCommand; byteBudget?: number } = {}
): Promise<VisualResult> => {
  assertPlan(plan); options.signal?.throwIfAborted();
  if (plan.requests.length === 0) return { version:1,key:plan.key,mediaSha256:plan.mediaSha256,round:plan.round,frames:[],totalBytes:0,reused:false };
  const byteBudget = options.byteBudget ?? plan.maxTotalBytes;
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > plan.maxTotalBytes) throw new Error("Invalid remaining visual byte budget");
  const source = await fs.lstat(sourcePath);
  if (!source.isFile() || source.isSymbolicLink() || source.size <= 0 || await hashFile(sourcePath) !== plan.mediaSha256) throw new Error("Visual source changed or is not a regular file");
  await fs.mkdir(outputRoot,{recursive:true,mode:0o700}); const root = await fs.lstat(outputRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Visual output root must be a regular directory");
  const lease = await acquireSingleton(`visual-${plan.key.slice(0,32)}`);
  const final = join(outputRoot,plan.key); const staging = join(outputRoot,`.${plan.key}-${randomUUID()}.partial`);
  try {
    const existing = await readCache(final,plan); if (existing) { if(existing.totalBytes > byteBudget) throw new Error("Visual cache exceeds remaining byte budget"); return existing; }
    await fs.mkdir(staging,{mode:0o700}); const frames: VisualResult["frames"] = []; let totalBytes = 0;
    for (const [index,request] of plan.requests.entries()) {
      options.signal?.throwIfAborted(); const file = `frame-${index}.jpg`; const path = join(staging,file);
      await (options.run || runCommand)("ffmpeg",["-nostdin","-v","error","-ss",String(request.timestampSeconds),"-accurate_seek","-i",sourcePath,"-frames:v","1","-vf","scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease","-q:v","3","-y",path],{timeoutMs:30000,signal:options.signal});
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > plan.maxBytesPerFrame || totalBytes + stat.size > byteBudget) throw new Error("Extracted frame exceeds its byte budget or is invalid");
      await fs.chmod(path,0o600); totalBytes += stat.size;
      frames.push({file,timestampSeconds:request.timestampSeconds,sha256:await hashFile(path),bytes:stat.size});
    }
    options.signal?.throwIfAborted();
    if (await hashFile(sourcePath) !== plan.mediaSha256) throw new Error("Visual source changed during extraction");
    const result: VisualResult = { version:1,key:plan.key,mediaSha256:plan.mediaSha256,round:plan.round,frames,totalBytes,reused:false };
    await fs.writeFile(join(staging,"frames.json"),JSON.stringify(result,null,2),{mode:0o600,flag:"wx"});
    options.signal?.throwIfAborted(); await fs.rename(staging,final); return result;
  } finally { await fs.rm(staging,{recursive:true,force:true}); await lease.release(); }
};

// Admit before the per-plan lease: consistent lock order for standalone callers too.
export const extractVisualEvidence = (...args: Parameters<typeof extractVisualEvidenceOwned>): Promise<VisualResult> => {
  assertPlan(args[0]);
  return withHeavyAdmission('command', args[0].mediaSha256, () => extractVisualEvidenceOwned(...args), { signal: args[3]?.signal, onWait: cliAdmissionWait });
};
