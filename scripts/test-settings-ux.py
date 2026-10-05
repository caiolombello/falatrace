#!/usr/bin/env python3
"""Render the actual QML settings dialog with a synthetic bridge; offline, disposable HOME.
No device, service, provider or configuration file outside the fixture is touched.
Exit 77 means the native desktop binary is unavailable.
"""
from pathlib import Path
import runpy, tempfile, subprocess, json, sys, hashlib, secrets
repo = Path(__file__).resolve().parents[1]
binary = repo / 'dist/desktop/recording-studio'
if not binary.is_file():
    print('Desktop binary missing; build with the existing SDK first.', file=sys.stderr); sys.exit(77)
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-settings-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; receipt = os.environ['FALATRACE_RECEIPT']
apps = [{'id':'slack','label':'Slack','kind':'app','defaultEnabled':True},{'id':'zen','label':'Zen','kind':'browser','defaultEnabled':True},
        {'id':'helium','label':'Helium','kind':'browser','defaultEnabled':True},{'id':'chromium','label':'Chromium','kind':'browser','defaultEnabled':True},
        {'id':'firefox','label':'Firefox','kind':'browser','defaultEnabled':True},{'id':'zoom','label':'Zoom','kind':'app','defaultEnabled':True},
        {'id':'discord','label':'Discord','kind':'app','defaultEnabled':False}]
values = {'callDetection.enabled': mode != 'first-run', 'callDetection.mode':'record', 'callDetection.enqueueOnStop':True,
          'callDetection.entryDebounceSeconds':5, 'callDetection.exitTimeoutSeconds':15,
          'callDetection.apps.slack':True,'callDetection.apps.zen':True,'callDetection.apps.helium':True,'callDetection.apps.chromium':True,
          'callDetection.apps.firefox':True,'callDetection.apps.zoom':True,'callDetection.apps.discord':False,
          'backend':'gpu-screen-recorder','recordingsDir':'/home/synthetic/Videos/Recordings','capture.audioSource':'both',
          'capture.microphone':'default','capture.desktop':'default','capture.profile':None,'capture.encoder':'gpu',
          'transcription.provider':'openai','transcription.language':'auto','transcription.openaiModel':'gpt-transcribe',
          'transcription.geminiModel':'gemini-3.5-transcribe','transcription.whisperCpp.command':'whisper-cli',
          'transcription.whisperCpp.modelPath':'/home/synthetic/model.bin','summary.provider':'openai','summary.ollamaUrl':'http://127.0.0.1:11434',
          'summary.ollamaModel':'qwen3.5:9b','summary.openaiModel':'gpt-6-luna','processing.defaultTarget':'local','processing.autoEnqueue':True}
revision = 'a' * 64
def settings(): return {'revision':revision,'exists':mode != 'first-run','values':values,'apps':apps,
    'readOnly':{'backendOutsideList':None,'obsEnabled':False,'remoteConfigured':False,'summaryLocal':False},
    'credentials':{'openai':'calls.env','gemini':'missing'}}
services = {'calls':{'installed':True,'enabled':True,'active':True,'outdated':False,'staleConfig':mode == 'services'},
            'tray':{'installed':True,'enabled':True,'active':True,'outdated':False,'staleConfig':False}}
log = []
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {})
    log.append({'op':op,'payload':p}); open(receipt,'w').write(json.dumps(log))
    if op == 'settings-read': v = settings()
    elif op == 'settings-diagnose':
        v = {'checks':[{'id':'ffmpeg','label':'FFmpeg','status':'ok','detail':'Encontrado.'},
                       {'id':'transcription-key','label':'Chave OPENAI_API_KEY','status':'ok','detail':'Chave definida em calls.env. O áudio é enviado para um serviço externo.'},
                       {'id':'summary-key','label':'Chave OPENAI_API_KEY','status':'ok','detail':'Chave definida em calls.env.'}],
             'audio':{'devices':[{'name':'alsa_input.synthetic-mic','description':'Microfone sintético','monitor':False},
                                 {'name':'alsa_output.synthetic.monitor','description':'Monitor sintético','monitor':True}],
                      'defaultMicrophone':'alsa_input.synthetic-mic','defaultDesktop':'alsa_output.synthetic.monitor'},
             'services':services,'recording':{'selectedBackend':'gpu-screen-recorder','blockedReason':None,'warnings':[],'session':None},
             'credentials':{'openai':'calls.env','gemini':'missing'}}
    elif op == 'settings-save':
        values.update(p['changes']); revision = 'b' * 64
        v = dict(settings(), saved=True, changed=list(p['changes']), backupCreated=True, cleanupPending=False, needsReload=False)
    elif op == 'settings-service':
        services['calls']['staleConfig'] = False; v = {'action':p['action'],'services':services}
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    elif op in ('list','list-cached','jobs-list'): v = {'items':[]}
    elif op == 'ux-capabilities': v = {'mockFrames':False,'realFrames':False}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
