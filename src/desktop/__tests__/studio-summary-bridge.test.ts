import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { JobStore, hashFile } from "../../jobs/store";
import { StudioSummaryFlow } from "../../summary/studio";
import { readCurrentReviewedSummary, reviewedSummaryProviderForConfig } from "../../summary/reviewed";
import type { RecordingSummary } from "../../jobs/types";
import { desktopRequestAdmitted, handleStudioSummaryOperation, StudioSummaryRequestRouter, parseRequest } from "../bridge";

assertQaIsolation();
const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const fixture=async()=>{
  const root=await fs.mkdtemp(join(process.env.TMPDIR!,"studio-summary-bridge-"));roots.push(root);
  const config=structuredClone(DEFAULT_CONFIG);
  config.recordingsDir=root;config.processing.defaultTarget="local";config.processing.autoEnqueue=false;
  config.openai.autoTranscribe=false;config.callDetection.enabled=false;config.aiContext.enabled=false;config.timesheet.enabled=false;
  config.summary.provider="ollama";config.summary.ollamaModel="fixture-local";
  const source=join(root,"synthetic.wav");await fs.writeFile(source,"SYNTHETIC MEDIA ONLY");
  const store=new JobStore(),created=await store.enqueue(config,source),job=await store.update(created.id,"completed");
  await fs.mkdir(job.artifactDir,{recursive:true});
  const transcript=join(job.artifactDir,"transcript.json"),original=join(job.artifactDir,"summary.json");
  await fs.writeFile(transcript,JSON.stringify({version:1,provider:job.transcription.provider,model:job.transcription.model,language:job.transcription.language,text:"Fonte sintética com timestamp.",segments:[{start:1,end:3,text:"Fonte sintética com timestamp."}]}));
  await fs.writeFile(original,"ORIGINAL SUMMARY FIXTURE PRESERVED");
  return {config,job,source,transcript,original};
};
test("Studio JSONL rejects implicit budget/consent and provider/frame overrides",()=>{
  const key=randomUUID(),requestId=randomUUID();
  expect(parseRequest({id:1,op:"summary-plan",key,payload:{requestId,maxRequests:1}}).op).toBe("summary-plan");
  for(const payload of [{requestId},{requestId,maxRequests:0},{requestId,maxRequests:9},{requestId,maxRequests:1,provider:"openai"},{requestId,maxRequests:1,timestamps:[1]}])expect(()=>parseRequest({id:1,op:"summary-plan",key,payload})).toThrow();
  for(const payload of [{requestId,consent:false,consentKey:"a".repeat(64)},{requestId,consent:true},{requestId,consent:true,consentKey:"bad"},{requestId,consent:true,consentKey:"a".repeat(64),model:"override"}])expect(()=>parseRequest({id:2,op:"summary-run",key,payload})).toThrow();
  expect(()=>parseRequest({id:3,op:"summary-cancel",key,payload:{requestId,consent:true}})).toThrow();
  expect(()=>parseRequest({id:1,op:"summary-plan",key:"arbitrary/path",payload:{requestId,maxRequests:1}})).toThrow();
});
test("Studio handler composes production plan/run/read with synthetic response and unchanged disabled flags",async()=>{
  const f=await fixture(),before=await Promise.all([f.source,f.transcript,f.original].map(hashFile)),configBefore=JSON.stringify(f.config);
  let calls=0;
  const flow=new StudioSummaryFlow({identity:reviewedSummaryProviderForConfig(f.config),summarize:async()=>{
    calls++;
    return {version:1,provider:"ollama",model:"fixture-local",title:"Resumo sintético",overview:"Nota de teste ligada ao momento.",topics:[],decisions:[],actionItems:[],citations:[{section:"overview",index:0,segmentIds:["s000000"],uncertainty:"clear"}]} as RecordingSummary;
  }});
  const requestId=randomUUID(),plan:any=await handleStudioSummaryOperation(flow,parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),f.job,f.config);
  expect(plan.provider.model).toBe("fixture-local");expect(plan.provider.endpoint).toContain("127.0.0.1");
  expect(plan.cost).toMatchObject({state:"unknown",estimatedUsd:null});expect(calls).toBe(0);
  await expect(handleStudioSummaryOperation(flow,parseRequest({id:2,op:"summary-plan",key:randomUUID(),payload:{requestId:randomUUID(),maxRequests:1}}),f.job,f.config)).rejects.toThrow("mismatch");
  const completed:any=await handleStudioSummaryOperation(flow,parseRequest({id:3,op:"summary-run",key:f.job.id,payload:{requestId,consent:true,consentKey:plan.consentKey}}),f.job,f.config);
  expect(completed.status).toBe("completed");expect(completed.requestId).toBe(requestId);expect(calls).toBe(1);
  expect(completed.raw).toBeUndefined();expect(completed.path).toBeUndefined();
  expect((await readCurrentReviewedSummary(f.job))?.summary.overview).toContain("Nota de teste");
  expect(await Promise.all([f.source,f.transcript,f.original].map(hashFile))).toEqual(before);
  expect(JSON.stringify(f.config)).toBe(configBefore);
  await flow.cancelAll();
});
test("Studio cancellation route works without loading or altering configuration",async()=>{
  const f=await fixture(),flow=new StudioSummaryFlow(),requestId=randomUUID();
  await handleStudioSummaryOperation(flow,parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),f.job,f.config);
  const cancelled:any=await handleStudioSummaryOperation(flow,parseRequest({id:2,op:"summary-cancel",key:f.job.id,payload:{requestId}}),f.job);
  expect(cancelled.status).toBe("cancelled");expect(cancelled.persisted).toBe(true);
  expect(await readCurrentReviewedSummary(f.job)).toBeUndefined();
  await flow.cancelAll();
});
test("cancellation overtakes source lookup before a plan is registered",async()=>{
  const f=await fixture(),flow=new StudioSummaryFlow(),router=new StudioSummaryRequestRouter(flow),requestId=randomUUID();
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const pending=router.dispatch(parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),async()=>{await gate;return {job:f.job,config:f.config};});
  const outcome=pending.catch(error=>error);
  const cancelled:any=await router.dispatch(parseRequest({id:2,op:"summary-cancel",key:f.job.id,payload:{requestId}}),async()=>({job:f.job}));
  expect(cancelled).toMatchObject({status:"cancelled",persisted:false});release();expect((await outcome as Error).message).toContain("cancelled before source resolution");
  expect(await readCurrentReviewedSummary(f.job)).toBeUndefined();
  const next:any=await router.dispatch(parseRequest({id:3,op:"summary-plan",key:f.job.id,payload:{requestId:randomUUID(),maxRequests:1}}),async()=>({job:f.job,config:f.config}));
  expect(next.status).toBe("planned");await flow.shutdown();
});
test("disconnect during accepted source lookup refuses late run without adapter call",async()=>{
  const f=await fixture();let calls=0;
  const flow=new StudioSummaryFlow({identity:reviewedSummaryProviderForConfig(f.config),summarize:async()=>{calls++;throw Error("Unexpected synthetic dispatch");}});
  const router=new StudioSummaryRequestRouter(flow),requestId=randomUUID();
  const plan:any=await router.dispatch(parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),async()=>({job:f.job,config:f.config}));
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const pending=router.dispatch(parseRequest({id:2,op:"summary-run",key:f.job.id,payload:{requestId,consent:true,consentKey:plan.consentKey}}),async()=>{await gate;return {job:f.job,config:f.config};});
  const outcome=pending.catch(error=>error);await flow.shutdown();release();expect((await outcome as Error).message).toContain("closed");
  expect(calls).toBe(0);expect(await readCurrentReviewedSummary(f.job)).toBeUndefined();
});
test("full JSONL queue still admits a real cancellation but no inference",async()=>{
  const f=await fixture(),flow=new StudioSummaryFlow(),router=new StudioSummaryRequestRouter(flow),requestId=randomUUID();
  await router.dispatch(parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),async()=>({job:f.job,config:f.config}));
  expect(desktopRequestAdmitted(32,"summary-run")).toBe(false);expect(desktopRequestAdmitted(32,"summary-plan")).toBe(false);
  expect(desktopRequestAdmitted(32,"summary-cancel")).toBe(true);expect(desktopRequestAdmitted(40,"summary-cancel")).toBe(true);
  const cancelled:any=await router.dispatch(parseRequest({id:2,op:"summary-cancel",key:f.job.id,payload:{requestId}}),async()=>({job:f.job}));
  expect(cancelled).toMatchObject({status:"cancelled",persisted:true});expect(await readCurrentReviewedSummary(f.job)).toBeUndefined();await flow.shutdown();
});
test("cancel intent aborts active response before a delayed source lookup could permit publication",async()=>{
  const f=await fixture();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const flow=new StudioSummaryFlow({identity:reviewedSummaryProviderForConfig(f.config),summarize:async()=>{
    entered();await gate;
    return {version:1,provider:"ollama",model:"fixture-local",title:"Late synthetic",overview:"Late synthetic response",topics:[],decisions:[],actionItems:[]} as RecordingSummary;
  }});
  const router=new StudioSummaryRequestRouter(flow),requestId=randomUUID();
  const plan:any=await router.dispatch(parseRequest({id:1,op:"summary-plan",key:f.job.id,payload:{requestId,maxRequests:1}}),async()=>({job:f.job,config:f.config}));
  const pending=router.dispatch(parseRequest({id:2,op:"summary-run",key:f.job.id,payload:{requestId,consent:true,consentKey:plan.consentKey}}),async()=>({job:f.job,config:f.config}));
  const outcome=pending.catch(error=>error);await started;
  let cancelSourceReads=0;
  const cancelled=router.dispatch(parseRequest({id:3,op:"summary-cancel",key:f.job.id,payload:{requestId}}),async()=>{cancelSourceReads++;await new Promise(()=>{});return {job:f.job};});
  release();expect((await outcome as Error).message).toContain("cancelled");
  expect((await cancelled as any).status).toBe("cancelled");expect(cancelSourceReads).toBe(0);
  expect(await readCurrentReviewedSummary(f.job)).toBeUndefined();await flow.shutdown();
});
