import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummaryEvidence, attachSummarySupport } from '../src/summary/evidence';
import { validateSummary, type Transcript } from '../src/jobs/types';
import { planVisualEvidence } from '../src/visual/plan';
import { extractVisualEvidence } from '../src/visual/extract';
import { runCommand } from '../src/jobs/command';
import { hashFile } from '../src/jobs/store';
const samples:number[]=[]; let checked=0;
for(let iteration=0;iteration<100;iteration++) for(let scenario=0;scenario<12;scenario++) {
 const transcript:Transcript={version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:`Cenário ${scenario}: revisar proposta.`,segments:[{start:scenario,end:scenario+1,text:'Revisar proposta.'}]};
 const start=performance.now(); const evidence=buildSummaryEvidence(transcript,'a'.repeat(64));
 const summary=validateSummary({title:'Revisão',overview:'Revisar proposta.',topics:[],decisions:[],actionItems:[],citations:[{section:'overview',index:0,segmentIds:['s000000'],uncertainty:scenario%2?'uncertain':'clear'}],limitations:[]},'ollama','synthetic');
 const supported=attachSummarySupport(summary,evidence);
 if(supported.support?.reviewRequired!==!!(scenario%2)) throw new Error('review mismatch');
 const plan=planVisualEvidence('a'.repeat(64),transcript,20,[]); if(plan.requests.length) throw new Error('sufficient transcript requested frames');
 samples.push(performance.now()-start); checked++;
}
samples.sort((a,b)=>a-b);
const root=await fs.mkdtemp(join(tmpdir(),'visual-benchmark-'));
try {
 const source=join(root,'synthetic.mp4');await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',source]);
 const transcript:Transcript={version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:'Veja a tela.',segments:[{start:0,end:3,text:'Veja a tela.'}]};
 const plan=planVisualEvidence(await hashFile(source),transcript,3,[.5,1.5].map(timestampSeconds=>({timestampSeconds,reason:'visual-reference',question:'Qual valor aparece?',segmentIds:['s000000']})));
 const firstStart=performance.now();const first=await extractVisualEvidence(plan,source,join(root,'frames'));const firstMs=performance.now()-firstStart;
 const cachedStart=performance.now();const cached=await extractVisualEvidence(plan,source,join(root,'frames'));const cachedMs=performance.now()-cachedStart;
 console.log(JSON.stringify({scope:'offline synthetic structural checks; not model quality or production performance',scenarios:12,iterationsPerScenario:100,checked,medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*.95)],video:{fixture:'lavfi testsrc2 320x180 10fps 3sec',frames:first.frames.length,totalBytes:first.totalBytes,firstMs,cachedMs,reused:cached.reused},externalModelRequests:0},null,2));
} finally {await fs.rm(root,{recursive:true,force:true});}
