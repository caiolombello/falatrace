import {ContextAccess} from './access';
import {RecordingCatalog} from './source';
import {AgentRetrieval} from './retrieval';
const flag=(args:string[],name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
export async function agentContextCli(args:string[]){
 const command=args[1],access=new ContextAccess(),catalog=new RecordingCatalog(),retrieval=new AgentRetrieval(access,catalog);
 const recipient={kind:'agent' as const,id:flag(args,'--recipient')||''};const grantId=flag(args,'--grant')||'';
 let result:unknown;
 if(command==='authorize-installation'){
  if(!args.includes('--include-future')||!args.includes('--exclude-secrets')||!args.includes('--consent'))throw Error('Explicit current/future scope and secret-exclusion acknowledgment required');
  const g=await access.authorize({consent:true,recipient,scope:{kind:'installation-recordings',sources:[],installation:{stateRootHash:access.installationId,includeFuture:true,excludeSecrets:true,deniedRecordings:[]}},data:['frames']});
  result=await import('./studio').then(m=>m.publicGrant(g));
 }else if(command==='exclude-recording'){result=await import('./studio').then(async m=>m.publicGrant(await access.exclude(grantId,flag(args,'--recording')||'')));
 }else if(command==='recordings'){result=await retrieval.recordings({grantId,recipient,offset:flag(args,'--offset')?Number(flag(args,'--offset')):undefined,limit:flag(args,'--limit')?Number(flag(args,'--limit')):undefined});
 }else if(command==='serve'){const {serveAgentFrames}=await import('./transport');await serveAgentFrames(grantId,recipient.id);return;}
 else if(command==='provider-status'){
  const {ProviderStudio}=await import('../provider-analysis/studio');const p=new ProviderStudio();result={...p.status(),usage:await p.usage()};
 }else if(command==='provider-authorize'){
  const {ProviderStudio}=await import('../provider-analysis/studio');const {validateAnalysis}=await import('../provider-analysis/contracts');
  const options=flag(args,'--options-json')||'';if(options.length>4096||!args.includes('--vision-json-declared'))throw Error('Bounded --options-json and explicit --vision-json-declared required; model access not verified');
  const ids=(flag(args,'--recordings')||'').split(',').filter(Boolean);if(ids.length!==1)throw Error('Select exactly one registered recording UUID');
  result=await new ProviderStudio().authorize(ids[0]!,{provider:flag(args,'--provider') as 'openai'|'google',model:flag(args,'--model')||'',analysis:validateAnalysis(JSON.parse(options)),context:args.includes('--context'),consent:args.includes('--consent')});
 }else if(command==='analyze-context'){
  const {ProviderStudio}=await import('../provider-analysis/studio');const p=new ProviderStudio();const abort=()=>p.cancel(grantId);process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{result=await p.run(async()=>flag(args,'--recording')||'',{grantId,requestId:flag(args,'--request')||'',question:flag(args,'--question')||'',timestamps:(flag(args,'--timestamps')||'').split(',').filter(Boolean).map(Number)});}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 }else if(command==='capabilities')result={...retrieval.capabilities(),providerAdapters:'implemented separately; provider-status reports runtime availability; agent grants never authorize API'};
 else if(command==='authorize'){
  const ids=(flag(args,'--recordings')||'').split(',').filter(Boolean);
  const sources=await catalog.snapshot(ids);
  const g=await access.authorize({consent:args.includes('--consent'),recipient,scope:{kind:'recordings',sources},data:(flag(args,'--data')||'frames').split(',') as Array<'context'|'frames'>});const {scope,...safe}=g;result={...safe,scope:{kind:scope.kind,recordingIds:scope.sources.map(s=>s.id)}};
 }else if(command==='status'){
  const g=await access.read(grantId);const {scope,...publicGrant}=g;result={...publicGrant,scope:{kind:scope.kind,recordingIds:scope.sources.map(s=>s.id),...(scope.installation?{includesFuture:true,excludedRecordingIds:scope.installation.deniedRecordings,identity:'local-launcher-binding-not-provider-authentication'}:{})}};
 }else if(['pause','resume','revoke'].includes(command||'')){
  const g=await access.change(grantId,command as 'pause'|'resume'|'revoke');result={id:g.id,paused:g.paused,revoked:g.revoked,revision:g.revision};
 }else if(command==='search'){result=await retrieval.search({grantId,recipient,query:flag(args,'--query'),limit:flag(args,'--limit')?Number(flag(args,'--limit')):undefined});
 }else if(command==='get-context'){result=await retrieval.getContext({grantId,recipient,recordingId:flag(args,'--recording')||'',query:flag(args,'--query'),offset:flag(args,'--offset')?Number(flag(args,'--offset')):undefined,maxCharacters:flag(args,'--max-characters')?Number(flag(args,'--max-characters')):undefined});
 }else if(command==='get-frames'){
  const controller=new AbortController();const abort=()=>controller.abort(Error('Frame retrieval cancelled'));process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{result=await retrieval.getFrames({grantId,recipient,recordingId:flag(args,'--recording')||'',timestamps:(flag(args,'--timestamps')||'').split(',').filter(Boolean).map(Number),supportsImages:args.includes('--client-vision')},{signal:controller.signal});}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 }else throw Error('agent-context: authorize-installation --recipient codex-openai|claude-anthropic|gemini-google --include-future --exclude-secrets --consent | recordings --grant UUID --recipient AGENT [--offset N] [--limit N] | exclude-recording --grant UUID --recording UUID | provider-status | provider-authorize --recordings UUID --provider openai|google --model MODEL --options-json JSON --vision-json-declared --consent [--context] | analyze-context --grant UUID --recording UUID --request UUID --question TEXT --timestamps SECONDS[,SECONDS] | capabilities | authorize --recordings UUID[,UUID] --recipient AGENT --consent | status/pause/resume/revoke --grant UUID | search/get-context --grant UUID --recipient AGENT | serve --grant UUID --recipient AGENT | get-frames --grant UUID --recipient AGENT --recording UUID --timestamps SECONDS[,SECONDS] --client-vision');
 console.log(JSON.stringify(result,null,2));
}
