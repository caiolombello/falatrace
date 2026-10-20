#!/usr/bin/env python3
"""Speaker name suggestions in the actual Studio QML, against a synthetic bridge.

Checks the Speakers tab: each suggestion shows its source, "Use" opens the review
prefilled, "Apply suggestions" sends a single human revision for the speakers still
without a name, and the request dialog sends the conversation only with consent
bound to the destination it shows. No provider, media, device or real bridge.
Timer instrumentation, not OS key events. Exit 77 without a Studio runtime.
"""
from pathlib import Path
import hashlib
import json
import runpy
import secrets
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, require_studio_command, runner_kind  # noqa: E402

command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-speakers-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

JOB = '123e4567-e89b-42d3-a456-426614174042'
CONSENT_KEY = 'b' * 64
BASE = {'jobId': JOB, 'mediaSha256': 'a' * 64, 'transcriptArtifactSha256': 'c' * 64, 'diarizationSha256': 'd' * 64}
TURNS = [
    {'id': 't000000', 'start': 0, 'end': 4, 'speaker': 'S01', 'label': 'Falante 1', 'humanSpeakerEdited': False, 'text': 'Bom dia. Ana, pode começar?'},
    {'id': 't000001', 'start': 4, 'end': 8, 'speaker': 'S02', 'label': 'Falante 2', 'humanSpeakerEdited': False, 'text': 'Claro, aqui é a Ana.'},
    {'id': 't000002', 'start': 8, 'end': 12, 'speaker': 'S03', 'label': 'Falante 3', 'humanSpeakerEdited': False, 'text': 'Certo, seguimos.'},
]
DETAIL = {
    'transcript': {'segments': [{'start': 0, 'end': 12, 'text': 'Bom dia. Ana, pode começar? Claro, aqui é a Ana. Certo, seguimos.'}], 'text': 'Bom dia. Ana, pode começar? Claro, aqui é a Ana. Certo, seguimos.', 'timing': 'segment'},
    'diarization': {'state': 'review', 'speakerCount': 3, 'matchedTokenRatio': 1, 'message': 'Identificação automática; revise as trocas de voz. A transcrição original foi preservada.', 'turns': TURNS},
    'review': {'revision': {'version': 1, 'revision': 0, 'base': BASE, 'humanReviewed': False}, 'canUndo': False, 'notes': [], 'derivedStale': False,
               'speakerLabels': {'S01': 'Falante 1', 'S02': 'Falante 2', 'S03': 'Falante 3'}, 'segmentEditUnavailable': False},
    'speakerSuggestions': {
        'state': 'ready', 'message': 'Sugestões prontas. Nada muda até você aplicar ou salvar um nome.',
        'items': [
            {'speakerId': 'S01', 'source': 'microphone', 'self': True, 'name': 'Caio Barbieri', 'localShare': 0.97},
            {'speakerId': 'S02', 'source': 'conversation', 'self': False, 'name': 'Ana', 'evidence': [{'turnId': 't000001', 'quote': 'aqui é a Ana'}]},
        ],
        'microphone': {'state': 'ready'},
        'conversation': {'state': 'ready', 'provider': 'openai', 'model': 'gpt-6-luna', 'external': True, 'generatedAt': '2026-10-20T12:00:00Z', 'partial': False, 'sentTurns': 3, 'totalTurns': 3},
        'destination': {'provider': 'openai', 'model': 'gpt-6-luna', 'endpoint': 'https://api.openai.com', 'external': True, 'consentKey': CONSENT_KEY},
    },
    'summary': '', 'status': 'completed', 'backup': 'none', 'jobId': JOB, 'diarizationId': JOB,
}

