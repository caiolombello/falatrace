import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioVisualFlow,type StudioSource} from '../studio-flow';
import {localOllamaAdapterIdentity} from '../ollama';
import {transcriptPlannerInput} from '../planner';
import {planSummaryChunks} from '../../summary/chunks';
import {SUMMARY_SYSTEM_PROMPT,SUMMARY_JSON_SCHEMA} from '../../summary/schema';
import {DEFAULT_CONFIG} from '../../config/defaults';
import {runCommand} from '../../jobs/command';
import {hashFile} from '../../jobs/store';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Stage='planner'|'vision'|'summary';
type Transport={calls:Record<Stage,number>;after?:(stage:Stage)=>Promise<void>|void};
const details={model_info:{architecture:'reviewed-binding-fixture'},capabilities:['vision','completion']};
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
async function fixture(run:(source:StudioSource,root:string,transport:Transport)=>Promise<void>){
 const root=await fs.mkdtemp(join(tmpdir(),'reviewed-visual-binding-')),original=globalThis.fetch;
 const transport:Transport={calls:{planner:0,vision:0,summary:0}};
 try{
  const path=join(root,'synthetic.mp4');await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=5','-t','3','-c:v','mpeg4','-y',path]);
  const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl='http://127.0.0.1:11434';
  const source:StudioSource={key:'synthetic-key',jobId:'synthetic-job',path,mediaHash:await hashFile(path),config,transcript:{version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:'Revisar proposta.',segments:[{start:0,end:3,text:'Revisar proposta.'}]}};
  // Only HTTP transport is replaced. No server, model, device or capture is used.
  globalThis.fetch=(async(url,init)=>{
   const target=new URL(String(url));expect(target.hostname).toBe('127.0.0.1');
   if(target.pathname==='/api/show')return Response.json(details);
   expect(target.pathname).toBe('/api/chat');const body=JSON.parse(String(init?.body)),input=JSON.parse(body.messages[1].content);
   let stage:Stage,response:unknown;
   if(input.segments){
    stage='planner';expect(body.messages[1].images).toBeUndefined();
    response={decision:'frames',rationale:'Conferir a origem da proposta.',sources:[{segmentId:'s000000',quote:'Revisar proposta.'}],requests:[{timestampSeconds:1.2,reason:'visual-reference',question:'Confira a origem.',segmentIds:['s000000']}]};
   }else if(body.model==='vision-fixture'){
    stage='vision';expect(body.messages[1].images).toHaveLength(1);const frame=input.frames[0];
    response={observations:[{frameFile:frame.file,timestampSeconds:frame.timestampSeconds,frameSha256:frame.sha256,text:'Observação recebida do transporte sintético.',uncertainty:'uncertain'}]};
   }else{
    stage='summary';expect(body.model).toBe('summary-fixture');expect(input.evidence.visual.observations).toHaveLength(1);
    response={title:'Resumo fixture',overview:'Revisar proposta e origem.',topics:[],decisions:[],actionItems:[],citations:[{section:'overview',index:0,segmentIds:['s000000'],uncertainty:'uncertain'}],limitations:[]};
   }
   transport.calls[stage]++;await transport.after?.(stage);return Response.json({message:{content:JSON.stringify(response)}});
  }) as typeof fetch;
  await run(source,root,transport);
 }finally{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});}
}
const flowAt=(root:string)=>new StudioVisualFlow(join(root,'app'),()=>1000);
const check=(flow:StudioVisualFlow,source:StudioSource)=>flow.check(source.config,'vision-fixture','summary-fixture');
const prepare=async(flow:StudioVisualFlow,source:StudioSource)=>flow.preview(source,(await check(flow,source)).id,'Confira este instante.',1.2);
const budget=async(root:string)=>JSON.parse(await fs.readFile(join(root,'app','budget.json'),'utf8'));
const resultPath=(root:string,source:StudioSource)=>join(root,'app','results',hash(source.jobId)+'.json');

