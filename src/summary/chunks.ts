import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RecordingSummary, SummaryContext, Transcript } from "../jobs/types";
import type { SummaryProvider } from "../config/defaults";
import { validateSummary } from "../jobs/types";
import type { NoteForSummary } from "../notes/align";
import { buildSummaryUserContent } from "./context";
import { attachSummarySupport, buildSummaryEvidence, type SummaryInputEvidence } from "./evidence";
import type { SummaryInputEvidence as Evidence } from "./evidence";
import { SUMMARY_LABELS } from "./language";
import { LEGACY_SUMMARY_SPEC, type SummaryPromptSpec } from "./prompt";
import type { SummaryInputUnit } from "./budget";
import {
  chunkRequestFor, finalizeSummaryV2, mergeSummarySections, resolvedSelection, templateAfterFirstPart, templateHeadings,
  type SummaryChunkRequest, type SummaryV2Request
} from "./v2";
/** One provider request. `notes` (v2) are the user's notes placed in this part; `request` is set
 * by summarizeInChunks for v2 summaries so the adapter sends the right spec and notes. */
export type SummaryChunk = { text: string; evidence: SummaryInputEvidence; key: string; notes?: NoteForSummary[]; request?: SummaryChunkRequest };
export type SummaryAdapter = (chunk: SummaryChunk, signal?: AbortSignal) => Promise<RecordingSummary>;
/** v2 planning input: the spec decides the key; the notes count against each part's budget.
 * `singleRequest` (a provider that is never asked twice, like OpenAI): when the transcript fits
 * alone, keep it in one part with the notes that fit instead of splitting it. */
export type SummaryChunkPrompt = { spec: SummaryPromptSpec & { notesIncluded?: boolean }; notes?: readonly NoteForSummary[]; singleRequest?: boolean };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Key of a chunk planned without a v2 spec (also the key of checkpoints written before v2). */
export const legacyChunkKey = (text: string, source: SummaryInputEvidence, context: SummaryContext | undefined, maxCharacters: number, unit: SummaryInputUnit = "characters"): string =>
  hash({text,source,context,maxCharacters,...(unit==='characters'?{}:{unit})});
