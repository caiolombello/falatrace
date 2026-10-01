import {promises as fs} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {getDefaultJobStateDir} from '../jobs/store';
import {privateDirectory,assertPrivateDirectoryAncestors} from '../visual/app-budget';
import {writePrivateArtifact} from '../jobs/artifacts';
import {acquireSingleton} from '../runtime/singleton';

export type SourceBinding={id:string;path:string;sha256:string};
import {validateProvider,validateAnalysis,type ProviderRecipient,type AnalysisOptions} from '../provider-analysis/contracts';
export type Recipient={kind:'agent';id:string}|ProviderRecipient;
export const INSTALLATION_RECIPIENTS=['codex-openai','claude-anthropic','gemini-google'] as const;
export const installationIdentity=()=>digest(resolve(dirname(getDefaultJobStateDir())));
export type Grant={version:1;kind:'falatrace-context-optin';id:string;createdAt:number;recipient:Recipient;scope:{kind:'recordings'|'workspace-snapshot'|'installation-recordings';sources:SourceBinding[];installation?:{stateRootHash:string;includeFuture:true;excludeSecrets:true;deniedRecordings:string[]}};data:Array<'context'|'frames'>;limits:{maxFrames:number;maxBytes:number;cacheTtlMs:number};analysis?:AnalysisOptions;paused:boolean;revoked:boolean;revision:number};
export const accessRoot=()=>join(dirname(getDefaultJobStateDir()),'agent-context');
export const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const assertId=(id:string)=>{if(typeof id!=='string'||!idPattern.test(id))throw Error('Invalid recording/access ID');return id;};
const recipient=(r:Recipient)=>{if(r?.kind==='provider'){validateProvider(r);return;}if(r?.kind!=='agent'||!/^[-a-z0-9._]{1,64}$/.test(r.id||''))throw Error('Unsupported or invalid recipient');};
const finite=(n:number,min:number,max:number)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function validate(g:Grant){recipient(g?.recipient);const installation=g?.scope?.kind==='installation-recordings',policy=g?.scope?.installation;if(installation){if(g.data?.length!==1||g.data[0]!=='frames'||g.recipient.kind!=='agent'||!INSTALLATION_RECIPIENTS.includes(g.recipient.id as any)||!policy||policy.includeFuture!==true||policy.excludeSecrets!==true||! /^[a-f0-9]{64}$/.test(policy.stateRootHash)||!Array.isArray(policy.deniedRecordings)||policy.deniedRecordings.length>5000||policy.deniedRecordings.some(id=>typeof id!=='string'||!idPattern.test(id))||g.scope.sources?.length!==0)throw Error('Invalid named installation opt-in');}else if(policy)throw Error('Unexpected installation policy');if(g?.recipient.kind==='provider')validateAnalysis(g.analysis!);else if(g?.analysis)throw Error('Agent retrieval grant cannot authorize API analysis');if(g?.version!==1||g.kind!=='falatrace-context-optin'||!idPattern.test(g.id)||!finite(g.createdAt,0,Number.MAX_SAFE_INTEGER)||!['recordings','workspace-snapshot','installation-recordings'].includes(g.scope?.kind)||!Array.isArray(g.scope.sources)||(!installation&&!g.scope.sources.length)||g.scope.sources.length>256||new Set(g.scope.sources.map(s=>s.id)).size!==g.scope.sources.length||g.scope.sources.some(s=>!idPattern.test(s.id)||typeof s.path!=='string'||!s.path.startsWith('/')||/[\r\n\0]/.test(s.path)||! /^[a-f0-9]{64}$/.test(s.sha256))||!Array.isArray(g.data)||!g.data.length||g.data.some(x=>!['context','frames'].includes(x))||!finite(g.limits?.maxFrames,1,6)||!finite(g.limits?.maxBytes,65536,8*1024*1024)||!finite(g.limits?.cacheTtlMs,1000,3600000)||typeof g.paused!=='boolean'||typeof g.revoked!=='boolean'||!finite(g.revision,1,Number.MAX_SAFE_INTEGER))throw Error('Invalid context opt-in; no legacy receipt conversion');return g;}
export class ContextAccess{
 constructor(readonly root=accessRoot(),readonly now=Date.now,readonly installationId=installationIdentity()){}
 private path(id:string){return join(this.root,'grants',assertId(id)+'.json');}
 async read(id:string){const p=this.path(id);await assertPrivateDirectoryAncestors(dirname(p));const st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>256000)throw Error('Unsafe opt-in artifact');const raw=JSON.parse(await fs.readFile(p,'utf8'));if(raw.sha256!==digest(raw.grant))throw Error('Opt-in changed/corrupt');const grant=validate(raw.grant);if(grant.scope.installation&&grant.scope.installation.stateRootHash!==this.installationId)throw Error('Opt-in belongs to another installation');return grant;}
 async authorize(input:{consent:boolean;recipient:Recipient;scope:Grant['scope'];data:Grant['data'];limits?:Partial<Grant['limits']>;analysis?:AnalysisOptions}){
  if(input.consent!==true)throw Error('Explicit one-time data/recipient/scope opt-in required');const g=validate({version:1,kind:'falatrace-context-optin',id:randomUUID(),createdAt:this.now(),recipient:input.recipient,scope:input.scope,data:input.data,limits:{maxFrames:2,maxBytes:2*1024*1024,cacheTtlMs:300000,...input.limits},...(input.analysis?{analysis:input.analysis}:{}),paused:false,revoked:false,revision:1});await privateDirectory(join(this.root,'grants'));await writePrivateArtifact(this.path(g.id),JSON.stringify({grant:g,sha256:digest(g)}));return g;
 }
 async list(recordingId:string){
  assertId(recordingId);const root=join(this.root,'grants');await assertPrivateDirectoryAncestors(root);
  const names=await fs.readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});if(names.length>256)throw Error('Opt-in catalog full');
  const grants=[];for(const name of names){if(!name.endsWith('.json'))continue;const g=await this.read(name.slice(0,-5));if(g.scope.kind==='installation-recordings'&&!g.scope.installation!.deniedRecordings.includes(recordingId)||g.scope.sources.some(s=>s.id===recordingId))grants.push(g);}
  return grants.sort((a,b)=>b.createdAt-a.createdAt);
 }
 async require(id:string,r:Recipient,data:'context'|'frames',recordingId?:string){const g=await this.read(id);recipient(r);if(g.paused||g.revoked)throw Error('Context access paused/revoked');if(digest(g.recipient)!==digest(r))throw Error('Recipient outside opt-in');if(!g.data.includes(data))throw Error('Data outside opt-in');if(recordingId&&(g.scope.kind==='installation-recordings'?g.scope.installation!.deniedRecordings.includes(assertId(recordingId)):!g.scope.sources.some(s=>s.id===assertId(recordingId))))throw Error('Recording outside opt-in scope');return g;}
 async exclude(id:string,recordingId:string){
  assertId(recordingId);const lock=await acquireSingleton('context-optin-'+assertId(id).replaceAll('-',''));
  try{const g=await this.read(id);if(g.scope.kind!=='installation-recordings')throw Error('Exclude requires an installation grant');if(!g.scope.installation!.deniedRecordings.includes(recordingId)){g.scope.installation!.deniedRecordings.push(recordingId);g.revision++;validate(g);await writePrivateArtifact(this.path(id),JSON.stringify({grant:g,sha256:digest(g)}));}return g;}finally{await lock.release();}
 }
 async change(id:string,action:'pause'|'resume'|'revoke'){
  assertId(id);const lock=await acquireSingleton('context-optin-'+id.replaceAll('-',''));
  try{const g=await this.read(id);if(g.revoked&&action!=='revoke')throw Error('Revoked opt-in cannot resume; new choice required');g.paused=action==='pause';g.revoked=action==='revoke'||g.revoked;g.revision++;await writePrivateArtifact(this.path(id),JSON.stringify({grant:g,sha256:digest(g)}));return g;}finally{await lock.release();}
 }
}