test('legacy omitted/undefined review identity preserves planner, session and summary cache keys',async()=>fixture(async(source,root,transport)=>{
 const flow=flowAt(root),cap=await check(flow,source),planned:any=await flow.plan(source,cap.id,true);
 const preview=await flow.preview(source,cap.id,'Confira este instante.',1.2),result=await flow.confirm(source,preview.id,true,preview.consentKey);
 const oldIdentity=hash({endpoint:source.config.summary.ollamaUrl,vision:'vision-fixture',summary:'summary-fixture',visionDigest:hash(details),summaryDigest:hash(details),media:source.mediaHash,transcript:hash(source.transcript)});
 const oldPlannerKey=hash({identity:oldIdentity,input:transcriptPlannerInput(source.transcript,3),version:1});
 expect(await fs.readdir(join(root,'app','plans'))).toEqual([oldPlannerKey+'.json']);expect(planned.plannerCacheHit).toBe(false);
 const oldAdapter=localOllamaAdapterIdentity(source.config.summary.ollamaUrl,'vision-fixture','vision-fixture')+':'+hash({vision:preview.visionDigest,summary:preview.summaryDigest,plan:preview.plan.key,window:preview.reviewWindow}).slice(0,24);
 const oldSessionKey=hash({mediaHash:source.mediaHash,transcriptSha256:hash(source.transcript),adapter:oldAdapter,duration:preview.plan.durationSeconds,version:1});
 expect(await fs.readdir(join(root,'app','sessions'))).toEqual([oldSessionKey]);
 const evidence={adapterIdentity:oldAdapter,expiresAt:result.expiresAt,observations:result.observations.map(({timestampSeconds,frameSha256,text,uncertainty}:any)=>({timestampSeconds,frameSha256,text,uncertainty}))};
 const part=planSummaryChunks(source.transcript,source.mediaHash,undefined,source.config.summary.maxInputCharacters,evidence)[0]!;
 const oldSummaryKey=hash({chunk:part.key,provider:'ollama',model:'summary-fixture',adapterIdentity:source.config.summary.ollamaUrl,prompt:SUMMARY_SYSTEM_PROMPT,schema:SUMMARY_JSON_SCHEMA});
 expect(await fs.readdir(join(root,'app','summaries',oldSessionKey))).toEqual([oldSummaryKey+'.json']);
 expect((await flow.readResult(source.jobId,source.mediaHash,source.transcript)).summaryMarkdown).toContain('Resumo fixture');
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,'review-A')).toBeUndefined();
 const restarted=flowAt(root),explicitUndefined={...source,reviewIdentity:undefined},nextCap=await check(restarted,explicitUndefined);
 expect((await restarted.plan(explicitUndefined,nextCap.id,true)).plannerCacheHit).toBe(true);
 const next=await restarted.preview(explicitUndefined,nextCap.id,'Confira este instante.',1.2);await restarted.confirm(explicitUndefined,next.id,true,next.consentKey);
 expect(transport.calls).toEqual({planner:1,vision:1,summary:1});expect((await budget(root)).inferences).toBe(3);
}));

test.each(['note-only-edit','edit-then-undo'])('same-text %s invalidates scope, planned preview and visual consent',async change=>fixture(async(source,root,transport)=>{
 let identity='review-A';const refreshed={...source,reviewIdentity:identity,refresh:async()=>({...source,reviewIdentity:identity})};
 const flow=flowAt(root),cap=await check(flow,refreshed),scope=await flow.scope(refreshed,0,3);
 const plan:any=await flow.plan(refreshed,cap.id,true,scope.id),preview=await flow.previewPlan(refreshed,plan.id);
 await expect(flow.confirm({...refreshed,path:join(root,'other-source.mp4')},preview.id,true,preview.consentKey)).rejects.toThrow('changed after preview');
 identity='review-B-'+change;const changed={...refreshed,reviewIdentity:identity};expect(changed.transcript).toEqual(source.transcript);
 await expect(flow.plan(changed,cap.id,true,scope.id)).rejects.toThrow('selection expired/changed');
 await expect(flow.previewPlan(changed,plan.id)).rejects.toThrow('Planner source changed');
 await expect(flow.confirm(changed,preview.id,true,preview.consentKey)).rejects.toThrow('changed after preview');
 await expect(flow.confirm(refreshed,preview.id,true,preview.consentKey)).rejects.toThrow('changed while waiting');
 expect(transport.calls).toEqual({planner:1,vision:0,summary:0});expect((await budget(root)).inferences).toBe(1);
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,identity)).toBeUndefined();
}));

