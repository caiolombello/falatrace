/** Deterministic pipeline demonstration. Does not capture a display/device or call a model. */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "../src/jobs/command";
import { hashFile } from "../src/jobs/store";
import { processJob } from "../src/jobs/pipeline";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { JobManifest, Transcript } from "../src/jobs/types";
import type { LocalVisualAdapter } from "../src/visual/session";
const output=process.argv[2];
if(!output)throw new Error("Pass a new synthetic output directory");
const root=resolve(output);
// A new directory prevents replacing an operator's files. No capture inputs are accepted.
await fs.mkdir(root,{mode:0o700});
const source=join(root,"synthetic.mp4");
await runCommand("ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","testsrc2=size=640x360:rate=10","-t","3","-c:v","mpeg4","-y",source]);
const hash=await hashFile(source);
const transcript:Transcript={version:1,provider:"whisper-cpp",model:"scripted-fixture",language:"pt",text:"Veja o gráfico sintético. Revisar antes de publicar.",segments:[{start:0,end:1.5,text:"Veja o gráfico sintético."},{start:1.5,end:3,text:"Revisar antes de publicar."}]};
await fs.writeFile(join(root,"transcript.json"),JSON.stringify(transcript),{mode:0o600});
const manifest:JobManifest={version:1,id:"123e4567-e89b-42d3-a456-426614174000",createdAt:"2026-09-30T00:00:00Z",source:{originalName:"synthetic.mp4",mediaFile:"source.mp4",size:(await fs.stat(source)).size,sha256:hash},transcription:{provider:"whisper-cpp",model:"scripted-fixture",language:"pt"},summary:{provider:"ollama",model:"scripted-summary"}};
let selections=0,inspections=0,summaries=0;
const adapter:LocalVisualAdapter={identity:"scripted-demo-no-model",localOnly:true,
 select:async()=>{selections++;return [{timestampSeconds:1,reason:"visual-reference",question:"O frame contém somente um padrão de teste?",segmentIds:["s000000"]}];},
 inspect:async input=>{inspections++;return input.frames.map(frame=>({frameFile:frame.file,timestampSeconds:frame.timestampSeconds,frameSha256:frame.sha256,text:"Observação roteirizada: o vídeo foi gerado com testsrc2. Não é resposta de IA.",uncertainty:"uncertain"}));}};
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input,init)=>{
 const url=new URL(String(input));
 if(url.origin!=="http://127.0.0.1:11434"||url.pathname!=="/api/chat")throw new Error("Unexpected request in synthetic demo");
 const payload=JSON.parse(String(init?.body));if(payload.model!=="scripted-summary")throw new Error("Unexpected provider/model");summaries++;
 return Response.json({message:{content:JSON.stringify({title:"DEMO SINTÉTICA — sem inferência",overview:"Revisar antes de publicar.",topics:["Fixture gerada localmente"],decisions:[],actionItems:[],citations:[{section:"overview",index:0,segmentIds:["s000001"],uncertainty:"uncertain"}],limitations:["Transcrição e respostas roteirizadas; nenhum modelo ou transcrição automática foi executado."]})}});
}) as typeof fetch;
try {
 await processJob(structuredClone(DEFAULT_CONFIG),manifest,source,root,{visual:{root:join(root,"visual-sessions"),adapter,ttlSeconds:60}});
 await processJob(structuredClone(DEFAULT_CONFIG),manifest,source,root,{visual:{root:join(root,"visual-sessions"),adapter,ttlSeconds:60}});
 if(selections!==1||inspections!==1||summaries!==1||await hashFile(source)!==hash)throw new Error("Demo reuse/source preservation failed");
 await fs.writeFile(join(root,"demo-receipt.json"),JSON.stringify({scope:"synthetic generated video; scripted transcript and adapters; no model/capture/device",durationSeconds:3,mediaSha256:hash,scriptedSelectionCalls:selections,scriptedInspectionCalls:inspections,scriptedSummaryCalls:summaries,retriesReusedCheckpoints:true,actualModelRequests:0,screenCapture:false,microphoneCapture:false},null,2),{mode:0o600});
 console.log(JSON.stringify({status:"passed",actualModelRequests:0,screenCapture:false,microphoneCapture:false,retriesReusedCheckpoints:true}));
} finally {globalThis.fetch=originalFetch;}