STUB = '''#!/usr/bin/python3
import sys,json,os
mode=os.environ['FALATRACE_TEST_MODE'];log=open(os.environ['FALATRACE_REQUEST_LOG'],'a')
detail=json.loads(os.environ['FALATRACE_DETAIL'])
item={'key':'synthetic-speakers','title':'Exemplo sintético — falantes','fileName':'synthetic.mkv','modifiedAt':'2026-10-20T12:00:00Z','location':'local','status':'completed','backup':'none'}
for line in sys.stdin:
 r=json.loads(line);op=r['op'];log.write(line.strip()+'\\n');log.flush()
 if op=='list':v={'items':[item]}
 elif op=='capture-status':v={'active':False,'session':None,'paused':False,'audio':{'configured':False}}
 elif op=='jobs-list':v={'items':[]}
 elif op=='list-cached':v={'cached':True,'items':None}
 elif op=='resolve':v={'state':'completed','location':'local','path':os.environ['FALATRACE_SYNTHETIC_MEDIA']}
 elif op=='processing-status':v={'waiting':[]}
 elif op=='ux-capabilities':v={'mockFrames':False,'realFrames':False}
 elif op=='settings-read':v={'revision':'a'*64,'exists':True,'values':{'studio.language':'en' if mode=='english' else 'pt-BR'},'apps':[],'nullable':[],'readOnly':{},'credentials':{'details':[]}}
 elif op=='detail':v=detail
 elif op=='revision-save':v={'version':1,'revision':1,'base':r['payload']['base']}
 elif op=='speakers-suggest':v={'id':r['key'],'status':'queued','unit':'recording-cli-speakers-'+r['key']+'.service'}
 else:print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture; nada foi alterado.'}),flush=True);continue
 print(json.dumps({'id':r['id'],'ok':True,'result':v}),flush=True)
'''

FIND = '''
 function uxFind(item, name) {
  if (!item) return null
  if (item.objectName === name) return item
  const kids = [].concat(item.children || [], item.contentItem && item.contentItem !== item ? [item.contentItem] : [])
  for (let index = 0; index < kids.length; index++) { const found = uxFind(kids[index], name); if (found) return found }
  return null
 }
'''

MODES = {
    # The tab as it opens: two suggestions and the apply action.
    'tab': ('', 1500),
    # The request dialog with the conversation consent checked.
    'dialog': ('''
 Timer { interval: 1000; running: true; repeat: false; onTriggered: { speakerSuggestDialog.open(); speakerSuggestDialog.conversationConsent.checked = true } }
''', 1500),
    'english': ('', 1700),
    'flow': ('''
 Timer { interval: 1000; running: true; repeat: false; onTriggered: {
  const a=[]; function check(name,pass){a.push({name:name,pass:!!pass})}
  check("speakers tab open with three speakers", tabs.currentIndex === 2 && speakerRows.length === 3)
  const mic = uxFind(window.contentItem, "speakerSuggestion-S01-microphone")
  check("owner suggestion names the source and share", mic && mic.visible && mic.text.indexOf("Caio Barbieri") >= 0 && mic.text.indexOf("97%") >= 0 && mic.text.indexOf("microfone") >= 0)
  const quoted = uxFind(window.contentItem, "speakerSuggestion-S02-conversation")
  check("conversation suggestion shows its quote", quoted && quoted.visible && quoted.text.indexOf("Ana") >= 0 && quoted.text.indexOf("aqui é a Ana") >= 0)
  check("no suggestion row for a speaker without one", !uxFind(window.contentItem, "speakerSuggestion-S03-microphone") && !uxFind(window.contentItem, "speakerSuggestion-S03-conversation"))
  check("apply offers exactly the unnamed speakers with one name", applicableSuggestions().length === 2)
  check("suggestions are not applied by themselves", !hasPending("revision-save") && speakerRows[0].label === "Falante 1")
  const use = uxFind(window.contentItem, "speakerUseSuggestion-S02-conversation")
  use.clicked()
  check("use opens the review prefilled with the suggestion", reviewDialog.visible && revisionText.text === "Ana" && reviewTarget.kind === "speaker-label" && reviewTarget.speakerId === "S02")
  check("opening the review sends nothing", !revisionPending())
  reviewDialog.close()
  uxFind(window.contentItem, "speakerApplySuggestions").clicked()
  check("apply sends one revision", hasPending("revision-save"))
  console.log("UX_ASSERTIONS "+JSON.stringify(a))
 } }
 Timer { interval: 1500; running: true; repeat: false; onTriggered: {
  const a=[]; function check(name,pass){a.push({name:name,pass:!!pass})}
  check("revision answered and detail reread", !revisionPending())
  uxFind(window.contentItem, "speakerSuggestButton").clicked()
  const consent = speakerSuggestDialog.conversationConsent
  check("request dialog opens without consent", speakerSuggestDialog.visible && !consent.checked)
  check("destination shown before sending", consent.text.indexOf("OpenAI") >= 0 && consent.text.indexOf("gpt-6-luna") >= 0 && consent.text.indexOf("provedor externo") >= 0)
  const run = uxFind(speakerSuggestDialog.contentItem.parent, "speakerSuggestRun") || uxFind(speakerSuggestDialog.footer, "speakerSuggestRun")
  check("without consent only the local microphone runs", run && run.text === "Analisar microfone")
  consent.checked = true
  check("consent changes the action", run.text === "Analisar microfone e conversa")
  run.clicked()
  check("request sent and dialog closed", hasPending("speakers-suggest") && !speakerSuggestDialog.visible)
  console.log("UX_ASSERTIONS "+JSON.stringify(a))
 } }
 Timer { interval: 2100; running: true; repeat: false; onTriggered: {
  console.log("UX_ASSERTIONS "+JSON.stringify([{name:"queued request polls and disables a second request",pass:speakersQueued && !uxFind(window.contentItem, "speakerSuggestButton").enabled}]))
 } }
''', 2600),
}

