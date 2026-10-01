import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {ContextAccess} from '../access';
import {RecordingCatalog} from '../source';
import {AgentRetrieval} from '../retrieval';
import {VisualAppBudget} from '../../visual/app-budget';
import {runCommand} from '../../jobs/command';
const policy={maxPreviews:3,maxInferences:1,period:'lifetime' as const};
async function fixture(offset=false){
 const root=await fs.mkdtemp(join(tmpdir(),'agent-context-')),path=join(root,'synthetic.mp4'),id=randomUUID();
 await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=2',...(offset?['-vf','select=not(mod(n\\,3)),setpts=PTS+2/TB','-fps_mode','vfr']:[]),'-threads','1','-c:v','libx264','-y',path],{timeoutMs:10000});
 const sha256=createHash('sha256').update(await fs.readFile(path)).digest('hex');
 const jobs={get:async(key:string)=>{if(key!==id)throw Object.assign(Error('missing'),{code:'ENOENT'});return {sourcePath:path,source:{sha256,originalName:'Synthetic'},id};}};
 const catalog=new RecordingCatalog(jobs as any,{get:async()=>null} as any);
 let clock=Date.now();const access=new ContextAccess(join(root,'access'),()=>clock);
 const budget=new VisualAppBudget(join(root,'visual-review'),async()=>policy);
 const recipient={kind:'agent' as const,id:'synthetic-agent'};
 const grant=await access.authorize({consent:true,recipient,scope:{kind:'recordings',sources:await catalog.snapshot([id])},data:['frames'],limits:{cacheTtlMs:1000}});
 const request={grantId:grant.id,recipient,recordingId:id,timestamps:[0.51],supportsImages:true};
 return {root,path,id,catalog,access,budget,recipient,grant,request,advance:()=>{clock+=2000;},retrieval:()=>new AgentRetrieval(new ContextAccess(access.root,()=>clock),catalog,budget,undefined,()=>clock),options:{policy,admission:{policy:{pause:'off' as const,unknown:'wait' as const}}}};
}
test('real synthetic video: one opt-in persists, returns pixels and PTS; cache TTL/restart retain lifetime budget',async()=>{
 const f=await fixture();try{
  const first=await f.retrieval().getFrames(f.request,f.options);expect(first.cacheHit).toBe(false);expect(first.frames[0]!.mimeType).toBe('image/jpeg');expect(first.frames[0]!.width).toBe(160);expect(first.frames[0]!.decodedTimestampSeconds).toBeCloseTo(0.6,4);expect(first.frames[0]!.precision).toBe('decoded-pts');expect((await fs.readFile(first.frames[0]!.file))[0]).toBe(255);
  expect((await f.retrieval().getFrames(f.request,f.options)).cacheHit).toBe(true);expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(2);
  f.advance();expect((await f.retrieval().getFrames(f.request,f.options)).cacheHit).toBe(false);expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(1);
  f.advance();await f.retrieval().getFrames(f.request,f.options);f.advance();await expect(f.retrieval().getFrames(f.request,f.options)).rejects.toThrow('budget exhausted');expect((await new ContextAccess(f.access.root).read(f.grant.id)).revoked).toBe(false);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('recipient, scope, client vision, changed media and revoke are denied without widening consent',async()=>{
 const f=await fixture();try{
  await expect(f.retrieval().getFrames({...f.request,recipient:{kind:'agent',id:'other'}},f.options)).rejects.toThrow('Recipient');
  await expect(f.retrieval().getFrames({...f.request,recordingId:randomUUID()},f.options)).rejects.toThrow('scope');
  await expect(f.retrieval().getFrames({...f.request,supportsImages:false},f.options)).rejects.toThrow('vision');
  await f.access.change(f.grant.id,'pause');await expect(f.retrieval().getFrames(f.request,f.options)).rejects.toThrow('paused');await f.access.change(f.grant.id,'resume');
  await fs.appendFile(f.path,'changed');await expect(f.retrieval().getFrames(f.request,f.options)).rejects.toThrow('source changed');
  await f.access.change(f.grant.id,'revoke');await expect(f.access.change(f.grant.id,'resume')).rejects.toThrow('cannot resume');expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(3);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
test('revoke during queued wait is revalidated before decode or spending',async()=>{
 const f=await fixture();try{
  let notify!:()=>void;const waiting=new Promise<void>(r=>notify=r);let busy=true;
  const pending=f.retrieval().getFrames(f.request,{policy,admission:{root:join(f.root,'queue'),policy:{pause:'capture-and-call',unknown:'wait'},pollMs:25,activity:async()=>({recording:busy?'active':'idle',call:'idle'}),onWait:()=>notify()}});
  await waiting;await f.access.change(f.grant.id,'revoke');busy=false;
  await expect(pending).rejects.toThrow('revoked');expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(3);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);

import {imageResult} from '../transport';
test('actual VFR/start offset: normalized PTS stays explicit and MCP contains JPEG pixels, not paths',async()=>{
 const f=await fixture(true);try{
  const result=await imageResult(f.retrieval(),f.request,f.options);expect(result.content[1]!.type).toBe('image');
  const image=result.content[1] as {data:string;mimeType:string};expect(Buffer.from(image.data,'base64')[0]).toBe(255);expect(image.mimeType).toBe('image/jpeg');
  const metadata=JSON.parse((result.content[0] as {text:string}).text);expect(metadata.frames[0].file).toBeUndefined();expect(metadata.frames[0].requestedTimestampSeconds).toBe(0.51);expect(metadata.frames[0].sourcePtsSeconds).toBeCloseTo(2.6,3);expect(metadata.frames[0].decodedTimestampSeconds).toBeCloseTo(0.6,3);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
import {resolve} from 'node:path';
test('real CLI across processes and stdio MCP: opt-in once, registered ID retrieval, no provider/summary artifacts',async()=>{
 const f=await fixture();try{
  const state=join(f.root,'cli-state'),jobs=join(state,'recording-cli/jobs');await fs.mkdir(jobs,{recursive:true,mode:0o700});
  await fs.writeFile(join(jobs,f.id+'.json'),JSON.stringify({version:1,id:f.id,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',source:{originalName:'synthetic.mp4',mediaFile:'source.mp4',size:(await fs.stat(f.path)).size,sha256:f.grant.scope.sources[0]!.sha256},transcription:{provider:'whisper-cpp',model:'synthetic',language:'en'},summary:{provider:'ollama',model:'synthetic'},sourcePath:f.path,artifactDir:join(f.root,'artifacts'),target:'local',state:'failed'}));
  const run=async(args:string[],input?:string)=>{const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../../cli/index.ts'),'agent-context',...args],{env:{...process.env,XDG_STATE_HOME:state},stdin:input===undefined?'ignore':'pipe',stdout:'pipe',stderr:'pipe'});if(input!==undefined){child.stdin!.write(input);child.stdin!.end();}const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw Error('Synthetic CLI failed: '+err);expect(code).toBe(0);expect(err).toBe('');return out;};
  const g=JSON.parse(await run(['authorize','--recordings',f.id,'--recipient','synthetic-agent','--data','context,frames','--consent']));expect(g.scope.recordingIds).toEqual([f.id]);expect(g.scope.sources).toBeUndefined();
  const scoped=['--grant',g.id,'--recipient','synthetic-agent'];const found=JSON.parse(await run(['search',...scoped,'--query','synthetic']));expect(found.items[0].recordingId).toBe(f.id);expect(found.items[0].path).toBeUndefined();
  const unavailable=JSON.parse(await run(['get-context',...scoped,'--recording',f.id]));expect(unavailable.available).toBe(false);expect(unavailable.framesAvailable).toBe(true);
  const artifact=join(f.root,'synthetic.recording',f.id);await fs.mkdir(artifact,{recursive:true,mode:0o700});const jobFile=join(jobs,f.id+'.json'),job=JSON.parse(await fs.readFile(jobFile,'utf8'));job.state='completed';job.artifactDir=artifact;await fs.writeFile(jobFile,JSON.stringify(job));
  await fs.writeFile(join(artifact,'summary.json'),JSON.stringify({version:1,provider:'ollama',model:'synthetic',title:'Synthetic choice',overview:'Synthetic decision',topics:[],decisions:[],actionItems:[]}));await fs.writeFile(join(artifact,'transcript.json'),JSON.stringify({version:1,provider:'whisper-cpp',model:'whisper-cpp',language:'en',text:'Synthetic choice at the chart.',segments:[{start:0.5,end:1.2,text:'Synthetic choice at the chart.'}]}));
  const contextual=JSON.parse(await run(['get-context',...scoped,'--recording',f.id,'--max-characters','4096']));expect(contextual.available).toBe(true);expect(contextual.context.excerpts[0].timestamps).toEqual({start:0.5,end:1.2});expect(contextual.context.sourcePath).toBeUndefined();const contextRpc=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search',arguments:{query:'synthetic'}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_context',arguments:{recordingId:f.id,maxCharacters:4096}}}].map(x=>JSON.stringify(x)).join('\n')+'\n';const contextReplies=(await run(['serve',...scoped],contextRpc)).trim().split('\n').map(x=>JSON.parse(x));expect(JSON.parse(contextReplies[1].result.content[0].text).items[0].recordingId).toBe(f.id);expect(JSON.parse(contextReplies[2].result.content[0].text).context.sourcePath).toBeUndefined();await fs.rm(artifact,{recursive:true});
  const args=['--grant',g.id,'--recipient','synthetic-agent'];const a=JSON.parse(await run(['get-frames',...args,'--recording',f.id,'--timestamps','0.51','--client-vision']));expect(a.cacheHit).toBe(false);
  const b=JSON.parse(await run(['get-frames',...args,'--recording',f.id,'--timestamps','0.51','--client-vision']));expect(b.cacheHit).toBe(true);
  const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_frames',arguments:{recordingId:f.id,timestamps:[0.51],supportsImages:true}}}].map(x=>JSON.stringify(x)).join('\n')+'\n';
  const replies=(await run(['serve',...args],input)).trim().split('\n').map(x=>JSON.parse(x));expect(replies[0].result.protocolVersion).toBe('2025-06-18');expect(replies[1].result.content[1].type).toBe('image');expect(Buffer.from(replies[1].result.content[1].data,'base64')[0]).toBe(255);
  expect(await fs.access(join(f.root,'artifacts')).then(()=>true,()=>false)).toBe(false);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);

test('concurrent duplicate requests fail explicitly without spending twice; queued cancel spends nothing',async()=>{
 const f=await fixture();try{
  let notify!:()=>void;const waiting=new Promise<void>(r=>notify=r);const controller=new AbortController();
  const options={policy,signal:controller.signal,admission:{root:join(f.root,'queue'),policy:{pause:'capture-and-call' as const,unknown:'wait' as const},pollMs:25,activity:async()=>({recording:'active' as const,call:'idle' as const}),onWait:()=>notify()}};
  const pending=f.retrieval().getFrames(f.request,options);await waiting;
  await expect(f.retrieval().getFrames(f.request,options)).rejects.toThrow('already pending');controller.abort(Error('synthetic cancellation'));
  await expect(pending).rejects.toThrow('cancellation');expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(3);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);

test('metadata and excerpts require context grant before any catalog read; frames-only consent is not expanded',async()=>{
 const f=await fixture();try{
  let reads=0;const catalog=new RecordingCatalog({get:async()=>{reads++;throw Error('must not read');}} as any,{} as any);
  const retrieval=new AgentRetrieval(f.access,catalog,f.budget);
  await expect(retrieval.search({grantId:f.grant.id,recipient:f.recipient})).rejects.toThrow('Data outside');
  await expect(retrieval.getContext({grantId:f.grant.id,recipient:f.recipient,recordingId:f.id})).rejects.toThrow('Data outside');expect(reads).toBe(0);
  await expect(retrieval.search({grantId:randomUUID(),recipient:f.recipient})).rejects.toThrow();expect(reads).toBe(0);
  const none=await f.retrieval().getFrames({...f.request,timestamps:[],supportsImages:false},f.options);expect(none.frames).toEqual([]);expect((await f.budget.snapshot(policy)).remainingPreviews).toBe(3);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
},30000);
import {AgentStudio} from '../studio';
test('Studio cancellation before awaited grant read finishes prevents retrieval/reserve/decode',async()=>{
 let release!:(value:any)=>void;const reading=new Promise<any>(r=>release=r);let retrievalCalls=0;
 const studio=new AgentStudio({read:async()=>reading} as any,{} as any,{getFrames:async()=>{retrievalCalls++;return {};}} as any);
 const pending=studio.frames(randomUUID(),randomUUID(),[0.5]);const grantId=[...(studio as any).active.keys()][0];
 studio.cancel(grantId);release({recipient:{kind:'agent',id:'synthetic'}});
 await expect(pending).rejects.toThrow('cancelled');expect(retrievalCalls).toBe(0);
});

test('Studio registers cancellation before deferred library resolution, not just before grant read',async()=>{
 let release!:(value:string)=>void;const library=new Promise<string>(r=>release=r);let reads=0,calls=0;
 const studio=new AgentStudio({read:async()=>{reads++;return {recipient:{kind:'agent',id:'synthetic'}};}} as any,{} as any,{getFrames:async()=>{calls++;return {};}} as any);
 const grant=randomUUID();const pending=studio.frames(()=>library,grant,[0.5]);studio.cancel(grant);release(randomUUID());
 await expect(pending).rejects.toThrow('cancelled');expect(reads).toBe(0);expect(calls).toBe(0);
});
