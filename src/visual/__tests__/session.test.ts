import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runVisualSession,cleanupExpiredVisualSessions,type LocalVisualAdapter} from '../session';
import {runCommand} from '../../jobs/command';import {hashFile} from '../../jobs/store';import type {Transcript} from '../../jobs/types';
const transcript:Transcript={version:1,provider:'whisper-cpp',model:'fixture',language:'pt',text:'Veja o gráfico.',segments:[{start:0,end:3,text:'Veja o gráfico.'}]};
test('local AI chooses transcript-linked frames; ledger reuses responses, bounds rounds and TTL removes only derived session',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'visual-ledger-'));let selections=0,inspections=0;const source=join(root,'fixture.mp4');
 const adapter:LocalVisualAdapter={identity:'synthetic-local-v1',localOnly:true,select:async input=>{selections++;return [{timestampSeconds:input.round===1?.5:1.5,reason:'visual-reference',question:'Qual valor aparece?',segmentIds:['s000000']}];},inspect:async input=>{inspections++;return input.frames.map(f=>({frameFile:f.file,timestampSeconds:f.timestampSeconds,frameSha256:f.sha256,text:'Fixture gerada; não contém conclusão real.',uncertainty:'uncertain'}));}};
 try{
 await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',source]);const mediaHash=await hashFile(source);
 const options={mediaHash,transcript,durationSeconds:3,sourcePath:source,root:join(root,'sessions'),adapter,ttlSeconds:60,now:1000};
 const first=await runVisualSession(options);expect(first.frames.length).toBe(1);expect(first.modelRequests).toBe(2);
 const reused=await runVisualSession(options);expect(reused.modelRequests).toBe(0);expect(selections).toBe(1);expect(inspections).toBe(1);
 const second=await runVisualSession({...options,round:2});expect(second.frames.length).toBe(2);
 await expect(runVisualSession({...options,round:3})).rejects.toThrow('round');
 await fs.mkdir(join(options.root,'unknown'));await fs.writeFile(join(options.root,'unknown','keep'),'keep');
 await fs.writeFile(join(first.directory,'unexpected-original.mkv'),'preserve');expect(await cleanupExpiredVisualSessions(options.root,61000,false)).toEqual([]);await fs.unlink(join(first.directory,'unexpected-original.mkv'));
 const expired=await runVisualSession({...options,now:61000});expect(expired.expired).toBe(true);expect(expired.observations).toEqual([]);expect(expired.modelRequests).toBe(0);
 expect(await cleanupExpiredVisualSessions(options.root,61000,true)).toEqual([first.key]);expect(await hashFile(source)).toBe(mediaHash);
 expect(await cleanupExpiredVisualSessions(options.root,61000,false)).toEqual([first.key]);expect((await runVisualSession({...options,now:62000})).modelRequests).toBe(0);expect((await fs.stat(join(first.directory,'.visual-session.json'))).isFile()).toBe(true);expect(await fs.readFile(join(options.root,'unknown','keep'),'utf8')).toBe('keep');expect(await hashFile(source)).toBe(mediaHash);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('sufficient transcript selector abstains with zero images; invalid requests and failed selectors consume persisted call budget',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'visual-select-bounds-'));let calls=0;
 const adapter:LocalVisualAdapter={identity:'fixture-local',localOnly:true,select:async input=>{calls++;if(input.segments[0]?.text==='Revisar proposta.')return [];return [{timestampSeconds:15,reason:'visual-reference',question:'Observe.',segmentIds:['s000000']}];},inspect:async()=>{calls++;return [];}};
 try{
 const options={mediaHash:'a'.repeat(64),transcript:{...transcript,text:'Revisar proposta.',segments:[{start:0,end:1,text:'Revisar proposta.'}]},durationSeconds:20,sourcePath:join(root,'must-not-read'),root:join(root,'sessions'),adapter};
 expect((await runVisualSession(options)).frames).toEqual([]);expect(calls).toBe(1);calls=0;
 for(let i=0;i<4;i++)await expect(runVisualSession({...options,transcript})).rejects.toThrow('matching transcript window');
 await expect(runVisualSession({...options,transcript})).rejects.toThrow('request budget');expect(calls).toBe(4);
 await expect(runVisualSession({...options,adapter:{...adapter,localOnly:false} as unknown as LocalVisualAdapter})).rejects.toThrow('local');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
