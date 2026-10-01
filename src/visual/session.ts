import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Transcript } from "../jobs/types";
import { acquireSingleton } from "../runtime/singleton";
import { planVisualEvidence, type VisualPlan, type VisualRequest } from "./plan";
import { extractVisualEvidence, readCache, type VisualResult } from "./extract";
export type VisualObservation={frameFile:string;timestampSeconds:number;frameSha256:string;text:string;uncertainty:"uncertain"|"clear"};
export type LocalVisualAdapter={identity:string;localOnly:true;select(input:{segments:Array<{id:string;start:number;end:number;text:string}>;durationSeconds:number;remainingFrames:number;round:number},signal?:AbortSignal):Promise<unknown>;inspect(input:{directory:string;frames:VisualResult['frames'];questions:VisualPlan['requests']},signal?:AbortSignal):Promise<VisualObservation[]>};
type Ledger={version:1;key:string;mediaSha256:string;transcriptSha256:string;adapterIdentity:string;createdAt:number;expiresAt:number;providerRequests:number;attempts:Array<{kind:"select"|"inspect";elapsedMs?:number;state:"running"|"completed"|"failed"}>;rounds:Array<{plan:VisualPlan;state:"reserved"|"extracted"|"completed";result?:VisualResult;observations?:VisualObservation[]}>};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeDir=async(path:string)=>{await fs.mkdir(path,{recursive:true,mode:0o700});const s=await fs.lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Unsafe visual session directory');};
const readLedger=async(path:string):Promise<Ledger>=>{const s=await fs.lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw new Error('Unsafe visual ledger');const stored=JSON.parse(await fs.readFile(path,'utf8'));const data=stored.ledger as Ledger;if(stored.sha256!==digest(data)||data.version!==1||!Number.isInteger(data.providerRequests)||data.providerRequests<0||data.providerRequests>4||!Array.isArray(data.attempts)||data.attempts.length!==data.providerRequests||!Number.isFinite(data.createdAt)||!Number.isFinite(data.expiresAt)||data.expiresAt<=data.createdAt||data.expiresAt-data.createdAt>86400000||!Array.isArray(data.rounds)||data.rounds.length>2||data.rounds.reduce((n,r)=>n+r.plan.requests.length,0)>8||data.rounds.reduce((n,r)=>n+(r.result?.totalBytes||0),0)>8*1024*1024)throw new Error('Invalid visual ledger');return data;};
const writeLedger=async(path:string,ledger:Ledger)=>{const temp=path+'.'+randomUUID()+'.tmp';try {await fs.writeFile(temp,JSON.stringify({ledger,sha256:digest(ledger)}),{mode:0o600,flag:'wx'});await fs.rename(temp,path);}finally{await fs.rm(temp,{force:true});}};
const assertObservations=(values:unknown,result:VisualResult):VisualObservation[]=>{
 if(!Array.isArray(values)||values.length>result.frames.length)throw new Error('Invalid visual observations');const seen=new Set<string>();
 return values.map(raw=>{if(!raw||typeof raw!=='object'||Object.keys(raw).some(k=>!['frameFile','timestampSeconds','frameSha256','text','uncertainty'].includes(k)))throw new Error('Unsupported visual observation fields');const value=raw as VisualObservation;const frame=result.frames.find(f=>f.file===value.frameFile);if(!frame||seen.has(value.frameFile)||value.timestampSeconds!==frame.timestampSeconds||value.frameSha256!==frame.sha256||typeof value.text!=='string'||!value.text.trim()||value.text.length>4000||!['clear','uncertain'].includes(value.uncertainty))throw new Error('Visual observation does not match extracted evidence');seen.add(value.frameFile);return value;});
};
export type ManualVisualConsent = { requests: VisualRequest[]; planKey: string; consent: true };
export const runVisualSession=async(options:{mediaHash:string;transcript:Transcript;durationSeconds:number;sourcePath:string;root:string;adapter:LocalVisualAdapter;signal?:AbortSignal;round?:number;ttlSeconds?:number;now?:number;extract?:typeof extractVisualEvidence;manual?:ManualVisualConsent}):Promise<{key:string;observations:VisualObservation[];frames:VisualResult['frames'];directory:string;expiresAt:number;modelRequests:number;expired?:boolean}>=>{
 if(options.adapter.localOnly!==true||!options.adapter.identity||options.adapter.identity.length>200)throw new Error('Only explicitly local visual adapters are supported');
 const round=options.round??1;const now=options.now??Date.now();const ttl=options.ttlSeconds??3600;
 if(!Number.isFinite(now)||!Number.isInteger(ttl)||ttl<60||ttl>86400||![1,2].includes(round))throw new Error('Invalid visual session TTL/round');
 planVisualEvidence(options.mediaHash,options.transcript,options.durationSeconds,[]);options.signal?.throwIfAborted();
 // Consent is bound to the exact preview plan, not to a mutable timestamp/question.
 const manualPlan=options.manual?planVisualEvidence(options.mediaHash,options.transcript,options.durationSeconds,options.manual.requests,{round}):undefined;
 if(options.manual){
  if(options.manual.consent!==true||manualPlan!.key!==options.manual.planKey||!manualPlan!.requests.length)throw new Error('Explicit consent for the exact visual preview is required');
  for(const request of manualPlan!.requests){
   if(request.reason!=='user-request'||!request.segmentIds.length||!request.segmentIds.every(id=>{const segment=options.transcript.segments[Number(id.slice(1))];return segment&&request.timestampSeconds>=segment.start&&request.timestampSeconds<=segment.end;}))throw new Error('Manual frame request has no matching transcript timestamp');
  }
 }
 const transcriptSha256=digest(options.transcript);const key=digest({mediaHash:options.mediaHash,transcriptSha256,adapter:options.adapter.identity,duration:options.durationSeconds,version:1});
 await safeDir(options.root);const lease=await acquireSingleton('visual-session-'+key.slice(0,32));const directory=join(options.root,key);let requests=0;
 try {
  await safeDir(directory);const path=join(directory,'.visual-session.json');let ledger:Ledger;
  try{ledger=await readLedger(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;ledger={version:1,key,mediaSha256:options.mediaHash,transcriptSha256,adapterIdentity:options.adapter.identity,createdAt:now,expiresAt:now+ttl*1000,providerRequests:0,attempts:[],rounds:[]};await writeLedger(path,ledger);}
  if(ledger.key!==key||ledger.mediaSha256!==options.mediaHash||ledger.transcriptSha256!==transcriptSha256||ledger.adapterIdentity!==options.adapter.identity)throw new Error('Visual ledger source identity mismatch');
  if(ledger.expiresAt<=now)return {key,observations:[],frames:[],directory,expiresAt:ledger.expiresAt,modelRequests:0,expired:true};
  const invoke=async<T>(kind:'select'|'inspect',call:()=>Promise<T>):Promise<T>=>{
   if(ledger.providerRequests>=4)throw new Error('Visual provider request budget exhausted');
   options.signal?.throwIfAborted();requests++;ledger.providerRequests++;const attempt:Ledger['attempts'][number]={kind,state:'running'};ledger.attempts.push(attempt);await writeLedger(path,ledger);const started=performance.now();
   try {const value=await call();attempt.state='completed';return value;}catch(error){attempt.state='failed';throw error;}finally{attempt.elapsedMs=performance.now()-started;await writeLedger(path,ledger);}
  };
  let item=ledger.rounds[round-1];
  if(item?.plan.requests.some(r=>r.reason==='user-request')&&!manualPlan)throw new Error('Manual visual round requires consent on resume');
  if(item&&manualPlan&&item.plan.key!==manualPlan.key)throw new Error('Visual round already reserved for a different consent plan');
  if(!item){
   if(round!==ledger.rounds.length+1||ledger.rounds.some(r=>r.state!=='completed'))throw new Error('Visual rounds must complete sequentially');
   const candidates=options.transcript.segments.flatMap((s,i)=>/veja|tela|gr[aá]fico|slide|inaud[ií]vel|\[.*inaudible.*\]/i.test(s.text)?[{id:'s'+String(i).padStart(6,'0'),...s}]:[]);
   if(JSON.stringify(candidates).length>24000)throw new Error('Visual selector transcript budget exceeded; request a narrower review');
   const used=ledger.rounds.flatMap(r=>r.plan.requests.map(p=>p.timestampSeconds));
   options.signal?.throwIfAborted();const raw=manualPlan?manualPlan.requests:candidates.length&&used.length<8?await invoke('select',()=>options.adapter.select({segments:candidates,durationSeconds:options.durationSeconds,remainingFrames:8-used.length,round},options.signal)):[];
   const plan=planVisualEvidence(options.mediaHash,options.transcript,options.durationSeconds,raw,{round,usedTimestamps:used});
   if(manualPlan&&plan.key!==manualPlan.key)throw new Error('Manual preview conflicts with previously reserved frames');
   if(!manualPlan)for(const request of plan.requests){if(request.reason==='user-request'||!request.segmentIds.some(id=>candidates.some(s=>s.id===id&&request.timestampSeconds>=Math.max(0,s.start-5)&&request.timestampSeconds<=Math.min(options.durationSeconds,s.end+5))))throw new Error('AI frame request has no matching transcript window');}
   item={plan,state:'reserved'};ledger.rounds.push(item);await writeLedger(path,ledger);
  }
  if(item.state==='reserved'){
   const result=await (options.extract||extractVisualEvidence)(item.plan,options.sourcePath,join(directory,'frames'),{signal:options.signal,byteBudget:8*1024*1024-ledger.rounds.reduce((n,r)=>n+(r.result?.totalBytes||0),0)});
   if(result.mediaSha256!==options.mediaHash||result.key!==item.plan.key||result.totalBytes+ledger.rounds.reduce((n,r)=>n+(r.result?.totalBytes||0),0)>8*1024*1024)throw new Error('Visual session byte budget exceeded');
   item.result=result;item.state='extracted';await writeLedger(path,ledger);
  }
  if(item.result?.frames.length){
   const verified=await (options.extract||extractVisualEvidence)(item.plan,options.sourcePath,join(directory,'frames'),{signal:options.signal,byteBudget:item.result.totalBytes});
   if(digest({...verified,reused:false})!==digest({...item.result,reused:false}))throw new Error('Visual checkpoint differs from verified cache');
  }
  if(item.state==='extracted'){
   options.signal?.throwIfAborted();const result=item.result!;const observations=result.frames.length?await invoke('inspect',()=>options.adapter.inspect({directory:join(directory,'frames',item!.plan.key),frames:result.frames,questions:item!.plan.requests},options.signal)):[];
   options.signal?.throwIfAborted();item.observations=assertObservations(observations,result);item.state='completed';await writeLedger(path,ledger);
  }
  return {key,observations:ledger.rounds.flatMap(r=>r.observations||[]),frames:ledger.rounds.flatMap(r=>r.result?.frames||[]),directory,expiresAt:ledger.expiresAt,modelRequests:requests};
 }finally{await lease.release();}
};
const disposableSession=async(directory:string,ledger:Ledger):Promise<boolean>=>{
 try {
  const names=await fs.readdir(directory);if(names.some(name=>!['.visual-session.json','frames'].includes(name)))return false;
  if(!names.includes('frames'))return false;
  const root=join(directory,'frames');const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())return false;
  for(const key of await fs.readdir(root)){
   const round=ledger.rounds.find(r=>r.plan.key===key);if(!round)return false;
   const cache=await readCache(join(root,key),round.plan);if(!cache)return false;
   const files=await fs.readdir(join(root,key));if(files.some(name=>name!=='frames.json'&&!cache.frames.some(f=>f.file===name)))return false;
  }
  return true;
 }catch{return false;}
};
export const cleanupExpiredVisualSessions=async(root:string,now=Date.now(),dryRun=true):Promise<string[]>=>{
 const stat=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return [];if(!stat.isDirectory()||stat.isSymbolicLink()||!Number.isFinite(now))throw new Error('Unsafe visual cleanup root');const removed:string[]=[];
 for(const name of await fs.readdir(root)){if(!/^[a-f0-9]{64}$/.test(name))continue;const lease=await acquireSingleton('visual-session-'+name.slice(0,32));try{const path=join(root,name);const directory=await fs.lstat(path);if(!directory.isDirectory()||directory.isSymbolicLink())continue;let ledger:Ledger;try{ledger=await readLedger(join(path,'.visual-session.json'));}catch{continue;}if(ledger.key!==name||ledger.expiresAt>now||!await disposableSession(path,ledger))continue;removed.push(name);if(!dryRun)await fs.rm(join(path,'frames'),{recursive:true,force:true});}finally{await lease.release();}}
 return removed;
};
