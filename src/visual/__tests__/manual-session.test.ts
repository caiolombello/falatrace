import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runVisualSession,type LocalVisualAdapter} from '../session';
import {planVisualEvidence} from '../plan';
import {runCommand} from '../../jobs/command';
import {hashFile} from '../../jobs/store';
import {summarizeInChunks} from '../../summary/chunks';
import type {Transcript} from '../../jobs/types';
const transcript:Transcript={version:1,provider:'whisper-cpp',model:'fixture',language:'pt',text:'Revisar proposta.',segments:[{start:0,end:3,text:'Revisar proposta.'}]};
test('consented manual frame uses the production adapter contract and keeps exact evidence in summary; restart/cache does not re-call',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'manual-visual-'));let inspections=0,summaries=0;
 try{
  const sourcePath=join(root,'synthetic.mp4');
  await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',sourcePath]);
  const mediaHash=await hashFile(sourcePath);
  const plan=planVisualEvidence(mediaHash,transcript,3,[{timestampSeconds:1.2,reason:'user-request',question:'O que aparece neste instante?',segmentIds:['s000000']}]);
  const adapter:LocalVisualAdapter={identity:'offline-contract-v1',localOnly:true,select:async()=>{throw Error('manual must never select');},inspect:async input=>{inspections++;return input.frames.map(frame=>({frameFile:frame.file,timestampSeconds:frame.timestampSeconds,frameSha256:frame.sha256,text:'Observação de fixture, não interpretação de modelo.',uncertainty:'uncertain'}));}};
  const options={root:join(root,'persistent'),sourcePath,mediaHash,transcript,durationSeconds:3,adapter,manual:{requests:plan.requests,planKey:plan.key,consent:true as const}};
  await expect(runVisualSession({...options,manual:{...options.manual,consent:false as true}})).rejects.toThrow('consent');
  await expect(runVisualSession({...options,manual:{...options.manual,planKey:'b'.repeat(64)}})).rejects.toThrow('consent');expect(inspections).toBe(0);
  const result=await runVisualSession(options);expect(result.modelRequests).toBe(1);expect(result.observations[0].timestampSeconds).toBe(1.2);expect(result.frames[0].timestampSeconds).toBe(1.2);
  const restarted=await runVisualSession({...options,adapter:{...adapter}});expect(restarted.modelRequests).toBe(0);expect(inspections).toBe(1);expect(restarted.key).toBe(result.key);
  await expect(runVisualSession({...options,manual:undefined})).rejects.toThrow('consent on resume');
  const changed=planVisualEvidence(mediaHash,transcript,3,[{...plan.requests[0],question:'Outra pergunta'}]);
  await expect(runVisualSession({...options,manual:{requests:changed.requests,planKey:changed.key,consent:true}})).rejects.toThrow('different consent plan');expect(inspections).toBe(1);
  const summary=await summarizeInChunks({transcript,mediaHash,maxCharacters:24000,provider:'ollama',model:'fixture',adapterIdentity:'offline-summary',cacheDir:join(root,'summary-cache'),visual:{adapterIdentity:adapter.identity,expiresAt:result.expiresAt,observations:result.observations.map(({timestampSeconds,frameSha256,text,uncertainty})=>({timestampSeconds,frameSha256,text,uncertainty}))},adapter:async part=>{
   summaries++;expect(part.evidence.visual!.observations[0].timestampSeconds).toBe(1.2);expect(part.evidence.visual!.observations[0].frameSha256).toBe(result.frames[0].sha256);expect(part.evidence.visual!.observations[0].uncertainty).toBe('uncertain');
   return {version:1,provider:'ollama',model:'fixture',title:'Fixture',overview:'Revisar proposta.',topics:[],decisions:[],actionItems:[],citations:[{section:'overview',index:0,segmentIds:['s000000'],uncertainty:'uncertain'}],limitations:['Modelo real não executado.']};
  }});expect(summaries).toBe(1);expect(summary.support!.reviewRequired).toBe(true);expect(await hashFile(sourcePath)).toBe(mediaHash);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed manual inference consumes persisted budget across adapter instances; expiry and cleanup do not reset it',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'manual-budget-'));let calls=0;
 try{
  const mediaHash='a'.repeat(64),plan=planVisualEvidence(mediaHash,transcript,3,[{timestampSeconds:1.2,reason:'user-request',question:'Confira.',segmentIds:['s000000']}]);
  const adapter:LocalVisualAdapter={identity:'offline-failing',localOnly:true,select:async()=>[],inspect:async()=>{calls++;throw Error('offline failure');}};
  const options={mediaHash,transcript,durationSeconds:3,sourcePath:join(root,'unused'),root,adapter,now:1000,ttlSeconds:60,manual:{requests:plan.requests,planKey:plan.key,consent:true as const},extract:async(p:typeof plan)=>({version:1 as const,round:p.round,key:p.key,mediaSha256:mediaHash,frames:[{file:'frame-0.jpg',timestampSeconds:1.2,sha256:'b'.repeat(64),bytes:10}],totalBytes:10,reused:false})};
  for(let i=0;i<4;i++)await expect(runVisualSession({...options,adapter:{...adapter}})).rejects.toThrow('offline failure');
  await expect(runVisualSession(options)).rejects.toThrow('request budget');expect(calls).toBe(4);
  const expired=await runVisualSession({...options,now:61000});expect(expired.expired).toBe(true);expect(expired.modelRequests).toBe(0);expect(calls).toBe(4);
  const ledger=JSON.parse(await fs.readFile(join(expired.directory,'.visual-session.json'),'utf8')).ledger;expect(ledger.providerRequests).toBe(4);expect(ledger.attempts.every((a:{state:string})=>a.state==='failed')).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
