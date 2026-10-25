import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planSummaryChunks,summarizeInChunks} from '../chunks';
import {buildSummaryUserContent} from '../context';
import {validateSummary,type Transcript} from '../../jobs/types';
import {buildSummaryV2Request} from '../v2';
import {SUMMARY_LABELS} from '../language';
import {BUILT_IN_TEMPLATES} from '../../templates/catalog';
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

test('v2 notes count against each part budget: every note goes to one part, and notes no part can hold are listed, never lost',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'summary-notes-budget-'));
 const short:Transcript={...transcript,segments:transcript.segments.slice(0,40)};
 // 30 long untimed notes cannot all fit next to the transcript in a 4096-character part.
 const entries=Array.from({length:30},(_,i)=>({id:'n'+String(i+1).padStart(6,'0'),createdAt:'2026-10-25T12:00:00.000Z',offsetSeconds:null,text:`Nota ${i} `+'detalhe '.repeat(30)}));
 const request=buildSummaryV2Request({transcriptText:'texto neutro',segments:short.segments,notes:{entries},templates:BUILT_IN_TEMPLATES,templateDefault:'general',detection:'keywords',languageSetting:'pt-BR'});
 const chunks=planSummaryChunks(short,'a'.repeat(64),undefined,4096,undefined,undefined,'characters',{spec:request.spec,notes:request.notes});
 const placed=chunks.flatMap(part=>(part.notes||[]).map(note=>note.id));
 expect(new Set(placed).size).toBe(placed.length);
 expect(placed.length).toBeGreaterThan(0);expect(placed.length).toBeLessThan(30);
 expect(chunks.slice(1).every(part=>!part.notes?.length)).toBe(true);
 for(const part of chunks)expect(buildSummaryUserContent(part.text,undefined,part.evidence,4096,'characters',part.notes).length).toBeLessThanOrEqual(4096);
 try{
  const result=await summarizeInChunks({transcript:short,mediaHash:'a'.repeat(64),maxCharacters:4096,provider:'ollama',model:'fixture',adapterIdentity:'fixture',cacheDir:root,request,
   adapter:async part=>validateSummary({title:'Notas',overview:'Resumo.',topics:[],decisions:[],actionItems:[],citations:[{section:'overview',index:0,segmentIds:[part.evidence.segments[0].id],uncertainty:'clear'}],limitations:[]},'ollama','fixture')});
  const unused=result.sections!.find(section=>section.heading===SUMMARY_LABELS['pt-BR'].unusedNotes)!;
  expect(unused.items.map(item=>item.noteIds[0])).toEqual(entries.map(entry=>entry.id));
  expect(unused.items.every(item=>item.origin==='user')).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