test('same-text reviewed revisions receive separate caches and results require exact review identity',async()=>fixture(async(source,root,transport)=>{
 let identity='review-A';const current=()=>({...source,reviewIdentity:identity}),flow=flowAt(root);
 const a=current(),pa=await prepare(flow,a);await flow.confirm(a,pa.id,true,pa.consentKey);
 expect((await flow.readResult(source.jobId,source.mediaHash,source.transcript,identity)).reviewIdentity).toBe(identity);
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript)).toBeUndefined();
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,'review-B')).toBeUndefined();
 identity='review-B';const b=current(),pb=await prepare(flow,b);expect(pb.consentKey).not.toBe(pa.consentKey);await flow.confirm(b,pb.id,true,pb.consentKey);
 expect(transport.calls).toEqual({planner:0,vision:2,summary:2});expect(await fs.readdir(join(root,'app','sessions'))).toHaveLength(2);expect(await fs.readdir(join(root,'app','summaries'))).toHaveLength(2);
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,'review-A')).toBeUndefined();
 expect((await flow.readResult(source.jobId,source.mediaHash,source.transcript,'review-B')).reviewIdentity).toBe('review-B');
 const restarted=flowAt(root),again=await prepare(restarted,b);await restarted.confirm(b,again.id,true,again.consentKey);
 expect(transport.calls).toEqual({planner:0,vision:2,summary:2});expect((await budget(root)).inferences).toBe(4);expect((await budget(root)).previews).toBe(3);
}));

test.each(['vision','summary'] as const)('review identity drifting during stubbed %s rejects publication without refunding attempts',async stage=>fixture(async(source,root,transport)=>{
 let identity='review-A';const reviewed={...source,reviewIdentity:identity,refresh:async()=>({...source,reviewIdentity:identity})};
 const flow=flowAt(root),preview=await prepare(flow,reviewed);transport.after=at=>{if(at===stage)identity='review-B';};
 await expect(flow.confirm(reviewed,preview.id,true,preview.consentKey)).rejects.toThrow('changed during review');
 expect(transport.calls).toEqual({planner:0,vision:1,summary:stage==='summary'?1:0});expect((await budget(root)).inferences).toBe(stage==='summary'?2:1);
 expect(await fs.stat(resultPath(root,source)).catch(()=>undefined)).toBeUndefined();expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,'review-B')).toBeUndefined();
}));

test('refresh throwing after stub summary leaves no result and preserves both spent attempts',async()=>fixture(async(source,root,transport)=>{
 let removed=false;const reviewed={...source,reviewIdentity:'review-A',refresh:async()=>{if(removed)throw Error('review source removed');return {...source,reviewIdentity:'review-A'};}};
 const flow=flowAt(root),preview=await prepare(flow,reviewed);transport.after=stage=>{if(stage==='summary')removed=true;};
 await expect(flow.confirm(reviewed,preview.id,true,preview.consentKey)).rejects.toThrow('review source removed');
 expect(transport.calls).toEqual({planner:0,vision:1,summary:1});expect((await budget(root)).inferences).toBe(2);expect(await fs.stat(resultPath(root,source)).catch(()=>undefined)).toBeUndefined();
}));

