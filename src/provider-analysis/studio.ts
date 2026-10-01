import {ProviderAnalysis} from './controller';
import {apiTransport} from './adapters';
import {defaultAnalysis,endpoints,validateAnalysis,validateProvider,type AnalysisOptions,type ProviderRecipient} from './contracts';
import {publicGrant} from '../agent-context/studio';
const runtimeEnabled=()=>process.env.FALATRACE_VISUAL_API_ENABLED==='1'&&process.env.FALATRACE_QA_ISOLATED!=='1';
export class ProviderStudio{
 private active=new Map<string,AbortController>();
 constructor(readonly analysis=new ProviderAnalysis(undefined,runtimeEnabled()?apiTransport(true):undefined)){}
 status(){return {implemented:true,available:runtimeEnabled(),reason:runtimeEnabled()?'Runtime enabled; credentials/capabilities/model access not verified':'API runtime disabled; credentials not inspected',destinations:endpoints,defaults:defaultAnalysis(),credentials:{openai:'OPENAI_API_KEY',google:'GEMINI_API_KEY'},modelDiscovery:'not run; select model and declare vision/JSON explicitly, verify access separately'};}
 async usage(){return this.analysis.ledger.snapshot();}
 async authorize(recordingId:string,input:{provider:'openai'|'google';model:string;consent:boolean;analysis:AnalysisOptions;context:boolean;maxFrames?:number;maxBytes?:number}){
  if(input.consent!==true)throw Error('Explicit provider/model/data/limits consent required');const recipient=validateProvider({kind:'provider',id:input.provider,endpoint:endpoints[input.provider],model:input.model,capabilities:{vision:true,json:true,source:'user-declared'}});
  validateAnalysis(input.analysis);const sources=await this.analysis.retrieval.catalog.snapshot([recordingId]);return publicGrant(await this.analysis.retrieval.access.authorize({consent:true,recipient,scope:{kind:'recordings',sources},data:input.context?['context','frames']:['frames'],limits:{maxFrames:input.maxFrames??2,maxBytes:input.maxBytes??2*1024*1024},analysis:input.analysis}));
 }
 cancel(grantId:string){this.active.get(grantId)?.abort(Error('Provider analysis cancelled'));return {cancelled:true};}
 async run(recording:()=>Promise<string>,input:{grantId:string;requestId:string;question:string;timestamps:number[]}){if(this.active.has(input.grantId))throw Error('Analysis already pending');const controller=new AbortController();this.active.set(input.grantId,controller);try{const recordingId=await recording();controller.signal.throwIfAborted();return await this.analysis.analyze({...input,recordingId},{signal:controller.signal});}finally{this.active.delete(input.grantId);}}
}
