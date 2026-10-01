import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {ContextAccess,digest,INSTALLATION_RECIPIENTS} from '../access';
import {RecordingCatalog} from '../source';
import {AgentRetrieval} from '../retrieval';
import {VisualAppBudget} from '../../visual/app-budget';
import {runCommand} from '../../jobs/command';
const policy={maxPreviews:2,maxInferences:1,period:'lifetime' as const};
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'installation-optin-')),path=join(root,'synthetic.mp4');
 await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=2','-threads','1','-c:v','libx264','-y',path],{timeoutMs:10000});
 const sha256=createHash('sha256').update(await fs.readFile(path)).digest('hex'),ids:string[]=[];
 const jobs={stateDir:join(root,'jobs'),get:async(id:string)=>{if(!ids.includes(id))throw Object.assign(Error('missing'),{code:'ENOENT'});return {id,sourcePath:path,source:{sha256,originalName:'Synthetic'}};}};
 await fs.mkdir(jobs.stateDir);const archive={stateDir:join(root,'archive'),get:async()=>null};
 const catalog=new RecordingCatalog(jobs as any,archive as any),installation=digest(root),access=new ContextAccess(join(root,'access'),Date.now,installation),recipient={kind:'agent' as const,id:'codex-openai'};
 const scope={kind:'installation-recordings' as const,sources:[],installation:{stateRootHash:installation,includeFuture:true as const,excludeSecrets:true as const,deniedRecordings:[]}};
 const grant=await access.authorize({consent:true,recipient,scope,data:['frames']});
 const budget=new VisualAppBudget(join(root,'budget'),async()=>policy);const retrieval=()=>new AgentRetrieval(new ContextAccess(access.root,Date.now,installation),catalog,budget);
 const add=async()=>{const id=randomUUID();ids.push(id);await fs.writeFile(join(jobs.stateDir,id+'.json'),'{}');return id;};
 return {root,path,access,catalog,recipient,scope,grant,budget,retrieval,add,options:{policy,admission:{policy:{pause:'off' as const,unknown:'wait' as const}}}};
}
test('installation consent includes later registered IDs, real pixels and persistent budget without per-frame consent',async()=>{
 const f=await fixture();try{
  expect((await f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient})).recordingIds).toEqual([]);
  const id=await f.add(),request={grantId:f.grant.id,recipient:f.recipient,recordingId:id,timestamps:[0.51],supportsImages:true};
  const list=await f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient});expect(list.recordingIds).toEqual([id]);expect(JSON.stringify(list)).not.toContain(f.path);
  const result=await f.retrieval().getFrames(request,f.options);expect(result.frames[0]!.decodedTimestampSeconds).toBeCloseTo(0.6,4);expect(result.frames[0]!.mimeType).toBe('image/jpeg');
  expect((await f.retrieval().getFrames(request,f.options)).cacheHit).toBe(true);expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(1);
  const next=await f.add();expect((await f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient})).recordingIds).toContain(next);
  await f.retrieval().getFrames({...request,recordingId:next},f.options);expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(0);
  const g=await f.access.authorize({consent:true,recipient:{kind:'agent',id:'claude-anthropic'},scope:f.scope,data:['frames']});
  await expect(f.retrieval().getFrames({...request,grantId:g.id,recipient:g.recipient},f.options)).rejects.toThrow('budget exhausted');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('named scope rejects unknown clients, cross-installation grants, context and unregistered media',async()=>{
 const f=await fixture();try{
  for(const id of INSTALLATION_RECIPIENTS)expect((await f.access.authorize({consent:true,recipient:{kind:'agent',id},scope:f.scope,data:['frames']})).recipient.id).toBe(id);
  await expect(f.access.authorize({consent:true,recipient:{kind:'agent',id:'unknown-client'},scope:f.scope,data:['frames']})).rejects.toThrow('named installation');
  await expect(f.access.authorize({consent:false,recipient:f.recipient,scope:f.scope,data:['frames']})).rejects.toThrow('Explicit');
  await expect(new ContextAccess(f.access.root,Date.now,digest('another-installation')).read(f.grant.id)).rejects.toThrow('another installation');
  await expect(f.retrieval().recordings({grantId:f.grant.id,recipient:{kind:'agent',id:'gemini-google'}})).rejects.toThrow('Recipient');
  await expect(f.retrieval().getContext({grantId:f.grant.id,recipient:f.recipient,recordingId:randomUUID()})).rejects.toThrow('Data outside');
  await expect(f.retrieval().getFrames({grantId:f.grant.id,recipient:f.recipient,recordingId:randomUUID(),timestamps:[0],supportsImages:true},f.options)).rejects.toThrow('not registered');
  expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(2);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('exclusion/pause/revoke apply after restart and before cached frames are delivered',async()=>{
 const f=await fixture();try{
  const id=await f.add(),request={grantId:f.grant.id,recipient:f.recipient,recordingId:id,timestamps:[0],supportsImages:true};
  await f.retrieval().getFrames(request,f.options);await f.access.exclude(f.grant.id,id);
  expect((await f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient})).recordingIds).toEqual([]);
  await expect(f.retrieval().getFrames(request,f.options)).rejects.toThrow('outside opt-in');
  await f.access.change(f.grant.id,'pause');await expect(f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient})).rejects.toThrow('paused');
  await f.access.change(f.grant.id,'resume');await f.access.change(f.grant.id,'revoke');await expect(f.access.change(f.grant.id,'resume')).rejects.toThrow('cannot resume');
  expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(1);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('revocation while queued blocks a future-recording request before decode',async()=>{
 const f=await fixture();try{
  const id=await f.add();let ready!:()=>void;const waiting=new Promise<void>(r=>ready=r);let busy=true;
  const pending=f.retrieval().getFrames({grantId:f.grant.id,recipient:f.recipient,recordingId:id,timestamps:[0],supportsImages:true},{policy,admission:{root:join(f.root,'queue'),policy:{pause:'capture-and-call',unknown:'wait'},pollMs:25,activity:async()=>({recording:busy?'active':'idle',call:'idle'}),onWait:()=>ready()}});
  await waiting;await f.access.change(f.grant.id,'revoke');busy=false;await expect(pending).rejects.toThrow('revoked');expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(2);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);

test('denied UUID arrays cannot bypass exclusion; malformed catalog names are ignored',async()=>{
 const f=await fixture();try{
  const id=await f.add();await f.access.exclude(f.grant.id,id);
  await fs.writeFile(join(f.catalog.jobs.stateDir,'------------------------------------.json'),'{}');
  expect((await f.retrieval().recordings({grantId:f.grant.id,recipient:f.recipient})).recordingIds).toEqual([]);
  await expect(f.retrieval().getFrames({grantId:f.grant.id,recipient:f.recipient,recordingId:[id] as any,timestamps:[0],supportsImages:true},f.options)).rejects.toThrow('Invalid recording');
  expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(2);
  await expect(f.access.authorize({consent:true,recipient:f.recipient,scope:{...f.scope,installation:{...f.scope.installation,deniedRecordings:Array.from({length:5001},()=>randomUUID())}},data:['frames']})).rejects.toThrow('Invalid named');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('expired cache above old threshold is swept instead of permanently wedging retrieval',async()=>{
 const f=await fixture();try{
  const root=join(f.access.root,'cache');
  for(let i=0;i<257;i++){const dir=join(root,digest(i));await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(join(dir,'frames.json'),JSON.stringify({expiresAt:0}),{mode:0o600});}
  expect(await f.retrieval().sweepCache()).toBe(0);expect(await fs.readdir(root)).toEqual([]);
  for(let i=0;i<256;i++){const dir=join(root,digest(i));await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(join(dir,'frames.json'),JSON.stringify({expiresAt:Date.now()+60000}),{mode:0o600});}
  const id=await f.add();await expect(f.retrieval().getFrames({grantId:f.grant.id,recipient:f.recipient,recordingId:id,timestamps:[0],supportsImages:true},f.options)).rejects.toThrow('cache full');expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(2);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('actual CLI installation authorize/status/exclusion succeeds once; MCP cannot switch recipient or smuggle an ID array',async()=>{
 const f=await fixture();try{
  const env={...process.env,XDG_STATE_HOME:join(f.root,'cli-state')};const run=async(args:string[])=>{const p=Bun.spawn([process.execPath,join(import.meta.dir,'../../cli/index.ts'),'agent-context',...args],{env,stdout:'pipe',stderr:'pipe'});const output=await new Response(p.stdout).text(),error=await new Response(p.stderr).text();expect(await p.exited).toBe(0);if(error)throw Error(error);return JSON.parse(output);};
  const grant=await run(['authorize-installation','--recipient','codex-openai','--include-future','--exclude-secrets','--consent']);expect(grant.scope.includesFuture).toBe(true);expect(grant.data).toEqual(['frames']);
  expect((await fs.readdir(join(env.XDG_STATE_HOME,'recording-cli/agent-context/grants'))).length).toBe(1);
  expect((await run(['status','--grant',grant.id])).id).toBe(grant.id);expect((await run(['recordings','--grant',grant.id,'--recipient','codex-openai'])).recordingIds).toEqual([]);
  const id=randomUUID();expect((await run(['exclude-recording','--grant',grant.id,'--recording',id])).scope.excludedRecordingIds).toEqual([id]);
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../../cli/index.ts'),'agent-context','serve','--grant',grant.id,'--recipient','codex-openai'],{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  for(const m of [{id:1,method:'initialize',params:{protocolVersion:'2026-07-28'}},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'get_frames',arguments:{recordingId:[id],timestamps:[0],supportsImages:true}}},{id:4,method:'tools/call',params:{name:'list_recordings',arguments:{recipient:'claude-anthropic'}}}])child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');child.stdin.end();
  const replies=(await new Response(child.stdout).text()).trim().split('\n').map(x=>JSON.parse(x));expect(await child.exited).toBe(0);expect(replies[0].result.protocolVersion).toBe('2025-06-18');expect(replies[1].result.tools.map((t:any)=>t.name)).toEqual(['list_recordings','get_frames']);expect(replies[2].error.message).toContain('Invalid tool');expect(replies[3].error.message).toContain('Invalid tool');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
