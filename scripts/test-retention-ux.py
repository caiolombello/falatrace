#!/usr/bin/env python3
"""Render the Studio library with recordings whose media the retention policy removed.

Offline and disposable: a synthetic bridge lists a transcript-only recording, an
audio-only one and one whose media is simply missing. The journey proves removed
media is never counted as needing attention, the player offers no "Abrir gravação"
for transcript-only media and the transcript stays readable.
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, qml_steps, require_assertion_lines, require_studio_command, runner_kind
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-retention-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

STUB = r'''#!/usr/bin/python3
import sys, json, os
receipt = os.environ['FALATRACE_RECEIPT']
base = {'modifiedAt':'2026-10-05T12:00:00Z','status':'completed','backup':'none','sourceExists':False,'artifactStatus':'Transcrição pronta · Resumo pronto'}
items = [
    {**base, 'key':'/synthetic/Recordings/removed.mkv','title':'Só transcrição','fileName':'removed.mkv','location':'transcript-only','media':'removed'},
    {**base, 'key':'/synthetic/Recordings/audio.mkv','title':'Só áudio','fileName':'audio.mkv','location':'audio-only','media':'audio-only'},
    {**base, 'key':'/synthetic/Recordings/missing.mkv','title':'Ausente','fileName':'missing.mkv','location':'missing','media':'missing'},
]
off = {'playback':False,'frames':False,'diarize':False,'speakersMic':False,'voices':False,'subtitles':False,'reprocess':False}
log = []
for line in sys.stdin:
    r = json.loads(line); op = r['op']
    log.append({'op':op,'key':r.get('key','')}); open(receipt, 'w').write(json.dumps(log))
    if op in ('list', 'list-cached'): v = {'items':items}
    elif op == 'detail': v = {'transcript':{'segments':[{'start':0,'end':2,'text':'Bom dia.'}],'text':'Bom dia.','timing':'segment'},'diarization':{'state':'idle'},
                              'status':'completed','backup':'none','media':{'state':'removed','removedAt':'2026-10-05T09:00:01.000Z','reason':'policy','features':off}}
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    elif op == 'jobs-list': v = {'items':[]}
    elif op == 'processing-status': v = {'waiting':[]}
    elif op == 'ux-capabilities': v = {'mockFrames':False,'realFrames':False}
    elif op == 'settings-read': v = {'revision':'a'*64,'exists':True,'values':{},'apps':[],'nullable':[],'readOnly':{},'credentials':{'details':[]}}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
'''

FIRST = ('check("removed and audio-only media are not counted as attention", libraryStats.total===3 && libraryStats.attention===1); '
         'check("origin labels: transcript-only has no media here, audio-only is here", origin("transcript-only")===t("Mídia indisponível") && origin("audio-only")===t("Neste computador")); '
         'selectRecording(items[1])')
SECOND = ('check("audio-only can still be opened", openRecordingButton.visible && !mediaGone(selected)); '
          'selectRecording(items[0])')
# The snapshot is taken after this step: it shows the transcript-only recording.
THIRD = ('check("transcript-only offers no player", !openRecordingButton.visible && mediaGone(selected)); '
         'check("transcript stays readable", !!detail.transcript && detail.transcript.segments.length===1)')

checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-retention-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    qml = root / 'library'; qml.mkdir()
    base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
    def timer(body):
        return (f'const a=[]; function check(name,pass){{a.push({{name:name,pass:!!pass}})}}; '
                f'{body}; console.log("UX_ASSERTIONS "+JSON.stringify(a))')
    # Each step waits for the replies it depends on (bounded): the library, then each selection's detail.
    extra = qml_steps([(900, 'items.length === 3 && !hasPending("list")', timer(FIRST)), (1700, '!detailLoading', timer(SECOND)),
                       (2500, '!detailLoading', timer(THIRD))], 500)
    (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n'); copy_qml_siblings(qml)
    image = out / 'retention-library.png'; receipt_path = root / 'requests.json'
    env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
           'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
           'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
           'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
           'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
           'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '8000', 'FALATRACE_RECEIPT': str(receipt_path)}
    runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
    r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=40)
    (out / 'retention-library.stderr').write_text(r.stderr)
    problems = [line for line in r.stderr.splitlines() if any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
    require_assertion_lines(r.stderr, 'UX_ASSERTIONS ', 3, 'library')
    if not image.exists() or problems:
        raise SystemExit('QML failure: ' + ('\n'.join(problems) or r.stderr[-4000:]))
    for line in r.stderr.splitlines():
        if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
    requests = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
    checks.append({'name': 'nothing tries to play or process removed media', 'pass': not any(q['op'] in ('resolve', 'recording-process', 'recording-process-plan') for q in requests)})
    screens.append({'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'retention-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or len(checks) < 6: sys.exit(1)
