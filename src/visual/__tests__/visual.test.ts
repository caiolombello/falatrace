import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planVisualEvidence } from '../plan';
import { extractVisualEvidence } from '../extract';
import { hashFile } from '../../jobs/store';
import { runCommand } from '../../jobs/command';
import type { Transcript } from '../../jobs/types';
const transcript: Transcript = { version:1, provider:'whisper-cpp', model:'synthetic', language:'pt',text:'Veja o gráfico.',segments:[{start:0,end:2,text:'Veja o gráfico.'}] };
const request = (timestampSeconds:number) => ({timestampSeconds,reason:'visual-reference',question:'Qual valor está no gráfico?',segmentIds:['s000000']});
test('visual planning bounds, deduplicates and rejects invalid evidence requests', () => {
  const plan = planVisualEvidence('a'.repeat(64),transcript,3,[request(.5),request(.6),request(1.5)]);
  expect(plan.requests.length).toBe(2);
  for (const value of [-1,3,NaN,Infinity]) expect(() => planVisualEvidence('a'.repeat(64),transcript,3,[request(value)])).toThrow();
  expect(() => planVisualEvidence('a'.repeat(64),transcript,3,[{...request(1),segmentIds:['s000099']}])).toThrow();
  expect(() => planVisualEvidence('a'.repeat(64),transcript,3,[{...request(1),path:'/tmp/unsafe'}])).toThrow();
  expect(() => planVisualEvidence('a'.repeat(64),transcript,3,[],{round:3})).toThrow();
  expect(() => planVisualEvidence('a'.repeat(64),transcript,10,[request(9)],{usedTimestamps:[0,1,2,3,4,5,6,7]})).toThrow();
});
test('synthetic video extraction is private, hashed and idempotent; corruption is not overwritten', async () => {
  const root = await fs.mkdtemp(join(tmpdir(),'visual-synthetic-'));
  try {
    const source = join(root,'synthetic.mp4'); const output = join(root,'frames');
    await runCommand('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','3','-c:v','mpeg4','-y',source]);
    const hash = await hashFile(source); const plan = planVisualEvidence(hash,transcript,3,[request(.5),request(1.5)]);
    const first = await extractVisualEvidence(plan,source,output);
    expect(first.frames.length).toBe(2); expect(first.totalBytes).toBeGreaterThan(0);
    expect((await fs.stat(join(output,plan.key,'frame-0.jpg'))).mode & 0o777).toBe(0o600);
    const cached = await extractVisualEvidence(plan,source,output,{run:async () => { throw new Error('cache must not run ffmpeg'); }});
    expect(cached.reused).toBe(true); expect(cached.frames).toEqual(first.frames); expect(await hashFile(source)).toBe(hash);
    await fs.writeFile(join(output,plan.key,'frame-0.jpg'),'damaged');
    await expect(extractVisualEvidence(plan,source,output)).rejects.toThrow('checksum');
    expect(await fs.readFile(join(output,plan.key,'frame-0.jpg'),'utf8')).toBe('damaged');
    const controller = new AbortController(); const second = planVisualEvidence(hash,transcript,3,[request(2)]);
    await expect(extractVisualEvidence(second,source,output,{signal:controller.signal,run:async () => {controller.abort(); throw new Error('synthetic cancellation');}})).rejects.toThrow('cancellation');
    expect((await fs.readdir(output)).filter(name => name.endsWith('.partial'))).toEqual([]);
    expect(await hashFile(source)).toBe(hash);
    controller.abort(); await expect(extractVisualEvidence(second,source,output,{signal:controller.signal})).rejects.toThrow();
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('command cancellation stops a synthetic child process', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),100);
  try { await expect(runCommand(process.execPath,['-e','setTimeout(()=>{},60000)'],{signal:controller.signal})).rejects.toThrow('cancelled'); }
  finally {clearTimeout(timer);}
});
