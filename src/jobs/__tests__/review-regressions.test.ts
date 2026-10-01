import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { processJob } from "../pipeline";
import { hashFile } from "../store";
import { writePrivateArtifact } from "../artifacts";
import { summarizeWithOpenAI } from "../../summary/openai";
import { transcribeGeminiAudio } from "../../transcription/gemini";
import { createLocalOllamaVisualAdapter } from "../../visual/ollama";
import { cleanupRemoteServer } from "../retention";
import type { JobManifest } from "../types";

const manifest:JobManifest={version:1,id:"123e4567-e89b-42d3-a456-426614174000",createdAt:"2026-09-30T00:00:00Z",source:{originalName:"fixture.wav",mediaFile:"source.wav",size:1,sha256:"a".repeat(64)},transcription:{provider:"whisper-cpp",model:"fixture",language:"pt"},summary:{provider:"ollama",model:"fixture"}};
test("corrupt transcript cache and source mismatch fail before any provider request",async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),"review-cache-"));const original=fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw new Error("must not call");}) as unknown as typeof fetch;
 try{
  const source=join(root,"fixture.wav");await fs.writeFile(source,"synthetic");const selected=structuredClone(manifest);selected.source.sha256=await hashFile(source);
  await fs.writeFile(join(root,"audio.mp3"),"preserve preexisting media");
  await fs.writeFile(join(root,"transcript.json"),"corrupt");await expect(processJob(DEFAULT_CONFIG,selected,source,root)).rejects.toThrow();expect(await fs.readFile(join(root,"transcript.json"),"utf8")).toBe("corrupt");
  await fs.writeFile(join(root,"transcript.json"),JSON.stringify({version:1,provider:"whisper-cpp",model:"fixture",language:"pt",text:"Revisar.",segments:[{start:0,end:1,text:"Revisar."}]}));await fs.writeFile(source,"different synthetic");await expect(processJob(DEFAULT_CONFIG,selected,source,root)).rejects.toThrow("hash differs");expect(calls).toBe(0);expect(await fs.readFile(join(root,"audio.mp3"),"utf8")).toBe("preserve preexisting media");
 }finally{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});}
});
test("private atomic artifact replacement fixes loose permissions and preserves symlink targets",async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),"review-artifact-"));try{
 const path=join(root,"summary.json");await fs.writeFile(path,"old",{mode:0o644});await writePrivateArtifact(path,"complete");expect(await fs.readFile(path,"utf8")).toBe("complete");expect((await fs.stat(path)).mode&0o777).toBe(0o600);
 const target=join(root,"external");await fs.writeFile(target,"keep");await fs.symlink(target,join(root,"linked"));await expect(writePrivateArtifact(join(root,"linked"),"replace")).rejects.toThrow("preserved");expect(await fs.readFile(target,"utf8")).toBe("keep");expect((await fs.readdir(root)).some(name=>name.endsWith(".tmp"))).toBe(false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("summary OpenAI has one attempt and an explicit output budget",async()=>{
 const original=fetch;const config=structuredClone(DEFAULT_CONFIG);config.openai.apiKey="synthetic-not-a-real-key";let calls=0;
 globalThis.fetch=(async(_url:URL|RequestInfo,init?:RequestInit)=>{calls++;expect(JSON.parse(String(init?.body)).max_completion_tokens).toBe(4096);return Response.json({error:{message:"synthetic failure"}},{status:500});}) as unknown as typeof fetch;
 try{await expect(summarizeWithOpenAI(config,"Fixture.","fixture-model")).rejects.toThrow();expect(calls).toBe(1);}finally{globalThis.fetch=original;}
});
test("Gemini cancellation reaches the in-flight stub without retry",async()=>{
 const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY="synthetic-only";const controller=new AbortController();let calls=0;
 try{const request=(async(_url:URL|RequestInfo,init?:RequestInit)=>{calls++;expect(init?.signal).toBeDefined();controller.abort();init?.signal?.throwIfAborted();throw new Error("unreachable");}) as unknown as typeof fetch;
 await expect(transcribeGeminiAudio(new Uint8Array([1]),{model:"fixture",language:"pt",duration:1},request,controller.signal)).rejects.toThrow();expect(calls).toBe(1);
 }finally{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;}
});
test("loopback visual adapter refuses cloud and unproven locality before chat",async()=>{
 expect(()=>createLocalOllamaVisualAdapter("http://127.0.0.1:11434","fixture:cloud","fixture")).toThrow();const original=fetch;let calls=0;
 globalThis.fetch=(async(url:URL|RequestInfo)=>{calls++;expect(new URL(String(url)).pathname).toBe("/api/show");return Response.json({remote_host:"https://example.invalid",model_info:{architecture:"synthetic"}});}) as unknown as typeof fetch;
 try{const adapter=createLocalOllamaVisualAdapter("http://127.0.0.1:11434","fixture","fixture");await expect(adapter.select({segments:[],durationSeconds:1,remainingFrames:1,round:1})).rejects.toThrow("locality");expect(calls).toBe(1);}finally{globalThis.fetch=original;}
});
test("archived remote result cleanup preserves unknown media and mismatched copies",async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),"review-retention-"));const server=join(root,"server"),archive=join(root,"archive"),relative="2026/09/"+manifest.id;const result=join(server,"results",manifest.id);
 try{
 await fs.mkdir(result,{recursive:true});await fs.mkdir(join(server,"status"));await fs.mkdir(join(archive,relative),{recursive:true});
 await fs.writeFile(join(server,"status",manifest.id+".json"),JSON.stringify({version:1,id:manifest.id,state:"completed",updatedAt:manifest.createdAt,archiveRelative:relative}));
 for(const name of ["transcript.json","transcript.md","summary.json","summary.md"]){await fs.writeFile(join(result,name),"fixture");await fs.writeFile(join(archive,relative,name),"fixture");}
 const config=structuredClone(DEFAULT_CONFIG);config.remote.archiveDir=archive;config.retention.remoteResultsDays=1;const old=new Date(0);const reset=()=>fs.utimes(result,old,old);
 await fs.writeFile(join(result,"unexpected-original.mkv"),"keep");await reset();expect((await cleanupRemoteServer(config,{serverRoot:server})).remoteResults).toBe(0);expect(await fs.readFile(join(result,"unexpected-original.mkv"),"utf8")).toBe("keep");
 await fs.unlink(join(result,"unexpected-original.mkv"));await fs.writeFile(join(result,"summary.json"),"different");await reset();expect((await cleanupRemoteServer(config,{serverRoot:server})).remoteResults).toBe(0);
 await fs.writeFile(join(result,"summary.json"),"fixture");await reset();expect((await cleanupRemoteServer(config,{serverRoot:server})).remoteResults).toBe(1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
