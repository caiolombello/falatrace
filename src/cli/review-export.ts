import { JobStore } from "../jobs/store";
import { readReviewedView, saveRevision, undoRevision, RevisionConflictError, type RevisionSaveInput, type RevisionUndoInput } from "../revisions";
import { previewExport, saveExport } from "../export";

export const REVIEW_EXPORT_HELP = `Local human review (JSON; no provider calls):
  review show <job-id>
  review apply <job-id> --input <JSON with expectedRevision, base, operations>
  review undo <job-id> --input <JSON with expectedRevision, base>
  export preview <job-id> --format <json|markdown|srt|vtt> --track <transcript|diarization>
  export save <job-id> --format <...> --track <...> --input <JSON with expectedRevision, expectedBase, expectedSnapshotSha256>
Read the current review/preview first. Saves reject stale revisions, preserve originals,
and write private local files. No automatic model or alignment is requested.
Exit codes: 0 success, 2 stale revision, 1 invalid/unavailable operation.
`;

export const parseReviewExportArgs = (args: string[]) => {
  const [command, action, id, ...rest] = args;
  if (!["review", "export"].includes(command || "") || !id || rest.length > 12 || rest.length % 2) throw new Error("Invalid local review/export arguments");
  const flags: Record<string,string> = {};
  const allowed=command==="review"?["--input"]:["--input","--format","--track"];
  for(let i=0;i<rest.length;i+=2) {
    const key=rest[i]!,value=rest[i+1]!;
    if(!allowed.includes(key)||Object.prototype.hasOwnProperty.call(flags,key)||value.length>65536)throw new Error("Invalid local review/export option");
    flags[key]=value;
  }
  const hasInput=Object.prototype.hasOwnProperty.call(flags,"--input");
  if(command==="review"&&(!["show","apply","undo"].includes(action||"")||(action==="show"?hasInput:!hasInput)))throw new Error("Use review show, apply or undo with an explicit current revision");
  if(command==="export"&&(!["preview","save"].includes(action||"")||(action==="save"?!hasInput:hasInput)||!["json","markdown","srt","vtt"].includes(flags["--format"]||"")||!["transcript","diarization"].includes(flags["--track"]||"")))throw new Error("Choose export format and source track explicitly; save requires the preview revision");
  let input:unknown;
  if(hasInput){input=JSON.parse(flags["--input"]!);if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid local revision input");}
  if(command==="review"&&hasInput){
    const body=input as Record<string,unknown>,keys=action==="apply"?["expectedRevision","base","operations"]:["expectedRevision","base"];
    if(Object.keys(body).some(key=>!keys.includes(key))||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0||!body.base||typeof body.base!=="object"||Array.isArray(body.base)||(action==="apply"&&(!Array.isArray(body.operations)||body.operations.length<1||body.operations.length>64)))throw new Error("An edit requires explicit bounded operations; undo is a separate command");
  }
  return {command,action,id,format:flags["--format"] as "json"|"markdown"|"srt"|"vtt",track:flags["--track"] as "transcript"|"diarization",input};
};

export const runReviewExportCli = async (args:string[]):Promise<void> => {
  try {
    const request=parseReviewExportArgs(args),job=await new JobStore().get(request.id);
    let result:unknown;
    if(request.command==="review") {
      result=request.action==="show"?await readReviewedView(job):request.action==="apply"?await saveRevision(job,request.input as RevisionSaveInput):await undoRevision(job,request.input as RevisionUndoInput);
    } else if(request.action==="preview") {
      result=await previewExport(job,{format:request.format,track:request.track});
      if((result as {available?:boolean}).available===false)process.exitCode=1;
    } else {
      const input=request.input as {expectedRevision:number;expectedBase:RevisionUndoInput["base"];expectedSnapshotSha256:string};
      if(Object.keys(input).some(key=>!["expectedRevision","expectedBase","expectedSnapshotSha256"].includes(key)))throw new Error("Invalid export revision input");
      result=await saveExport(job,{format:request.format,track:request.track,...input});
    }
    console.log(JSON.stringify(result,null,2));
  } catch(error) {
    const conflict=error instanceof RevisionConflictError;
    console.error(JSON.stringify({error:{code:conflict?"revision-conflict":"local-operation-unavailable",message:conflict?"Origin or revision changed; read it again before saving.":"Local operation unavailable. Check arguments, explicit source/revision and private storage; no provider was called."}}));
    process.exitCode=conflict?2:1;
  }
};
