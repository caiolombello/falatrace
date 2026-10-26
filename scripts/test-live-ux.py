#!/usr/bin/env python3
"""Live capture in the actual Studio QML against a synthetic bridge.

Offline and disposable: no device, capture or provider is touched. Each mode drives the live view
with studio_fixture.qml_steps (every step waits, bounded, for the state the previous reply produces,
never a fixed delay, and prints its own assertion line): a capture started from the Studio opens the
notepad and autosaves (800 ms after typing, right away on Enter), the live transcript stays off until
asked and a cloud provider needs consent before live-set (again for another provider, and also when
the provider is not known), Parar saves the notes first and then opens the new meeting, the compact
light layout, a bridge with the notepad off (and the notepad turned on in Settings, with no restart), and the one-minute test capture (also when test mode is
set before the capture starts).
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, qml_steps, require_assertion_lines, require_studio_command, runner_kind  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-live-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

SESSION = '11111111-1111-4111-8111-111111111111'
STUB = r'''#!/usr/bin/python3
import sys, json, os, datetime
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a'); session_id = os.environ['FALATRACE_SESSION']
now = lambda: datetime.datetime.now(datetime.timezone.utc)
ago = {'test-mode': 58}.get(mode, 30)
active = mode not in ('start', 'no-notes', 'test-start')
started = (now() - datetime.timedelta(seconds=ago)).isoformat()
stopped = False; live_on = False; seq = 0
notes_on = mode not in ('no-notes', 'notes-on')
notes = {'id': session_id, 'rev': 0, 'text': '', 'entries': [], 'updatedAt': None}
old = {'key': '/synthetic/Recordings/daily.mkv', 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}
new = {'key': '/synthetic/Recordings/new.mkv', 'recordingId': session_id, 'jobId': session_id, 'title': 'Gravação — 21/10/2026 14:00', 'hasMeetingTitle': False, 'fileName': 'new.mkv', 'modifiedAt': 1792100000000, 'location': 'local', 'status': 'processing', 'backup': 'none'}
audio = {'configured': {'audioSource': 'both', 'microphone': 'default', 'desktop': 'default'}}
def status():
    return {'active': active, 'session': {'id': session_id, 'startedAt': started, 'phase': 'recording', 'owner': 'manual'} if active else None, 'paused': False, 'audio': audio}
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': [new, old] if stopped else [old]}
    elif op == 'capture-status': v = status()
    elif op == 'capture-start': active = True; started = now().isoformat(); v = status()
    elif op == 'capture-stop': active = False; stopped = True; v = {**status(), 'outcome': 'stopped', 'jobId': session_id, 'jobQueued': 'queued'}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities':
        v = {'mockFrames': False, 'realFrames': False, 'firstRun': {},
             'features': {name: (name != 'notes' or notes_on) for name in ['notes', 'live', 'actions', 'librarySearch', 'assistant', 'recipes', 'share', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates']}}
    elif op == 'settings-read':
        # compact: settings without the live provider, so the panel cannot know where the audio would go.
        values = {'studio.language': 'pt-BR'} if mode == 'compact' else {'studio.language': 'pt-BR', 'live.provider': 'groq'}
        v = {'revision': 'a' * 64, 'exists': True, 'values': values, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'settings-diagnose': v = {}
    elif op == 'settings-save':
        # notes-on: the notepad is turned on in Settings; the bridge offers it from then on.
        notes_on = notes_on or p.get('changes', {}).get('notes.enabled') is True
        v = {'revision': 'b' * 64, 'exists': True, 'values': {'studio.language': 'pt-BR', 'live.provider': 'groq', 'notes.enabled': notes_on}, 'changed': sorted(p.get('changes', {})),
             'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail': v = {'transcript': {'segments': [], 'text': '', 'timing': 'none'}, 'diarization': {'state': 'idle', 'turns': []}, 'summary': '', 'status': 'processing', 'backup': 'none', 'jobId': session_id, 'notes': {**notes, 'digest': 'x'}}
    elif op == 'resolve': v = {'state': 'failed', 'message': 'Mídia sintética indisponível.'}
    elif op == 'notes-read': v = notes
    elif op == 'notes-save':
        lines = [text.rstrip() for text in p['text'].split('\n') if text.strip()]
        notes = {'id': r['key'], 'rev': notes['rev'] + 1, 'text': '\n'.join(lines), 'updatedAt': now().isoformat(), 'saved': True,
                 'entries': [{'id': 'n%06d' % (index + 1), 'at': '00:%02d' % (10 + index), 'offsetSeconds': 10 + index, 'text': text} for index, text in enumerate(lines)]}
        if p.get('title'): notes['title'] = p['title']
        v = notes
    elif op == 'live-read':
        lines = []
        if live_on: seq += 1; lines = [{'seq': seq, 'start': 20 + seq * 15, 'end': 34 + seq * 15, 'text': 'Trecho ao vivo %d: o orçamento de suporte entra na proposta.' % seq}]
        # Like the bridge, the provider comes only with a live status (once it was turned on).
        v = {'lines': lines, 'lastSeq': seq, 'hasMore': False, 'status': 'running' if live_on else 'stopped', 'stale': False, **({'provider': 'groq'} if live_on else {})}
    elif op == 'live-set':
        if p.get('enabled') and p.get('consent') is not True:
            print(json.dumps({'id': r['id'], 'ok': False, 'error': 'Confirme o envio do áudio ao provedor antes de ligar o texto ao vivo.'}), flush=True); continue
        live_on = bool(p.get('enabled')); v = {'enabled': live_on, 'status': 'running' if live_on else 'stopped', 'changed': True, 'provider': 'groq', 'external': True}
    else:
        print(json.dumps({'id': r['id'], 'ok': False, 'error': 'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

# Window helpers the steps use: find an item by objectName, and evaluate a ready condition that may
# touch an item not built yet (false instead of a TypeError).
HELPERS = '''
 function uxFind(item, name) { if (!item) return null; if (item.objectName === name) return item
  const kids = [].concat(item.children || [], item.contentItem && item.contentItem !== item ? [item.contentItem] : [])
  for (let i = 0; i < kids.length; i++) { const f = uxFind(kids[i], name); if (f) return f } return null }
 function uxTry(f) { try { return !!f() } catch (error) { return false } }
'''


def step(mode, name, ready, body, limit=None):
    """A qml_steps step: wait (bounded) until `ready`, then run `body` and print its checks as one line.

    A ready condition that never held is reported as a failed check, so a missing reply cannot pass silently.
    """
    condition = 'uxTry(function(){ return %s })' % ready if ready else 'true'
    code = ('const a=[]; function check(name,pass){a.push({name:%s+name,pass:!!pass})}; ' % json.dumps(mode + ': ')
            + ('if (!(%s)) check(%s, false); ' % (condition, json.dumps('timed out waiting for ' + name)) if ready else '')
            + 'try { %s } catch (error) { check(%s + error, false) }; ' % (body, json.dumps(name + ' threw '))
            + 'console.log("UX_ASSERTIONS "+JSON.stringify(a))')
    return (0, condition, code) if limit is None else (0, condition, code, limit)


READY = ('bridge ready', 'captureKnown && features.live === true', '')
OPEN_LIVE = [READY, ('open live', 'liveAvailable()', 'openLive()'), ('notes loaded', 'currentView === "live" && liveView.notesEditor.loaded', '')]
CONSENT = ('consent', None, 'captureConsent.intent = "capture"; captureConsent.open(); captureConsent.accept()')
PLANS = {
    'start': ('1320x820', False, [READY, CONSENT,
        ('live view', 'currentView === "live" && liveView.notesEditor.loaded', '''
    check("a capture started here opens the notepad", liveView.visible && liveView.sessionId === "''' + SESSION + '''")
    check("the live transcript stays off until asked", !liveView.transcriptPanel.visible)
    check("Parar e gerar notas is offered", uxFind(window.contentItem, "liveStop").visible)
    check("the notepad has the focus", liveView.notesEditor.area.activeFocus)
    liveView.notesEditor.area.insert(0, "terminei o fluxo de login")'''),
        ('autosaved', 'liveView.notesEditor.rev === 1 && !liveView.notesEditor.saving', '''
    check("typing saves by itself", true)
    liveView.notesEditor.area.cursorPosition = liveView.notesEditor.area.length
    liveView.notesEditor.newLine()
    liveView.notesEditor.area.insert(liveView.notesEditor.area.length, "[ ] revisar o PR")'''),
        ('second line', 'liveView.notesEditor.rev >= 2 && !liveView.notesEditor.saving && !liveView.notesEditor.dirty', '''
    check("each line gets its time in the gutter", liveView.notesEditor.gutterModel().map(function(row){ return row.label }).join(",") === "00:10,00:11")
    check("the save state says it saved", uxFind(liveView, "notesSaveState").text.indexOf("Salvo") === 0)''')]),
    'panel': ('1320x820', False, OPEN_LIVE + [
        ('show panel', None, 'uxFind(window.contentItem, "liveTranscriptToggle").clicked()'),
        ('panel read', 'liveView.transcriptPanel.visible && liveView.transcriptPanel.status === "stopped"', '''
    check("off, the panel shows costs and where the audio goes", uxFind(window.contentItem, "liveConsent").visible && !uxFind(window.contentItem, "liveEnable").enabled)
    liveView.transcriptPanel.setEnabled(true)
    check("without consent nothing is sent to the provider", !hasPending("live-set"))
    uxFind(window.contentItem, "liveConsentCheck").click()
    check("consent enables the switch", uxFind(window.contentItem, "liveEnable").enabled)
    studioSettings = Object.assign({}, studioSettings, {"live.provider": "openai"})
    check("another provider asks for the consent again", !uxFind(window.contentItem, "liveEnable").enabled && uxFind(window.contentItem, "liveConsentCheck").text.indexOf("OpenAI") >= 0)
    studioSettings = Object.assign({}, studioSettings, {"live.provider": "groq"})
    uxFind(window.contentItem, "liveConsentCheck").click()
    uxFind(window.contentItem, "liveEnable").clicked()'''),
        ('lines', '!!uxFind(window.contentItem, "liveLine-1")', '''
    check("live lines appear while recording", liveView.transcriptPanel.running)
    uxFind(window.contentItem, "liveAddNote-1").clicked()'''),
        ('copied to notes', 'liveView.notesEditor.area.text.indexOf("orçamento de suporte") >= 0', '''
    check("a live line can become your note", liveView.notesEditor.area.text.indexOf("“Trecho ao vivo 1") === 0)
    check("no error or notice from live", errorText === "" && notice.indexOf("ao vivo") < 0)''')]),
    'stop': ('1320x820', False, OPEN_LIVE + [
        ('type and stop', None, 'liveView.notesEditor.area.text = "linha escrita antes de parar"; uxFind(window.contentItem, "liveStop").clicked()'),
        ('meeting opened', 'currentView === "meeting" && selected.key === "/synthetic/Recordings/new.mkv" && !detailLoading', '''
    check("after Parar the new meeting opens on Notas", tabs.currentIndex === 1)
    check("progress shows until the notes are ready", uxFind(window.contentItem, "notesProgress").visible)
    check("the notes typed live are there", detailView.notesDocument.myNotes.length === 1)''')]),
    'compact': ('900x640', True, OPEN_LIVE + [
        ('panel', None, 'liveView.transcriptPanel.shown = true; liveView.notesEditor.area.text = "# Lançamento\\nterminei o fluxo de login\\n[ ] revisar o PR — Bruno"; liveView.notesEditor.saveNow()'),
        ('saved', 'liveView.notesEditor.rev === 1 && liveView.transcriptPanel.status !== ""', '''
    const stop = uxFind(window.contentItem, "liveStop"), p = stop.mapToItem(window.contentItem, 0, 0)
    check("Parar fits in 900x640", stop.visible && p.x >= 0 && p.y >= 0 && p.x + stop.width <= window.width && p.y + stop.height <= window.height)
    check("compact keeps the notepad wider than the panel", liveView.notesEditor.width > liveView.transcriptPanel.width)
    check("a provider not known yet asks for consent, like a cloud one", liveView.transcriptPanel.external && uxFind(liveView, "liveConsent").visible && !uxFind(liveView, "liveEnable").enabled)''')]),
    'no-notes': ('1320x820', False, [(READY[0], 'captureKnown && features.live === true && features.notes === false', ''), CONSENT,
        ('capture started', 'captureStatus.active && !captureBusy', '''
    check("with the notepad off, the capture does not open the live view", currentView !== "live")''')]),
    # The notepad turned on in Settings during a capture: the Studio asks for the features again after the
    # save, so the live view offers the notepad at once, without a restart.
    'notes-on': ('1320x820', False, [(READY[0], 'captureKnown && features.live === true && features.notes === false', ''),
        ('open live', 'liveAvailable()', 'openLive()'),
        ('notes off', 'currentView === "live" && liveView.sessionId !== ""', '''
    check("with the notepad off, the live view has no notepad", !liveView.notesEditor.visible)
    settingsDialog.open()'''),
        ('settings read', 'settingsDialog.visible && settingsEditable && !hasPending("settings-diagnose")', 'setSettingsField("notes.enabled", true); saveSettingsDraft()'),
        ('saved', 'feature("notes") && liveView.notesEditor.loaded', '''
    check("saving Settings turns the notepad on at once, without a restart", liveView.notesEditor.visible && settingsNotice.indexOf("Configuração salva") === 0)
    settingsDialog.close()''')]),
    # The first-steps test recording sets test mode before the capture starts (C6c's wizardRecordTest).
    'test-start': ('1320x820', False, [READY,
        ('test consent', None, 'liveView.testMode = true; captureConsent.intent = "capture"; captureConsent.open(); captureConsent.accept()'),
        ('live view', 'currentView === "live" && liveView.notesEditor.loaded && liveView.recording', '''
    check("a test capture started here stays a test capture", liveView.testMode && uxFind(window.contentItem, "liveCoach").visible && uxFind(window.contentItem, "liveCoach").text.indexOf("Conversa de teste") === 0)''')]),
    'test-mode': ('1320x820', False, OPEN_LIVE + [
        ('test', None, 'liveView.testMode = true; check("the test capture says when it stops", uxFind(window.contentItem, "liveCoach").visible)'),
        ('stopped', '!captureStatus.active && !captureBusy', 'check("the test capture stops by itself after a minute", true)', 9000)]),
}

checks, screens = [], []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-live-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (size, light, plan) in PLANS.items():
        qml = root / mode; qml.mkdir()
        width, height = size.split('x')
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        # The theme and size first (no bridge reply needed), then the steps; the snapshot follows the last one.
        steps = [(200, 'true', f'window.lightTheme = {"true" if light else "false"}; window.width = {width}; window.height = {height}')]
        steps += [step(mode, *entry) for entry in plan]
        (qml / 'Main.qml').write_text(base[:-1] + HELPERS + qml_steps(steps, 400) + '}\n'); copy_qml_siblings(qml)
        image, log = out / f'live-{mode}.png', root / f'{mode}-requests.jsonl'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'), 'TMPDIR': str(root / 'tmp'),
               'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen', 'QT_QUICK_BACKEND': 'software', 'QT_FORCE_STDERR_LOGGING': '1',
               'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               # A deadline only: the PySide6 runner snapshots as soon as the last step ran (qaSnapshotReady).
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '12000',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_REQUEST_LOG': str(log), 'FALATRACE_SESSION': SESSION}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=60)
        (out / f'live-{mode}.stderr').write_text(r.stderr)
        # A step that threw is already a failed check on its assertion line; anything else is a QML failure.
        problems = [line for line in r.stderr.splitlines() if 'UX_ASSERTIONS ' not in line and any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
        if not image.exists() or problems:
            raise SystemExit(f'QML failure in {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
        require_assertion_lines(r.stderr, 'UX_ASSERTIONS ', len(plan), mode)
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        ops = [q['op'] for q in requests]
        def sent(op): return [q for q in requests if q['op'] == op]
        if mode == 'start':
            saves = sent('notes-save')
            checks.append({'name': 'start: notes-read and notes-save use the capture session id', 'pass': [q['key'] for q in sent('notes-read')] == [SESSION] and all(q['key'] == SESSION for q in saves)})
            checks.append({'name': 'start: the first save carries the typed line and the revision it read',
                           'pass': len(saves) >= 2 and saves[0]['payload'] == {'text': 'terminei o fluxo de login', 'expectedRev': 0, 'title': ''} and saves[-1]['payload']['text'] == 'terminei o fluxo de login\n[ ] revisar o PR'})
            checks.append({'name': 'start: the live transcript was never read or switched while hidden', 'pass': not sent('live-read') and not sent('live-set')})
        if mode == 'panel':
            sets = sent('live-set')
            checks.append({'name': 'panel: live-set only after consent, with consent', 'pass': [q['payload'] for q in sets] == [{'enabled': True, 'consent': True}] and all(q['key'] == SESSION for q in sets)})
        if mode == 'stop':
            stop_at = ops.index('capture-stop') if 'capture-stop' in ops else -1
            last_save = max([index for index, op in enumerate(ops) if op == 'notes-save'] or [-1])
            checks.append({'name': 'stop: the notes are saved before Parar', 'pass': 0 <= last_save < stop_at and requests[last_save]['payload']['text'] == 'linha escrita antes de parar'})
            checks.append({'name': 'stop: the list is read again after Parar', 'pass': 'list' in ops[stop_at + 1:]})
        if mode == 'no-notes':
            checks.append({'name': 'no-notes: no notes op without the notes flag', 'pass': not any(op.startswith('notes-') for op in ops) and 'capture-start' in ops})
        if mode == 'notes-on':
            save_at = ops.index('settings-save') if 'settings-save' in ops else len(ops)
            checks.append({'name': 'notes-on: the features are asked again after the save, and the notes read only then',
                           'pass': 'ux-capabilities' in ops[save_at + 1:] and [q['key'] for q in sent('notes-read')] == [SESSION] and ops.index('notes-read') > save_at})
        if mode == 'test-start':
            checks.append({'name': 'test-start: the test capture starts and is not stopped before its minute', 'pass': 'capture-start' in ops and 'capture-stop' not in ops})
        if mode == 'test-mode':
            checks.append({'name': 'test-mode: one capture-stop', 'pass': ops.count('capture-stop') == 1})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'live-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True, 'captureStarted': False}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
