import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {activityReason,heavyPolicy,readActivity,readHeavyStatus,withHeavyAdmission} from '../heavy-admission';
const idle=async()=>({recording:'idle',call:'idle'} as const);
const policy={pause:'capture-and-call',unknown:'wait'} as const;
const nap=(n=30)=>new Promise<void>(r=>setTimeout(r,n));
async function fixture(run:(root:string)=>Promise<void>){const root=await fs.mkdtemp(join(tmpdir(),'falatrace-admission-'));try{await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
async function until(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await nap();}throw Error('Fixture condition timed out');}
test('policy distinguishes recording, inferred call, unknown and explicit overrides',()=>{
 expect(heavyPolicy({})).toEqual(policy);
 expect(activityReason({recording:'active',call:'idle'},policy)).toBe('recording-active');
 expect(activityReason({recording:'idle',call:'active'},policy)).toBe('call-inferred');
 expect(activityReason({recording:'idle',call:'active'},{pause:'capture',unknown:'wait'})).toBeUndefined();
 expect(activityReason({recording:'unknown',call:'idle'},policy)).toBe('activity-unknown');
 expect(activityReason({recording:'unknown',call:'unknown'},{pause:'off',unknown:'wait'})).toBeUndefined();
 expect(activityReason({recording:'unknown',call:'idle'},{...policy,unknown:'allow'})).toBeUndefined();
 expect(()=>heavyPolicy({FALATRACE_HEAVY_PAUSE:'invalid'})).toThrow();
});
test('detector reads metadata only, stale active remains blocking, stale idle/invalid unknown',async()=>fixture(async root=>{
 expect(await readActivity(root)).toEqual({recording:'idle',call:'unknown'});
 const write=async(name:string,data:any)=>fs.writeFile(join(root,name),JSON.stringify({... (name==='recording-session.json'?{id:'123e4567-e89b-42d3-a456-426614174000',owner:'manual',backend:'audio',outputPath:join(root,'synthetic.mkv'),startedAt:new Date().toISOString()}:{recordingOwned:false,confidence:0,reasons:[]}),...data}));
 await write('recording-session.json',{version:1,phase:'recording'});
 await write('call-monitor.json',{version:1,state:'IN_CALL',dryRun:false,updatedAt:'2000-01-01'});
 expect(await readActivity(root)).toEqual({recording:'active',call:'active'});
 await write('recording-session.json',{version:1,phase:'stopped'});
 await write('call-monitor.json',{version:1,state:'IDLE',dryRun:false,updatedAt:'2000-01-01'});
 expect(await readActivity(root)).toEqual({recording:'idle',call:'unknown'});
 await write('call-monitor.json',{version:1,state:'IDLE',dryRun:false,updatedAt:new Date().toISOString()});
 expect((await readActivity(root)).call).toBe('idle');
 await fs.writeFile(join(root,'recording-session.json'),'broken');
 expect((await readActivity(root)).recording).toBe('unknown');
}));
test('two jobs serialize FIFO; an active call does not interrupt running work; resumes without duplication',async()=>fixture(async root=>{
 let activity={recording:'idle',call:'idle'} as any,release!:()=>void;const order:string[]=[];
 const first=withHeavyAdmission('pipeline','first',async()=>{order.push('first-start');await new Promise<void>(r=>release=r);order.push('first-end');},{root,policy,activity:async()=>activity,pollMs:25});
 await until(async()=>!!release);activity={recording:'active',call:'active'};
 const reasons:string[]=[];
 const second=withHeavyAdmission('pipeline','second',async()=>{order.push('second');},{root,policy,activity:async()=>activity,pollMs:25,onWait:r=>reasons.push(r)});
 await until(async()=>reasons.includes('queue'));release();await first;
 await until(async()=>reasons.includes('recording-active'));expect(order).toEqual(['first-start','first-end']);
 activity={recording:'idle',call:'idle'};await second;expect(order).toEqual(['first-start','first-end','second']);
 expect((await readHeavyStatus(root)).waiting).toEqual([]);
}));
test('waiting cancel removes ticket and permits next request, retains caller checkpoint',async()=>fixture(async root=>{
 const controller=new AbortController();let ran=false;
 const checkpoint=join(root,'checkpoint');await fs.writeFile(checkpoint,'synthetic-kept');
 const waiting=withHeavyAdmission('pipeline','cancelled',async()=>{ran=true;},{root,policy,activity:async()=>({recording:'active',call:'idle'}),signal:controller.signal,pollMs:25});
 await until(async()=>(await readHeavyStatus(root)).waiting.length===1);controller.abort();await expect(waiting).rejects.toThrow();
 expect(ran).toBe(false);expect(await fs.readFile(checkpoint,'utf8')).toBe('synthetic-kept');
 await withHeavyAdmission('pipeline','next',async()=>{ran=true;},{root,policy,activity:idle});expect(ran).toBe(true);
}));
test('failed detector waits visibly; explicit unknown allow permits; work failure releases lease',async()=>fixture(async root=>{
 const c=new AbortController();let reported='';
 const waiting=withHeavyAdmission('pipeline','failure',async()=>{throw Error('must not run');},{root,policy,activity:async()=>{throw Error('detector unavailable');},onWait:r=>{reported=r;c.abort();},signal:c.signal});
 await expect(waiting).rejects.toThrow();expect(reported).toBe('activity-unknown');
 await expect(withHeavyAdmission('pipeline','throws',async()=>{throw Error('synthetic failure');},{root,policy:{...policy,unknown:'allow'},activity:async()=>({recording:'unknown',call:'unknown'})})).rejects.toThrow('synthetic failure');
 expect((await readHeavyStatus(root)).active).toBe(false);
}));
test('nested command shares the active lease; nested different job is refused',async()=>fixture(async root=>{
 await withHeavyAdmission('pipeline','job',async()=>{
  await withHeavyAdmission('command','ffmpeg',async()=>expect((await readHeavyStatus(root)).active).toBe(true),{root,policy,activity:idle});
  await expect(withHeavyAdmission('pipeline','other',async()=>{}, {root,policy,activity:idle})).rejects.toThrow('Nested different job');
 },{root,policy,activity:idle});
}));
test('no TTL stealing of living owner; dead owner recovery and PID identity mismatch recovery',async()=>fixture(async root=>{
 let release!:()=>void;
 const held=withHeavyAdmission('pipeline','live',async()=>new Promise<void>(r=>release=r),{root,policy,activity:idle});
 await until(async()=>!!release);
 const path=join(root,'queue.json'),state=JSON.parse(await fs.readFile(path,'utf8'));
 const c=new AbortController();let ran=false;
 const next=withHeavyAdmission('pipeline','next',async()=>{ran=true;},{root,policy,activity:idle,signal:c.signal,pollMs:25});
 await until(async()=>(await readHeavyStatus(root)).waiting.length===1);await nap(100);expect(ran).toBe(false);c.abort();await expect(next).rejects.toThrow();release();await held;
 state.queue[0].owner.pid=2147483647;await fs.writeFile(path,JSON.stringify(state),{mode:0o600});
 await withHeavyAdmission('pipeline','recovered',async()=>{ran=true;},{root,policy,activity:idle});expect(ran).toBe(true);
 state.queue[0].owner.pid=process.pid;state.queue[0].owner.start='0';await fs.writeFile(path,JSON.stringify(state));
 await withHeavyAdmission('pipeline','pid-reused',async()=>{}, {root,policy,activity:idle});expect((await readHeavyStatus(root)).active).toBe(false);
}));
test('cross-process jobs never overlap using exclusive synthetic marker; persistent queue recovers after exit',async()=>fixture(async root=>{
 const module=join(import.meta.dir,'../heavy-admission.ts'),script=join(root,'child.ts');
 await fs.writeFile(script,`import {withHeavyAdmission} from ${JSON.stringify(module)};import {promises as fs} from 'node:fs';const root=process.argv[2];await withHeavyAdmission('pipeline',process.argv[3],async()=>{const f=await fs.open(root+'/exclusive','wx');await Bun.sleep(60);await f.close();await fs.unlink(root+'/exclusive');await fs.appendFile(root+'/done',process.argv[3]+'\\n');},{root,policy:{pause:'off',unknown:'wait'},pollMs:25});`);
 const children=['a','b','c'].map(id=>Bun.spawn([process.execPath,script,root,id],{stdout:'pipe',stderr:'pipe'}));
 expect(await Promise.all(children.map(c=>c.exited))).toEqual([0,0,0]);
 expect(new Set((await fs.readFile(join(root,'done'),'utf8')).trim().split('\n'))).toEqual(new Set(['a','b','c']));
 expect(JSON.parse(await fs.readFile(join(root,'queue.json'),'utf8')).queue).toEqual([]);
}));
test('FIFO surviving requests do not starve; cancelled head during detector pause frees later request',async()=>fixture(async root=>{
 let active=true;const activity=async()=>({recording:active?'active':'idle',call:'idle'} as const);const c=new AbortController();const order:number[]=[];
 const head=withHeavyAdmission('pipeline','head',async()=>{}, {root,policy,activity,signal:c.signal,pollMs:25});
 await until(async()=>(await readHeavyStatus(root)).waiting.length===1);
 const p1=withHeavyAdmission('pipeline','one',async()=>{order.push(1);},{root,policy,activity,pollMs:25});
 await until(async()=>(await readHeavyStatus(root)).waiting.length===2);
 const p2=withHeavyAdmission('pipeline','two',async()=>{order.push(2);},{root,policy,activity,pollMs:25});
 c.abort();await expect(head).rejects.toThrow();active=false;await Promise.all([p1,p2]);expect(order).toEqual([1,2]);
}));
test('symlink and corrupt state fail closed without work or replacing original bytes',async()=>fixture(async root=>{
 const path=join(root,'queue.json');await fs.writeFile(path,'invalid');let ran=false;
 await expect(withHeavyAdmission('pipeline','job',async()=>{ran=true;},{root,policy,activity:idle})).rejects.toThrow();expect(ran).toBe(false);expect(await fs.readFile(path,'utf8')).toBe('invalid');
 await fs.unlink(path);await fs.symlink(join(root,'target'),path);
 await expect(withHeavyAdmission('pipeline','job',async()=>{}, {root,policy,activity:idle})).rejects.toThrow('Unsafe');
}));
test('restart reclaims a terminated synthetic owner, keeps checkpoint and never steals a live one',async()=>fixture(async root=>{
 const module=join(import.meta.dir,'../heavy-admission.ts'),script=join(root,'crash.ts');
 await fs.writeFile(script,`import {withHeavyAdmission} from ${JSON.stringify(module)};import {promises as fs} from 'node:fs';await withHeavyAdmission('pipeline','crash',async()=>{await fs.writeFile(process.argv[2]+'/checkpoint','retained');await Bun.sleep(60000);},{root:process.argv[2],policy:{pause:'off',unknown:'wait'}});`);
 const child=Bun.spawn([process.execPath,script,root],{stdout:'ignore',stderr:'pipe'});
 try {
  await until(async()=>{try{return await fs.readFile(join(root,'checkpoint'),'utf8')==='retained';}catch{return false;}});
  expect((await readHeavyStatus(root)).active).toBe(true);
  child.kill('SIGTERM');await child.exited;
  let runs=0;await withHeavyAdmission('pipeline','recovered',async()=>{runs++;},{root,policy,activity:idle});
  expect(runs).toBe(1);expect(await fs.readFile(join(root,'checkpoint'),'utf8')).toBe('retained');
 }finally{child.kill();await child.exited;}
}));
test('admission signal abort during running work does not automatically terminate that work',async()=>fixture(async root=>{
 const c=new AbortController();let started=false,finished=false,release!:()=>void;
 const running=withHeavyAdmission('pipeline','running',async()=>{started=true;await new Promise<void>(r=>release=r);finished=true;},{root,policy,activity:idle,signal:c.signal});
 await until(async()=>started);c.abort();expect(finished).toBe(false);expect((await readHeavyStatus(root)).active).toBe(true);
 release();await running;expect(finished).toBe(true);expect((await readHeavyStatus(root)).active).toBe(false);
}));
test('duplicate same-job operation is refused promptly, not queued behind the provider it blocks',async()=>fixture(async root=>{
 let release!:()=>void;let calls=0;
 const first=withHeavyAdmission('diarization','same-job',async()=>{calls++;await new Promise<void>(r=>release=r);},{root,policy,activity:idle});
 try {
  await until(async()=>!!release);
  await expect(withHeavyAdmission('diarization','same-job',async()=>{calls++;},{root,policy,activity:idle})).rejects.toThrow('already pending or running');
  expect(calls).toBe(1);expect((await readHeavyStatus(root)).waiting).toEqual([]);
 }finally{release?.();await first;}
}));
test('status is read-only: missing root is not created, queue inode and mtime preserved',async()=>fixture(async root=>{
 const missing=join(root,'missing');expect((await readHeavyStatus(missing)).active).toBe(false);expect(await fs.access(missing).then(()=>true,()=>false)).toBe(false);
 await withHeavyAdmission('pipeline','job',async()=>{}, {root,policy,activity:idle});const path=join(root,'queue.json'),before=await fs.stat(path);await nap();await readHeavyStatus(root);const after=await fs.stat(path);expect(after.ino).toBe(before.ino);expect(after.mtimeMs).toBe(before.mtimeMs);
}));
test('release failure never masks work result or error; later transaction cleans pending release after repair',async()=>fixture(async root=>{
 const path=join(root,'queue.json');let state='';
 const result=await withHeavyAdmission('pipeline','success',async()=>{state=await fs.readFile(path,'utf8');await fs.writeFile(path,'synthetic corruption');return 'completed';},{root,policy,activity:idle});expect(result).toBe('completed');expect(await fs.readFile(path,'utf8')).toBe('synthetic corruption');
 await fs.writeFile(path,state);await withHeavyAdmission('pipeline','next',async()=>{}, {root,policy,activity:idle});expect((await readHeavyStatus(root)).active).toBe(false);
 await expect(withHeavyAdmission('pipeline','failure',async()=>{state=await fs.readFile(path,'utf8');await fs.writeFile(path,'synthetic corruption');throw Error('original failure');},{root,policy,activity:idle})).rejects.toThrow('original failure');await fs.writeFile(path,state);await withHeavyAdmission('pipeline','after',async()=>{}, {root,policy,activity:idle});
}));
