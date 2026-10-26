#!/usr/bin/env python3
"""Render the Studio library with recordings whose media the retention policy removed.

Offline and disposable: a synthetic bridge lists a transcript-only recording, an
audio-only one and one whose media is simply missing. The journey proves removed
media is never counted as needing attention, the player offers no "Abrir gravação"
for transcript-only media and the transcript stays readable. A second set of modes drives
"Remover mídia agora…": the plan first (Cancel focused, sizes, scope), the explicit
confirmation, the removal polled through media-status, the meeting left with its text and
the media-only actions off; a plan that cannot remove anything; and a meeting whose media was
removed (citations show the transcript, sharing still works).
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, qml_steps, require_assertion_lines, require_studio_command, run_journey_modes, runner_kind
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
# ── "Remover mídia agora…" and the meeting page without media ──
JOB = '22222222-2222-4222-8222-222222222222'
CONSENT = 'e' * 64
MEDIA_STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a'); JOB = os.environ['RETENTION_JOB']; CONSENT = os.environ['RETENTION_CONSENT']
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
removed = mode == 'removed-meeting'
on = {'playback': True, 'frames': True, 'diarize': True, 'speakersMic': True, 'voices': True, 'subtitles': True, 'reprocess': True}
off = {key: False for key in on}
def item():
    return {'key': '/synthetic/Recordings/present.mkv', 'recordingId': JOB, 'jobId': JOB, 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'present.mkv', 'modifiedAt': 1792000000000,
            'location': 'transcript-only' if removed else 'local', 'media': 'removed' if removed else 'present', 'sourceExists': not removed, 'status': 'completed', 'backup': 'none'}
doc = {'version': 2, 'generatedAt': '2026-10-21T15:02:00Z', 'model': {'label': 'ollama · qwen3.5:9b', 'local': True}, 'template': {'id': 'general', 'name': 'Geral', 'source': 'default', 'reason': '', 'confidence': 1}, 'language': 'pt-BR', 'stale': None, 'notesDigest': 'd' * 64,
       'overview': {'text': 'A equipe manteve o lançamento no dia 30.', 'citations': [{'segmentId': 's2', 'start': 42}]},
       'sections': [{'heading': 'Decisões', 'items': [{'kind': 'decision', 'origin': 'ai', 'text': 'Lançamento no dia 30.', 'uncertain': False, 'citations': [{'segmentId': 's2', 'start': 42}], 'noteIds': []}]}],
       'unusedNotes': [], 'orphanActions': [], 'limitations': []}
segments = [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia.'}, {'id': 's2', 'start': 42, 'end': 50, 'text': 'O lançamento fica no dia 30.'}]
plan_polls = 0; remove_polls = 0
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': [item()]}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': True, 'features': {name: True for name in names}, 'firstRun': {}}
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail':
        media = {'state': 'removed', 'removedAt': '2026-10-12T09:00:00Z', 'reason': 'manual', 'features': off} if removed else {'state': 'present', 'features': on}
        v = {'transcript': {'segments': segments, 'text': 'Bom dia. O lançamento fica no dia 30.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []}, 'summary': '# Daily\n\n- ok', 'notesDoc': doc,
             'status': 'completed', 'backup': 'none', 'jobId': JOB, 'diarizationId': JOB, 'subtitleId': JOB, 'media': media,
             'review': {'revision': {'revision': 0, 'base': {'jobId': JOB}}, 'canUndo': False, 'notes': [], 'derivedStale': False}}
    elif op == 'resolve': v = {'state': 'completed', 'location': 'local', 'path': os.environ['FALATRACE_SYNTHETIC_MEDIA']}
    elif op == 'media-plan': v = {'requestId': '11111111-aaaa-4aaa-8aaa-111111111111', 'status': 'running'}
    elif op == 'media-remove':
        if p.get('consentKey') != CONSENT: refuse(r, 'A situação da gravação mudou; revise a remoção da mídia de novo.'); continue
        v = {'requestId': '22222222-bbbb-4bbb-8bbb-222222222222', 'status': 'running'}
    elif op == 'media-status':
        key = '/synthetic/Recordings/present.mkv'
        if p['requestId'].startswith('1111'):
            plan_polls += 1
            if plan_polls < 2: v = {'requestId': p['requestId'], 'kind': 'plan', 'key': key, 'status': 'running'}
            elif mode == 'not-eligible':
                reason = 'Os backups da mídia ainda não terminaram; a mídia foi mantida.'
                v = {'requestId': p['requestId'], 'kind': 'plan', 'key': key, 'status': 'completed', 'eligible': False, 'reasons': [reason],
                     'options': [{'mode': 'audio-only', 'eligible': False, 'bytesFreed': None, 'reasons': [reason]}, {'mode': 'transcript-only', 'eligible': False, 'bytesFreed': 1234567890, 'reasons': [reason]}],
                     'consentKey': CONSENT, 'scope': 'total', 'legacyTranscript': False}
            else:
                v = {'requestId': p['requestId'], 'kind': 'plan', 'key': key, 'status': 'completed', 'eligible': True, 'reasons': [],
                     'options': [{'mode': 'audio-only', 'eligible': True, 'bytesFreed': None, 'reasons': []}, {'mode': 'transcript-only', 'eligible': True, 'bytesFreed': 1234567890, 'reasons': []}],
                     'consentKey': CONSENT, 'scope': 'total', 'legacyTranscript': False}
        else:
            remove_polls += 1
            if remove_polls < 2: v = {'requestId': p['requestId'], 'kind': 'remove', 'key': key, 'status': 'running'}
            else:
                removed = True
                v = {'requestId': p['requestId'], 'kind': 'remove', 'key': key, 'status': 'completed', 'mode': 'transcript-only', 'removed': True, 'bytesFreed': 1234567890}
    elif op == 'share-preview': v = {'previewId': '88888888-8888-4888-8888-888888888888', 'markdown': '# Daily do time', 'chars': 15, 'external': False, 'destinationLabel': 'Área de transferência', 'ready': True, 'target': 'clipboard'}
    elif op == 'home-read': v = {'upcoming': [], 'openActions': [], 'openActionsTotal': 0, 'processing': [], 'calendarConnected': True, 'reminderMode': 'on', 'refreshing': False}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''
PICK = ('library', 'items.length === 1 && !hasPending("list")', 'selectRecording(items[0])')
OPEN = ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && !!detail.media && newBridge', '''
    check("media present can be removed", detailView.mediaRemovable)
    mediaRemoveDialog.open()''')
MEDIA_PLANS = {
    'remove': ('1320x820', False, [PICK, OPEN,
        ('plan ready', 'mediaRemoveDialog.stage === "ready"', '''
    check("the plan comes first, Cancel has the focus", uxFind(mediaRemoveDialog.footer, "mediaRemoveCancel").activeFocus)
    check("both choices say what they keep and free", !!uxFind(mediaRemoveDialog.contentItem, "mediaOption-audio-only") && mediaRemoveDialog.sizeText(1234567890) === "1,2 GB")
    check("a removal with no other copy says so", mediaRemoveDialog.plan.scope === "total")
    uxFind(mediaRemoveDialog.contentItem, "mediaOption-transcript-only").clicked()
    check("nothing goes before the confirmation", !uxFind(mediaRemoveDialog.footer, "mediaRemoveConfirm").enabled && mediaRemoveDialog.mode === "transcript-only")
    mediaRemoveDialog.consent.checked = true
    check("the confirmation enables Remover mídia", uxFind(mediaRemoveDialog.footer, "mediaRemoveConfirm").enabled)
    uxFind(mediaRemoveDialog.footer, "mediaRemoveConfirm").clicked()
    check("removing cannot be closed halfway", mediaRemoveDialog.stage === "removing" && mediaRemoveDialog.closePolicy === Popup.NoAutoClose)'''),
        ('removed', '!mediaRemoveDialog.visible && toast.message.indexOf("Mídia removida") === 0', 'check("the removal is confirmed in a toast, not in errorText or notice", errorText.indexOf("mídia") < 0 && notice.indexOf("mídia") < 0)'),
        ('meeting without media', 'selected.location === "transcript-only" && !detailLoading && detail.media.state === "removed"', '''
    check("the meeting shows its text-only state", uxFind(detailView, "playerRemovedLine").visible && !openRecordingButton.visible)
    check("what needs the media is off, and no second removal", !detailView.mediaAllows("diarize") && !detailView.mediaAllows("frames") && !detailView.mediaRemovable)''')]),
    'not-eligible': ('900x640', True, [PICK, OPEN,
        ('plan ready', 'mediaRemoveDialog.stage === "ready"', '''
    check("a plan that cannot remove says why", mediaRemoveDialog.plan.eligible === false && mediaRemoveDialog.mode === "")
    check("nothing can be confirmed", !uxFind(mediaRemoveDialog.footer, "mediaRemoveConfirm").enabled && !mediaRemoveDialog.consent.visible)''')]),
    'removed-meeting': ('1320x820', False, [PICK,
        ('meeting open', '!!selected.key && !detailLoading && !!detail.notesDoc && newBridge', '''
    check("no player and no removal for a transcript-only meeting", !openRecordingButton.visible && !detailView.mediaRemovable)
    uxFind(window.contentItem, "citation-s2").clicked()
    check("a citation shows the transcript at that moment", tabs.currentIndex === 0)'''),
        ('transcript shown', 'tabs.currentIndex === 0 && detailView.flashIndex === 1', '''
    check("sharing still works", detailView.shareButton.visible)
    detailView.shareButton.clicked()'''),
        ('shared', 'shareDialog.visible && !!shareDialog.preview.previewId', 'check("the preview is there", shareDialog.previewArea.text === "# Daily do time"); shareDialog.close()')]),
}
more, media_screens, media_requests = run_journey_modes(command, 'retention', out, MEDIA_STUB, MEDIA_PLANS,
                                                      lambda mode: {'RETENTION_JOB': JOB, 'RETENTION_CONSENT': CONSENT})
checks.extend(more); screens.extend(media_screens)


def sent(mode, op):
    return [q for q in media_requests[mode] if q['op'] == op]


checks.append({'name': "remove: the plan and the removal name the recording; the removal carries the plan's consent key",
               'pass': [q['key'] for q in sent('remove', 'media-plan')] == ['/synthetic/Recordings/present.mkv']
               and [(q['key'], q['payload']) for q in sent('remove', 'media-remove')] == [('/synthetic/Recordings/present.mkv', {'mode': 'transcript-only', 'consentKey': CONSENT})]
               and all(set(q['payload']) == {'requestId'} for q in sent('remove', 'media-status'))})
checks.append({'name': 'remove: the library is read again after the removal', 'pass': len(sent('remove', 'list')) >= 2})
checks.append({'name': 'not-eligible: nothing is removed', 'pass': not sent('not-eligible', 'media-remove')})
checks.append({'name': 'removed-meeting: nothing tries to play, remove or process the removed media',
               'pass': not any(q['op'] in ('resolve', 'media-plan', 'media-remove', 'recording-process', 'recording-process-plan') for q in media_requests['removed-meeting'])})
failed = [c for c in checks if not c['pass']]
(out / 'retention-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or len(checks) < 20: sys.exit(1)
