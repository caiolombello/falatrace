import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const id='123e4567-e89b-42d3-a456-426614174000';
async function until(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await Bun.sleep(30);}throw Error('Synthetic worker condition timed out');}
test('actual worker waits before claiming, graceful stop retains queued media, restart consumes request once and preserves failed media',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-worker-admission-'));let child:ReturnType<typeof Bun.spawn>|undefined;
 try {
  const home=join(root,'home'),state=join(root,'state'),server=join(home,'.local/share/recording-cli/server'),queue=join(server,'queue',id),managed=join(state,'recording-cli');
  await fs.mkdir(queue,{recursive:true});await fs.mkdir(managed,{recursive:true,mode:0o700});
  const bytes='synthetic-media-preserved';await fs.writeFile(join(queue,'source.mkv'),bytes);await fs.writeFile(join(queue,'transcript.json'),'corrupt-cache');
  await fs.writeFile(join(queue,'manifest.json'),JSON.stringify({version:1,id,createdAt:'2026-10-01T00:00:00Z',source:{originalName:'synthetic.mkv',mediaFile:'source.mkv',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},transcription:{provider:'whisper-cpp',model:'fixture',language:'pt'},summary:{provider:'ollama',model:'fixture'}}));
  const session={version:1,id,owner:'manual',backend:'gpu-screen-recorder',phase:'recording',outputPath:join(queue,'source.mkv'),startedAt:'2026-10-01T00:00:00Z'};
  await fs.writeFile(join(managed,'recording-session.json'),JSON.stringify(session));
  const script=join(root,'worker.ts');await fs.writeFile(script,`import {runWorker,runWorkerOnce} from ${JSON.stringify(join(import.meta.dir,'../worker.ts'))};import {DEFAULT_CONFIG} from ${JSON.stringify(join(import.meta.dir,'../../config/defaults.ts'))};const config=structuredClone(DEFAULT_CONFIG);config.remote.archiveDir=${JSON.stringify(join(root,'archive'))};globalThis.fetch=async()=>{throw Error('No provider allowed in fixture');};if(process.argv[2]==='once')await runWorkerOnce(config);else await runWorker(config);`);
  const env={HOME:home,XDG_STATE_HOME:state,PATH:'/usr/bin:/bin',FALATRACE_HEAVY_PAUSE:'capture'};
  child=Bun.spawn([process.execPath,script],{env,stdout:'ignore',stderr:'pipe'});
  await until(async()=>{try{return JSON.parse(await fs.readFile(join(managed,'heavy-admission/queue.json'),'utf8')).queue[0]?.reason==='recording-active';}catch{return false;}});
  expect(await fs.readFile(join(queue,'source.mkv'),'utf8')).toBe(bytes);
  expect(await fs.stat(join(server,'processing',id)).catch(()=>null)).toBeNull();
  child.kill('SIGTERM');expect(await child.exited).toBe(0);expect(await fs.readFile(join(queue,'source.mkv'),'utf8')).toBe(bytes);
  session.phase='stopped';await fs.writeFile(join(managed,'recording-session.json'),JSON.stringify(session));
  child=Bun.spawn([process.execPath,script,'once'],{env,stdout:'ignore',stderr:'pipe'});expect(await child.exited).toBe(0);
  expect(await fs.stat(queue).catch(()=>null)).toBeNull();
  expect(await fs.readFile(join(server,'failed',id,'source.mkv'),'utf8')).toBe(bytes);
  expect(JSON.parse(await fs.readFile(join(server,'status',id+'.json'),'utf8')).state).toBe('failed');
  expect((await fs.readdir(join(server,'failed')))).toEqual([id]);
 }finally{child?.kill();if(child)await child.exited;await fs.rm(root,{recursive:true,force:true});}
},10000);
