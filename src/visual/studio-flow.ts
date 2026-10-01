import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import {promises as fs} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {hashFile} from '../jobs/store';
import {probeMedia} from '../jobs/media';
import {sweepExpiredPlannerCache,writePlannerCache} from './planner-cache';
import {writePrivateArtifact} from '../jobs/artifacts';
import type {AppConfig} from '../config/defaults';
import type {Transcript} from '../jobs/types';
import {formatSummaryMarkdown} from '../jobs/format';
import {transcriptPlannerInput,selectTranscriptScope,validateTranscriptDecision,type TranscriptScope,type TranscriptDecision} from './planner';
import {planVisualEvidence,type VisualPlan} from './plan';
import {extractVisualEvidence} from './extract';
import {runVisualSession} from './session';
import {createLocalOllamaVisualAdapter,verifyLocalOllamaModel} from './ollama';
import {VisualAppBudget,privateDirectory,assertPrivateDirectoryAncestors} from './app-budget';
import {summarizeInChunks} from '../summary/chunks';
import {summarizeWithOllama} from '../summary/ollama';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export type StudioSource={key:string;jobId:string;path:string;mediaHash:string;transcript:Transcript;config:AppConfig;refresh?:()=>Promise<StudioSource>};
type Checked={endpoint:string;visionModel:string;summaryModel:string;visionDigest:string;summaryDigest:string;policyRevision:number;expiresAt:number};
type Item={source:StudioSource;checked:Checked;plan:VisualPlan;reviewWindow:number;scopeId?:string;scope?:TranscriptScope;origin?:"planner";preview:Record<string,any>;controller:AbortController;promise?:Promise<any>;result?:any};
/** Production coordinator; tests replace only HTTP transport. No scripted observations. */
export class StudioVisualFlow {
 private checked=new Map<string,Checked>();private items=new Map<string,Item>();
 private budget:VisualAppBudget;
 private decisions=new Map<string,{decision:TranscriptDecision;key:string;scopeId?:string;sourceIdentity:string;capabilityId:string;expiresAt:number;scope?:TranscriptScope}>();
 private scopes=new Map<string,{scope:TranscriptScope;key:string;identity:string;expiresAt:number}>();
 private scoping=new Map<string,AbortController>();
 private planning=new Map<string,AbortController>();
 private pendingPreviews=new Map<string,AbortController>();
 constructor(readonly root:string,private now=()=>Date.now(),readPolicy?:()=>Promise<import('./app-budget').VisualBudgetPolicy|undefined>){this.budget=new VisualAppBudget(root,readPolicy);}
 async check(config:AppConfig,visionModel:string,summaryModel:string){
  const endpoint=config.summary.ollamaUrl;
  const visionDigest=await verifyLocalOllamaModel(endpoint,visionModel,true);
  const summaryDigest=await verifyLocalOllamaModel(endpoint,summaryModel,false);
  const policy=await this.budget.snapshot(config.visualReview);
  const id=randomUUID();this.checked.set(id,{endpoint,visionModel,summaryModel,visionDigest,summaryDigest,policyRevision:policy.policyRevision,expiresAt:this.now()+300000});
  if(this.checked.size>16)this.checked.delete(this.checked.keys().next().value!);
  return {id,policyRevision:policy.policyRevision,budgetScope:'user-installation',budgetPeriod:'lifetime',budgetLimits:config.visualReview||{maxInferences:24,maxPreviews:16,period:'lifetime'},temporaryAlphaDefaults:!config.visualReview,provider:'ollama-local',visionModel,summaryModel,endpoint:new URL(endpoint).origin,vision:true,completion:true,expiresAt:this.now()+300000};
 }
 async scope(source:StudioSource,startSeconds:number,endSeconds:number){
  if(this.scoping.has(source.key))throw Error('Scope preparation already pending');const controller=new AbortController();this.scoping.set(source.key,controller);
  try{return await withHeavyAdmission('preview',source.jobId,async()=>{
   source=source.refresh?await source.refresh():source;controller.signal.throwIfAborted();const duration=await probeMedia(source.path);if(await hashFile(source.path)!==source.mediaHash)throw Error('Scope source changed');
   const scope=selectTranscriptScope(source.transcript,duration,startSeconds,endSeconds);controller.signal.throwIfAborted();for(const [id,item] of this.scopes)if(item.expiresAt<=this.now())this.scopes.delete(id);if(this.scopes.size>=16)throw Error('Pending transcript scopes exhausted');
   const id=randomUUID(),expiresAt=this.now()+300000,identity=hash({job:source.jobId,key:source.key,path:source.path,media:source.mediaHash,transcript:source.transcript,endpoint:source.config.summary.ollamaUrl});this.scopes.set(id,{scope,key:source.key,identity,expiresAt});
   return {id,...scope,segments:scope.withinLimits?scope.segments:[],includedCount:scope.segments.length,omittedCount:scope.totalSegments-scope.segments.length,maxSegments:200,maxCharacters:24000,durationSeconds:duration,expiresAt,transcriptOnly:true};
  },{signal:controller.signal,onWait:cliAdmissionWait});}finally{this.scoping.delete(source.key);}
 }
 async plan(source:StudioSource,capabilityId:string,consentTranscript:boolean,scopeId?:string){
  if(consentTranscript!==true)throw Error('Explicit transcript planning consent required');
  if(this.planning.has(source.key))throw Error('Planner already pending');
  const controller=new AbortController();this.planning.set(source.key,controller);
  try{return await withHeavyAdmission('vision',source.jobId,async()=>{
   source=source.refresh?await source.refresh():source;const signal=controller.signal;signal.throwIfAborted();
   const checked=this.checked.get(capabilityId);if(!checked||checked.expiresAt<=this.now()||checked.endpoint!==source.config.summary.ollamaUrl)throw Error('Model capability expired or provider changed');
   const duration=await probeMedia(source.path);if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed');
   const storedScope=scopeId?this.scopes.get(scopeId):undefined;
   if(scopeId&&(!storedScope||storedScope.expiresAt<=this.now()||storedScope.identity!==hash({job:source.jobId,key:source.key,path:source.path,media:source.mediaHash,transcript:source.transcript,endpoint:source.config.summary.ollamaUrl})))throw Error('Transcript selection expired/changed while waiting');
   const selected=storedScope?.scope;const input=transcriptPlannerInput(source.transcript,duration,selected);
   const identity=hash({endpoint:checked.endpoint,vision:checked.visionModel,summary:checked.summaryModel,visionDigest:checked.visionDigest,summaryDigest:checked.summaryDigest,media:source.mediaHash,transcript:hash(source.transcript)});
   await this.budget.assertRevision(checked.policyRevision,source.config.visualReview);signal.throwIfAborted();
   const cacheKey=hash({identity,input,version:1});await privateDirectory(join(this.root,'plans'));await sweepExpiredPlannerCache(join(this.root,'plans'),this.now(),false);signal.throwIfAborted();const path=join(this.root,'plans',cacheKey+'.json');
   let raw:unknown,cached=false;const st=await fs.lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});
   if(st){if(!st.isFile()||st.isSymbolicLink()||st.size>64000)throw Error('Unsafe planner cache');const stored=JSON.parse(await fs.readFile(path,'utf8'));if(stored.sha256!==hash(stored.raw))throw Error('Planner cache corrupt');if(stored.expiresAt>this.now()){raw=stored.raw;cached=true;}}
   if(!cached){signal.throwIfAborted();if(await verifyLocalOllamaModel(checked.endpoint,checked.summaryModel,false,signal)!==checked.summaryDigest)throw Error('Planner model changed');await this.budget.reserve('inference',source.jobId,identity,source.config.visualReview,false,checked.policyRevision);signal.throwIfAborted();raw=await createLocalOllamaVisualAdapter(checked.endpoint,checked.summaryModel,checked.visionModel).plan!(input,signal);}
   signal.throwIfAborted();const decision=validateTranscriptDecision(source.mediaHash,source.transcript,duration,raw,selected);if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed during planning');
   if(!cached)await writePlannerCache(join(this.root,'plans'),cacheKey,raw,this.now()+300000);
   await this.budget.assertRevision(checked.policyRevision,source.config.visualReview);signal.throwIfAborted();if(checked.expiresAt<=this.now()||scopeId&&!this.scopeCurrent(scopeId))throw Error('Planner consent/selection expired');
   for(const [did,item] of this.decisions)if(item.key===source.key)this.decisions.delete(did);
   const id=randomUUID(),expiresAt=Math.min(checked.expiresAt,this.now()+300000);for(const [key,item] of this.decisions)if(item.expiresAt<=this.now())this.decisions.delete(key);if(this.decisions.size>=16)throw Error('Pending plans exhausted');
   this.decisions.set(id,{decision,key:source.key,scopeId,sourceIdentity:hash({job:source.jobId,key:source.key,media:source.mediaHash,transcript:source.transcript,endpoint:checked.endpoint}),capabilityId,expiresAt,scope:selected});
   return {id,...decision,scope:selected,plannerCacheHit:cached,plannerAttemptConsumed:!cached,maxAdditionalInferenceRequests:decision.decision==='frames'?9:0,expiresAt,requiresVisualConsent:decision.decision==='frames',transcriptOnly:true,provider:'ollama-local',model:checked.summaryModel,budgetScope:'user-installation',budgetPeriod:'lifetime',budgetLimits:source.config.visualReview||{maxInferences:24,maxPreviews:16,period:'lifetime'},temporaryAlphaDefaults:!source.config.visualReview};
  },{signal:controller.signal,onWait:cliAdmissionWait});}finally{this.planning.delete(source.key);}
 }
 private scopeCurrent(id:string){const item=this.scopes.get(id);return !!item&&item.expiresAt>this.now();}
 async previewPlan(source:StudioSource,id:string){
  const item=this.decisions.get(id);if(!item||item.expiresAt<=this.now()||item.scopeId&&!this.scopeCurrent(item.scopeId)||item.decision.decision!=='frames')throw Error('Current frames plan required');
  const expected=hash({job:source.jobId,key:source.key,media:source.mediaHash,transcript:source.transcript,endpoint:source.config.summary.ollamaUrl});if(item.sourceIdentity!==expected)throw Error('Planner source changed');
  if(this.pendingPreviews.has(source.key))throw Error('Preview already pending');const controller=new AbortController();this.pendingPreviews.set(source.key,controller);
  try{return await withHeavyAdmission('preview',source.jobId,async()=>{
   const latest=source.refresh?await source.refresh():source;if(item.expiresAt<=this.now()||hash({job:latest.jobId,key:latest.key,media:latest.mediaHash,transcript:latest.transcript,endpoint:latest.config.summary.ollamaUrl})!==expected)throw Error('Planner source expired/changed');
   return this.previewOwned(latest,item.capabilityId,'',0,controller.signal,item.decision,item.scope,item.scopeId);
  },{signal:controller.signal,onWait:cliAdmissionWait});}finally{this.pendingPreviews.delete(source.key);}
 }
 async preview(source:StudioSource,capabilityId:string,question:string,seconds:number){
  if(this.pendingPreviews.has(source.key))throw Error('Preview already pending');
  const controller=new AbortController();this.pendingPreviews.set(source.key,controller);
  try{return await withHeavyAdmission('preview',source.jobId,async()=>{const latest=source.refresh?await source.refresh():source;if(latest.key!==source.key||latest.jobId!==source.jobId)throw Error('Source changed while waiting');return this.previewOwned(latest,capabilityId,question,seconds,controller.signal);},{signal:controller.signal,onWait:cliAdmissionWait});}
  finally{this.pendingPreviews.delete(source.key);}
 }
 private async previewOwned(source:StudioSource,capabilityId:string,question:string,seconds:number,signal:AbortSignal,decision?:TranscriptDecision,scope?:TranscriptScope,scopeId?:string){
  signal.throwIfAborted();if(scopeId&&!this.scopeCurrent(scopeId))throw Error('Transcript selection expired');
  const checked=this.checked.get(capabilityId);if(!checked||checked.expiresAt<=this.now()||checked.endpoint!==source.config.summary.ollamaUrl)throw Error('Model capability expired or provider changed');
  if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed');
  const duration=await probeMedia(source.path);const ids=source.transcript.segments.flatMap((s,i)=>seconds>=s.start&&seconds<=s.end?['s'+String(i).padStart(6,'0')]:[]);
  if(!decision&&!ids.length)throw Error('Timestamp must match a transcript segment');
  const plan=decision?validateTranscriptDecision(source.mediaHash,source.transcript,duration,{decision:decision.decision,rationale:decision.rationale,sources:decision.sources,requests:decision.plan.requests},scope).plan:planVisualEvidence(source.mediaHash,source.transcript,duration,[{timestampSeconds:seconds,reason:'user-request',question,segmentIds:ids.slice(0,8)}]);
  const identity=hash({endpoint:checked.endpoint,vision:checked.visionModel,summary:checked.summaryModel,visionDigest:checked.visionDigest,summaryDigest:checked.summaryDigest,media:source.mediaHash,transcript:hash(source.transcript)});
  const remaining=await this.budget.reserve('preview',source.jobId,identity,source.config.visualReview,true,checked.policyRevision);await privateDirectory(this.root);
  const scratch=await fs.mkdtemp(join(this.root,'.preview-'));
  try{
   const extracted=await extractVisualEvidence(plan,source.path,scratch,{signal});const frame=extracted.frames[0];if(!frame)throw Error('Frame unavailable');
   const bytes=await fs.readFile(join(scratch,extracted.key,frame.file));
   const framePreviews=await Promise.all(extracted.frames.map(async f=>({...f,frameData:'data:image/jpeg;base64,'+(await fs.readFile(join(scratch,extracted.key,f.file))).toString('base64')})));
   const reviewWindow=Math.floor(this.now()/3600000);
   const id=randomUUID(),expiresAt=Math.min(checked.expiresAt,this.now()+300000,(reviewWindow+1)*3600000);
   const sent={origin:decision?'planner':'manual',scopeId,scope,plannerDecision:decision,frames:extracted.frames,reviewWindow,provider:'ollama-local',endpoint:checked.endpoint,visionModel:checked.visionModel,summaryModel:checked.summaryModel,planKey:plan.key,mediaHash:source.mediaHash,transcriptHash:hash(source.transcript),frameSha256:frame.sha256,frameBytes:frame.bytes,timestampSeconds:frame.timestampSeconds,segmentIds:plan.requests[0].segmentIds,question,summaryData:scope?'selected transcript interval only + visual observations; partial summary; at most eight chunks':'transcript + visual observations; at most eight chunks',visionDigest:checked.visionDigest,summaryDigest:checked.summaryDigest,expiresAt};
   const consentKey=hash(sent);const preview={id,plan,framePreviews,frameData:'data:image/jpeg;base64,'+bytes.toString('base64'),...sent,consentKey,...remaining,requiresReview:true};
   signal.throwIfAborted();if(scopeId&&!this.scopeCurrent(scopeId))throw Error('Transcript selection expired');
   for(const [key,item] of this.items)if(item.preview.expiresAt<=this.now()&&!item.promise)this.items.delete(key);
   if(this.items.size>=16)throw Error('Pending visual previews exhausted');
   const {refresh,...snapshot}=source;
   this.items.set(id,{source:structuredClone(snapshot),checked:{...checked},plan,reviewWindow,scopeId,scope,origin:decision?'planner':undefined,preview,controller:new AbortController()});return structuredClone(preview);
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
 cancelAll(){for(const controller of this.scoping.values())controller.abort();for(const controller of this.planning.values())controller.abort();for(const controller of this.pendingPreviews.values())controller.abort();for(const item of this.items.values())item.controller.abort();this.items.clear();}
 cancel(key:string,id:string,scopeId?:string){this.scoping.get(key)?.abort();if(scopeId&&this.scopes.get(scopeId)?.key===key){this.scopes.delete(scopeId);for(const [did,d] of this.decisions)if(d.key===key&&d.scopeId===scopeId)this.decisions.delete(did);for(const [iid,item] of this.items)if(item.source.key===key&&item.scopeId===scopeId){item.controller.abort();this.items.delete(iid);}}for(const [did,d] of this.decisions)if(d.key===key)this.decisions.delete(did);this.planning.get(key)?.abort();this.pendingPreviews.get(key)?.abort();const item=this.items.get(id);if(item&&item.source.key===key){item.controller.abort();this.items.delete(id);}return {cancelled:true};}
 async confirm(source:StudioSource,id:string,consent:boolean,consentKey:string){
  const item=this.items.get(id);
  if(!item||item.scopeId&&!this.scopeCurrent(item.scopeId)||!consent||item.source.key!==source.key||item.source.jobId!==source.jobId||item.preview.consentKey!==consentKey||item.preview.expiresAt<=this.now())throw Error('Explicit current consent required');
  if(item.checked.endpoint!==source.config.summary.ollamaUrl||item.source.mediaHash!==source.mediaHash||hash(source.transcript)!==hash(item.source.transcript))throw Error('Provider/source changed after preview');
  await this.budget.assertRevision(item.checked.policyRevision,source.config.visualReview);if(item.result)return structuredClone(item.result);if(item.promise)return item.promise;
  const signal=item.controller.signal;
  item.promise=withHeavyAdmission('vision',source.jobId,async()=>{
   if(item.preview.expiresAt<=this.now()||item.scopeId&&!this.scopeCurrent(item.scopeId))throw Error('Consent expired while waiting; selection may have changed; request a fresh preview');
   signal.throwIfAborted();
   const latest=source.refresh?await source.refresh():source;
   if(latest.key!==item.source.key||latest.jobId!==item.source.jobId||latest.path!==item.source.path||latest.config.summary.ollamaUrl!==item.checked.endpoint||latest.mediaHash!==item.source.mediaHash||hash(latest.transcript)!==item.preview.transcriptHash||await hashFile(latest.path)!==item.source.mediaHash)throw Error('Provider/source changed while waiting; fresh preview required');
   const {refresh,...snapshot}=latest;source=structuredClone(snapshot);
   signal.throwIfAborted();
   const c=item.checked;await this.budget.assertRevision(c.policyRevision,source.config.visualReview);signal.throwIfAborted();
   if(await verifyLocalOllamaModel(c.endpoint,c.visionModel,true,signal)!==c.visionDigest||await verifyLocalOllamaModel(c.endpoint,c.summaryModel,false,signal)!==c.summaryDigest)throw Error('Model changed after preview');
   const identity=hash({endpoint:c.endpoint,vision:c.visionModel,summary:c.summaryModel,visionDigest:c.visionDigest,summaryDigest:c.summaryDigest,media:source.mediaHash,transcript:hash(source.transcript)});
   const adapter=createLocalOllamaVisualAdapter(c.endpoint,c.visionModel,c.visionModel);adapter.identity+=":"+hash({vision:c.visionDigest,summary:c.summaryDigest,plan:item.plan.key,window:item.reviewWindow}).slice(0,24);
   const baseInspect=adapter.inspect;adapter.inspect=async(input,s)=>{
    if(hash(input.frames)!==hash(item.preview.frames))throw Error('Extracted frame changed after consent');
    await this.budget.reserve('inference',source.jobId,identity,source.config.visualReview,true,c.policyRevision);signal.throwIfAborted();return baseInspect(input,s);
   };
   const visual=await runVisualSession({mediaHash:source.mediaHash,transcript:source.transcript,durationSeconds:item.plan.durationSeconds,sourcePath:source.path,root:join(this.root,'sessions'),adapter,manual:{requests:item.plan.requests,planKey:item.plan.key,consent:true,origin:item.origin},signal,now:this.now()});
   if(visual.expired||!visual.observations.length)throw Error('Visual evidence expired or unavailable');
   const visualEvidence={adapterIdentity:adapter.identity,expiresAt:visual.expiresAt,observations:visual.observations.map(({timestampSeconds,frameSha256,text,uncertainty})=>({timestampSeconds,frameSha256,text,uncertainty}))};
   const config=structuredClone(source.config);config.summary.ollamaUrl=c.endpoint;
   const selectedIds=item.scope?.segments.map(s=>s.id);
   const summary=await summarizeInChunks({transcript:source.transcript,segmentIds:selectedIds,mediaHash:source.mediaHash,maxCharacters:config.summary.maxInputCharacters,provider:'ollama',model:c.summaryModel,adapterIdentity:c.endpoint,visual:visualEvidence,cacheDir:join(this.root,'summaries',visual.key),signal,adapter:async(part,s)=>{
    await this.budget.reserve('inference',source.jobId,identity,source.config.visualReview,true,c.policyRevision);signal.throwIfAborted();
    if(await verifyLocalOllamaModel(c.endpoint,c.summaryModel,false,signal)!==c.summaryDigest)throw Error('Summary model changed');
    return summarizeWithOllama(config,part.text,c.summaryModel,undefined,part.evidence,s);
   }});
   summary.support!.reviewRequired=true;summary.limitations=[...(summary.limitations||[]),...(item.scope?['Resumo parcial do intervalo selecionado; restante da transcrição omitido.']:[]),'Evidência visual seletiva; revisar a origem e a incerteza.'];
   signal.throwIfAborted();if(await hashFile(source.path)!==source.mediaHash)throw Error('Source changed during review');
   const result={scope:item.scope,sourceKey:source.key,timestampSeconds:item.plan.requests[0].timestampSeconds,synthetic:false,requiresReview:true,text:visual.observations.map(o=>o.text).join('\n'),observations:visual.observations,summaryMarkdown:formatSummaryMarkdown(summary),summary,consentKey,provider:'ollama-local',visionModel:c.visionModel,summaryModel:c.summaryModel,mediaHash:source.mediaHash,transcriptHash:hash(source.transcript),expiresAt:visual.expiresAt};
   await privateDirectory(join(this.root,'results'));signal.throwIfAborted();await writePrivateArtifact(join(this.root,'results',hash(source.jobId)+'.json'),JSON.stringify({result,sha256:hash(result)}));
   item.result=result;return structuredClone(result);
  },{signal,onWait:cliAdmissionWait});return item.promise;
 }
}
