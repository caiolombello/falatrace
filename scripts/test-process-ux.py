#!/usr/bin/env python3
"""Render the Studio "Processar…" dialog against a synthetic bridge.

Offline and disposable: no media, provider, job store or configuration outside the
fixture is touched. Each mode selects one synthetic recording, drives the dialog with
timed actions and records every request the UI sent, so the journey proves the dialog
discloses destinations first and queues nothing without consent of that exact plan.
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, require_studio_command, runner_kind
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-process-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; receipt = os.environ['FALATRACE_RECEIPT']
status = 'completed' if mode == 'completed' else 'failed' if mode == 'retry' else 'unprocessed'
item = {'key':'/synthetic/Recordings/demo.mkv','title':'Gravação sintética','fileName':'demo.mkv','modifiedAt':'2026-10-05T12:00:00Z','location':'vaio','status':status,'backup':'none','sourceExists':True}
local = lambda kind: {'provider':'whisper-cpp' if kind == 't' else 'ollama','model':'ggml-large-v3-turbo-q5_0.bin' if kind == 't' else 'qwen3.5:9b',
                      'where':'Whisper.cpp neste computador' if kind == 't' else 'Ollama neste computador','external':False}
external = {'provider':'openai','model':'gpt-transcribe','where':'OpenAI, serviço externo','external':True}
plans = 0; log = []
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {})
    log.append({'op':op,'key':r.get('key',''),'payload':p}); open(receipt, 'w').write(json.dumps(log))
    if op in ('list', 'list-cached'): v = {'items':[item]}
    elif op == 'detail': v = {'transcript':{'segments':[],'text':'','timing':'none'},'diarization':{'state':'idle'},'status':status,'backup':'none'}
    elif op == 'recording-process-plan':
        plans += 1
        action = 'none' if mode == 'none' else 'retry' if mode == 'retry' else 'create'
        v = {'key':item['key'],'action':action,'reason':'O arquivo original não está neste computador.' if mode == 'none' else 'Esta gravação ainda não foi processada.',
             'durationSeconds':None if mode == 'none' else 1830,'target':'local','transcription':external if mode == 'external' else local('t'),'summary':local('s'),
             'consentKey':('c' if plans == 1 else 'd') * 64}
    elif op == 'recording-process':
        if mode == 'changed':
            print(json.dumps({'id':r['id'],'ok':False,'error':'A gravação ou as configurações mudaram. Revise o destino de novo.'}), flush=True); continue
        v = {'jobId':'223e4567-e89b-42d3-a456-426614174000','status':'queued','created':mode != 'retry'}
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    elif op == 'jobs-list': v = {'items':[]}
    elif op == 'processing-status': v = {'waiting':[]}
    elif op == 'ux-capabilities': v = {'mockFrames':False,'realFrames':False}
    elif op == 'settings-read': v = {'revision':'a'*64,'exists':True,'values':{},'apps':[],'nullable':[],'readOnly':{},'credentials':{'details':[]}}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
'''

SELECT = 'selectRecording(items[0])'
# mode: (action at 700 ms, step at 1500 ms, step at 2300 ms, step at 3100 ms)
MODES = {
    'local': (SELECT, 'check("button offered for an unprocessed recording", processButton.visible && processButton.enabled); processDialog.open()',
              'check("plan shows local destinations", processDialog.ready && !processDialog.external && processDialog.plan.transcription.where.indexOf("neste computador")>=0); '
              'check("running needs the consent box", !processDialog.processRun.enabled && processDialog.processConsent.visible); processDialog.processConsent.checked=true; '
              'check("consent enables running", processDialog.processRun.enabled); processDialog.run()',
              'check("dialog closes after queueing", !processDialog.visible); check("notice confirms the job", notice.indexOf("Processamento criado")>=0)'),
    'external': (SELECT, 'processDialog.open()',
                 'check("external destination is disclosed", processDialog.external && processDialog.plan.transcription.external); '
                 'check("warning names the external send", processDialog.ready); processDialog.close()',
                 'check("closing sends nothing", !processDialog.visible && !hasPending("recording-process"))'),
    'changed': (SELECT, 'processDialog.open()', 'processDialog.processConsent.checked=true; processDialog.run()',
                'check("changed plan keeps the dialog open with the reason", processDialog.visible && processDialog.error.indexOf("mudaram")>=0 && !processDialog.processConsent.checked && !processDialog.processRun.enabled); processDialog.load()'),
    'retry': (SELECT, 'check("button offered after a failure", processButton.visible); processDialog.open()',
              'check("retry is described", processDialog.plan.action==="retry" && processDialog.actionText().indexOf("Repetir")>=0)', ''),
    'none': (SELECT, 'processDialog.open()',
             'check("nothing to do hides consent and run", !processDialog.ready && !processDialog.processConsent.visible && !processDialog.processRun.enabled && processDialog.plan.reason.indexOf("original")>=0)', ''),
    'completed': (SELECT, 'check("no process button for a completed recording", !processButton.visible)', '', ''),
}
ALLOWED_RUNS = {'local': 1, 'changed': 1}

checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-process-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (action, first, second, third) in MODES.items():
        qml = root / mode; qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        def timer(ms, body):
            return (f' Timer {{ interval: {ms}; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; '
                    f'{body}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}\n')
        extra = '\n' + f' Timer {{ interval: 700; running: true; repeat: false; onTriggered: {{ {action} }} }}\n' + timer(1500, first) + timer(2300, second) + timer(3100, third)
        (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n'); copy_qml_siblings(qml)
        image = out / f'process-{mode}.png'; receipt_path = root / f'{mode}-requests.json'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
               'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
               'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '3600',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_RECEIPT': str(receipt_path)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=40)
        (out / f'process-{mode}.stderr').write_text(r.stderr)
        problems = [line for line in r.stderr.splitlines() if any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
        if not image.exists() or problems:
            raise SystemExit(f'QML failure: {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
        runs = [q for q in requests if q['op'] == 'recording-process']
        checks.append({'name': f'{mode}: recording-process sent only after consent', 'pass': len(runs) == ALLOWED_RUNS.get(mode, 0)
                       and all(q['payload'] == {'consent': True, 'consentKey': 'c' * 64} and q['key'] == '/synthetic/Recordings/demo.mkv' for q in runs)})
        if mode == 'changed':
            plans = [q for q in requests if q['op'] == 'recording-process-plan']
            checks.append({'name': 'changed: reviewing again asks for a fresh plan', 'pass': len(plans) == 2})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'process-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
