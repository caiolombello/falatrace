import {promises as fs} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {hashFile} from '../jobs/store';
import {probeMedia} from '../jobs/media';
import {writePrivateArtifact} from '../jobs/artifacts';
import type {AppConfig} from '../config/defaults';
import type {Transcript} from '../jobs/types';
import {formatSummaryMarkdown} from '../jobs/format';
import {planVisualEvidence,type VisualPlan} from './plan';
import {extractVisualEvidence} from './extract';
import {runVisualSession} from './session';
import {createLocalOllamaVisualAdapter,verifyLocalOllamaModel} from './ollama';
import {VisualAppBudget,privateDirectory,assertPrivateDirectoryAncestors} from './app-budget';
import {summarizeInChunks} from '../summary/chunks';
import {summarizeWithOllama} from '../summary/ollama';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export type StudioSource={key:string;jobId:string;path:string;mediaHash:string;transcript:Transcript;config:AppConfig};
type Checked={endpoint:string;visionModel:string;summaryModel:string;visionDigest:string;summaryDigest:string;expiresAt:number};
type Item={source:StudioSource;checked:Checked;plan:VisualPlan;reviewWindow:number;preview:Record<string,any>;controller:AbortController;promise?:Promise<any>;result?:any};
/** Production coordinator; tests replace only HTTP transport. No scripted observations. */
export class StudioVisualFlow {
 private checked=new Map<string,Checked>();private items=new Map<string,Item>();
 private budget:VisualAppBudget;
 constructor(readonly root:string,private now=()=>Date.now()){this.budget=new VisualAppBudget(root);}
 async check(config:AppConfig,visionModel:string,summaryModel:string){
  const endpoint=config.summary.ollamaUrl;
  const visionDigest=await verifyLocalOllamaModel(endpoint,visionModel,true);
  const summaryDigest=await verifyLocalOllamaModel(endpoint,summaryModel,false);
  const id=randomUUID();this.checked.set(id,{endpoint,visionModel,summaryModel,visionDigest,summaryDigest,expiresAt:this.now()+300000});
  if(this.checked.size>16)this.checked.delete(this.checked.keys().next().value!);
  return {id,provider:'ollama-local',visionModel,summaryModel,endpoint:new URL(endpoint).origin,vision:true,completion:true,expiresAt:this.now()+300000};
 }
 async preview(source:StudioSource,capabilityId:string,question:string,seconds:number){
  const checked=this.checked.get(capabilityId);if(!checked||checked.expiresAt<=this.now()||checked.endpoint!==source.config.summary.ollamaUrl)throw Error('Model capability expired or provider changed');
  if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed');
  const duration=await probeMedia(source.path);const ids=source.transcript.segments.flatMap((s,i)=>seconds>=s.start&&seconds<=s.end?['s'+String(i).padStart(6,'0')]:[]);
  if(!ids.length)throw Error('Timestamp must match a transcript segment');
  const plan=planVisualEvidence(source.mediaHash,source.transcript,duration,[{timestampSeconds:seconds,reason:'user-request',question,segmentIds:ids.slice(0,8)}]);
  const identity=hash({endpoint:checked.endpoint,vision:checked.visionModel,summary:checked.summaryModel,visionDigest:checked.visionDigest,summaryDigest:checked.summaryDigest,media:source.mediaHash,transcript:hash(source.transcript)});
  const remaining=await this.budget.reserve('preview',source.jobId,identity);await privateDirectory(this.root);
  const scratch=await fs.mkdtemp(join(this.root,'.preview-'));
  try{
   const extracted=await extractVisualEvidence(plan,source.path,scratch);const frame=extracted.frames[0];if(!frame)throw Error('Frame unavailable');
   const bytes=await fs.readFile(join(scratch,extracted.key,frame.file));
   const reviewWindow=Math.floor(this.now()/3600000);
   const id=randomUUID(),expiresAt=Math.min(checked.expiresAt,this.now()+300000,(reviewWindow+1)*3600000);
   const sent={reviewWindow,provider:'ollama-local',endpoint:checked.endpoint,visionModel:checked.visionModel,summaryModel:checked.summaryModel,planKey:plan.key,mediaHash:source.mediaHash,transcriptHash:hash(source.transcript),frameSha256:frame.sha256,frameBytes:frame.bytes,timestampSeconds:frame.timestampSeconds,segmentIds:plan.requests[0].segmentIds,question,summaryData:'transcript + verified visual observations; at most eight chunks',visionDigest:checked.visionDigest,summaryDigest:checked.summaryDigest,expiresAt};
   const consentKey=hash(sent);const preview={id,plan,frameData:'data:image/jpeg;base64,'+bytes.toString('base64'),...sent,consentKey,...remaining,requiresReview:true};
   if(this.items.size>=16)throw Error('Pending visual previews exhausted');
   this.items.set(id,{source:structuredClone(source),checked:{...checked},plan,reviewWindow,preview,controller:new AbortController()});return structuredClone(preview);
  }finally{await fs.rm(scratch,{recursive:true,force:true});}
 }
 async readResult(jobId:string,mediaHash:string,transcript?:Transcript){
  const path=join(this.root,'results',hash(jobId)+'.json');await assertPrivateDirectoryAncestors(this.root);
  for(const folder of [this.root,join(this.root,'results')]){const st=await fs.lstat(folder).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!st)return undefined;if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe visual result directory');}
  const stat=await fs.lstat(path).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return undefined;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Unsafe visual result');
  const stored=JSON.parse(await fs.readFile(path,'utf8')),r=stored.result;
  if(!r||stored.sha256!==hash(r)||r.mediaHash!==mediaHash||typeof r.summaryMarkdown!=='string'||!Number.isFinite(r.expiresAt)||transcript&&r.transcriptHash!==hash(transcript))return undefined;
  return r.expiresAt<=this.now()?{...r,evidenceExpired:true,requiresReview:true,summaryMarkdown:r.summaryMarkdown+'\n\nAviso: evidência visual derivada expirada; estas notas históricas foram preservadas. Nova análise exige preview/consentimento atuais.'}:r;
 }
 cancel(key:string,id:string){const item=this.items.get(id);if(item&&item.source.key===key){item.controller.abort();this.items.delete(id);}return {cancelled:true};}
 async confirm(source:StudioSource,id:string,consent:boolean,consentKey:string){
  const item=this.items.get(id);
  if(!item||!consent||item.source.key!==source.key||item.source.jobId!==source.jobId||item.preview.consentKey!==consentKey||item.preview.expiresAt<=this.now())throw Error('Explicit current consent required');
  if(item.checked.endpoint!==source.config.summary.ollamaUrl||item.source.mediaHash!==source.mediaHash||hash(source.transcript)!==hash(item.source.transcript)||await hashFile(source.path)!==source.mediaHash)throw Error('Provider/source changed after preview');
  if(item.result)return structuredClone(item.result);if(item.promise)return item.promise;
  const signal=item.controller.signal;
  item.promise=(async()=>{
   const c=item.checked;
   if(await verifyLocalOllamaModel(c.endpoint,c.visionModel,true,signal)!==c.visionDigest||await verifyLocalOllamaModel(c.endpoint,c.summaryModel,false,signal)!==c.summaryDigest)throw Error('Model changed after preview');
   const identity=hash({endpoint:c.endpoint,vision:c.visionModel,summary:c.summaryModel,visionDigest:c.visionDigest,summaryDigest:c.summaryDigest,media:source.mediaHash,transcript:hash(source.transcript)});
   const adapter=createLocalOllamaVisualAdapter(c.endpoint,c.visionModel,c.visionModel);adapter.identity+=":"+hash({vision:c.visionDigest,summary:c.summaryDigest,plan:item.plan.key,window:item.reviewWindow}).slice(0,24);
   const baseInspect=adapter.inspect;adapter.inspect=async(input,s)=>{
    if(input.frames[0]?.sha256!==item.preview.frameSha256||input.frames[0]?.bytes!==item.preview.frameBytes)throw Error('Extracted frame changed after consent');
    await this.budget.reserve('inference',source.jobId,identity);signal.throwIfAborted();return baseInspect(input,s);
   };
   const visual=await runVisualSession({mediaHash:source.mediaHash,transcript:source.transcript,durationSeconds:item.plan.durationSeconds,sourcePath:source.path,root:join(this.root,'sessions'),adapter,manual:{requests:item.plan.requests,planKey:item.plan.key,consent:true},signal,now:this.now()});
   if(visual.expired||!visual.observations.length)throw Error('Visual evidence expired or unavailable');
   const visualEvidence={adapterIdentity:adapter.identity,expiresAt:visual.expiresAt,observations:visual.observations.map(({timestampSeconds,frameSha256,text,uncertainty})=>({timestampSeconds,frameSha256,text,uncertainty}))};
   const config=structuredClone(source.config);config.summary.ollamaUrl=c.endpoint;
   const summary=await summarizeInChunks({transcript:source.transcript,mediaHash:source.mediaHash,maxCharacters:config.summary.maxInputCharacters,provider:'ollama',model:c.summaryModel,adapterIdentity:c.endpoint,visual:visualEvidence,cacheDir:join(this.root,'summaries',visual.key),signal,adapter:async(part,s)=>{
    await this.budget.reserve('inference',source.jobId,identity);signal.throwIfAborted();
    if(await verifyLocalOllamaModel(c.endpoint,c.summaryModel,false,signal)!==c.summaryDigest)throw Error('Summary model changed');
    return summarizeWithOllama(config,part.text,c.summaryModel,undefined,part.evidence,s);
   }});
   summary.support!.reviewRequired=true;summary.limitations=[...(summary.limitations||[]),'Evidência visual seletiva; revisar a origem e a incerteza.'];
   signal.throwIfAborted();if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed during review');
   const result={sourceKey:source.key,timestampSeconds:item.plan.requests[0].timestampSeconds,synthetic:false,requiresReview:true,text:visual.observations.map(o=>o.text).join('\n'),observations:visual.observations,summaryMarkdown:formatSummaryMarkdown(summary),summary,consentKey,provider:'ollama-local',visionModel:c.visionModel,summaryModel:c.summaryModel,mediaHash:source.mediaHash,transcriptHash:hash(source.transcript),expiresAt:visual.expiresAt};
   await privateDirectory(join(this.root,'results'));signal.throwIfAborted();await writePrivateArtifact(join(this.root,'results',hash(source.jobId)+'.json'),JSON.stringify({result,sha256:hash(result)}));
   item.result=result;return structuredClone(result);
  })();return item.promise;
 }
}