export const planSummaryChunks = (transcript: Transcript, mediaHash: string, context: SummaryContext | undefined, maxCharacters: number, visual?: Evidence["visual"],segmentIds?:string[],unit:SummaryInputUnit="characters",prompt?:SummaryChunkPrompt): SummaryChunk[] => {
  const evidence = { ...buildSummaryEvidence(transcript,mediaHash,8000,segmentIds), ...(visual ? { visual } : {}) };
  const fullText = segmentIds ? evidence.segments.map(s=>s.text).join("\n") : transcript.text.trim() ? transcript.text : transcript.segments.map(s=>s.text.trim()).filter(Boolean).join("\n");
  // Without a v2 spec this is exactly the legacy plan: same parts, same keys.
  const v2 = prompt?.spec.version === 2 ? prompt : undefined;
  const allNotes = v2 && v2.spec.notesIncluded ? [...(v2.notes || [])] : undefined;
  // A note's nearSegmentIds only name segments of its own part that have text: the answer may
  // cite only those, so a hint outside the part would lead the model to an id that is refused.
  const scoped = (source:SummaryInputEvidence, notes?:NoteForSummary[]):NoteForSummary[]|undefined => {
    if(!notes)return undefined;
    const ids=new Set(source.segments.filter(s=>s.text.trim()).map(s=>s.id));
    return notes.map(note=>({...note,nearSegmentIds:note.nearSegmentIds.filter(id=>ids.has(id))}));
  };
  const fits = (text:string, source:SummaryInputEvidence, notes?:NoteForSummary[]) => {try {buildSummaryUserContent(text,context,source,maxCharacters,unit,scoped(source,notes));return source.segments.length<=1000;} catch {return false;}};
  const chunk = (text:string,source:SummaryInputEvidence,notes?:NoteForSummary[]):SummaryChunk => {
    if(!v2)return {text,evidence:source,key:legacyChunkKey(text,source,context,maxCharacters,unit)};
    const sent=scoped(source,notes)||[];
    return {text,evidence:source,key:hash({text,source,context,maxCharacters,...(unit==='characters'?{}:{unit}),spec:v2.spec.id,notes:sent}),notes:sent};
  };
  if(fits(fullText,evidence,allNotes))return [chunk(fullText,evidence,allNotes)];
  if(v2?.singleRequest&&allNotes?.length&&fits(fullText,evidence,[])){
    // One request only: the longest run of notes (in notepad order) that still fits; the others
    // are listed later as notes the model did not use. Fitting shrinks as notes are added.
    let low=0,high=allNotes.length-1;
    while(low<high){const middle=(low+high+1)>>1;if(fits(fullText,evidence,allNotes.slice(0,middle)))low=middle;else high=middle-1;}
    return [chunk(fullText,evidence,allNotes.slice(0,low))];
  }
  // Each note goes to one part: the part holding the segment it was typed after (nearSegmentIds,
  // else its time); untimed notes go to the first part. A part that cannot hold all its notes
  // keeps the earliest ones; the rest are listed later as notes the model did not use.
  const spoken = evidence.segments.filter(s=>s.text.trim());
  const known = new Set(spoken.map(s=>s.id));
  const anchorOf = (note:NoteForSummary):string|undefined => {
    const near = note.nearSegmentIds.find(id=>known.has(id));
    if(near||note.offsetSeconds===null||!spoken.length)return near;
    let anchor=spoken[0].id;for(const segment of spoken){if(segment.start<=note.offsetSeconds)anchor=segment.id;else break;}return anchor;
  };
  const anchors = new Map((allNotes||[]).map(note=>[note.id,anchorOf(note)]));
  const assigned = new Set<string>();
  const notesOf = (segments:SummaryInputEvidence['segments'],first:boolean):NoteForSummary[]|undefined => {
    if(!allNotes)return undefined;
    const ids=new Set(segments.map(s=>s.id));
    return allNotes.filter(note=>{if(assigned.has(note.id))return false;const anchor=anchors.get(note.id);return anchor===undefined?first:ids.has(anchor);});
  };
  // Fragment text only; a fragment keeps its original segment ID and interval, never invented timing.
  const pieces = evidence.segments.length ? evidence.segments.filter(s=>s.text.trim()).flatMap(s=>{
    const size=Math.max(1,Math.floor(maxCharacters/6));const result:typeof evidence.segments=[];
    for(let offset=0;offset<s.text.length;offset+=size)result.push({...s,text:s.text.slice(offset,offset+size)});return result;
  }) : [];
  const chunks:SummaryChunk[]=[];
  const add=(text:string,segments:SummaryInputEvidence['segments'])=>{
    const source={...evidence,segments};let notes=notesOf(segments,chunks.length===0);
    while(notes?.length&&!fits(text,source,notes))notes=notes.slice(0,-1);
    if(!fits(text,source,notes))throw new Error('Summary context/fragment exceeds budget');
    for(const note of notes||[])assigned.add(note.id);
    chunks.push(chunk(text,source,notes));if(chunks.length>8)throw new Error('Summary exceeds eight-chunk job budget before any provider request');
  };
  if(!pieces.length){
    const size=Math.max(1,Math.floor(maxCharacters/3));for(let offset=0;offset<fullText.length;offset+=size)add(fullText.slice(offset,offset+size),[]);
  } else {
    let current:typeof pieces=[];
    for(const piece of pieces){const proposed=[...current,piece];if(current.length && !fits(proposed.map(s=>s.text).join('\n'),{...evidence,segments:proposed},notesOf(proposed,chunks.length===0))){add(current.map(s=>s.text).join('\n'),current);current=[];}current.push(piece);}
    if(current.length)add(current.map(s=>s.text).join('\n'),current);
  }
  return chunks;
};
export const summarizeInChunks = async (options:{transcript:Transcript;mediaHash:string;context?:SummaryContext;maxCharacters:number;provider:SummaryProvider;model:string;adapterIdentity:string;visual?:Evidence["visual"];segmentIds?:string[];cacheDir:string;adapter:SummaryAdapter;signal?:AbortSignal;inputUnit?:SummaryInputUnit;legacyMaxCharacters?:number;
  /** v2 summary (templates, language, notes); without it the legacy prompt is used, unchanged. */
  request?:SummaryV2Request}):Promise<RecordingSummary> => {
  const request=options.request;
  const chunks=planSummaryChunks(options.transcript,options.mediaHash,options.context,options.maxCharacters,options.visual,options.segmentIds,options.inputUnit,
    request?{spec:request.spec,notes:request.notes,singleRequest:options.provider==='openai'}:undefined);
  if(chunks.length>1 && options.provider==='openai')throw new Error('Multi-request API summary requires an explicit paid-budget policy; use local summary');
  options.signal?.throwIfAborted();await fs.mkdir(options.cacheDir,{recursive:true,mode:0o700});
  const dir=await fs.lstat(options.cacheDir);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('Unsafe summary cache directory');
  const results:RecordingSummary[]=[];
  let fixed:ReturnType<typeof templateAfterFirstPart>;
  for(const [index,part] of chunks.entries()){
    options.signal?.throwIfAborted();
    const chunkRequest=request?chunkRequestFor(request,part.notes||[],fixed):undefined;
    const spec:SummaryPromptSpec=chunkRequest?.spec||LEGACY_SUMMARY_SPEC;
    const checkpointKey=(chunk:string)=>hash({chunk,provider:options.provider,model:options.model,adapterIdentity:options.adapterIdentity,prompt:spec.system,schema:spec.schema});const key=checkpointKey(part.key);const path=join(options.cacheDir,key+'.json');let summary:RecordingSummary|undefined;
    // A checkpoint written under the earlier configured character budget covers the exact same text, evidence,
    // context, provider, model, prompt and schema; only the unused upper bound differed. Reuse it, never re-pay.
    // A v2 request never reuses a part written with the legacy prompt: that answer has no template sections,
    // never saw the notes and is in Portuguese, so its metadata would claim a spec, language and template
    // it was not made with. Legacy keys stay readable by legacy requests (scoped visual reviews, v1 plans).
    const candidates=[key];
    if(!request&&options.legacyMaxCharacters!==undefined&&(options.legacyMaxCharacters!==options.maxCharacters||(options.inputUnit||'characters')!=='characters'))candidates.push(checkpointKey(hash({text:part.text,source:part.evidence,context:options.context,maxCharacters:options.legacyMaxCharacters})));
    for(const candidate of candidates){
      const candidatePath=join(options.cacheDir,candidate+'.json');
      try {const stat=await fs.lstat(candidatePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Unsafe summary checkpoint');const stored=JSON.parse(await fs.readFile(candidatePath,'utf8'));if(stored.key!==candidate || stored.summarySha256!==hash(stored.summary))throw new Error('Summary checkpoint fingerprint mismatch');summary=attachSummarySupport(validateSummary(stored.summary,options.provider,options.model),part.evidence);break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(!summary){summary=attachSummarySupport(validateSummary(await options.adapter(chunkRequest?{...part,request:chunkRequest}:part,options.signal),options.provider,options.model),part.evidence);options.signal?.throwIfAborted();const temporary=join(options.cacheDir,'.'+randomUUID()+'.tmp');try {await fs.writeFile(temporary,JSON.stringify({version:1,key,summary,summarySha256:hash(summary)}),{flag:'wx',mode:0o600});await fs.rename(temporary,path);}finally{await fs.rm(temporary,{force:true});}}
    results.push(summary);
    // A model-choice summary keeps the template its first part chose for every later part.
    if(request&&index===0&&chunks.length>1)fixed=templateAfterFirstPart(request,summary);
  }
  const selection=request?(fixed?.selection||resolvedSelection(request,results[0])):undefined;
  const language=request?.language||'pt-BR';
  let output:RecordingSummary;
  if(results.length===1)output=results[0];
  else {
    const merged:RecordingSummary={...results[0],support:undefined,overview:results.map(s=>s.overview).join('\n\n'),topics:[],decisions:[],actionItems:[],citations:[],limitations:[],
      sections:mergeSummarySections(results.map(s=>s.sections),selection?templateHeadings(selection,language):[])};
    for(const item of results){for(const citation of item.citations||[]){const offset=citation.section==='topic'?merged.topics.length:citation.section==='decision'?merged.decisions.length:citation.section==='action'?merged.actionItems.length:0;merged.citations!.push({...citation,index:citation.section==='overview'?0:citation.index+offset});}merged.topics.push(...item.topics);merged.decisions.push(...item.decisions);merged.actionItems.push(...item.actionItems);merged.limitations!.push(...item.limitations||[]);}
    // Each part may carry up to 100 limitations; a stored summary holds at most 100 (like the reviewed merge).
    merged.limitations=[...new Set(merged.limitations)].slice(0,99).concat(SUMMARY_LABELS[language].limitation.chunked);
    output=attachSummarySupport(validateSummary(merged,options.provider,options.model),buildSummaryEvidence(options.transcript,options.mediaHash,8000,options.segmentIds));output.support!.reviewRequired=true;
  }
  return request&&selection?finalizeSummaryV2(output,request,selection,options.provider,options.model):output;
};