test('callbacks are stripped from snapshots and the refreshed publication guard runs once for concurrent confirmation',async()=>fixture(async(source,root,transport)=>{
 let publications=0;const publishCurrent:NonNullable<StudioSource['publishCurrent']>=async publish=>{publications++;expect(await fs.stat(resultPath(root,source)).catch(()=>undefined)).toBeUndefined();await publish();};
 const refresh:NonNullable<StudioSource['refresh']>=async()=>({...source,reviewIdentity:'review-A',refresh,publishCurrent});
 const reviewed={...source,reviewIdentity:'review-A',refresh,publishCurrent:async()=>{throw Error('stale source guard must be replaced');}};
 const flow=flowAt(root),preview=await prepare(flow,reviewed),[a,b]=await Promise.all([flow.confirm(reviewed,preview.id,true,preview.consentKey),flow.confirm(reviewed,preview.id,true,preview.consentKey)]);
 expect(a).toEqual(b);expect(publications).toBe(1);expect(transport.calls).toEqual({planner:0,vision:1,summary:1});
 expect(Object.keys(preview)).not.toContain('refresh');expect(Object.keys(preview)).not.toContain('publishCurrent');expect(Object.keys(a)).not.toContain('refresh');expect(Object.keys(a)).not.toContain('publishCurrent');
 const stored=await fs.readFile(resultPath(root,source),'utf8');expect(stored).not.toContain('publishCurrent');expect(stored).not.toContain('"refresh"');
}));

test('final publication closure refreshes inside the guard and preserves the previous result on a revision race',async()=>fixture(async(source,root,transport)=>{
 const flow=flowAt(root),a={...source,reviewIdentity:'review-A'},pa=await prepare(flow,a);await flow.confirm(a,pa.id,true,pa.consentKey);
 const before=await fs.readFile(resultPath(root,source)),entered=gate(),release=gate();let identity='review-B',publications=0;
 const publishCurrent:NonNullable<StudioSource['publishCurrent']>=async publish=>{publications++;entered.release();await release.promise;await publish();};
 const reviewed={...source,reviewIdentity:identity,refresh:async()=>({...source,reviewIdentity:identity,publishCurrent})};
 const preview=await prepare(flow,reviewed),pending=flow.confirm(reviewed,preview.id,true,preview.consentKey).then(()=>undefined,error=>error);
 try{await entered.promise;identity='review-C';release.release();expect((await pending).message).toContain('changed during review');}
 finally{release.release();await pending;}
 expect(publications).toBe(1);expect(await fs.readFile(resultPath(root,source))).toEqual(before);expect(transport.calls).toEqual({planner:0,vision:2,summary:2});expect((await budget(root)).inferences).toBe(4);
 expect(await flow.readResult(source.jobId,source.mediaHash,source.transcript,identity)).toBeUndefined();
}));

test('cancel at the publication guard prevents the result write and keeps the consumed budget',async()=>fixture(async(source,root,transport)=>{
 const entered=gate(),release=gate(),publishCurrent:NonNullable<StudioSource['publishCurrent']>=async publish=>{entered.release();await release.promise;await publish();};
 const reviewed={...source,reviewIdentity:'review-A',publishCurrent},flow=flowAt(root),preview=await prepare(flow,reviewed);
 const pending=flow.confirm(reviewed,preview.id,true,preview.consentKey).then(()=>undefined,error=>error);
 try{await entered.promise;flow.cancel(reviewed.key,preview.id);release.release();expect(await pending).toBeInstanceOf(Error);}
 finally{release.release();await pending;}
 expect(transport.calls).toEqual({planner:0,vision:1,summary:1});expect((await budget(root)).inferences).toBe(2);expect(await fs.stat(resultPath(root,source)).catch(()=>undefined)).toBeUndefined();
}));

test('new consent does not reset the existing lifetime budget identity lock after reviewed transcript text changes',async()=>fixture(async(source,root,transport)=>{
 const flow=flowAt(root),reviewed={...source,reviewIdentity:'review-A'},preview=await prepare(flow,reviewed);await flow.confirm(reviewed,preview.id,true,preview.consentKey);
 const changed={...source,reviewIdentity:'review-B',transcript:{...source.transcript,text:'Proposta corrigida.',segments:[{...source.transcript.segments[0]!,text:'Proposta corrigida.'}]}};
 await expect(prepare(flow,changed)).rejects.toThrow('identity locked');expect(transport.calls).toEqual({planner:0,vision:1,summary:1});expect((await budget(root)).inferences).toBe(2);expect((await budget(root)).previews).toBe(1);
 expect(await flow.readResult(source.jobId,source.mediaHash,changed.transcript,'review-B')).toBeUndefined();
}));
