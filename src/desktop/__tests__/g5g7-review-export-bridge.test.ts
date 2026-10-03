import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { parseRequest, buildReviewedBoundary } from "../bridge";
import type { ReviewedView } from "../../revisions";
import { parseReviewExportArgs } from "../../cli/review-export";

assertQaIsolation();
const repo=join(import.meta.dir,"../../..");
const id="44444444-4444-4444-8444-444444444444";
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
type Result={ok:boolean;result?:any;error?:string};
async function fixture(run:(env:NodeJS.ProcessEnv,artifact:string)=>Promise<void>) {
  const root=await fs.mkdtemp(join(process.env.TMPDIR!,"g5g7-bridge-"));
  const env:NodeJS.ProcessEnv={...process.env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"};
  try {
    for(const [key,name] of [["HOME","home"],["XDG_CONFIG_HOME","config"],["XDG_STATE_HOME","state"],["XDG_DATA_HOME","data"],["XDG_RUNTIME_DIR","runtime"],["XDG_CACHE_HOME","cache"],["TMPDIR","tmp"]]){env[key!]=join(root,name!);await fs.mkdir(env[key!]!,{mode:0o700});}
    assertQaIsolation(env);
    const artifact=join(root,"synthetic.recording",id),sourcePath=join(root,"synthetic.mkv"),state=join(env.XDG_STATE_HOME!,"recording-cli/jobs");
    await fs.mkdir(artifact,{recursive:true,mode:0o700});await fs.mkdir(state,{recursive:true,mode:0o700});
    await fs.writeFile(sourcePath,"synthetic-media",{mode:0o600});
    const job={version:1,id,createdAt:"2026-10-03T00:00:00Z",updatedAt:"2026-10-03T00:00:00Z",source:{originalName:"synthetic.mkv",mediaFile:"source.mkv",size:15,sha256:digest("synthetic-media")},sourcePath,artifactDir:artifact,target:"local",state:"completed",transcription:{provider:"whisper-cpp",model:"synthetic-local",language:"pt"},summary:{provider:"ollama",model:"synthetic-summary"}};
    await fs.writeFile(join(state,id+".json"),JSON.stringify(job),{mode:0o600});
    await fs.writeFile(join(artifact,"transcript.json"),JSON.stringify({version:1,provider:"whisper-cpp",model:"synthetic-local",language:"pt",text:"Trecho sintético com origem.",segments:[{start:1.25,end:3.5,text:"Trecho sintético com origem."}]}),{mode:0o600});
    await run(env,artifact);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}
async function child(env:NodeJS.ProcessEnv,mode:"bridge"|"cli",args:string[],request?:unknown) {
  assertQaIsolation(env);
  const process=Bun.spawn(["/usr/bin/python3","-I",join(repo,"scripts/qa-run.py"),Bun.which("bun")!,"run","--preload",join(repo,"scripts/offline-network.ts"),join(repo,mode==="bridge"?"src/desktop/bridge.ts":"src/cli/index.ts"),...args],{cwd:repo,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  if(request)process.stdin.write(JSON.stringify(request)+"\n");process.stdin.end();
  const timeout=setTimeout(()=>process.kill(),12000);
  try {const [stdout,stderr,exit]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);return {stdout,stderr,exit};}
  finally {clearTimeout(timeout);if(process.exitCode===null)process.kill();}
}
async function bridge(env:NodeJS.ProcessEnv,op:string,payload?:unknown):Promise<Result> {
  const result=await child(env,"bridge",[],{id:1,op,key:id,...(payload?{payload}:{})});
  expect(result.exit).toBe(0);expect(result.stderr).toBe("");return JSON.parse(result.stdout);
}
describe("G5/G7 real local JSONL and CLI boundaries",()=>{
  test("matching canonical/acoustic speaker codes never borrow a human name without explicit attribution",()=>{
    const segment={id:"s000000",canonicalId:id+":"+"a".repeat(64)+":s000000",originalText:"Original.",text:"Original.",start:1,end:2,speakerId:"S01",humanEdited:false,humanSpeakerEdited:false,textRange:{start:0,end:9}};
    const transcript={version:1,provider:"whisper-cpp",model:"synthetic",language:"pt",text:"Original.",segments:[{start:1,end:2,text:"Original.",speaker:"S01"}]};
    const view={original:{transcript},transcript,segments:[segment],diarization:{labels:{S01:"Nome humano da fonte acústica"},turns:[{id:"t000000",start:1,end:2,text:"Fala acústica.",speaker:"S01",label:"Nome humano da fonte acústica",humanSpeakerEdited:false}]},revision:{version:1,revision:1,base:{jobId:id,mediaSha256:"a".repeat(64),transcriptArtifactSha256:"b".repeat(64)},humanReviewed:true},notes:[],canUndo:true,derivedStale:true} as unknown as ReviewedView;
    const captions={text:"Original.",timing:"segment" as const,segments:transcript.segments};
    const acoustic={state:"review" as const,turns:[{start:1,end:2,text:"Fala acústica.",speaker:"S01",label:"Nome humano da fonte acústica"}]};
    const automatic=buildReviewedBoundary(view,captions,acoustic);
    expect(automatic.transcript.segments[0]!.speaker).toBe("S01");expect(automatic.captionTranscript.segments[0]!.speaker).toBe("S01");expect(automatic.diarization.turns![0]!.label).toBe("Nome humano da fonte acústica");
    view.segments[0]!.humanSpeakerEdited=true;
    const attributed=buildReviewedBoundary(view,captions,acoustic);expect(attributed.transcript.segments[0]!.speaker).toBe("Nome humano da fonte acústica");expect(attributed.captionTranscript.segments[0]!.speaker).toBe("S01");
    view.segments[0]!.speakerId=undefined;
    expect(buildReviewedBoundary(view,captions,acoustic).transcript.segments[0]!.speaker).toBeUndefined();
  });
  test("UI saves with explicit CAS; replay conflicts, original bytes remain and undo advances history",async()=>fixture(async(env,artifact)=>{
    const before=await fs.readFile(join(artifact,"transcript.json"));
    const cli=await child(env,"cli",["review","show",id]);expect(cli.exit).toBe(0);expect(cli.stderr).toBe("");
    const view=JSON.parse(cli.stdout),input={expectedRevision:0,base:view.revision.base,operations:[{kind:"segment-text",segmentId:"s000000",text:"Texto corrigido por pessoa."}]};
    const saved=await bridge(env,"revision-save",input);expect(saved.ok).toBe(true);expect(saved.result.revision).toBe(1);
    const replay=await bridge(env,"revision-save",input);expect(replay.ok).toBe(false);expect(replay.error).toContain("Releia");
    expect(await fs.readFile(join(artifact,"transcript.json"))).toEqual(before);
    const staleCli=await child(env,"cli",["review","apply",id,"--input",JSON.stringify(input)]);expect(staleCli.exit).toBe(2);expect(staleCli.stdout).toBe("");expect(JSON.parse(staleCli.stderr).error.code).toBe("revision-conflict");
    const invalidCli=await child(env,"cli",["review","apply",id,"--input",JSON.stringify({expectedRevision:1,base:view.revision.base})]);expect(invalidCli.exit).toBe(1);expect(invalidCli.stdout).toBe("");
    const unchanged=JSON.parse((await child(env,"cli",["review","show",id])).stdout);expect(unchanged.revision.revision).toBe(1);expect(unchanged.transcript.text).toBe("Texto corrigido por pessoa.");
    const undone=await bridge(env,"revision-undo",{expectedRevision:1,base:view.revision.base});expect(undone.ok).toBe(true);expect(undone.result.revision).toBe(2);
    const after=JSON.parse((await child(env,"cli",["review","show",id])).stdout);expect(after.transcript.text).toBe(view.original.transcript.text);expect(after.canUndo).toBe(false);
    expect(await fs.readFile(join(artifact,"transcript.json"))).toEqual(before);
  }),20000);
  test("real preview→save produces private deterministic files and refuses a stale preview",async()=>fixture(async(env)=>{
    const first=await bridge(env,"export-preview",{format:"srt",track:"transcript"});expect(first.ok).toBe(true);expect(first.result.available).toBe(true);expect(first.result.display).toContain("00:00:01,250 --> 00:00:03,500");
    const input={format:"srt",track:"transcript",expectedRevision:first.result.revision,expectedBase:first.result.base,expectedSnapshotSha256:first.result.snapshotSha256};
    const saved=await bridge(env,"export-save",input);expect(saved.ok).toBe(true);expect(saved.result.sha256).toBe(digest(await fs.readFile(saved.result.path,"utf8")));expect((await fs.stat(saved.result.path)).mode&0o077).toBe(0);expect((await fs.stat(saved.result.manifestPath)).mode&0o077).toBe(0);
    const repeated=await bridge(env,"export-save",input);expect(repeated.ok).toBe(true);expect(repeated.result.reused).toBe(true);expect(repeated.result.path).toBe(saved.result.path);
    const edit=await bridge(env,"revision-save",{expectedRevision:0,base:first.result.base,operations:[{kind:"segment-text",segmentId:"s000000",text:"Outro texto sintético."}]});expect(edit.ok).toBe(true);
    expect((await bridge(env,"export-save",input)).ok).toBe(false);
    const blocked=await bridge(env,"export-preview",{format:"srt",track:"transcript"});expect(blocked.ok).toBe(true);expect(blocked.result.available).toBe(false);expect(blocked.result.error).toBeTruthy();
    const cli=await child(env,"cli",["export","preview",id,"--format","markdown","--track","transcript"]);expect(cli.exit).toBe(0);expect(JSON.parse(cli.stdout).display).toContain("Outro texto sintético.");
  }),20000);
  test("malformed UI/CLI mutation requests never acquire an implicit fresh version",()=>{
    for(const payload of [{operations:[]},{expectedRevision:-1,base:{}},{expectedRevision:0,base:{jobId:id,mediaSha256:"a".repeat(64),transcriptArtifactSha256:"b".repeat(64),unexpected:true},operations:[]}])expect(()=>parseRequest({id:1,op:"revision-save",key:id,payload})).toThrow();
    expect(()=>parseRequest({id:1,op:"export-preview",key:id,payload:{format:"srt"}})).toThrow();
    expect(()=>parseReviewExportArgs(["review","apply",id])).toThrow();
    expect(()=>parseReviewExportArgs(["export","save",id,"--format","json","--track","transcript"])).toThrow();
    expect(()=>parseReviewExportArgs(["review","show",id,"--input","{}"])).toThrow();
    for(const operations of [undefined,null,false,0,[]])expect(()=>parseReviewExportArgs(["review","apply",id,"--input",JSON.stringify({expectedRevision:1,base:{jobId:id},operations})])).toThrow();
  });
});
