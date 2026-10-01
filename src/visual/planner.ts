import {createHash} from 'node:crypto';
import type {Transcript} from '../jobs/types';
import {planVisualEvidence,type VisualPlan} from './plan';
export type TranscriptScope={startSeconds:number;endSeconds:number;segments:Array<{id:string;start:number;end:number;text:string}>;totalSegments:number;omittedBefore:number;omittedAfter:number;omittedIntersecting:number;characters:number;withinLimits:boolean;key:string};
export type PlannerInput={segments:Array<{id:string;start:number;end:number;text:string}>;durationSeconds:number;remainingFrames:number;round:number};
export type TranscriptDecision={decision:'frames'|'none'|'abstain';rationale:string;sources:Array<{segmentId:string;quote:string}>;plan:VisualPlan;key:string};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeText=(x:unknown,max:number)=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
/** Include only entire segments inside the explicit interval, preserving original IDs and absolute times. */
export function selectTranscriptScope(transcript:Transcript,durationSeconds:number,startSeconds=0,endSeconds=durationSeconds):TranscriptScope{
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>86400||!Number.isFinite(startSeconds)||!Number.isFinite(endSeconds)||startSeconds<0||endSeconds<=startSeconds||endSeconds>durationSeconds)throw Error('Invalid explicit transcript interval');
 const all=transcript.segments.map((s,i)=>({id:'s'+String(i).padStart(6,'0'),start:s.start,end:s.end,text:s.text}));
 if(!all.length||all.length>100000||all.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.start>=durationSeconds||s.end>durationSeconds||typeof s.text!=='string'))throw Error('Invalid transcript segment timing');
 const segments=all.filter(s=>s.start>=startSeconds&&s.end<=endSeconds);const characters=JSON.stringify(segments).length;
 const data={startSeconds,endSeconds,segments,totalSegments:all.length,omittedBefore:all.filter(s=>s.end<=startSeconds&&!segments.includes(s)).length,omittedAfter:all.filter(s=>s.start>=endSeconds&&!segments.includes(s)).length,omittedIntersecting:all.filter(s=>!segments.includes(s)&&s.end>startSeconds&&s.start<endSeconds).length,characters,withinLimits:segments.length>0&&segments.length<=200&&characters<=24000};return {...data,key:hash(data)};
}
export function transcriptPlannerInput(transcript:Transcript,durationSeconds:number,selected?:{startSeconds:number;endSeconds:number}):PlannerInput{
 const scope=selectTranscriptScope(transcript,durationSeconds,selected?.startSeconds,selected?.endSeconds);
 if(!scope.withinLimits)throw Error('Planner transcript exceeds safe scope; choose a smaller explicit interval');
 return {segments:scope.segments,durationSeconds,remainingFrames:2,round:1};
}
export function validateTranscriptDecision(mediaHash:string,transcript:Transcript,durationSeconds:number,raw:unknown,selected?:{startSeconds:number;endSeconds:number}):TranscriptDecision{
 const input=transcriptPlannerInput(transcript,durationSeconds,selected);
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['decision','rationale','sources','requests'].includes(k)))throw Error('Unsupported planner fields');
 const value=raw as any;
 if(!['frames','none','abstain'].includes(value.decision)||!safeText(value.rationale,1000)||!Array.isArray(value.sources)||value.sources.length>8||!Array.isArray(value.requests)||value.requests.length>2)throw Error('Invalid planner decision');
 const sources=value.sources.map((s:any)=>{const segment=input.segments.find(t=>t.id===s?.segmentId);if(!s||Object.keys(s).some(k=>!['segmentId','quote'].includes(k))||!segment||!safeText(s.quote,500)||!segment.text.includes(s.quote))throw Error('Planner source is not an exact transcript quote');return {segmentId:s.segmentId,quote:s.quote};});
 if(value.decision!=='frames'&&value.requests.length||value.decision==='frames'&&(!value.requests.length||!sources.length))throw Error('Planner decision/request mismatch');
 const plan=planVisualEvidence(mediaHash,transcript,durationSeconds,value.requests);
 for(const request of plan.requests){if(!['visual-reference','transcript-gap'].includes(request.reason)||!request.segmentIds.length||!request.segmentIds.every(id=>sources.some((s:any)=>s.segmentId===id)&&input.segments.some(s=>s.id===id&&request.timestampSeconds>=s.start&&request.timestampSeconds<=s.end)))throw Error('Planner frame has no exact source/timestamp window');}
 const data={decision:value.decision,rationale:value.rationale,sources,plan};return {...data,key:hash(data)};
}
