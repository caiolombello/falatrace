import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {writePrivateArtifact} from '../jobs/artifacts';
import {acquireSingleton} from '../runtime/singleton';
import {assertPrivateDirectoryAncestors} from './app-budget';
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hasRaw=(x:any)=>!!x&&typeof x==='object'&&Object.prototype.hasOwnProperty.call(x,'raw');
const valid=(x:any)=>hasRaw(x)&&x.sha256===digest(x.raw)&&Number.isFinite(x.expiresAt);
const bytesHash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
const file=(root:string,key:string)=>{if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid planner cache key');return join(root,key+'.json');};
async function plannerLease(root:string,key:string){file(root,key);const name='planner-cache-'+bytesHash(Buffer.from(resolve(root))).slice(0,16)+'-'+key.slice(0,24),deadline=Date.now()+5000;for(;;){try{return await acquireSingleton(name);}catch(e){if((e as Error).message!==name+' is already running'||Date.now()>=deadline)throw e;await new Promise(r=>setTimeout(r,25));}}}
async function rootSafe(root:string){await assertPrivateDirectoryAncestors(root);const st=await fs.lstat(root);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw Error('Unsafe planner cache root');}
async function read(root:string,key:string){await rootSafe(root);const path=file(root,key),st=await fs.lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>64000)throw Error('Unsafe planner cache file');const bytes=await fs.readFile(path);return {path,st,bytes};}
export async function sweepExpiredPlannerCache(root:string,now=Date.now(),dryRun=true){if(!Number.isFinite(now))throw Error('Invalid planner cache clock');await rootSafe(root);const names=await fs.readdir(root);if(names.length>4096)throw Error('Planner cache scan limit exceeded');const removed:string[]=[];
 for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const key=name.slice(0,64),lease=await plannerLease(root,key);try{let item;try{item=await read(root,key);}catch{continue;}let data;try{data=JSON.parse(item.bytes.toString());}catch{continue;}if(!data||data.version!==1||data.kind!=='falatrace-planner-cache'||!valid(data)||data.expiresAt>now)continue;removed.push(key);if(!dryRun){const current=await fs.lstat(item.path);if(current.ino!==item.st.ino||current.dev!==item.st.dev||bytesHash(await fs.readFile(item.path))!==bytesHash(item.bytes))throw Error('Planner cache changed during removal');await fs.unlink(item.path);}}finally{await lease.release();}}
 return removed;
}
/** Explicit optimistic recovery; no provider retry, no recursion, no delete without reviewed bytes hash. */
export async function recoverPlannerCache(root:string,key:string,expectedSha256:string,dryRun=true,allowExpiredLegacy=false){if(!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error('Explicit cache bytes hash required');file(root,key);const lease=await plannerLease(root,key);try{const item=await read(root,key);if(bytesHash(item.bytes)!==expectedSha256)throw Error('Planner cache changed; recovery refused');let valid=false,expiredLegacy=false;try{const data=JSON.parse(item.bytes.toString());valid=hasRaw(data)&&data.sha256===digest(data.raw)&&Number.isFinite(data.expiresAt);expiredLegacy=valid&&!data.kind&&!data.version&&data.expiresAt<=Date.now();}catch{}if(valid&&!(allowExpiredLegacy&&expiredLegacy))throw Error('Valid planner cache; corruption recovery refused');if(!dryRun){const current=await fs.lstat(item.path);if(current.ino!==item.st.ino||current.dev!==item.st.dev||bytesHash(await fs.readFile(item.path))!==expectedSha256)throw Error('Planner cache changed during recovery');await fs.unlink(item.path);}return {key,sha256:expectedSha256,removed:!dryRun};}finally{await lease.release();}}

export async function writePlannerCache(root:string,key:string,raw:unknown,expiresAt:number){if(!Number.isFinite(expiresAt))throw Error('Invalid planner expiry');await rootSafe(root);file(root,key);const lease=await plannerLease(root,key);try{await writePrivateArtifact(file(root,key),JSON.stringify({version:1,kind:'falatrace-planner-cache',raw,sha256:digest(raw),expiresAt}));}finally{await lease.release();}}