checks, screens, requests = [], [], {}
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-speakers-fixture-') as scratch:
    root = Path(scratch)
    nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce)
    (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']:
        (root / name).mkdir(mode=0o700)
    # The inert player never decodes it; it only keeps the media lookup from failing.
    media = root / 'synthetic.mkv'
    media.write_bytes(b'')
    stub = root / 'bridge-stub.py'
    stub.write_text(STUB)
    stub.chmod(0o700)
    for mode, (extra, delay) in MODES.items():
        qml = root / mode
        qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        (qml / 'Main.qml').write_text(base[:-1] + FIND + extra + '}\n')
        copy_qml_siblings(qml)
        image = out / f'speakers-{mode}.png'
        log = root / f'{mode}-requests.jsonl'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'), 'TMPDIR': str(root / 'tmp'),
               'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen', 'QT_QUICK_BACKEND': 'software',
               # Fedora's Qt ships *.debug=false and logs to journald without a terminal;
               # both would hide the console.log lines the assertions travel on.
               'QT_LOGGING_RULES': 'js.debug=true;qml.debug=true;default.debug=true', 'QT_FORCE_STDERR_LOGGING': '1',
               'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': 'synthetic-speakers', 'RECORDING_DESKTOP_DIARIZATION_SMOKE': '1',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': str(delay),
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_REQUEST_LOG': str(log), 'FALATRACE_DETAIL': json.dumps(DETAIL),
               'FALATRACE_SYNTHETIC_MEDIA': str(media)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        result = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=60)
        (out / f'speakers-{mode}.stderr').write_text(result.stderr)
        evidence = json.loads(Path(str(image) + '.json').read_text()) if Path(str(image) + '.json').exists() else {}
        if not evidence.get('snapshot') or 'ReferenceError' in result.stderr or 'TypeError' in result.stderr or 'failed to load component' in result.stderr:
            raise SystemExit(f'QML failure in {mode}: ' + result.stderr[-4000:])
        for line in result.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line:
                checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests[mode] = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})

flow = requests['flow']
saves = [request for request in flow if request['op'] == 'revision-save']
suggests = [request for request in flow if request['op'] == 'speakers-suggest']
checks.append({'name': 'apply sends the two suggested names in one revision bound to the review base',
               'pass': len(saves) == 1 and saves[0]['key'] == JOB and saves[0]['payload'] == {
                   'expectedRevision': 0, 'base': BASE, 'operations': [
                       {'kind': 'speaker-label', 'speakerId': 'S01', 'label': 'Caio Barbieri'},
                       {'kind': 'speaker-label', 'speakerId': 'S02', 'label': 'Ana'}]}})
checks.append({'name': 'the conversation request carries consent bound to the destination shown',
               'pass': len(suggests) == 1 and suggests[0]['key'] == JOB and suggests[0]['payload'] == {'conversation': True, 'consent': True, 'consentKey': CONSENT_KEY}})
checks.append({'name': 'viewing the tab or the dialog sends no revision and no suggestion request',
               'pass': all(request['op'] not in ('revision-save', 'speakers-suggest') for mode in ('tab', 'dialog', 'english') for request in requests[mode])})
failed = [check for check in checks if not check['pass']]
receipt = {'actualQmlSha256': hashlib.sha256(source.encode()).hexdigest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens,
           'syntheticBackend': True, 'providerCalls': 0, 'limits': ['Timer instrumentation, not OS key events', 'Synthetic bridge; the real bridge is covered by bun tests']}
(out / 'speakers-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
(out / 'speakers-requests.json').write_text(json.dumps(requests, indent=2, ensure_ascii=False) + '\n')
if not checks or failed:
    raise SystemExit('Assertion failed: ' + json.dumps(failed or checks, ensure_ascii=False))
print(json.dumps({'screens': len(screens), 'assertionsPassed': len(checks), 'output': str(out)}))