'''

# Each mode: (action at 600 ms, assertions at 1500 ms, snapshot ms)
MODES = {
    'first-run': ('', 'check("first run opens settings once", settingsDialog.visible && settingsFirstRun && settingsTabs.currentIndex===0); check("detection starts disabled", settingsDraft["callDetection.enabled"]===false); check("discord stays opt-in", settingsDraft["callDetection.apps.discord"]===false)'),
    'tab-calls': ('settingsDialog.open()', 'check("settings loaded", !!settingsData.revision && !settingsHasChanges()); check("no save without changes", !settingsEditable || !settingsHasChanges())'),
    'tab-capture': ('settingsDialog.open(); settingsTabs.currentIndex=1', 'check("devices listed from diagnose", settingsDeviceOptions(false).some(function(o){return o.value==="alsa_input.synthetic-mic"}) && settingsDeviceOptions(true).length===2)'),
    'tab-processing': ('settingsDialog.open(); settingsTabs.currentIndex=2', 'check("credential source shown, never value", settingsCredentialText(settingsData.credentials.openai)==="definida em calls.env")'),
    'services': ('settingsDialog.open(); settingsTabs.currentIndex=3', 'check("stale monitor flagged", settingsServiceStatus("calls")==="warning" && settingsServiceText("calls").indexOf("configuração anterior")>=0)'),
    'save': ('settingsDialog.open()', 'setSettingsField("callDetection.apps.discord", true); setSettingsField("backend", "audio"); check("diff has two changes", Object.keys(settingsChanges()).length===2); saveSettingsDraft()'),
    'compact': ('window.width=900; window.height=640; settingsDialog.open(); settingsTabs.currentIndex=0', 'check("dialog fits compact window", settingsDialog.width<=window.width && settingsDialog.height<=window.height)'),
    'discard': ('settingsDialog.open()', 'setSettingsField("callDetection.enabled", false); check("unsaved change counted", settingsHasChanges()); settingsDialog.reject(); check("discard closes and clears draft", !settingsDialog.visible && Object.keys(settingsDraft).length===0)'),
}
FOLLOW_UP = {
    'save': 'check("saved notice asks to apply monitor", settingsNotice.indexOf("Aplique o monitor")>=0 && !settingsHasChanges() && settingsData.revision==="' + 'b' * 64 + '")',
    'services': 'runSettingsService("calls-apply")',
}
FINAL = {
    'services': 'check("apply clears stale flag", settingsServiceStatus("calls")==="ok" && settingsNotice.indexOf("aplicado")>=0)',
}
checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-settings-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (action, assertion) in MODES.items():
        qml = root / mode; qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        follow = FOLLOW_UP.get(mode, ''); final = FINAL.get(mode, '')
        extra = f'''
 Timer {{ interval: 600; running: true; repeat: false; onTriggered: {{ {action} }} }}
 Timer {{ interval: 1500; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; {assertion}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}
 Timer {{ interval: 2300; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; {follow}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}
 Timer {{ interval: 3100; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; {final}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}
'''
        (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n')
        image = out / f'settings-{mode}.png'; receipt_path = root / f'{mode}-requests.json'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
               'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
               'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '3600',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_RECEIPT': str(receipt_path)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([str(binary), str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=25)
        (out / f'settings-{mode}.stderr').write_text(r.stderr)
        if not image.exists() or 'ReferenceError' in r.stderr or 'TypeError' in r.stderr or 'failed to load component' in r.stderr:
            raise SystemExit(f'Native QML failure: {mode}: ' + r.stderr[-4000:])
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
        if mode == 'save':
            saves = [q for q in requests if q['op'] == 'settings-save']
            checks.append({'name': 'save: bridge received exactly the diff', 'pass': len(saves) == 1 and saves[0]['payload']['changes'] == {'callDetection.apps.discord': True, 'backend': 'audio'} and saves[0]['payload']['revision'] == 'a' * 64})
        if mode not in ('save', 'services'):
            checks.append({'name': f'{mode}: no save or service request', 'pass': not any(q['op'] in ('settings-save', 'settings-service') for q in requests)})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'settings-receipt.json').write_text(json.dumps({'actualQmlSha256': hashlib.sha256(source.encode()).hexdigest(), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
