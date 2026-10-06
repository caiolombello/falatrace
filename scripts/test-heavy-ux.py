#!/usr/bin/env python3
"""Real Qt UI -> fixture bridge -> actual admission/preview coordinator, synthetic state and HTTP fixture. Offline, disposable HOME."""
from pathlib import Path
import runpy
import tempfile,subprocess,json,sys,hashlib,shutil,secrets
repo=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
from studio_fixture import require_studio_command,copy_qml_siblings
command=require_studio_command()
bun=shutil.which('bun') or str(Path.home()/'.bun/bin/bun')
source=(repo/'src/desktop/Main.qml').read_text()
checks=[];screens=[]
with tempfile.TemporaryDirectory(dir='/tmp',prefix='falatrace-local-ux-') as temp:
 root=Path(temp);nonce=secrets.token_hex(16);(root/'.falatrace-qa').write_text(nonce);(root/'.falatrace-qa').chmod(0o600)
 for name in ['home','runtime','config','state','data','cache','tmp']:(root/name).mkdir(mode=0o700)
 video=root/'synthetic.mp4'
 subprocess.run(['/usr/bin/ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=5','-t','3','-an','-c:v','mpeg4',str(video)],check=True,capture_output=True,timeout=15)
 videoHash=hashlib.sha256(video.read_bytes()).hexdigest()
 for mode in ['real-wait','real-wait-cancel']:
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
let saves=0,operations=[],vision=0,summaries=0;
const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl='http://127.0.0.1:11434';
const realFlow=new StudioVisualFlow(REAL_ROOT);const source={key:item.key,jobId:'synthetic-job',path:VIDEO_PATH,mediaHash:VIDEO_HASH,transcript,config};
globalThis.fetch=async(url,init)=>{
 if(new URL(String(url)).hostname!=='127.0.0.1')throw Error('Nonlocal fixture transport refused');const b=JSON.parse(String(init.body));
 if(new URL(String(url)).pathname==='/api/show')return MODE==='real-model-error'?new Response('',{status:404}):Response.json({model_info:{architecture:'synthetic'},capabilities:['vision','completion']});
 const input=JSON.parse(b.messages[1].content);
 if(b.model==='vision-fixture'){vision++;const f=input.frames[0];return Response.json({message:{content:JSON.stringify({observations:[{frameFile:f.file,timestampSeconds:f.timestampSeconds,frameSha256:f.sha256,text:'Resposta do adapter via transporte stub: verificar o frame sintético.',uncertainty:'uncertain'}]})}});}
 summaries++;return Response.json({message:{content:JSON.stringify({title:'Resumo do transporte stub',overview:'Notas ligadas ao instante solicitado. Fixture sintética; modelo não executado.',topics:[],decisions:[],actionItems:[],citations:[],limitations:['Transporte stub; não valida qualidade de modelo.']})}});
};
async function accept(line){
 let r;try{r=parseRequest(JSON.parse(line));operations.push(r.op);let value;
 switch(r.op){
 case 'list':value={items:[item]};break;
 case 'capture-status':value={active:true,paused:true,session:{startedAt:new Date().toISOString(),owner:'call',backend:'gpu-screen-recorder'},audio:{configured:false},warning:'Estado de captura sintético; nenhuma captura real'};break;
 case 'processing-status':value=await readHeavyStatus();break;
 case 'jobs-list':value={items:[]};break;
 case 'ux-capabilities':value={mockFrames:!MODE.startsWith('real-'),realFrames:true};break;
 case 'detail':value={transcript:{...transcript,timing:'segment'},diarization:{state:'idle'},summary:'Fixture sem IA real.',status:'completed',backup:'none'};break;
 case 'resolve':value={state:'failed',message:'Playback não validado no fixture.'};break;
 case 'frames-check-models':value=await handleRealFrameOperation(realFlow,r,source);break;
 case 'frames-preview':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}if(MODE==='frames-stale')await Bun.sleep(400);value=await prepareMockFramePreview(flow,r.key,VIDEO_PATH,VIDEO_HASH,transcript,r.payload.question,r.payload.seconds);break;
 case 'frames-confirm':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}value=await flow.confirm(r.key,r.payload.previewId,r.payload.consent);break;
 case 'frames-cancel':if(MODE.startsWith('real-')){value=await handleRealFrameOperation(realFlow,r,source);break;}value=flow.cancel(r.key,r.payload.previewId);break;
 case 'onboarding-read':value=await readOnboarding(CONFIG_PATH);break;
 case 'onboarding-save-local':value=await saveLocalOnboarding(r.payload.revision,CONFIG_PATH);saves++;break;
 default:throw new Error('Operação recusada no fixture');
 }
 await writeFile(RECEIPT,JSON.stringify({mockCalls:flow.calls,saves,operations,vision,summaries}));console.log(JSON.stringify({id:r.id,ok:true,result:value}));
 }catch(e){await writeFile(RECEIPT,JSON.stringify({mockCalls:flow.calls,saves,operations,vision,summaries,error:String(e)}));console.log(JSON.stringify({id:r?.id||JSON.parse(line).id,ok:false,error:'Configuração/pedido recusado; fixture preservado.'}));}
}
createInterface({input:process.stdin}).on('line',line=>void accept(line));
'''
  for token,value in {'GUARD_MODULE':str(repo/'scripts/qa-isolation-guard.ts'),'HEAVY_MODULE':str(repo/'src/runtime/heavy-admission.ts'),'FRAME_MODULE':str(repo/'src/visual/review-flow.ts'),'PREVIEW_MODULE':str(repo/'src/visual/mock-preview.ts'),'VIDEO_PATH':str(video),'VIDEO_HASH':videoHash,'CONFIG_MODULE':str(repo/'src/config/onboarding.ts'),'BRIDGE_MODULE':str(repo/'src/desktop/bridge.ts'),'CONFIG_PATH':str(config),'RECEIPT':str(receipt),'MODE':mode,'REAL_MODULE':str(repo/'src/visual/studio-flow.ts'),'DEFAULT_MODULE':str(repo/'src/config/defaults.ts'),'REAL_ROOT':str(folder/'visual-state')}.items():bridge=bridge.replace(token,json.dumps(value))
  (folder/'bridge.ts').write_text(bridge)
  extra='''
 Timer { interval: 350; running: true; onTriggered: { window.lightTheme = true; ACTION } }
 Timer { interval: 650; running: true; onTriggered: { SECOND } }
 Timer { interval: 1100; running: true; onTriggered: { const a=[]; function check(name,pass){a.push({name:name,pass:!!pass})}; /*TEST_ASSERT*/; console.log("LOCAL_UX_ASSERTIONS "+JSON.stringify(a)) } }
