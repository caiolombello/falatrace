import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioVisualFlow,type StudioSource} from '../studio-flow';
import {VisualAppBudget} from '../app-budget';
import {DEFAULT_CONFIG} from '../../config/defaults';
import {runCommand} from '../../jobs/command';
import {hashFile} from '../../jobs/store';
import {handleRealFrameOperation,parseRequest} from '../../desktop/bridge';
async function fixture(run:(s:StudioSource,root:string,calls:{vision:number;summary:number},change:(state:string)=>void)=>Promise<void>){
 const root=await fs.mkdtemp(join(tmpdir(),'studio-production-')),original=globalThis.fetch;const calls={vision:0,summary:0};let state='ok';
 try{
  const path=join(root,'synthetic.mp4');await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',path]);
  const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl='http://127.0.0.1:11434';
  const s:StudioSource={key:'synthetic-key',jobId:'synthetic-job',path,mediaHash:await hashFile(path),config,transcript:{version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:'Revisar proposta.',segments:[{start:0,end:3,text:'Revisar proposta.'}]}};
  globalThis.fetch=(async(url,init)=>{
   expect(new URL(String(url)).hostname).toBe('127.0.0.1');const body=JSON.parse(String(init?.body));
   if(new URL(String(url)).pathname==='/api/show')return state==='nomodel'?new Response('',{status:404}):Response.json({model_info:{architecture:state==='changed'?'changed':'synthetic'},capabilities:state==='unknown'?[]:['vision','completion']});
   const input=JSON.parse(body.messages[1].content);
   if(body.model==='vision-fixture'){
    calls.vision++;expect(body.messages[1].images.length).toBe(1);if(state==='slow')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,300);init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});});
    if(state==='fail')throw Error('synthetic failure');const f=input.frames[0];
    return Response.json({message:{content:JSON.stringify({observations:[{frameFile:f.file,timestampSeconds:f.timestampSeconds,frameSha256:state==='invalidframe'?'c'.repeat(64):f.sha256,text:'Resposta fornecida pelo transporte fixture do adapter.',uncertainty:'uncertain'}]})}});
   }
   calls.summary++;if(state==='summaryfail')return new Response('',{status:500});expect(input.evidence.visual.observations[0].timestampSeconds).toBe(1.2);
   return Response.json({message:{content:JSON.stringify({title:'Resumo fixture',overview:'Revisar proposta e origem.',topics:[],decisions:[],actionItems:[],citations:[{section:'overview',index:0,segmentIds:['s000000'],uncertainty:'uncertain'}],limitations:[]})}});
  }) as typeof fetch;
  await run(s,root,calls,x=>state=x);
 }finally{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});}
}
async function prepared(flow:StudioVisualFlow,s:StudioSource){const c=await flow.check(s.config,'vision-fixture','summary-fixture');return flow.preview(s,c.id,'Confira este instante.',1.2);}
test('Studio bridge confirmation executes production vision+summary adapters, idempotent result, restart resumes persistent caches',async()=>fixture(async(s,root,calls)=>{
 const flow=new StudioVisualFlow(join(root,'app'));
 const cap=await handleRealFrameOperation(flow,parseRequest({id:1,op:'frames-check-models',key:s.key,payload:{visionModel:'vision-fixture',summaryModel:'summary-fixture'}}),s) as any;
 const p=await handleRealFrameOperation(flow,parseRequest({id:2,op:'frames-preview',key:s.key,payload:{question:'Confira este instante.',seconds:1.2,capabilityId:cap.id}}),s) as any;
 expect(calls).toEqual({vision:0,summary:0});expect(p.frameBytes).toBeGreaterThan(0);expect(p.timestampSeconds).toBe(1.2);
 const req=parseRequest({id:3,op:'frames-confirm',key:s.key,payload:{previewId:p.id,consent:true,consentKey:p.consentKey}});
 const [a,b]=await Promise.all([handleRealFrameOperation(flow,req,s),handleRealFrameOperation(flow,req,s)]) as any[];
 expect(a.synthetic).toBe(false);expect(a.summaryMarkdown).toContain('Resumo fixture');expect(a.timestampSeconds).toBe(1.2);expect(a.summary.support.reviewRequired).toBe(true);expect(a).toEqual(b);expect(calls).toEqual({vision:1,summary:1});
 expect((await flow.readResult(s.jobId,s.mediaHash,s.transcript)).summaryMarkdown).toContain("Resumo fixture");expect(await flow.readResult(s.jobId,"0".repeat(64),s.transcript)).toBeUndefined();
 const restarted=new StudioVisualFlow(join(root,'app'));const q=await prepared(restarted,s);await restarted.confirm(s,q.id,true,q.consentKey);expect(calls).toEqual({vision:1,summary:1});
 const budget=JSON.parse(await fs.readFile(join(root,'app/budget.json'),'utf8'));expect(budget.inferences).toBe(2);expect(budget.previews).toBe(2);
 const other=await restarted.check(s.config,'different-vision','summary-fixture');await expect(restarted.preview(s,other.id,'Outra pergunta.',1.2)).rejects.toThrow('identity locked');
 await expect(restarted.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('consent');
}));
test('missing consent, expired preview, provider/model/media changes and unsupported models make zero inference calls',async()=>fixture(async(s,root,calls,change)=>{
 let now=1000;const flow=new StudioVisualFlow(join(root,'app'),()=>now),p=await prepared(flow,s);
 await expect(flow.confirm(s,p.id,false,p.consentKey)).rejects.toThrow('consent');await expect(flow.confirm(s,p.id,true,'wrong')).rejects.toThrow('consent');
 await expect(flow.confirm({...s,config:{...s.config,summary:{...s.config.summary,ollamaUrl:'http://localhost:11435'}}},p.id,true,p.consentKey)).rejects.toThrow('changed');
 change('changed');await expect(flow.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('Model changed');change('ok');
 now=301000;await expect(flow.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('consent');now=1000;
 change('nomodel');await expect(flow.check(s.config,'missing','summary')).rejects.toThrow('unavailable');change('unknown');await expect(flow.check(s.config,'x','y')).rejects.toThrow('capability');change('ok');
 const next=await prepared(flow,s);await fs.appendFile(s.path,'changed');await expect(flow.confirm(s,next.id,true,next.consentKey)).rejects.toThrow('changed');expect(calls).toEqual({vision:0,summary:0});
}));
test('invalid observations, failed and canceled inference consume global budget; cancel never publishes summary',async()=>fixture(async(s,root,calls,change)=>{
 const flow=new StudioVisualFlow(join(root,'app'));let p=await prepared(flow,s);change('invalidframe');await expect(flow.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('match extracted');expect(calls.summary).toBe(0);
 p=await prepared(flow,s);change('fail');await expect(flow.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('failure');
 p=await prepared(flow,s);change('slow');const pending=flow.confirm(s,p.id,true,p.consentKey);await Bun.sleep(40);flow.cancel(s.key,p.id);await expect(pending).rejects.toThrow();expect(calls.summary).toBe(0);
 p=await prepared(flow,s);change('summaryfail');await expect(flow.confirm(s,p.id,true,p.consentKey)).rejects.toThrow('HTTP 500');expect(calls.summary).toBe(1);
 const budget=JSON.parse(await fs.readFile(join(root,'app/budget.json'),'utf8'));expect(budget.inferences).toBeGreaterThanOrEqual(3);expect(await fs.stat(join(root,'app/results')).catch(()=>null)).toBeNull();
}));
test('global lifetime guard survives a separate process and caps changed identities; corrupt state and symlinks fail closed',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'global-visual-'));
 try{
  const budget=new VisualAppBudget(join(root,'app'));await budget.reserve('inference','job','identity');
  const script=join(root,'restart.ts');await fs.writeFile(script,`import {VisualAppBudget} from ${JSON.stringify(join(import.meta.dir,'../app-budget.ts'))};await new VisualAppBudget(${JSON.stringify(join(root,'app'))}).reserve('inference','job','identity');`);
  const child=Bun.spawn([process.execPath,script],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(0);expect(await new Response(child.stderr).text()).toBe('');
  expect(JSON.parse(await fs.readFile(join(root,'app/budget.json'),'utf8')).inferences).toBe(2);
  await expect(budget.reserve('inference','job','different')).rejects.toThrow('identity locked');
  for(let i=2;i<24;i++)await new VisualAppBudget(join(root,'app')).reserve('inference','job-'+i,'identity-'+i);
  await expect(budget.reserve('inference','another-job','another-model')).rejects.toThrow('Global');
  await fs.writeFile(join(root,'app/budget.json'),'{invalid');await expect(budget.reserve('preview','job','identity')).rejects.toThrow();
  await fs.symlink(join(root,'app'),join(root,'link'));await expect(new VisualAppBudget(join(root,'link/sub')).reserve('preview','job','identity')).rejects.toThrow('Unsafe');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('distinct consented questions work, TTL renews only with fresh consent and global budget persists; historical summary stays readable',async()=>fixture(async(s,root,calls)=>{
 let now=1000;const flow=new StudioVisualFlow(join(root,'app'),()=>now);
 let cap=await flow.check(s.config,'vision-fixture','summary-fixture');const a=await flow.preview(s,cap.id,'Pergunta A',1.2);await flow.confirm(s,a.id,true,a.consentKey);
 const b=await flow.preview(s,cap.id,'Pergunta B',1.2);await flow.confirm(s,b.id,true,b.consentKey);expect(calls).toEqual({vision:2,summary:2});
 now=3602000;const historical=await flow.readResult(s.jobId,s.mediaHash,s.transcript);expect(historical.evidenceExpired).toBe(true);expect(historical.summaryMarkdown).toContain('notas históricas');
 await expect(flow.confirm(s,a.id,true,a.consentKey)).rejects.toThrow('consent');
 cap=await flow.check(s.config,'vision-fixture','summary-fixture');const fresh=await flow.preview(s,cap.id,'Pergunta A',1.2);expect(fresh.reviewWindow).toBe(1);await flow.confirm(s,fresh.id,true,fresh.consentKey);
 expect(calls).toEqual({vision:3,summary:3});const budget=JSON.parse(await fs.readFile(join(root,'app/budget.json'),'utf8'));expect(budget.inferences).toBe(6);expect(budget.previews).toBe(3);
 const restarted=new StudioVisualFlow(join(root,'app'),()=>now);cap=await restarted.check(s.config,'vision-fixture','summary-fixture');const reused=await restarted.preview(s,cap.id,'Pergunta A',1.2);await restarted.confirm(s,reused.id,true,reused.consentKey);expect(calls).toEqual({vision:3,summary:3});expect(JSON.parse(await fs.readFile(join(root,'app/budget.json'),'utf8')).inferences).toBe(6);
}));
test('consent expiring while queued is refused before any vision or summary; fresh preview remains required',async()=>fixture(async(s,root,calls)=>{
 const admission=await import('../../runtime/heavy-admission');let now=1000;
 const flow=new StudioVisualFlow(join(root,'app'),()=>now),p=await prepared(flow,s);
 let release!:()=>void;
 const blocker=admission.withHeavyAdmission('pipeline','other-heavy-job',async()=>new Promise<void>(r=>release=r));
 try {
  for(let i=0;i<100&&!release;i++)await Bun.sleep(10);expect(!!release).toBe(true);
  const pending=flow.confirm(s,p.id,true,p.consentKey);const refused=pending.then(()=>{throw Error('Unexpected consent acceptance');},error=>error);
  for(let i=0;i<100;i++){if((await admission.readHeavyStatus()).waiting.length)break;await Bun.sleep(10);}
  expect((await admission.readHeavyStatus()).waiting.length).toBe(1);
  now=301001;release();await blocker;expect((await refused).message).toContain('Consent expired while waiting');expect(calls).toEqual({vision:0,summary:0});
  expect(await flow.readResult(s.jobId,s.mediaHash,s.transcript)).toBeUndefined();
 }finally{release?.();await blocker;}
}));
test('production refresh contract refuses provider/transcript changes after queue wait before inference',async()=>fixture(async(s,root,calls)=>{
 const admission=await import('../../runtime/heavy-admission');
 for(const change of ['provider','transcript']){
  const flow=new StudioVisualFlow(join(root,change));let changed=false;const source={...s,refresh:async()=>{
   const next=structuredClone(s);if(changed){if(change==='provider')next.config.summary.ollamaUrl='http://localhost:11435';else next.transcript.text+=' corrected';}return next;
  }};
  const p=await prepared(flow,source);let release!:()=>void;
  const blocker=admission.withHeavyAdmission('pipeline','another-job',async()=>new Promise<void>(r=>release=r));
  try{
   for(let i=0;i<100&&!release;i++)await Bun.sleep(10);expect(!!release).toBe(true);
   const result=flow.confirm(source,p.id,true,p.consentKey).then(()=>{throw Error('Unexpected inference');},error=>error);
   for(let i=0;i<100;i++){if((await admission.readHeavyStatus()).waiting.length)break;await Bun.sleep(10);}
   changed=true;release();await blocker;expect((await result).message).toContain('changed while waiting');expect(calls).toEqual({vision:0,summary:0});
  }finally{release?.();await blocker;}
 }
}));
