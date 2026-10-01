import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {acquireSingleton} from '../runtime/singleton';
import {writePrivateArtifact} from '../jobs/artifacts';
/** Temporary alpha defaults, independent of any benchmark budget. Explicit config can replace limits, never counters. */
export const VISUAL_APP_LIMITS={inferences:24,previews:16} as const;
export type VisualBudgetPolicy={maxInferences:number;maxPreviews:number;period:'lifetime'};
export const visualBudgetPolicy=(config?:VisualBudgetPolicy):VisualBudgetPolicy=>{const p=config||{maxInferences:24,maxPreviews:16,period:'lifetime'};if(p.period!=='lifetime'||![p.maxInferences,p.maxPreviews].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=1000))throw Error('Invalid visual budget policy');return {maxInferences:p.maxInferences,maxPreviews:p.maxPreviews,period:p.period};};
export async function assertPrivateDirectoryAncestors(path:string) {
 const absolute=resolve(path);let parent=absolute;
 while(parent!==dirname(parent)){const stat=await fs.lstat(parent).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw Error('Unsafe visual app state');parent=dirname(parent);}
}
export async function privateDirectory(path:string){await assertPrivateDirectoryAncestors(path);await fs.mkdir(resolve(path),{recursive:true,mode:0o700});}

/** Fixed app-root lifetime counters. No reset/refund/identity-scope switch in the UI. */
export class VisualAppBudget {
 constructor(readonly root:string,private readPolicy?:()=>Promise<VisualBudgetPolicy|undefined>){}
 async snapshot(configured?:VisualBudgetPolicy){return this.reserve(undefined,'','',configured,false);}
 async assertRevision(revision:number,configured?:VisualBudgetPolicy){const state=await this.snapshot(configured);if(state.policyRevision!==revision)throw Error('Visual budget policy changed; fresh consent required');return state;}
 async reserve(kind:'preview'|'inference'|undefined,job:string,identity:string,configured?:VisualBudgetPolicy,bindIdentity=true,expectedRevision?:number) {
  await privateDirectory(this.root);
  const name='visual-app-budget-'+createHash('sha256').update(resolve(this.root)).digest('hex').slice(0,24);let lease;const deadline=Date.now()+5000;for(;;){try{lease=await acquireSingleton(name);break;}catch(error){if((error as Error).message!==name+' is already running'||Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,25));}}
  try{
   const loader=await import('../config/load');const authority=this.readPolicy?'injected-test-reader':loader.getRequestedConfigDir();const configPath=this.readPolicy?'<injected>':loader.getConfigPath();const snapshot=this.readPolicy?{config:{visualReview:await this.readPolicy()},exists:true,visualPolicyDeclared:true}:await loader.loadConfigSnapshot(configPath).catch(e=>{if(e.code==='ENOENT')return {config:{visualReview:undefined},exists:false,visualPolicyDeclared:false};throw e;});const configPresent=snapshot.exists,policy=visualBudgetPolicy(snapshot.config.visualReview);const requested=visualBudgetPolicy(configured);const path=join(this.root,'budget.json');let data:{version:number;inferences:number;previews:number;jobs:Record<string,string>;policy?:VisualBudgetPolicy;policyRevision?:number;authority?:string;configPresent?:boolean;configPath?:string;policyDeclared?:boolean;audit?:Array<{at:string;from:VisualBudgetPolicy|null;to:VisualBudgetPolicy;inferences:number;previews:number}>}={version:1,inferences:0,previews:0,jobs:{}};
   const stat=await fs.lstat(path).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
   if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Unsafe global visual budget');data=JSON.parse(await fs.readFile(path,'utf8'));}
   if(data.version!==1||!Number.isSafeInteger(data.inferences)||data.inferences<0||data.inferences>1000000||!Number.isSafeInteger(data.previews)||data.previews<0||data.previews>1000000||!data.jobs||typeof data.jobs!=='object'||Array.isArray(data.jobs)||Object.keys(data.jobs).length>2000||Object.values(data.jobs).some(x=>typeof x!=='string'))throw Error('Invalid global visual budget');
   if(data.authority&&data.authority!==authority)throw Error('Visual policy authority differs; explicit migration required');if(data.configPresent&&data.configPath&&data.configPath!==configPath&&configPath!==join(authority,'config.json'))throw Error('Canonical config fallback refused; explicit migration required');if(data.policyDeclared&&!snapshot.visualPolicyDeclared)throw Error('Canonical visualReview policy missing; explicit defaults required');if(data.configPresent&&!configPresent)throw Error('Canonical policy config missing; no defaults fallback permitted');if(!data.authority||data.configPresent!==configPresent||data.configPath!==configPath||data.policyDeclared!==snapshot.visualPolicyDeclared){data.authority=authority;data.configPresent=configPresent;data.configPath=configPath;data.policyDeclared=snapshot.visualPolicyDeclared;await writePrivateArtifact(path,JSON.stringify(data));}
   if(data.policy)visualBudgetPolicy(data.policy);if(data.policyRevision!==undefined&&(!Number.isSafeInteger(data.policyRevision)||data.policyRevision<1))throw Error('Invalid visual policy revision');
   if(data.audit && (!Array.isArray(data.audit)||data.audit.length>256||data.audit.some(a=>!a||!Number.isFinite(Date.parse(a.at))||!Number.isSafeInteger(a.inferences)||!Number.isSafeInteger(a.previews)||a.inferences<0||a.previews<0||!a.to)))throw Error('Invalid visual budget audit');
   if(JSON.stringify(data.policy)!==JSON.stringify(policy)){if((data.audit?.length||0)>=256)throw Error('Visual budget audit full; no reset allowed');data.audit=[...(data.audit||[]),{at:new Date().toISOString(),from:data.policy||null,to:policy,inferences:data.inferences,previews:data.previews}];data.policy=policy;data.policyRevision=(data.policyRevision||0)+1;await writePrivateArtifact(path,JSON.stringify(data));}
   if(!data.policyRevision){data.policyRevision=1;await writePrivateArtifact(path,JSON.stringify(data));}
   if(JSON.stringify(requested)!==JSON.stringify(policy)||expectedRevision!==undefined&&data.policyRevision!==expectedRevision)throw Error('Visual budget policy changed; refresh config and consent');
   const state=()=>({policyRevision:data.policyRevision!,remainingInferences:Math.max(0,policy.maxInferences-data.inferences),remainingPreviews:Math.max(0,policy.maxPreviews-data.previews),budgetScope:'user-installation',budgetPeriod:policy.period,budgetLimits:policy,temporaryAlphaDefaults:!configured});
   if(!kind)return state();
   const jobKey=createHash('sha256').update(job).digest('hex');
   if(bindIdentity&&data.jobs[jobKey]&&data.jobs[jobKey]!==identity)throw Error('Provider/model identity locked for this job');
   const field=kind==='preview'?'previews':'inferences';
   if(data[field]>=(kind==='preview'?policy.maxPreviews:policy.maxInferences))throw Error('Global visual app budget exhausted');
   data[field]++;if(kind==='inference'&&bindIdentity)data.jobs[jobKey]=identity;
   await writePrivateArtifact(path,JSON.stringify(data));
   return state();
  }finally{await lease.release();}
 }
}
