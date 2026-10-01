#!/usr/bin/env python3
"""Render the actual QML with a synthetic protocol stub; never access devices or providers.
Requires a locally built desktop binary and existing Qt runtime. No runtime installation.
Exit 77 means native runtime unavailable. Video playback and OS keyboard events are unverified.
"""
from pathlib import Path
import runpy
import tempfile,subprocess,os,json,sys,hashlib,shutil,secrets
repo=Path(__file__).resolve().parents[1]
binary=repo/'dist/desktop/recording-studio'
if not binary.is_file():
 print('Desktop binary missing; explicitly build with existing SDK first.',file=sys.stderr);sys.exit(77)
out=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(tempfile.mkdtemp(dir='/tmp',prefix='falatrace-ui-output-'))
out.mkdir(parents=True,exist_ok=True)
source=(repo/'src/desktop/Main.qml').read_text()
checks=[];screens=[]
with tempfile.TemporaryDirectory(dir='/tmp',prefix='falatrace-ui-fixture-') as scratch:
 root=Path(scratch);nonce=secrets.token_hex(16);(root/'.falatrace-qa').write_text(nonce);(root/'.falatrace-qa').chmod(0o600)
 for name in ['home','runtime','config','state','data','cache','tmp']:(root/name).mkdir(mode=0o700)
 video=root/'synthetic.mp4'
 subprocess.run(['/usr/bin/ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=5','-t','3','-an','-c:v','mpeg4',str(video)],check=True,capture_output=True,timeout=15)
 stub=root/'bridge-stub.py'
 stub.write_text('''#!/usr/bin/python3
import sys,json,os,datetime
mode=os.environ['FALATRACE_TEST_MODE']
item={'key':'synthetic-demo','title':'Exemplo sintético — revisão de interface','fileName':'synthetic.mp4','modifiedAt':'2026-09-30T12:00:00Z','location':'local','status':'completed','backup':'none'}
for line in sys.stdin:
 r=json.loads(line);op=r['op']
 if op=='list':
  if mode=='loading':continue
  if mode=='error':print(json.dumps({'id':r['id'],'ok':False,'error':'Falha sintética. Dados preservados; use Reconectar.'}),flush=True);continue
  v={'items':[] if mode=='empty' else [item]}
 elif op=='capture-status':v={'active':mode=='recording','session':{'startedAt':(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=128)).isoformat()} if mode=='recording' else None,'paused':mode=='paused','audio':{'configured':False},'warning':'Fixture sintético: nenhuma captura ou dispositivo real'}
 elif op=='jobs-list':v={'items':[]}
 elif op=='detail':v={'transcript':{'segments':[{'start':0,'end':2,'text':'Este texto foi criado para testar a interface.'}],'text':'Este texto foi criado para testar a interface.','timing':'segment'},'diarization':{'state':'idle','turns':[]},'summary':'Nota sintética em [00:00]. Não houve inferência de IA. Confira a fonte.','summaryInfo':'adapter scripted/local fixture','status':'completed','backup':'none','jobId':'synthetic-demo'}
 elif op=='resolve' and mode not in ['error','loading']:v={'state':'completed','location':'local','path':os.environ['FALATRACE_SYNTHETIC_VIDEO']}
 elif op=='context-meeting':v={'context':'STALE-CONTEXT-MUST-NOT-APPEAR','citations':['00:00']}
 else:print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture; nenhuma captura iniciada.'}),flush=True);continue
 print(json.dumps({'id':r['id'],'ok':True,'result':v}),flush=True)
''');stub.chmod(0o700)
 for mode in ['dark','light','compact','summary','consent','empty','error','loading','recording','paused','regression']:
  qml=root/mode;qml.mkdir()
  base=source.replace('../../docs/assets/',(repo/'docs/assets').as_uri()+'/').rstrip()
  light='true' if mode in ['light','compact'] else 'false'
  action='captureConsent.open()' if mode=='consent' else 'tabs.currentIndex = 1' if mode=='summary' else ''
  if mode=='compact':action+='; window.width = 900; window.height = 640'
  extra=f'\n Timer {{ interval: 350; running: true; repeat: false; onTriggered: {{ window.lightTheme = {light}; {action} }} }}\n'
  if mode=='regression':extra+='''
 Timer { interval: 450; running: true; repeat: false; onTriggered: {
  const a=[]; function check(name,pass){a.push({name:name,pass:!!pass})}
  check("synthetic backend available", backend.available)
  check("synthetic selection", selected.key === "synthetic-demo")
  contextCopyText="old-copy"; selectRecording(selected); check("copy cleared on selection", contextCopyText === "")
  captureConsent.open(); check("consent modal", captureConsent.visible && captureConsent.modal)
  check("dialog never starts capture", !hasPending("capture-start") && !captureBusy)
  captureConsent.reject(); check("cancel closes consent", !captureConsent.visible && !captureBusy)
  search.forceActiveFocus(); check("editing excludes player shortcuts", textHasFocus)
  requestMeetingContext(); const other=Object.assign({},selected);other.key="synthetic-other";selectRecording(other)
  console.log("UX_ASSERTIONS "+JSON.stringify(a))
 } }
 Timer { interval: 900; running: true; repeat: false; onTriggered: {
  const a=[{name:"stale context discarded",pass:selected.key === "synthetic-other" && contextText === "" && contextCopyText === "" && !contextLoading}]
  backToLibrary(); a.push({name:"back clears selected and focuses search",pass:!selected.key && search.activeFocus && !mediaReady})
  console.log("UX_ASSERTIONS "+JSON.stringify(a))
 } }
'''
  (qml/'Main.qml').write_text(base[:-1]+extra+'}\n')
  image=out/f'studio-{mode}.png'
  env={'FALATRACE_QA_ISOLATED':'1','FALATRACE_QA_ROOT':str(root),'FALATRACE_QA_NONCE':nonce,'XDG_CONFIG_HOME':str(root/'config'),'XDG_STATE_HOME':str(root/'state'),'XDG_DATA_HOME':str(root/'data'),'HOME':str(root/'home'),'XDG_RUNTIME_DIR':str(root/'runtime'),'XDG_CACHE_HOME':str(root/'cache'),'TMPDIR':str(root/'tmp'),'LANG':'C.UTF-8','PATH':'/usr/bin:/bin','QT_QPA_PLATFORM':'offscreen','QT_QUICK_BACKEND':'software','RECORDING_DESKTOP_SOFTWARE_SMOKE':'1','RECORDING_DESKTOP_SMOKE_KEY':'synthetic-demo' if mode not in ['empty','error','loading'] else '', 'RECORDING_DESKTOP_SNAPSHOT':str(image),'RECORDING_DESKTOP_SNAPSHOT_MS':'1300','FALATRACE_TEST_MODE':mode,'FALATRACE_SYNTHETIC_VIDEO':str(video)}
  runpy.run_path(str(repo/'scripts/qa-run.py'))['require_isolated'](env)
  r=subprocess.run([str(binary),str(qml),str(stub)],env=env,capture_output=True,text=True,timeout=15)
  (out/f'studio-{mode}.stderr').write_text(r.stderr)
  receipt=json.loads(Path(str(image)+'.json').read_text()) if Path(str(image)+'.json').exists() else {}
  if not receipt.get('snapshot') or 'ReferenceError' in r.stderr or 'failed to load component' in r.stderr:raise SystemExit(f'Native QML failure: {mode}: '+r.stderr)
  for line in r.stderr.splitlines():
   if 'UX_ASSERTIONS ' in line:checks.extend(json.loads(line.split('UX_ASSERTIONS ',1)[1]))
  screens.append({'mode':mode,'file':image.name,'sha256':hashlib.sha256(image.read_bytes()).hexdigest(),'snapshot':True,'exitCode':r.returncode,'mediaReady':receipt.get('mediaReady')})
 if not checks or any(not c['pass'] for c in checks):raise SystemExit('Native assertion failed: '+json.dumps(checks))
receipt={'actualQmlSha256':hashlib.sha256(source.encode()).hexdigest(),'assertions':checks,'screens':screens,'platform':'Qt offscreen software','syntheticBackend':True,'captureStarted':False,'productModelCalls':0,'limits':['Timer instrumentation, not OS key events','No physical screen/microphone/real services','Video decoding and playback unverified; combined existing snapshot exit may be5']}
(out/'ui-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'screens':len(screens),'assertionsPassed':len(checks),'output':str(out)}))
