import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { getRecordingStateDir } from '../recording/session';
import { acquireSingleton } from './singleton';
import { privateDirectory } from '../visual/app-budget';
import { writePrivateArtifact } from '../jobs/artifacts';

export type Activity = { recording: 'active'|'idle'|'unknown'; call: 'active'|'idle'|'unknown' };
export type Policy = { pause: 'capture-and-call'|'capture'|'off'; unknown: 'wait'|'allow' };
export type WaitReason = 'recording-active'|'call-inferred'|'activity-unknown'|'queue';
type Owner = { pid:number; boot:string; start:string };
type Ticket = { id:string; job:string; kind:string; owner:Owner; reason?:WaitReason };
type State = { version:1; queue:Ticket[]; active?:string };
const context = new AsyncLocalStorage<{ root:string; job:string; active:boolean }>();
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export const heavyRoot = () => join(getRecordingStateDir(),'heavy-admission');
export function heavyPolicy(env=process.env):Policy {
 const pause=env.FALATRACE_HEAVY_PAUSE || 'capture-and-call';
 const unknown=env.FALATRACE_HEAVY_UNKNOWN || 'wait';
 if(!['capture-and-call','capture','off'].includes(pause)||!['wait','allow'].includes(unknown))throw Error('Invalid heavy admission policy');
 return {pause:pause as Policy['pause'],unknown:unknown as Policy['unknown']};
}
export function activityReason(a:Activity,p:Policy):WaitReason|undefined {
 if(p.pause==='off')return;
 if(a.recording==='active')return 'recording-active';
 if(p.pause==='capture-and-call'&&a.call==='active')return 'call-inferred';
 if(p.unknown==='wait'&&(a.recording==='unknown'||p.pause==='capture-and-call'&&a.call==='unknown'))return 'activity-unknown';
}
const messages:Record<WaitReason,string>={
 'recording-active':'Aguardando a gravação terminar; mídia e áudio preservados.',
 'call-inferred':'Aguardando a chamada inferida terminar; nenhum pipeline novo iniciado.',
 'activity-unknown':'Aguardando estado de captura/chamada confiável; política de estado desconhecido = wait.',
 'queue':'Aguardando outro pipeline pesado; ordem FIFO preservada.'
};
export const waitMessage=(reason:WaitReason)=>messages[reason];
async function privateJson(path:string,max=65536):Promise<any|undefined> {
 const st=await fs.lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});
 if(!st)return;
 if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('Unsafe admission input');
 return JSON.parse(await fs.readFile(path,'utf8'));
}
/** Persisted recording intent is conservative: stale active requires recovery, never TTL unlock. */
export async function readActivity(root=getRecordingStateDir(),now=Date.now()):Promise<Activity> {
 let recording:Activity['recording']='unknown',call:Activity['call']='unknown';
 try {const s=await privateJson(join(root,'recording-session.json'));
  if(s===undefined)recording='idle';
  if(s?.version===1&&typeof s.id==='string'&&/^[a-f0-9-]{36}$/i.test(s.id)&&['manual','call'].includes(s.owner)&&['audio','gpu-screen-recorder','obs'].includes(s.backend)&&typeof s.outputPath==='string'&&isAbsolute(s.outputPath)&&Number.isFinite(Date.parse(s.startedAt))&&['starting','recording','stopped'].includes(s.phase))recording=s.phase==='stopped'?'idle':'active';
 }catch{/* Invalid/detector errors stay unknown. */}
 try {const s=await privateJson(join(root,'call-monitor.json'));
  if(s?.version===1&&s.dryRun===false&&typeof s.recordingOwned==='boolean'&&Number.isFinite(s.confidence)&&s.confidence>=0&&s.confidence<=1&&Array.isArray(s.reasons)&&s.reasons.every((r:unknown)=>typeof r==='string')&&['IDLE','CANDIDATE','IN_CALL','ENDING'].includes(s.state)){
   const age=now-Date.parse(s.updatedAt);
   if(['IN_CALL','ENDING'].includes(s.state))call='active';
   else if(Number.isFinite(age)&&age>=0&&age<=30000)call=s.state==='IDLE'?'idle':'unknown';
  }
 }catch{/* No silent inference of inactivity. */}
 return {recording,call};
}
async function owner(pid=process.pid):Promise<Owner> {
 const [boot,stat]=await Promise.all([fs.readFile('/proc/sys/kernel/random/boot_id','utf8'),fs.readFile(`/proc/${pid}/stat`,'utf8')]);
 const parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 if(!/^\d+$/.test(parts[19]||''))throw Error('Process identity unavailable');
 return {pid,boot:boot.trim(),start:parts[0]==='Z'?'dead':parts[19]};
}
async function alive(o:Owner):Promise<boolean> {
 try {const current=await owner(o.pid);return current.start!=='dead'&&current.boot===o.boot&&current.start===o.start;}
 catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code||''))return false;throw e;}
}
const validate=(s:any):State=>{
 if(s?.version!==1||!Array.isArray(s.queue)||s.queue.length>64||s.queue.some((t:any)=>!t||typeof t.id!=='string'||!/^[-a-f0-9]{36}$/.test(t.id)||typeof t.job!=='string'||!/^[a-f0-9]{64}$/.test(t.job)||typeof t.kind!=='string'||!['pipeline','preview','vision','diarization','playback','subtitles','command'].includes(t.kind)||!Number.isSafeInteger(t.owner?.pid)||t.owner.pid<1||typeof t.owner.boot!=='string'||!/^[-a-f0-9]{36}$/.test(t.owner.boot)||typeof t.owner.start!=='string'||!/^\d+$/.test(t.owner.start)||t.reason!==undefined&&!Object.prototype.hasOwnProperty.call(messages,t.reason))||new Set(s.queue.map((t:Ticket)=>t.id)).size!==s.queue.length||s.active!==undefined&&!s.queue.some((t:Ticket)=>t.id===s.active))throw Error('Invalid admission state; retained for review');
 return s;
};
export type AdmissionOptions={root?:string;signal?:AbortSignal;policy?:Policy;activity?:()=>Promise<Activity>;onWait?:(reason:WaitReason)=>void;pollMs?:number};
const delay=(ms:number,signal?:AbortSignal)=>new Promise<void>((yes,no)=>{
 signal?.throwIfAborted();const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);no(signal?.reason||Error('Cancelled'));};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);yes();},ms);signal?.addEventListener('abort',stop,{once:true});
});
const pendingReleases=new Map<string,string>();
async function transaction<T>(root:string,act:(s:State)=>Promise<T>,readOnly=false):Promise<T>{
 if(readOnly){await privateDirectoryCheck(root);}else await privateDirectory(root);const rootStat=await fs.stat(root);
 if(rootStat.uid!==process.getuid?.()||(rootStat.mode&0o077)!==0)throw Error('Unsafe admission directory permissions');
 const key='heavy-admission-'+hash(`${rootStat.dev}:${rootStat.ino}`).slice(0,24);
 let lease;
 for(;;){try{lease=await acquireSingleton(key);break;}catch(e){if((e as Error).message!==`${key} is already running`)throw e;await delay(30);}}
 try {const path=join(root,'queue.json');const state=validate(await privateJson(path)||{version:1,queue:[]});
  const live:Ticket[]=[];for(const t of state.queue)if(pendingReleases.get(t.id)!==root&&await alive(t.owner))live.push(t);
  state.queue=live;if(state.active&&!live.some(t=>t.id===state.active))delete state.active;
  const result=await act(state);if(!readOnly){await writePrivateArtifact(path,JSON.stringify(state));for(const [id,pendingRoot] of pendingReleases)if(pendingRoot===root&&!state.queue.some(t=>t.id===id))pendingReleases.delete(id);}return result;
 }finally{await lease.release();}
}
/** Cross-process FIFO. No TTL stealing: only proved dead/PID-reused owners are reclaimed. */
export async function withHeavyAdmission<T>(kind:Ticket['kind'],job:string,run:()=>Promise<T>,options:AdmissionOptions={}):Promise<T>{
 const root=resolve(options.root||heavyRoot());
 const held=context.getStore();
 if(held?.root===root&&held.active){if(kind==='command'||held.job===hash(job))return run();throw Error('Nested different job admission refused');}
 const policy=options.policy||heavyPolicy();
 if(!['capture-and-call','capture','off'].includes(policy.pause)||!['wait','allow'].includes(policy.unknown))throw Error('Invalid heavy admission policy');
  const ticket:Ticket={id:randomUUID(),job:hash(job),kind,owner:await owner()};
 options.signal?.throwIfAborted();
 await transaction(root,async s=>{if(kind!=='command'&&s.queue.some(t=>t.job===ticket.job&&t.kind===kind))throw Error('Heavy operation for this job is already pending or running');if(s.queue.length>=64)throw Error('Heavy queue full; request retained by caller');s.queue.push(ticket);});
 let previous:WaitReason|undefined;
 try {
  for(;;){options.signal?.throwIfAborted();
   let a:Activity;try{a=await(options.activity||readActivity)();}catch{a={recording:'unknown',call:'unknown'};}
   const reason=await transaction(root,async s=>{
    const own=s.queue.find(t=>t.id===ticket.id);if(!own)throw Error('Admission ticket lost; no work started');
    const waiting=s.active||s.queue[0]?.id!==ticket.id?'queue':activityReason(a,policy);
    own.reason=waiting;if(!waiting)s.active=ticket.id;return waiting;
   });
   if(!reason){options.signal?.throwIfAborted();const held={root,job:ticket.job,active:true};
    try{return await context.run(held,run);}finally{held.active=false;}}
   if(previous!==reason){previous=reason;options.onWait?.(reason);}
   await delay(Math.max(25,options.pollMs||1000),options.signal);
  }
 }finally{
  pendingReleases.set(ticket.id,root);let error:unknown;
  for(let attempt=0;attempt<3;attempt++){try{await transaction(root,async s=>{s.queue=s.queue.filter(t=>t.id!==ticket.id);if(s.active===ticket.id)delete s.active;});error=undefined;break;}catch(e){error=e;if(attempt<2)await delay(30*(attempt+1));}}
  if(error)console.error(JSON.stringify({event:'processing.release-pending',message:'Admission cleanup failed; retained for the next transaction. Work outcome preserved.'}));
 }
}
async function privateDirectoryCheck(root:string){await import('../visual/app-budget').then(m=>m.assertPrivateDirectoryAncestors(root));}
export async function readHeavyStatus(root=heavyRoot()) {
 const empty=()=>({active:false,waiting:[] as Array<{job:string;kind:string;reason:WaitReason;message:string}>,policy:heavyPolicy(),activity:undefined as Activity|undefined});
 const st=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return;throw e;});if(!st)return {...empty(),activity:await readActivity()};
 return transaction(root,async s=>({active:!!s.active,waiting:s.queue.filter(t=>t.id!==s.active).map(t=>({job:t.job,kind:t.kind,reason:t.reason||'queue',message:waitMessage(t.reason||'queue')})),policy:heavyPolicy(),activity:await readActivity()}),true);
}
export const cliAdmissionWait=(reason:WaitReason)=>console.error(JSON.stringify({event:'processing.waiting',reason,message:waitMessage(reason)}));
