import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planSummaryChunks,summarizeInChunks} from '../chunks';
import {buildSummaryUserContent} from '../context';
import {validateSummary,type Transcript} from '../../jobs/types';
const transcript:Transcript={version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:'',segments:Array.from({length:1001},(_,i)=>({start:i,end:i+1,text:'Revisar proposta sintética.'}))};
test('long transcript chunks preserve global IDs and bounded payloads, cache complete parts on retry and flag global review',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'summary-chunks-'));let calls=0;
 const chunks=planSummaryChunks(transcript,'a'.repeat(64),undefined,24000);
 expect(chunks.length).toBeGreaterThan(1);expect(chunks.length).toBeLessThanOrEqual(8);
 expect(chunks.flatMap(p=>p.evidence.segments.map(s=>s.id))).toEqual(transcript.segments.map((_,i)=>'s'+String(i).padStart(6,'0')));
 for(const part of chunks)expect(buildSummaryUserContent(part.text,undefined,part.evidence,24000).length).toBeLessThanOrEqual(24000);
 const options={transcript,mediaHash:'a'.repeat(64),maxCharacters:24000,provider:'ollama' as const,model:'fixture',adapterIdentity:'fixture-v1',cacheDir:root,adapter:async(part:typeof chunks[number])=>{calls++;if(calls===2)throw new Error('fixture transient');return validateSummary({title:'Revisão',overview:'Revisar proposta.',topics:[],decisions:['Revisar proposta.'],actionItems:[],citations:[{section:'decision',index:0,segmentIds:[part.evidence.segments[0].id],uncertainty:'clear'}],limitations:[]},'ollama','fixture');}};
 try {
  await expect(summarizeInChunks(options)).rejects.toThrow('transient');expect((await fs.readdir(root)).length).toBe(1);
  const result=await summarizeInChunks(options);expect(calls).toBe(chunks.length+1);expect(result.decisions.length).toBe(chunks.length);expect(result.support?.reviewRequired).toBe(true);
  expect(result.citations?.filter(c=>c.section==='decision').map(c=>c.index)).toEqual(chunks.map((_,i)=>i));
  await summarizeInChunks(options);expect(calls).toBe(chunks.length+1);
  const path=join(root,(await fs.readdir(root))[0]);const stored=JSON.parse(await fs.readFile(path,'utf8'));stored.summary.overview='tampered';await fs.writeFile(path,JSON.stringify(stored));
  await expect(summarizeInChunks(options)).rejects.toThrow('fingerprint');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('excessive transcript, preabort and automatic paid chunking make zero adapter calls',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'summary-bounds-'));let calls=0;const controller=new AbortController();controller.abort(new Error('cancelled fixture'));
 const options={transcript,mediaHash:'a'.repeat(64),maxCharacters:24000,provider:'ollama' as const,model:'fixture',adapterIdentity:'fixture',cacheDir:root,adapter:async()=>{calls++;throw new Error('unexpected');}};
 try{
 await expect(summarizeInChunks({...options,signal:controller.signal})).rejects.toThrow('cancelled');
 await expect(summarizeInChunks({...options,provider:'openai'})).rejects.toThrow('paid-budget');
 expect(()=>planSummaryChunks({...transcript,segments:[{start:0,end:1,text:'x'.repeat(500000)}]},'a'.repeat(64),undefined,24000)).toThrow('eight-chunk');expect(calls).toBe(0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
