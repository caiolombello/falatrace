import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from '../../jobs/command';
import {hashFile} from '../../jobs/store';
import {planVisualEvidence} from '../plan';
import {extractVisualEvidence} from '../extract';

test('accurate input seek preserves reference JPEGs at zero, fractional and late timestamps with B-frames',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-seek-'));
 try {
  for(const container of ['mp4','mkv']){
   const source=join(root,'synthetic.'+container);
   await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','20','-an','-c:v','mpeg4','-bf','2','-g','30','-threads','2','-y',source]);
   const mediaHash=await hashFile(source);
   const transcript={version:1 as const,provider:'whisper-cpp' as const,model:'synthetic',language:'pt',text:'Exemplo sintético.',segments:[{start:0,end:20,text:'Exemplo sintético.'}]};
   for(const seconds of [0,1.25,17.35]){
    const plan=planVisualEvidence(mediaHash,transcript,20,[{timestampSeconds:seconds,reason:'user-request',question:'Verificar frame sintético.',segmentIds:['s000000']}]);
    const result=await extractVisualEvidence(plan,source,join(root,container));
    const reference=join(root,container+'-'+seconds+'.jpg');
    await runCommand('ffmpeg',['-nostdin','-v','error','-i',source,'-ss',String(seconds),'-frames:v','1','-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",'-q:v','3','-y',reference]);
    expect(result.frames[0].sha256).toBe(await hashFile(reference));
    expect(result.frames[0].timestampSeconds).toBe(seconds);
    expect(await hashFile(source)).toBe(mediaHash);
   }
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
},15000);