'''
  if mode.startswith('real-'):
   action='framesDialog.open(); frameVisionModel.text="vision-fixture"; frameSummaryModel.text="summary-fixture"; send("frames-check-models",selected.key,{visionModel:frameVisionModel.text,summaryModel:frameSummaryModel.text})'
   second='' if mode=='real-model-error' else 'frameSeconds.text="1.2"; prepareFrames()'
   assertion='check("real path preview has bound consent", !!framePreview.consentKey && framePreview.visionModel==="vision-fixture" && !frameResult.sourceKey)' if mode in ['real-preview','real-no-consent'] else 'check("real adapter result updates summary UI", frameResult.sourceKey && !frameResult.synthetic && detail.summary.includes("Resumo do transporte stub")); check("real timestamp exact",frameResult.timestampSeconds===1.2)' if mode in ['real-result','real-compact'] else 'check("real cancellation clears preview",!framesDialog.visible && !framePreview.id)' if mode=='real-cancel' else 'check("model missing error visible, no capability",!!uxError && !frameCapability.id)' if mode=='real-model-error' else 'check("real source reference exact",sourceReferenceSeconds===1.2 && !framesDialog.visible && notice.includes("00:01.200"))'
   if mode=='real-summary':assertion='check("summary visible after real adapter result",tabs.currentIndex===1 && !framesDialog.visible && contextArea.text.includes("Resumo do transporte stub"))'
   extra=extra.replace('interval: 1100','interval: 1900')
   third='confirmFrames(); confirmFrames()' if mode in ['real-result','real-compact','real-reference','real-summary'] else 'framesDialog.reject()' if mode=='real-cancel' else 'send("frames-confirm",selected.key,{previewId:framePreview.id,consent:false,consentKey:framePreview.consentKey})' if mode=='real-no-consent' else ''
   extra+='\n Timer { interval: 1100; running: true; onTriggered: { '+third+' } }\n'
   if mode in ['real-result','real-compact']:extra+='\n Timer { interval: 1700; running: true; onTriggered: { frameScroll.contentItem.contentY=Math.max(0,frameScroll.contentItem.contentHeight-frameScroll.availableHeight) } }\n'
   if mode=='real-summary':extra+='\n Timer { interval: 1650; running: true; onTriggered: { framesDialog.close(); tabs.currentIndex=1 } }\n'
   if mode=='real-reference':extra+='\n Timer { interval: 1650; running: true; onTriggered: followFrameReference() }\n'
   if mode=='real-compact':action='window.width=900; window.height=640; '+action;assertion+='; check("real compact cancel visible",framesDialog.height<=window.height-64 && frameCancelButton.visible && frameColumn.width<=frameScroll.availableWidth)'
  elif mode.startswith('frames-'):
   action='framesDialog.open(); frameSeconds.text="1.2"; prepareFrames()'
   second='confirmFrames(); confirmFrames()' if mode in ['frames-result','frames-reference','frames-compact'] else 'framesDialog.reject()' if mode=='frames-cancel' else 'backToLibrary()' if mode=='frames-stale' else ''
   assertion='check("preview ready without provider", !!framePreview.id && !frameResult.synthetic)' if mode=='frames-preview' else 'check("mock result has temporal reference", frameResult.synthetic && frameResult.timestampSeconds === 1.2); check("confirmation no longer pending", !hasPending("frames-confirm"))' if mode in ['frames-result','frames-reference','frames-compact'] else 'check("cancel closes and clears preview", !framesDialog.visible && !framePreview.id)' if mode=='frames-cancel' else 'check("stale preview discarded after Back", !selected.key && !framePreview.id && !framesDialog.visible)'
  else:
   action='onboardingDialog.open()'
   second='localChoice.checked=true; send("onboarding-save-local", "", {revision:onboardingDraft.revision})' if mode=='onboarding-saved' else 'onboardingDialog.reject()' if mode=='onboarding-cancel' else ''
   assertion='check("onboarding reads existing destination", onboardingDialog.visible && !!onboardingDraft.revision && !localChoice.checked)' if mode=='onboarding-view' else 'check("save completes without starting service", !onboardingDialog.visible && notice.includes("nenhum serviço"))' if mode=='onboarding-saved' else 'check("cancel closes draft", !onboardingDialog.visible && !onboardingDraft.revision)' if mode=='onboarding-cancel' else 'check("invalid config visible and saving blocked", !!uxError && !onboardingDraft.revision && !localChoice.enabled)'
  if mode=='frames-compact':action='window.width=900; window.height=640; '+action;assertion+='; check("compact dialog within viewport", framesDialog.height <= window.height-64); check("compact content fits width and Cancel remains visible", frameColumn.width <= frameScroll.availableWidth && frameCancelButton.visible)'
  if mode=='frames-reference':
   extra+='\n Timer { interval: 900; running: true; onTriggered: followFrameReference() }\n'
   assertion='check("reference points to exact source time", sourceReferenceSeconds === 1.2 && !framesDialog.visible && notice.includes("00:01.200"))'
  if mode.startswith('real-wait'):
   assertion='check("wait reason visible with zero preview/inference",processingWait.includes("gravação") && !framePreview.id && hasPending("frames-preview"))'
   extra=extra.replace('interval: 1900','interval: 2150')
   if mode=='real-wait-cancel':
    extra+='\n Timer { interval: 2250; running: true; onTriggered: framesDialog.reject() }\n Timer { interval: 2650; running: true; onTriggered: console.log("LOCAL_UX_ASSERTIONS "+JSON.stringify([{name:"cancel pending admission closes and clears preview",pass:!framesDialog.visible && !hasPending("frames-preview") && !framePreview.id && !processingWait}])) }\n'
  extra=extra.replace('ACTION',action).replace('SECOND',second).replace('/*TEST_ASSERT*/',assertion)
  qml=source.replace('../../docs/assets/',(repo/'docs/assets').as_uri()+'/').rstrip();(folder/'Main.qml').write_text(qml[:-1]+extra+'}\n');copy_qml_siblings(folder)
  png=out/(mode+'.png')
  state=folder/'state';managed=state/'recording-cli';managed.mkdir(parents=True)
  (managed/'recording-session.json').write_text(json.dumps({'version':1,'phase':'recording','id':'123e4567-e89b-42d3-a456-426614174000','owner':'manual','backend':'gpu-screen-recorder','startedAt':'2026-10-01T00:00:00Z','outputPath':str(video)}))
  env={'FALATRACE_QA_ISOLATED':'1','FALATRACE_QA_ROOT':str(root),'FALATRACE_QA_NONCE':nonce,'XDG_CONFIG_HOME':str(root/'config'),'XDG_DATA_HOME':str(root/'data'),'FALATRACE_HEAVY_PAUSE':'capture','XDG_STATE_HOME':str(state),'HOME':str(root/'home'),'XDG_RUNTIME_DIR':str(root/'runtime'),'XDG_CACHE_HOME':str(root/'cache'),'TMPDIR':str(root/'tmp'),'LANG':'C.UTF-8','PATH':'/usr/bin:/bin','QT_QPA_PLATFORM':'offscreen','QT_QUICK_BACKEND':'software','RECORDING_DESKTOP_SOFTWARE_SMOKE':'1','RECORDING_DESKTOP_SMOKE_KEY':'synthetic-demo','RECORDING_DESKTOP_SNAPSHOT':str(png),'RECORDING_DESKTOP_SNAPSHOT_MS':'2900'}
  runpy.run_path(str(repo/'scripts/qa-run.py'))['require_isolated'](env)
  result=subprocess.run([*command,str(folder),bun],env=env,capture_output=True,text=True,timeout=40)
  (out/(mode+'.stderr')).write_text(result.stderr)
  assert png.is_file() and 'ReferenceError' not in result.stderr and 'TypeError' not in result.stderr and 'Unable to assign' not in result.stderr and 'failed to load component' not in result.stderr,result.stderr
  for line in result.stderr.splitlines():
   if 'LOCAL_UX_ASSERTIONS ' in line:checks.extend(json.loads(line.split('LOCAL_UX_ASSERTIONS ',1)[1]))
  data=json.loads(receipt.read_text());assert data['mockCalls']==(1 if mode in ['frames-result','frames-reference','frames-compact'] else 0),data
  if mode.startswith('real-'):assert [data['vision'],data['summaries']]==([1,1] if mode in ['real-result','real-reference','real-compact','real-summary'] else [0,0]),data
  assert data['saves']==(1 if mode=='onboarding-saved' else 0),data
  if mode=='onboarding-saved':
   saved=json.loads(config.read_text());assert saved['future']=={'synthetic':True} and saved['obs']['password']=='synthetic-secret' and saved['processing']['autoEnqueue'] is False
  else:assert config.read_text()==before
  checks.append({'name':mode+' provider/save count and preservation','pass':True})
  screens.append({'mode':mode,'sha256':hashlib.sha256(png.read_bytes()).hexdigest(),'mockCalls':data['mockCalls'],'saves':data['saves'],'visionTransportCalls':data['vision'],'summaryTransportCalls':data['summaries'],'exitCode':result.returncode})
assert checks and all(c['pass'] for c in checks),checks
final={'screens':screens,'assertions':checks,'actualQmlSha256':hashlib.sha256(source.encode()).hexdigest(),'realConfigModules':True,'studioFlowSha256':hashlib.sha256((repo/'src/visual/studio-flow.ts').read_bytes()).hexdigest(),'appBudgetSha256':hashlib.sha256((repo/'src/visual/app-budget.ts').read_bytes()).hexdigest(),'bridgeSha256':hashlib.sha256((repo/'src/desktop/bridge.ts').read_bytes()).hexdigest(),'mockOnly':False,'realAdapterWithStubTransport':True,'privateCapture':False,'networkProviderCalls':0,'heavyAdmissionSha256':hashlib.sha256((repo/'src/runtime/heavy-admission.ts').read_bytes()).hexdigest(),'limits':['Offscreen scripted input, no physical key events/playback/native capture/model quality','Demo-only MockFrameReview is session scoped; normal production flow uses the persistent common budget. All displayed model output here is HTTP-fixture data; no real model quality validated.']}
(out/'receipt.json').write_text(json.dumps(final,indent=2));print(json.dumps({'screens':len(screens),'assertions':len(checks),'passed':True}))
