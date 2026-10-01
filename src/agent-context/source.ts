import {promises as fs} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {JobStore,hashFile} from '../jobs/store';
import {ArchiveStore} from '../archive/store';
import {validateMediaExtension} from '../jobs/types';
import {assertId,type SourceBinding} from './access';

export class RecordingCatalog{
 constructor(readonly jobs=new JobStore(),readonly archive=new ArchiveStore()){}
 async get(id:string):Promise<SourceBinding&{title:string;job:boolean}>{
  assertId(id);let job;
  try{job=await this.jobs.get(id);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(job){await this.regular(job.sourcePath);return {id,path:resolve(job.sourcePath),sha256:job.source.sha256,title:job.source.originalName,job:true};}
  const a=await this.archive.get(id);if(!a||!a.source.sha256)throw Error('Recording is not registered with a source hash');await this.regular(a.sourcePath);return {id,path:resolve(a.sourcePath),sha256:a.source.sha256,title:a.source.fileName,job:false};
 }
 async registeredIds(){
  // IDs only: no transcript/title scan and no media decoding for discovery.
  const ids=new Set<string>();
  for(const root of [this.jobs.stateDir,this.archive.stateDir]){
   const names=await fs.readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
   if(names.length>10000)throw Error('Recording catalog exceeds bounded discovery limit');
   for(const n of names)if(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(n))ids.add(assertId(n.slice(0,-5)));
  }
  return [...ids].sort();
 }
 async regular(path:string){validateMediaExtension(path);for(let p=resolve(path);;p=dirname(p)){const st=await fs.lstat(p);if(st.isSymbolicLink())throw Error('Recording symlink refused');if(p===dirname(p))break;}const st=await fs.lstat(path);if(!st.isFile()||st.size<=0)throw Error('Recording must be finalized regular media');}
 async validate(binding:SourceBinding){const current=await this.get(binding.id);if(current.path!==binding.path||current.sha256!==binding.sha256||await hashFile(current.path)!==binding.sha256)throw Error('Recording source changed; existing opt-in is not widened');return current;}
 async snapshot(ids:string[],workspace?:string){if(!ids.length||ids.length>256||new Set(ids).size!==ids.length)throw Error('Select 1–256 distinct registered recordings');const sources=await Promise.all(ids.map(id=>this.get(id)));if(workspace){const root=resolve(workspace)+sep;if(sources.some(s=>!s.path.startsWith(root)))throw Error('Recording outside configured workspace');}return sources.map(({id,path,sha256})=>({id,path,sha256}));}
}
