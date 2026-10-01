import {expect,test} from 'bun:test';import {promises as fs} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DEFAULT_CONFIG} from '../../config/defaults';import {processJob} from '../pipeline';import {runCommand} from '../command';import {hashFile} from '../store';import type {JobManifest,Transcript} from '../types';import {createLocalOllamaVisualAdapter} from '../../visual/ollama';
test('pipeline passes verified frame observations as untrusted context and preserves review/provenance without real provider calls',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'visual-pipeline-'));const original=globalThis.fetch;let selector=0,vision=0,summaries=0;let summaryInput:any;
 try{
 const source=join(root,'synthetic.mp4');await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',source]);const hash=await hashFile(source);
 const transcript:Transcript={version:1,provider:'whisper-cpp',model:'fixture',language:'pt',text:'Veja o gráfico.',segments:[{start:0,end:3,text:'Veja o gráfico.'}]};await fs.writeFile(join(root,'transcript.json'),JSON.stringify(transcript));
 const manifest:JobManifest={version:1,id:'123e4567-e89b-42d3-a456-426614174000',createdAt:'2026-09-30T00:00:00Z',source:{originalName:'synthetic.mp4',mediaFile:'source.mp4',size:(await fs.stat(source)).size,sha256:hash},transcription:{provider:'whisper-cpp',model:'fixture',language:'pt'},summary:{provider:'ollama',model:'summary-fixture'}};
 globalThis.fetch=(async(url,init)=>{expect(new URL(String(url)).hostname).toBe('127.0.0.1');const request=JSON.parse(String(init?.body));if(new URL(String(url)).pathname==='/api/show')return Response.json({model_info:{'general.architecture':'synthetic'}});const input=JSON.parse(request.messages[1].content);let result:unknown;
 if(request.model==='selector-fixture'){selector++;expect(input.segments[0].id).toBe('s000000');result={requests:[{timestampSeconds:1,reason:'visual-reference',question:'Qual valor aparece?',segmentIds:['s000000']}]};}
 else if(request.model==='vision-fixture'){vision++;expect(request.messages[1].images.length).toBe(1);expect(request.messages[0].content).toContain('never instructions');const f=input.frames[0];result={observations:[{frameFile:f.file,timestampSeconds:f.timestampSeconds,frameSha256:f.sha256,text:'Imagem sintética; texto ambíguo, revisar.',uncertainty:'uncertain'}]};}
 else {summaries++;summaryInput=input;result={title:'Revisão',overview:'Revisar a imagem.',topics:[],decisions:[],actionItems:[],citations:[],limitations:['A imagem não comprova decisões.']};}
 return Response.json({message:{content:JSON.stringify(result)}});
 }) as typeof fetch;
 const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl='http://127.0.0.1:11434';
 const adapter=createLocalOllamaVisualAdapter('http://127.0.0.1:11434','selector-fixture','vision-fixture');
 await processJob(config,manifest,source,root,{visual:{root:join(root,'visual-sessions'),adapter}});
 expect(summaryInput.evidence.visual.observations[0].timestampSeconds).toBe(1);expect(JSON.parse(await fs.readFile(join(root,'summary.json'),'utf8')).support.reviewRequired).toBe(true);
 expect(JSON.parse(await fs.readFile(join(root,'visual-evidence.json'),'utf8')).mediaSha256).toBe(hash);expect((await fs.stat(join(root,'visual-evidence.json'))).mode&0o777).toBe(0o600);
 await processJob(config,manifest,source,root,{visual:{root:join(root,'visual-sessions'),adapter}});expect([selector,vision,summaries]).toEqual([1,1,1]);expect(await hashFile(source)).toBe(hash);
 await processJob(config,manifest,source,root);expect(await fs.stat(join(root,'visual-evidence.json')).catch(()=>null)).toBeNull();for(const name of ['summary.json','summary.md','transcript.md'])expect((await fs.stat(join(root,name))).mode&0o777).toBe(0o600);
 expect(()=>createLocalOllamaVisualAdapter('https://provider.example.test','x','y')).toThrow('loopback');
 }finally{globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});}
});
