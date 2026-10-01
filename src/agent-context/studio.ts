import {ContextAccess,type Grant} from './access';
import {RecordingCatalog} from './source';
import {AgentRetrieval} from './retrieval';
import {loadConfig} from '../config/load';
export const publicGrant=(g:Grant)=>{const {scope,...safe}=g;return {...safe,scope:{kind:scope.kind,recordingIds:scope.sources.map(s=>s.id),...(scope.installation?{includesFuture:true,excludedRecordingIds:scope.installation.deniedRecordings,identity:'local-launcher-binding-not-provider-authentication'}:{})}};};
export class AgentStudio {
 private active=new Map<string,AbortController>();
 cancel(grantId:string){this.active.get(grantId)?.abort(Error('Studio frame request cancelled'));return {cancelled:true};}
 constructor(readonly access=new ContextAccess(),readonly catalog=new RecordingCatalog(),readonly retrieval=new AgentRetrieval(access,catalog)){}
 async status(recordingId:string){const {config}=await loadConfig();return {grants:(await this.access.list(recordingId)).map(publicGrant),budget:await this.retrieval.budget.snapshot(config.visualReview),capabilities:this.retrieval.capabilities(),providerAnalysis:await import('../provider-analysis/studio').then(async m=>{const p=new m.ProviderStudio();return {...p.status(),usage:await p.usage()};})};}
 async authorize(recordingId:string,recipientId:string,data:Array<'context'|'frames'>,consent:boolean){if(consent!==true)throw Error('Explicit one-time opt-in required');return publicGrant(await this.access.authorize({consent,recipient:{kind:'agent',id:recipientId},scope:{kind:'recordings',sources:await this.catalog.snapshot([recordingId])},data}));}
 async change(recordingId:string,grantId:string,action:'pause'|'resume'|'revoke'){const g=await this.access.read(grantId);if(g.scope.kind!=='installation-recordings'&&!g.scope.sources.some(s=>s.id===recordingId))throw Error('Recording outside opt-in scope');return publicGrant(await this.access.change(grantId,action));}
 async frames(recording:string|(()=>Promise<string>),grantId:string,timestamps:number[]){if(this.active.has(grantId))throw Error('Frame request already pending');const controller=new AbortController();this.active.set(grantId,controller);try{const recordingId=typeof recording==='function'?await recording():recording;controller.signal.throwIfAborted();const grant=await this.access.read(grantId);controller.signal.throwIfAborted();return await this.retrieval.getFrames({recordingId,grantId,recipient:grant.recipient,timestamps,supportsImages:true},{signal:controller.signal});}finally{this.active.delete(grantId);}}
}
