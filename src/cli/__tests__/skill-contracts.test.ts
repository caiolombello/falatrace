import {expect,test} from 'bun:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DEFAULT_CONFIG} from '../../config/defaults';

test('skill read-only examples match actual CLI text/JSON and preserve synthetic inputs without provider execution',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-skill-')),id='11111111-1111-4111-8111-111111111111',artifact=join(root,'synthetic.recording',id),state=join(root,'state'),configRoot=join(root,'config'),jobPath=join(state,'recording-cli/jobs',id+'.json');
 try{
  for(const p of [artifact,join(state,'recording-cli/jobs'),join(configRoot,'recording-cli'),join(root,'home')])await fs.mkdir(p,{recursive:true,mode:0o700});
  const config=structuredClone(DEFAULT_CONFIG);config.timesheet.contextPath=join(state,'recording-cli/timesheet-context.json');const configFile=join(configRoot,'recording-cli/config.json');await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});await fs.writeFile(config.timesheet.contextPath,JSON.stringify({version:1,colleagues:[],clients:[],taskTypes:[]}));
  const sourcePath=join(root,'synthetic.mkv');await fs.writeFile(sourcePath,'media');const job={version:1,id,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',source:{originalName:'synthetic.mkv',mediaFile:'source.mkv',size:5,sha256:'a'.repeat(64)},transcription:{provider:'whisper-cpp',model:'synthetic',language:'en'},summary:{provider:'ollama',model:'synthetic'},sourcePath,artifactDir:artifact,target:'local',state:'completed'};await fs.writeFile(jobPath,JSON.stringify(job));
  const summaryFile=join(artifact,'summary.json'),transcriptFile=join(artifact,'transcript.json');await fs.writeFile(summaryFile,JSON.stringify({version:1,provider:'ollama',model:'synthetic',title:'Synthetic chart',overview:'Synthetic decision.',topics:[],decisions:[],actionItems:[]}));await fs.writeFile(transcriptFile,JSON.stringify({version:1,provider:'whisper-cpp',model:'whisper-cpp',language:'en',text:'Synthetic chart decision.',segments:[{start:10,end:12,text:'Synthetic chart decision.'}]}));
  const before=await Promise.all([configFile,jobPath,summaryFile,transcriptFile].map(p=>fs.readFile(p,'utf8')));
  const run=async(args:string[])=>{const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../index.ts'),...args],{env:{...process.env,HOME:join(root,'home'),XDG_CONFIG_HOME:configRoot,XDG_STATE_HOME:state,XDG_DATA_HOME:join(root,'data')},stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code).toBe(0);expect(err).toBe('');return out;};
  expect(await run(['--version'])).toBe('FalaTrace 0.2.0-alpha.5\n');expect(await run(['jobs','list'])).toContain(id+'  completed');expect(JSON.parse(await run(['jobs','status',id])).id).toBe(id);
  const found=JSON.parse(await run(['context','search','Synthetic chart','--limit','5']));expect(found.trust).toBe('untrusted-meeting-data');expect(found.items[0].jobId).toBe(id);expect(found.bounded.limit).toBe(5);
  const context=JSON.parse(await run(['context','meeting',id,'--max-characters','4096']));expect(context.trust).toBe('untrusted-meeting-data');expect(context.budget.characters).toBeLessThanOrEqual(4096);expect(context.excerpts[0].timestamps).toEqual({start:10,end:12});expect(['segment','block']).toContain(context.excerpts[0].timing);
  expect(await Promise.all([configFile,jobPath,summaryFile,transcriptFile].map(p=>fs.readFile(p,'utf8')))).toEqual(before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
