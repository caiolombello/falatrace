import {test,expect} from 'bun:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {emptyTimesheetContext,writeInitialTimesheetContext,loadTimesheetContext} from '../context';
import {validateTimesheetContext,validateCardId} from '../types';
import {DEFAULT_CONFIG} from '../../config/defaults';
import {loadConfigSnapshot} from '../../config/load';

test('fresh catalog and defaults do not impose an organization or enable automation/AI',()=>{
 expect(emptyTimesheetContext()).toEqual({version:1,colleagues:[],clients:[],taskTypes:[]});
 expect(DEFAULT_CONFIG.timesheet.enabled).toBe(false);
 expect(DEFAULT_CONFIG.timesheet.aiClassification).toBe(false);
 expect(DEFAULT_CONFIG.timesheet.automaticFromCalls).toBe(false);
});
test('catalogs accept independent client codes and retain custom numeric task identities',()=>{
 const catalog={version:1 as const,colleagues:[],clients:[{code:'ACME:ops-1',name:'Synthetic customer',aliases:[],responsibleNames:[]}],taskTypes:[{id:42,name:'Research',slug:'research'}]};
 expect(validateTimesheetContext(catalog)).toEqual(catalog);
 const legacy={...catalog,clients:[{...catalog.clients[0]!,code:'CL008'}],taskTypes:[{id:11,name:'Existing custom category',slug:'existing'}]};
 expect(validateTimesheetContext(legacy)).toEqual(legacy);
 for(const code of ['a\nb','<script>','x'.repeat(21)]) expect(()=>validateTimesheetContext({...catalog,clients:[{...catalog.clients[0]!,code}]})).toThrow();
});
test('bounded task references allow multiple systems while retaining legacy normalization',()=>{
 for(const ref of ['12345','task_Ab.9','issue:44','repo/42','ref#19'])expect(validateCardId(ref)).toBe(ref);
 expect(validateCardId(' dev-123 ')).toBe('DEV-123');
 for(const ref of ['a\nb','<script>','a b','x'.repeat(101),''])expect(()=>validateCardId(ref)).toThrow();
});
test('loading existing enabled config defaults missing consent flags off without writing config/catalog',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-neutral-'));
 try{
  const path=join(root,'config.json');const old=JSON.stringify({timesheet:{enabled:true}});await fs.writeFile(path,old);
  const loaded=await loadConfigSnapshot(path);
  expect(loaded.config.timesheet.aiClassification).toBe(false);expect(loaded.config.timesheet.automaticFromCalls).toBe(false);
  expect(await fs.readFile(path,'utf8')).toBe(old);
  await fs.writeFile(path,JSON.stringify({timesheet:{enabled:true,aiClassification:false,automaticFromCalls:false}}));
  const explicit=await loadConfigSnapshot(path);expect(explicit.config.timesheet.aiClassification).toBe(false);expect(explicit.config.timesheet.automaticFromCalls).toBe(false);
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.timesheet.contextPath=join(root,'catalog.json');
  const catalog=JSON.stringify({version:1,clients:[],colleagues:[],taskTypes:[{id:11,name:'Personal category',slug:'personal'}]});await fs.writeFile(cfg.timesheet.contextPath,catalog);
  await expect(writeInitialTimesheetContext(cfg)).rejects.toThrow('already exists');
  expect((await loadTimesheetContext(cfg)).taskTypes[0]!.id).toBe(11);expect(await fs.readFile(cfg.timesheet.contextPath,'utf8')).toBe(catalog);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('non-legacy client memory uses safe managed filenames and cleanup preserves unrelated files',async()=>{
 const {buildAiContextFiles,getClientAiContextPath,renderClientContext}=await import('../../knowledge/context');
 const {JobStore}=await import('../../jobs/store');const {TimeEntryStore}=await import('../store');
 const root=await fs.mkdtemp(join(tmpdir(),'falatrace-memory-id-'));
 try{
  const config=structuredClone(DEFAULT_CONFIG);config.timesheet.contextPath=join(root,'catalog.json');
  await fs.writeFile(config.timesheet.contextPath,JSON.stringify({version:1,colleagues:[],taskTypes:[],clients:[{code:'project:blue',name:'Synthetic',aliases:[],responsibleNames:[]},{code:'CL008',name:'Legacy synthetic',aliases:[],responsibleNames:[]}]}));
  const out=join(root,'memory');await fs.mkdir(join(out,'clients'),{recursive:true});
  const path=await getClientAiContextPath(config,'project:blue',out);expect(path).toMatch(/client-[a-f0-9]{64}\.md$/);
  const legacy=await getClientAiContextPath(config,'CL008',out);expect(legacy).toBe(join(out,'clients','CL008.md'));
  const generated=renderClientContext({code:'project:blue',name:'Synthetic',aliases:[],responsibleNames:[]},[],{maxMeetings:10,maxCharacters:8000}).content;await fs.writeFile(path,generated);await fs.writeFile(legacy,generated);await fs.writeFile(join(out,'clients','notes.md'),'unrelated user fixture');
  const jobStore=new JobStore(join(root,'jobs'));const timeStore=new TimeEntryStore(join(root,'timesheet'));
  await buildAiContextFiles(config,{outputDir:out,jobStore,timeStore});
  expect(await fs.stat(path).then(()=>true,()=>false)).toBe(false);expect(await fs.stat(legacy).then(()=>true,()=>false)).toBe(false);expect(await fs.readFile(join(out,'clients','notes.md'),'utf8')).toBe('unrelated user fixture');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
