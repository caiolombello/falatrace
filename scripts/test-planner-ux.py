#!/usr/bin/env python3
"""Real Qt UI -> fixture bridge -> actual mock review/config modules. Offline, disposable HOME."""
from pathlib import Path
import runpy
import tempfile,subprocess,json,sys,hashlib,shutil,secrets
repo=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
binary=repo/'dist/desktop/recording-studio'
bun=shutil.which('bun') or str(Path.home()/'.bun/bin/bun')
source=(repo/'src/desktop/Main.qml').read_text()
assert binary.is_file(),'Build using existing native SDK first'
checks=[];screens=[]
with tempfile.TemporaryDirectory(dir='/tmp',prefix='falatrace-local-ux-') as temp:
 root=Path(temp);nonce=secrets.token_hex(16);(root/'.falatrace-qa').write_text(nonce);(root/'.falatrace-qa').chmod(0o600)
 for name in ['home','runtime','config','state','data','cache','tmp']:(root/name).mkdir(mode=0o700)
 video=root/'synthetic.mp4'
 subprocess.run(['/usr/bin/ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=5','-t','3','-an','-c:v','mpeg4',str(video)],check=True,capture_output=True,timeout=15)
 videoHash=hashlib.sha256(video.read_bytes()).hexdigest()
 for mode in ['real-plan-visible','real-plan-result','real-plan-none','real-plan-cancel','real-plan-compact']:
  folder=root/mode;folder.mkdir();config=folder/'config.json';before='{"future":{"synthetic":true},"obs":{"password":"synthetic-secret"}}' if mode!='onboarding-invalid' else '{invalid';config.write_text(before)
  receipt=folder/'bridge-receipt.json'
  bridge='''import GUARD_MODULE;
import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
import {MockFrameReview} from FRAME_MODULE;
import {prepareMockFramePreview} from PREVIEW_MODULE;
import {readOnboarding,saveLocalOnboarding} from CONFIG_MODULE;
import {parseRequest,handleRealFrameOperation} from BRIDGE_MODULE;
import {StudioVisualFlow} from REAL_MODULE;
import {readHeavyStatus} from HEAVY_MODULE;
import {DEFAULT_CONFIG} from DEFAULT_MODULE;
const flow=new MockFrameReview();const item={key:'synthetic-demo',title:'Exemplo sintético — UX local',fileName:'synthetic.mp4',modifiedAt:'2026-10-01T00:00:00Z',location:'local',status:'completed',backup:'none'};
const transcript={version:1,provider:'whisper-cpp',model:'synthetic',language:'pt',text:'Botão sintético à direita.',segments:[{start:0,end:3,text:'Botão sintético à direita.'}]};
let saves=0,operations=[],vision=0,summaries=0,planner=0;
const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl='http://127.0.0.1:11434';
const realFlow=new StudioVisualFlow(REAL_ROOT);const source={key:item.key,jobId:'synthetic-job',path:VIDEO_PATH,mediaHash:VIDEO_HASH,transcript,config};
globalThis.fetch=async(url,init)=>{
 if(new URL(String(url)).hostname!=='127.0.0.1')throw Error('Nonlocal fixture transport refused');const b=JSON.parse(String(init.body));
 if(new URL(String(url)).pathname==='/api/show')return MODE==='real-model-error'?new Response('',{status:404}):Response.json({model_info:{architecture:'synthetic'},capabilities:['vision','completion']});
 const input=JSON.parse(b.messages[1].content);
 if(input.segments){planner++;return Response.json({message:{content:JSON.stringify(MODE==='real-plan-none'?{decision:'none',rationale:'Áudio sintético suficiente; nenhum frame necessário.',sources:[],requests:[]}:{decision:'frames',rationale:'Verificar detalhe visual não descrito; proposta sintética, sem modelo real.',sources:[{segmentId:'s000000',quote:'Botão sintético à direita.'}],requests:[{timestampSeconds:1.2,reason:'visual-reference',question:'O que pode ser verificado neste instante?',segmentIds:['s000000']}]})}});}

 if(b.model==='vision-fixture'){vision++;const f=input.frames[0];return Response.json({message:{content:JSON.stringify({observations:[{frameFile:f.file,timestampSeconds:f.timestampSeconds,frameSha256:f.sha256,text:'Resposta do adapter via transporte stub: verificar o frame sintético.',uncertainty:'uncertain'}]})}});}
 summaries++;return Response.json({message:{content:JSON.stringify({title:'Resumo do transporte stub',overview:'Notas ligadas ao instante solicitado. Fixture sintética; modelo não executado.',topics:[],decisions:[],actionItems:[],citations:[],limitations:['Transporte stub; não valida qualidade de modelo.']})}});
};
for await(const line of createInterface({input:process.stdin})){
 let r;try{r=parseRequest(JSON.parse(line));operations.push(r.op);let value;
 switch(r.op){
 case 'list':value={items:[item]};break;
 case 'capture-status':value={active:false,paused:true,audio:{configured:false},warning:'Fixture offline; nenhuma captura real'};break;
 case 'processing-status':value=await readHeavyStatus();break;
 case 'jobs-list':value={items:[]};break;
 case 'ux-capabilities':value={mockFrames:!MODE.startsWith('real-'),realFrames:true};break;
 case 'detail':value={transcript:{...transcript,timing:'segment'},diarization:{state:'idle'},summary:'Fixture sem IA real.',status:'completed',backup:'none'};break;
 case 'resolve':value={state:'failed',message:'Playback não validado no fixture.'};break;
 case 'frames-check-models':value=await handleRealFrameOperation(realFlow,r,source);break;
 case 'frames-scope':case 'frames-plan':case 'frames-preview-plan':value=await handleRealFrameOperation(realFlow,r,source);break;
 case 'frames-preview':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}if(MODE==='frames-stale')await Bun.sleep(400);value=await prepareMockFramePreview(flow,r.key,VIDEO_PATH,VIDEO_HASH,transcript,r.payload.question,r.payload.seconds);break;
 case 'frames-confirm':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}value=await flow.confirm(r.key,r.payload.previewId,r.payload.consent);break;
 case 'frames-cancel':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}value=flow.cancel(r.key,r.payload.previewId);break;
 case 'onboarding-read':value=await readOnboarding(CONFIG_PATH);break;
 case 'onboarding-save-local':value=await saveLocalOnboarding(r.payload.revision,CONFIG_PATH);saves++;break;
 default:throw new Error('Operação recusada no fixture');
 }
 await writeFile(RECEIPT,JSON.stringify({mockCalls:flow.calls,saves,operations,vision,summaries,planner}));console.log(JSON.stringify({id:r.id,ok:true,result:value}));
 }catch(e){await writeFile(RECEIPT,JSON.stringify({mockCalls:flow.calls,saves,operations,vision,summaries,planner,error:String(e)}));console.log(JSON.stringify({id:r?.id||JSON.parse(line).id,ok:false,error:'Configuração/pedido recusado; fixture preservado.'}));}
}
'''
  for token,value in {'GUARD_MODULE':str(repo/'scripts/qa-isolation-guard.ts'),'HEAVY_MODULE':str(repo/'src/runtime/heavy-admission.ts'),'FRAME_MODULE':str(repo/'src/visual/review-flow.ts'),'PREVIEW_MODULE':str(repo/'src/visual/mock-preview.ts'),'VIDEO_PATH':str(video),'VIDEO_HASH':videoHash,'CONFIG_MODULE':str(repo/'src/config/onboarding.ts'),'BRIDGE_MODULE':str(repo/'src/desktop/bridge.ts'),'CONFIG_PATH':str(config),'RECEIPT':str(receipt),'MODE':mode,'REAL_MODULE':str(repo/'src/visual/studio-flow.ts'),'DEFAULT_MODULE':str(repo/'src/config/defaults.ts'),'REAL_ROOT':str(folder/'visual-state')}.items():bridge=bridge.replace(token,json.dumps(value))
  (folder/'bridge.ts').write_text(bridge)
  extra='''
 Timer { interval: 350; running: true; onTriggered: { window.lightTheme = true; ACTION } }
 Timer { interval: 650; running: true; onTriggered: { SECOND } }
 Timer { interval: 1100; running: true; onTriggered: { const a=[]; function check(name,pass){a.push({name:name,pass:!!pass})}; /*TEST_ASSERT*/; console.log("LOCAL_UX_ASSERTIONS "+JSON.stringify(a)) } }
'''
  action='framesDialog.open(); frameVisionModel.text="vision-fixture"; frameSummaryModel.text="summary-fixture"; send("frames-check-models",selected.key,{visionModel:frameVisionModel.text,summaryModel:frameSummaryModel.text})'
  second='scopeStart.text="0";scopeEnd.text="3";prepareTranscriptScope()'
  extra+='\n Timer { interval:1000; running:true; onTriggered:{ plannerTranscriptConsent.checked=true; planFrames() } }\n'
  assertion='check("plan and exact source visible before images",framePlan.decision==="frames" && framePlan.sources[0].quote==="Botão sintético à direita." && !framePreview.id && !frameResult.sourceKey)'
  extra=extra.replace('interval: 1100','interval: 3400')
  if mode=='real-plan-result':
   extra+='\n Timer { interval: 1550; running:true; onTriggered: previewPlannedFrames() }\n Timer { interval: 2350; running:true; onTriggered: { confirmFrames();confirmFrames() } }\n Timer { interval: 3050; running:true; onTriggered: { frameScroll.contentItem.contentY=Math.max(0,frameScroll.contentItem.contentHeight-frameScroll.availableHeight) } }\n'
   assertion='check("planner result stays separate from complete summary",frameResult.sourceKey && !frameResult.synthetic && detail.summary==="Fixture sem IA real." && detail.visualReview.summaryMarkdown.includes("Resumo do transporte stub"));check("source timestamp preserved",frameResult.timestampSeconds===1.2 && frameResult.observations[0].uncertainty==="uncertain")'
  elif mode=='real-plan-none':assertion='check("none leaves summary and sends no frames",framePlan.decision==="none" && framePlan.plan.requests.length===0 && !framePreview.id && !frameResult.sourceKey)'
  elif mode=='real-plan-cancel':
   second='plannerTranscriptConsent.checked=false'
   extra=extra.replace('plannerTranscriptConsent.checked=true; planFrames()', '')
   extra+='\n Timer { interval: 1200; running:true; onTriggered: { planFrames();framesDialog.reject() } }\n'
   assertion='check("planner unconsented/cancel closes without results",!framesDialog.visible && !framePlan.id && !framePreview.id && !frameResult.sourceKey)'
  elif mode=='real-plan-compact':
   action='window.width=900;window.height=640;'+action
   assertion+=';check("compact cancel and no overflow",frameCancelButton.visible && framesDialog.height<=window.height-64 && frameColumn.width<=frameScroll.availableWidth)'
  if mode in ['real-plan-visible','real-plan-compact','real-plan-none']:extra+='\n Timer { interval: 2000; running:true; onTriggered: { frameScroll.contentItem.contentY=300 } }\n'
  extra=extra.replace('ACTION',action).replace('SECOND',second).replace('/*TEST_ASSERT*/',assertion)
  qml=source.replace('../../docs/assets/',(repo/'docs/assets').as_uri()+'/').rstrip();(folder/'Main.qml').write_text(qml[:-1]+extra+'}\n')
  png=out/(mode+'.png')
  env={'FALATRACE_QA_ISOLATED':'1','FALATRACE_QA_ROOT':str(root),'FALATRACE_QA_NONCE':nonce,'XDG_CONFIG_HOME':str(root/'config'),'XDG_STATE_HOME':str(root/'state'),'XDG_DATA_HOME':str(root/'data'),'FALATRACE_HEAVY_PAUSE':'off','HOME':str(root/'home'),'XDG_RUNTIME_DIR':str(root/'runtime'),'XDG_CACHE_HOME':str(root/'cache'),'TMPDIR':str(root/'tmp'),'LANG':'C.UTF-8','PATH':'/usr/bin:/bin','QT_QPA_PLATFORM':'offscreen','QT_QUICK_BACKEND':'software','RECORDING_DESKTOP_SOFTWARE_SMOKE':'1','RECORDING_DESKTOP_SMOKE_KEY':'synthetic-demo','RECORDING_DESKTOP_SNAPSHOT':str(png),'RECORDING_DESKTOP_SNAPSHOT_MS':'3900'}
  runpy.run_path(str(repo/'scripts/qa-run.py'))['require_isolated'](env)
  result=subprocess.run([str(binary),str(folder),bun],env=env,capture_output=True,text=True,timeout=15)
  (out/(mode+'.stderr')).write_text(result.stderr)
  assert png.is_file() and 'ReferenceError' not in result.stderr and 'TypeError' not in result.stderr and 'Unable to assign' not in result.stderr and 'failed to load component' not in result.stderr,result.stderr
  for line in result.stderr.splitlines():
   if 'LOCAL_UX_ASSERTIONS ' in line:checks.extend(json.loads(line.split('LOCAL_UX_ASSERTIONS ',1)[1]))
  data=json.loads(receipt.read_text());assert data['mockCalls']==(1 if mode in ['frames-result','frames-reference','frames-compact'] else 0),data
  if mode.startswith('real-'):assert [data['vision'],data['summaries']]==([1,1] if mode in ['real-plan-result'] else [0,0]),data
  assert data['planner']==(0 if mode=='real-plan-cancel' else 1),data
  assert data['saves']==(1 if mode=='onboarding-saved' else 0),data
  if mode=='onboarding-saved':
   saved=json.loads(config.read_text());assert saved['future']=={'synthetic':True} and saved['obs']['password']=='synthetic-secret' and saved['processing']['autoEnqueue'] is False
  else:assert config.read_text()==before
  checks.append({'name':mode+' provider/save count and preservation','pass':True})
  screens.append({'mode':mode,'sha256':hashlib.sha256(png.read_bytes()).hexdigest(),'mockCalls':data['mockCalls'],'saves':data['saves'],'visionTransportCalls':data['vision'],'summaryTransportCalls':data['summaries'],'plannerTransportCalls':data['planner'],'exitCode':result.returncode})
assert checks and all(c['pass'] for c in checks),checks
final={'screens':screens,'assertions':checks,'actualQmlSha256':hashlib.sha256(source.encode()).hexdigest(),'realConfigModules':True,'studioFlowSha256':hashlib.sha256((repo/'src/visual/studio-flow.ts').read_bytes()).hexdigest(),'appBudgetSha256':hashlib.sha256((repo/'src/visual/app-budget.ts').read_bytes()).hexdigest(),'bridgeSha256':hashlib.sha256((repo/'src/desktop/bridge.ts').read_bytes()).hexdigest(),'mockOnly':False,'realAdapterWithStubTransport':True,'privateCapture':False,'networkProviderCalls':0,'limits':['Offscreen scripted input, no physical key events/playback/native capture/model quality','Demo-only MockFrameReview is session scoped; normal production flow uses the persistent common budget. All displayed model output here is HTTP-fixture data; no real model quality validated.']}
(out/'receipt.json').write_text(json.dumps(final,indent=2));print(json.dumps({'screens':len(screens),'assertions':len(checks),'passed':True}))
