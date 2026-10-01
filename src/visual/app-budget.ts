import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {acquireSingleton} from '../runtime/singleton';
import {writePrivateArtifact} from '../jobs/artifacts';
export const VISUAL_APP_LIMITS={inferences:24,previews:16} as const;
export async function assertPrivateDirectoryAncestors(path:string) {
 const absolute=resolve(path);let parent=absolute;
 while(parent!==dirname(parent)){const stat=await fs.lstat(parent).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw Error('Unsafe visual app state');parent=dirname(parent);}
}
export async function privateDirectory(path:string){await assertPrivateDirectoryAncestors(path);await fs.mkdir(resolve(path),{recursive:true,mode:0o700});}

/** Fixed app-root lifetime counters. No reset/refund/identity-scope switch in the UI. */
export class VisualAppBudget {
 constructor(readonly root:string){}
 async reserve(kind:'preview'|'inference',job:string,identity:string) {
  await privateDirectory(this.root);
  const lease=await acquireSingleton('visual-app-budget-'+createHash('sha256').update(resolve(this.root)).digest('hex').slice(0,24));
  try{
   const path=join(this.root,'budget.json');let data:{version:number;inferences:number;previews:number;jobs:Record<string,string>}={version:1,inferences:0,previews:0,jobs:{}};
   const stat=await fs.lstat(path).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
   if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Unsafe global visual budget');data=JSON.parse(await fs.readFile(path,'utf8'));}
   if(data.version!==1||!Number.isSafeInteger(data.inferences)||data.inferences<0||data.inferences>24||!Number.isSafeInteger(data.previews)||data.previews<0||data.previews>16||!data.jobs||typeof data.jobs!=='object'||Array.isArray(data.jobs)||Object.keys(data.jobs).length>40||Object.values(data.jobs).some(x=>typeof x!=='string'))throw Error('Invalid global visual budget');
   const jobKey=createHash('sha256').update(job).digest('hex');
   if(data.jobs[jobKey]&&data.jobs[jobKey]!==identity)throw Error('Provider/model identity locked for this job');
   const field=kind==='preview'?'previews':'inferences';
   if(data[field]>=VISUAL_APP_LIMITS[field])throw Error('Global visual app budget exhausted');
   data[field]++;if(kind==='inference')data.jobs[jobKey]=identity;
   await writePrivateArtifact(path,JSON.stringify(data));
   return {remainingInferences:24-data.inferences,remainingPreviews:16-data.previews};
  }finally{await lease.release();}
 }
}
