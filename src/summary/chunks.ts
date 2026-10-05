import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RecordingSummary, SummaryContext, Transcript } from "../jobs/types";
import type { SummaryProvider } from "../config/defaults";
import { validateSummary } from "../jobs/types";
import { buildSummaryUserContent } from "./context";
import { attachSummarySupport, buildSummaryEvidence, type SummaryInputEvidence } from "./evidence";
import type { SummaryInputEvidence as Evidence } from "./evidence";
import { SUMMARY_SYSTEM_PROMPT, SUMMARY_JSON_SCHEMA } from "./schema";
import type { SummaryInputUnit } from "./budget";
export type SummaryChunk = { text: string; evidence: SummaryInputEvidence; key: string };
export type SummaryAdapter = (chunk: SummaryChunk, signal?: AbortSignal) => Promise<RecordingSummary>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const planSummaryChunks = (transcript: Transcript, mediaHash: string, context: SummaryContext | undefined, maxCharacters: number, visual?: Evidence["visual"],segmentIds?:string[],unit:SummaryInputUnit="characters"): SummaryChunk[] => {
  const evidence = { ...buildSummaryEvidence(transcript,mediaHash,8000,segmentIds), ...(visual ? { visual } : {}) };
  const fullText = segmentIds ? evidence.segments.map(s=>s.text).join("\n") : transcript.text.trim() ? transcript.text : transcript.segments.map(s=>s.text.trim()).filter(Boolean).join("\n");
  const fits = (text:string, source:SummaryInputEvidence) => {try {buildSummaryUserContent(text,context,source,maxCharacters,unit);return source.segments.length<=1000;} catch {return false;}};
  const chunk = (text:string,source:SummaryInputEvidence) => ({text,evidence:source,key:hash({text,source,context,maxCharacters,...(unit==='characters'?{}:{unit})})});
  if(fits(fullText,evidence))return [chunk(fullText,evidence)];
  // Fragment text only; a fragment keeps its original segment ID and interval, never invented timing.
  const pieces = evidence.segments.length ? evidence.segments.filter(s=>s.text.trim()).flatMap(s=>{
    const size=Math.max(1,Math.floor(maxCharacters/6));const result:typeof evidence.segments=[];
    for(let offset=0;offset<s.text.length;offset+=size)result.push({...s,text:s.text.slice(offset,offset+size)});return result;
  }) : [];
  const chunks:SummaryChunk[]=[];
  const add=(text:string,segments:SummaryInputEvidence['segments'])=>{
    const source={...evidence,segments};if(!fits(text,source))throw new Error('Summary context/fragment exceeds budget');
    chunks.push(chunk(text,source));if(chunks.length>8)throw new Error('Summary exceeds eight-chunk job budget before any provider request');
  };
  if(!pieces.length){
    const size=Math.max(1,Math.floor(maxCharacters/3));for(let offset=0;offset<fullText.length;offset+=size)add(fullText.slice(offset,offset+size),[]);
  } else {
    let current:typeof pieces=[];
    for(const piece of pieces){const proposed=[...current,piece];if(current.length && !fits(proposed.map(s=>s.text).join('\n'),{...evidence,segments:proposed})){add(current.map(s=>s.text).join('\n'),current);current=[];}current.push(piece);}
    if(current.length)add(current.map(s=>s.text).join('\n'),current);
  }
  return chunks;
};
export const summarizeInChunks = async (options:{transcript:Transcript;mediaHash:string;context?:SummaryContext;maxCharacters:number;provider:SummaryProvider;model:string;adapterIdentity:string;visual?:Evidence["visual"];segmentIds?:string[];cacheDir:string;adapter:SummaryAdapter;signal?:AbortSignal;inputUnit?:SummaryInputUnit;legacyMaxCharacters?:number}):Promise<RecordingSummary> => {
  const chunks=planSummaryChunks(options.transcript,options.mediaHash,options.context,options.maxCharacters,options.visual,options.segmentIds,options.inputUnit);
  if(chunks.length>1 && options.provider==='openai')throw new Error('Multi-request API summary requires an explicit paid-budget policy; use local summary');
  options.signal?.throwIfAborted();await fs.mkdir(options.cacheDir,{recursive:true,mode:0o700});
  const dir=await fs.lstat(options.cacheDir);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('Unsafe summary cache directory');
  const results:RecordingSummary[]=[];
  for(const part of chunks){
    options.signal?.throwIfAborted();const checkpointKey=(chunk:string)=>hash({chunk,provider:options.provider,model:options.model,adapterIdentity:options.adapterIdentity,prompt:SUMMARY_SYSTEM_PROMPT,schema:SUMMARY_JSON_SCHEMA});const key=checkpointKey(part.key);const path=join(options.cacheDir,key+'.json');let summary:RecordingSummary|undefined;
    // A checkpoint written under the earlier configured character budget covers the exact same text, evidence,
    // context, provider, model, prompt and schema; only the unused upper bound differed. Reuse it, never re-pay.
    const legacy=options.legacyMaxCharacters!==undefined&&(options.legacyMaxCharacters!==options.maxCharacters||(options.inputUnit||'characters')!=='characters')
      ?checkpointKey(hash({text:part.text,source:part.evidence,context:options.context,maxCharacters:options.legacyMaxCharacters})):undefined;
    for(const candidate of legacy?[key,legacy]:[key]){
      const candidatePath=join(options.cacheDir,candidate+'.json');
      try {const stat=await fs.lstat(candidatePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Unsafe summary checkpoint');const stored=JSON.parse(await fs.readFile(candidatePath,'utf8'));if(stored.key!==candidate || stored.summarySha256!==hash(stored.summary))throw new Error('Summary checkpoint fingerprint mismatch');summary=attachSummarySupport(validateSummary(stored.summary,options.provider,options.model),part.evidence);break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(!summary){summary=attachSummarySupport(validateSummary(await options.adapter(part,options.signal),options.provider,options.model),part.evidence);options.signal?.throwIfAborted();const temporary=join(options.cacheDir,'.'+randomUUID()+'.tmp');try {await fs.writeFile(temporary,JSON.stringify({version:1,key,summary,summarySha256:hash(summary)}),{flag:'wx',mode:0o600});await fs.rename(temporary,path);}finally{await fs.rm(temporary,{force:true});}}
    results.push(summary);
  }
  if(results.length===1)return results[0];
  const merged:RecordingSummary={...results[0],support:undefined,overview:results.map(s=>s.overview).join('\n\n'),topics:[],decisions:[],actionItems:[],citations:[],limitations:[]};
  for(const item of results){for(const citation of item.citations||[]){const offset=citation.section==='topic'?merged.topics.length:citation.section==='decision'?merged.decisions.length:citation.section==='action'?merged.actionItems.length:0;merged.citations!.push({...citation,index:citation.section==='overview'?0:citation.index+offset});}merged.topics.push(...item.topics);merged.decisions.push(...item.decisions);merged.actionItems.push(...item.actionItems);merged.limitations!.push(...item.limitations||[]);}
  merged.limitations=[...new Set(merged.limitations)].concat('Resumo montado por partes: revisar redundâncias, contexto global e eventuais conflitos. Fragmentos mantêm o intervalo do segmento original.');
  const output=attachSummarySupport(validateSummary(merged,options.provider,options.model),buildSummaryEvidence(options.transcript,options.mediaHash,8000,options.segmentIds));output.support!.reviewRequired=true;return output;
};
