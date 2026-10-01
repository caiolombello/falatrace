import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {extractVisualEvidence} from '../extract';
import {planVisualEvidence} from '../plan';
import {hashFile} from '../../jobs/store';
import {withHeavyAdmission,readHeavyStatus} from '../../runtime/heavy-admission';
test('standalone extractor and pipeline take admission before per-plan lock, avoiding reversed-order deadlock',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-lock-order-'));let release!:()=>void;
 try {
  const path=join(root,'synthetic.mp4');await fs.writeFile(path,'synthetic-source');
  const transcript={version:1 as const,provider:'whisper-cpp' as const,model:'fixture',language:'pt',text:'Verificar.',segments:[{start:0,end:2,text:'Verificar.'}]};
  const plan=planVisualEvidence(await hashFile(path),transcript,2,[{timestampSeconds:1,reason:'user-request',question:'Verificar.',segmentIds:['s000000']}]);
  let calls=0;
  const run=async(_command:string,args:string[])=>{calls++;if(calls===1)await new Promise<void>(r=>release=r);await fs.writeFile(args[args.length-1],'synthetic-jpeg-stub');return {stdout:'',stderr:''};};
  const first=extractVisualEvidence(plan,path,join(root,'standalone'),{run});
  for(let i=0;i<100&&!release;i++)await Bun.sleep(10);expect(!!release).toBe(true);
  const second=withHeavyAdmission('pipeline','another-job',()=>extractVisualEvidence(plan,path,join(root,'pipeline'),{run}));
  for(let i=0;i<100;i++){if((await readHeavyStatus()).waiting.length)break;await Bun.sleep(10);}
  expect(calls).toBe(1);release();const [a,b]=await Promise.all([first,second]);
  expect(calls).toBe(2);expect(a.frames).toEqual(b.frames);expect((await readHeavyStatus()).active).toBe(false);
 }finally{release?.();await fs.rm(root,{recursive:true,force:true});}
},5000);
