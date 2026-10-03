import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { loadConfig } from "../config/load";
import { JobStore } from "../jobs/store";
import { validateJobId } from "../jobs/types";
import { RevisionConflictError } from "../revisions";
import { planReviewedSummary, regenerateReviewedSummary, readReviewedSummary, cancelReviewedSummary } from "../summary/reviewed";
import { buildRemovalPlan, validateRemovalPlan, getRemovalRoots, RemovalPlanConflictError, type RemovalPlan } from "../lifecycle/removal-plan";

export const REVIEWED_SNAPSHOT_HELP = `Reviewed snapshots (local; no implicit generation or removal):
  summary-review show <job-id>
  summary-review plan <job-id> --input <JSON with requestId, maxRequests>
  summary-review run <job-id> --input <JSON with requestId, consent:true, consentKey>
  summary-review cancel <job-id> --input <JSON with requestId>
  removal-plan show <job-id>
  removal-plan validate <job-id> --input <plan JSON>
Summary planning shows the exact revision, input and configured local Ollama destination.
Run requires that plan's explicit consent; real model quality remains unvalidated.
Removal plans are dry-run only: no purge, remote deletion or automatic new retention.
Exit codes: 0 success, 2 stale snapshot, 1 invalid/unavailable operation.
`;
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const parseReviewedSnapshotArgs = (args: string[]) => {
  const [command,action,id,...rest]=args;
  if(!id || !["summary-review","removal-plan"].includes(command||"") || rest.length>2 || rest.length%2 || rest.length&&(rest[0]!=="--input"||rest[1]!.length>2*1024*1024))throw Error("Invalid reviewed snapshot arguments");
  validateJobId(id);
  const hasInput=rest.length===2;
  if(command==="summary-review"&&(!["show","plan","run","cancel"].includes(action||"")||(action==="show"?hasInput:!hasInput)))throw Error("Read the current plan before an explicit summary run");
  if(command==="removal-plan"&&(!["show","validate"].includes(action||"")||(action==="show"?hasInput:!hasInput)))throw Error("Removal planning has show/validate only; no execution command");
  const input=hasInput?JSON.parse(rest[1]!):undefined;
  if(hasInput&&!object(input))throw Error("Expected JSON object");
  if(command==="summary-review"&&hasInput){
    const keys=action==="plan"?["requestId","maxRequests"]:action==="run"?["requestId","consent","consentKey"]:["requestId"];
    if(Object.keys(input).some(key=>!keys.includes(key))||typeof input.requestId!=="string"||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId))throw Error("Invalid explicit summary request");
    if(action==="plan"&&(!Number.isSafeInteger(input.maxRequests)||Number(input.maxRequests)<1||Number(input.maxRequests)>8))throw Error("Choose a provider-request budget between 1 and 8");
    if(action==="run"&&(input.consent!==true||typeof input.consentKey!=="string"||!/^[a-f0-9]{64}$/.test(input.consentKey)))throw Error("Current explicit summary consent is required");
  }
  return {command,action,id,input:input as Record<string,unknown>|undefined};
};
export const runReviewedSnapshotCli = async (args:string[]):Promise<void> => {
  try{
    const request=parseReviewedSnapshotArgs(args),store=new JobStore(),job=await store.get(request.id);
    let result:unknown;
    if(request.command==="summary-review"){
      if(request.action==="show")result=await readReviewedSummary(job) || {available:false,reason:"No summary bound to the current revision; no provider called"};
      else if(request.action==="cancel")result=await cancelReviewedSummary(job,String(request.input!.requestId));
      else{
        const {config}=await loadConfig();
        result=request.action==="plan"?await planReviewedSummary(job,{requestId:String(request.input!.requestId),maxRequests:Number(request.input!.maxRequests),config}):await regenerateReviewedSummary(job,{requestId:String(request.input!.requestId),config,consent:request.input!.consent===true,consentKey:String(request.input!.consentKey)});
      }
    }else{
      const {config}=await loadConfig(),root=resolve(config.recordingsDir.startsWith("~/")?join(homedir(),config.recordingsDir.slice(2)):config.recordingsDir);
      const current={job,roots:getRemovalRoots(root,store),reason:"manual" as const};
      if(request.action==="validate"){await validateRemovalPlan(request.input as unknown as RemovalPlan,current);result={valid:true,executable:false,mode:"dry-run"};}
      else result=await buildRemovalPlan(current);
    }
    console.log(JSON.stringify(result));
  }catch(error){
    const stale=error instanceof RevisionConflictError||error instanceof RemovalPlanConflictError;
    process.exitCode=stale?2:1;
    console.error(JSON.stringify({error:{code:stale?"snapshot-conflict":"invalid-or-unavailable",message:stale?"Snapshot changed; reread and obtain new explicit consent. Nothing was overwritten or removed.":"Operation unavailable. Check local configuration, source, request budget and explicit consent. No removal was executed."}}));
  }
};
