#!/usr/bin/env python3
"""The meeting page's notes in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode opens one synthetic meeting and drives the notes page with
studio_fixture.qml_steps: every step waits (bounded) for the state the previous reply produces,
never a fixed delay, and prints its own assertion line. Modes: the v2 notes document (your lines
vs lines the AI completed, citations, actions with undo, a second action of the same recording,
the place in the notes kept across a list refresh), a conflicting action, the Markdown fallback,
"Minhas notas" (notes-read/notes-save, and text typed while a save runs), a meeting still being
processed in English and compact, the transcript search in the sidebar, and a bridge that offers
none of the new features. Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, qml_steps, require_assertion_lines, require_studio_command, runner_kind  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-notes-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

JOB = '22222222-2222-4222-8222-222222222222'
SHA = 'a' * 64
ACTION = '33333333-3333-4333-8333-333333333333'
DONE_ACTION = '44444444-4444-4444-8444-444444444444'
SEGMENTS = [
    {'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia, vamos começar pela revisão do lançamento.', 'speaker': 'Ana'},
    {'id': 's2', 'start': 42, 'end': 50, 'text': 'O SSO já está integrado no ambiente de testes.', 'speaker': 'Bruno'},
    {'id': 's3', 'start': 610, 'end': 622, 'text': 'Falta acesso ao bucket de produção, isso bloqueia o deploy.', 'speaker': 'Bruno'},
    {'id': 's4', 'start': 1215, 'end': 1230, 'text': 'Bruno, você revisa o PR do login até quinta?', 'speaker': 'Ana'},
]
NOTES = {'id': JOB, 'rev': 3, 'digest': 'd' * 64, 'text': 'terminei o fluxo de login\n[ ] mandar convite da demo',
         'entries': [{'id': 'n000001', 'at': '00:31', 'offsetSeconds': 31, 'text': 'terminei o fluxo de login'},
                     {'id': 'n000002', 'at': '12:30', 'offsetSeconds': 750, 'text': '[ ] mandar convite da demo'}], 'updatedAt': '2026-10-21T15:10:00Z'}
# Both actions live in the recording's one actions file, so they carry its one revision (as the bridge sends them).
NOTES_DOC = {
    'version': 2, 'generatedAt': '2026-10-21T15:02:00Z', 'model': {'label': 'ollama · qwen3.5:9b', 'local': True},
    'template': {'id': 'daily', 'name': 'Daily', 'source': 'calendar', 'reason': 'pela agenda', 'confidence': 1}, 'language': 'pt-BR', 'stale': None, 'notesDigest': 'd' * 64,
    'overview': {'text': 'A equipe revisou o lançamento e manteve a data do dia 30; o único bloqueio é o acesso ao bucket.', 'citations': [{'segmentId': 's1', 'start': 3}, {'segmentId': 's3', 'start': 610}]},
    'sections': [
        {'heading': 'Ontem', 'items': [
            {'kind': 'text', 'origin': 'user', 'text': 'terminei o fluxo de login', 'uncertain': False, 'at': '00:31', 'citations': [], 'noteIds': ['n000001']},
            {'kind': 'text', 'origin': 'ai', 'text': 'Bruno integrou o SSO no ambiente de testes.', 'uncertain': False, 'at': '00:42', 'citations': [{'segmentId': 's2', 'start': 42}], 'noteIds': []}]},
        {'heading': 'Bloqueios', 'items': [
            {'kind': 'text', 'origin': 'ai', 'text': 'Falta acesso ao bucket de produção.', 'uncertain': True, 'at': '10:10', 'citations': [{'segmentId': 's3', 'start': 610}], 'noteIds': []},
            {'kind': 'decision', 'origin': 'ai', 'text': 'O lançamento continua marcado para o dia 30.', 'uncertain': False, 'at': '00:03', 'citations': [{'segmentId': 's1', 'start': 3}], 'noteIds': []}]},
        {'heading': 'Próximos passos', 'items': [
            {'kind': 'action', 'origin': 'ai', 'text': 'Revisar o PR do login', 'uncertain': False, 'at': '20:15', 'citations': [{'segmentId': 's4', 'start': 1215}], 'noteIds': [],
             'action': {'actionId': ACTION, 'mediaSha256': SHA, 'rev': 1, 'status': 'open', 'owner': 'Bruno', 'dueDate': 'quinta'}},
            {'kind': 'action', 'origin': 'user', 'text': 'mandar convite da demo', 'uncertain': False, 'at': '12:30', 'citations': [], 'noteIds': ['n000002'],
             'action': {'actionId': DONE_ACTION, 'mediaSha256': SHA, 'rev': 1, 'status': 'done', 'owner': 'você', 'dueDate': ''}}]}],
    'unusedNotes': [{'text': 'perguntar sobre férias', 'at': '30:01'}], 'orphanActions': [], 'limitations': ['O trecho entre 25:00 e 27:00 ficou sem áudio claro.']}
REVIEW = {'revision': {'revision': 0, 'base': {'jobId': JOB}, 'humanReviewed': False}, 'canUndo': False, 'notes': [], 'derivedStale': False, 'segmentEditUnavailable': False}
BASE_DETAIL = {'transcript': {'segments': SEGMENTS, 'text': 'Bom dia.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []},
               'status': 'completed', 'backup': 'none', 'jobId': JOB, 'review': REVIEW, 'people': [{'id': 'p1', 'name': 'Ana Souza'}, {'id': 'p2', 'name': 'Bruno Lima'}],
               'clients': [{'code': 'ACME', 'name': 'ACME', 'source': 'calendar'}], 'notes': NOTES}
DETAILS = {
    'v2': {**BASE_DETAIL, 'summary': '# Daily\n\n- Equipe revisou o lançamento', 'notesDoc': NOTES_DOC},
    # An older summary, and the transcript corrected after it (the bridge marks derived artifacts stale).
    'legacy': {**BASE_DETAIL, 'summary': '# Daily\n\n## Decisões\n\n- Lançamento no dia 30 [00:42]\n- Falta acesso ao bucket', 'notes': None,
               'review': {**REVIEW, 'revision': {'revision': 1, 'base': {'jobId': JOB}, 'humanReviewed': True}, 'derivedStale': True}},
    'processing': {**BASE_DETAIL, 'transcript': {'segments': [], 'text': '', 'timing': 'none'}, 'summary': '', 'status': 'processing', 'review': None},
}
for value in DETAILS.values():
    if value.get('notes') is None: value.pop('notes', None)
    if value.get('review') is None: value.pop('review', None)

# Like the real stores, action-set and notes-save refuse a revision that is not the current one.
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a')
detail = json.loads(os.environ['FALATRACE_DETAIL']); notes = json.loads(os.environ['FALATRACE_NOTES'])
features = mode != 'no-features'
english = mode == 'processing-en'
item = {'key': '/synthetic/Recordings/daily.mkv', 'recordingId': detail['jobId'], 'jobId': detail['jobId'], 'title': 'Daily do time', 'hasMeetingTitle': True,
        'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': detail['status'], 'backup': 'none', 'durationSeconds': 2830, 'people': ['Ana Souza', 'Bruno Lima']}
other = {'key': '/synthetic/Recordings/one.mkv', 'title': '1:1 com Ana', 'hasMeetingTitle': True, 'fileName': 'one.mkv', 'modifiedAt': 1791900000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}
rev = 1
def refuse(r, message):
    print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': [item, other]}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities':
        v = {'mockFrames': False, 'realFrames': False}
        if features: v.update({'features': {name: True for name in ['notes', 'actions', 'librarySearch', 'live', 'assistant', 'recipes', 'share', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates']}, 'firstRun': {}})
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail': v = detail
    elif op == 'resolve': v = {'state': 'completed', 'location': 'local', 'path': os.environ['FALATRACE_SYNTHETIC_MEDIA']}
    elif op == 'notes-read' and features: v = notes
    elif op == 'notes-save' and features:
        if p['expectedRev'] != notes['rev']: refuse(r, 'As notas mudaram em outra janela; recarregue antes de salvar.'); continue
        lines = [text for text in p['text'].split('\n') if text.strip()]
        notes = {**notes, 'rev': notes['rev'] + 1, 'text': '\n'.join(lines), 'updatedAt': '2026-10-21T16:00:00Z', 'saved': True,
                 'entries': [{'id': 'n%06d' % (index + 1), 'text': text} for index, text in enumerate(lines)]}
        v = notes
    elif op == 'action-set' and features:
        if mode == 'conflict' or p.get('expectedRev', rev) != rev: refuse(r, 'As ações mudaram em outra janela; recarregue e tente de novo.'); continue
        rev += 1; v = {'rev': rev, 'item': {'actionId': p['actionId'], 'mediaSha256': p['mediaSha256'], 'status': p['status'], 'rev': rev}}
    elif op == 'library-search' and features:
        v = {'hits': [{'jobId': detail['jobId'], 'key': item['key'], 'title': item['title'], 'date': '2026-10-21T14:00:00Z', 'kind': 'segment', 'segmentId': 's2', 'start': 42, 'snippet': '… o SSO já está integrado no ambiente de testes …'}], 'refreshing': False}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

# Window helpers the steps use: find an item by objectName, and evaluate a ready condition that may
# touch an item not built yet (false instead of a TypeError).
HELPERS = '''
 property real uxScroll: 0
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


OPEN = ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId', 'check("opens on Notas", tabs.currentIndex === 1 && detailView.notesDocument.visible)')
PLANS = {
    'v2': ('1320x820', False, [OPEN,
        ('document rendered', '!!uxFind(window.contentItem, "noteItem-0-1")', '''
    const mine = uxFind(window.contentItem, "noteItem-0-0"), ai = uxFind(window.contentItem, "noteItem-0-1")
    check("your line and the AI line are told apart", mine.mine && !ai.mine && String(mine.inkColor) !== String(ai.inkColor) && String(mine.inkColor) === String(noteInk) && String(ai.inkColor) === String(aiInk))
    check("template chip names the template and why", uxFind(window.contentItem, "templateChip").visible && uxFind(window.contentItem, "templateChip").chipText.indexOf("Daily · pela agenda") === 0)
    check("status names when and with what", uxFind(window.contentItem, "notesStatus").text.indexOf("qwen3.5") >= 0)
    check("each AI line cites its moment", !!uxFind(window.contentItem, "citation-s2") && !!uxFind(window.contentItem, "citation-s3"))
    check("notes mode offered", detailView.notesMode.visible)
    uxFind(window.contentItem, "notesAboutToggle").clicked()
    check("about these notes opens with limits and unused notes", uxFind(window.contentItem, "notesAbout").visible)
    check("notes made from the original transcript say so", uxFind(window.contentItem, "notesSource").text === "Feitas a partir da transcrição original." && !uxFind(window.contentItem, "notesStale").visible)
    uxFind(window.contentItem, "actionCheck-''' + ACTION + '''").click()
    check("checking is optimistic", detailView.notesDocument.effectiveStatus({actionId: "''' + ACTION + '''", status: "open"}) === "done")
    check("another action of the same recording waits for this save", !detailView.notesDocument.actionEditable(detailView.notesDocument.findAction("''' + DONE_ACTION + '''")))'''),
        ('action saved', '!hasPending("action-set") && toast.opened', '''
    check("undo offered", toast.actionText === "Desfazer" && toast.message === "Ação concluída")
    check("no error or notice from the action", errorText === "" && notice.indexOf("ação") < 0)
    toast.actionButton.clicked()'''),
        ('undo saved', ('!hasPending("action-set") && detailView.notesDocument.effectiveStatus({actionId: "' + ACTION + '", status: "done"}) === "open" && !detailView.notesDocument.actionState["' + ACTION + '"].pending'), '''
    check("undo reopened the action", true)
    uxFind(window.contentItem, "actionCheck-''' + DONE_ACTION + '''").click()'''),
        ('second action saved', ('!hasPending("action-set") && !detailView.notesDocument.filePending("' + SHA + '") && detailView.notesDocument.effectiveStatus(detailView.notesDocument.findAction("' + DONE_ACTION + '")) === "open"'), '''
    check("a second action of the same recording is saved against the recording's current revision", !toast.opened)
    uxFind(window.contentItem, "citation-s3").activate(true)'''),
        ('transcript focus', 'tabs.currentIndex === 0 && detailView.flashIndex >= 0', '''
    check("Shift on a citation shows the transcript at that segment", detailView.flashIndex === 2)
    tabs.currentIndex = 1'''),
        ('citation seeks', 'tabs.currentIndex === 1 && !!uxFind(window.contentItem, "citation-s2") && uxFind(window.contentItem, "citation-s2").visible', '''
    uxFind(window.contentItem, "citation-s2").clicked()
    check("a citation waits for the media and seeks once it is ready", pendingSeek === 42)'''),
        ('scrolled', 'tabs.currentIndex === 1 && detailView.notesDocument.contentHeight > detailView.notesDocument.height', '''
    const doc = detailView.notesDocument
    check("the notes are long enough to scroll", doc.contentHeight > doc.height)
    uxScroll = Math.min(60, doc.contentHeight - doc.height); doc.contentY = uxScroll
    refreshLibrary()'''),
        ('list refreshed', '!hasPending("list") && !hasPending("detail") && !detailLoading', '''
    check("a refresh of the list (a job finished) keeps the place in the notes", uxScroll > 0 && Math.abs(detailView.notesDocument.contentY - uxScroll) < 1)''')]),
    'conflict': ('1320x820', False, [OPEN,
        ('document rendered', '!!uxFind(window.contentItem, "actionCheck-' + ACTION + '")', 'uxFind(window.contentItem, "actionCheck-' + ACTION + '").click()'),
        ('conflict answered', '!hasPending("action-set") && toast.opened', '''
    check("the action rolls back", detailView.notesDocument.effectiveStatus({actionId: "''' + ACTION + '''", status: "open"}) === "open")
    check("the conflict is said in the toast, not in errorText or notice", toast.message.indexOf("outra janela") >= 0 && errorText === "" && notice.indexOf("ações") < 0)''')]),
    'legacy': ('1320x820', True, [OPEN,
        ('fallback rendered', 'detailView.notesDocument.docState === "legacy"', '''
    check("older summaries use the same document", detailView.notesDocument.legacyBlocks.length === 4)
    check("template chip says the format is older", uxFind(window.contentItem, "templateChip").chipText.indexOf("Formato antigo") === 0)
    check("a [mm:ss] bullet gets a citation", !!uxFind(window.contentItem, "legacyCitation-2") && uxFind(window.contentItem, "legacyCitation-2").start === 42)
    check("contextArea keeps the summary text on tab 1", contextArea.text.indexOf("Lançamento no dia 30") >= 0)
    check("no notes doc ops without a v2 document", !hasPending("action-set"))
    uxFind(window.contentItem, "notesAboutToggle").clicked()
    check("an older summary made before your transcript corrections says so", uxFind(window.contentItem, "notesStale").visible && uxFind(window.contentItem, "notesSource").text === "Feitas antes das suas correções na transcrição.")''')]),
    'mine': ('1320x820', False, [OPEN,
        ('switch to my notes', None, 'detailView.notesMode.currentIndex = 1'),
        ('notes loaded', 'detailView.notesEditor.loaded', '''
    check("the notepad shows your lines", detailView.notesEditor.area.text.indexOf("terminei o fluxo de login") === 0 && detailView.notesEditor.rev === 3)
    detailView.notesEditor.area.text = detailView.notesEditor.area.text + "\\nperguntar sobre o orçamento"
    detailView.notesEditor.saveNow()'''),
        ('saved', '!detailView.notesEditor.saving && detailView.notesEditor.rev === 4', '''
    check("the save state says it saved", uxFind(detailView, "notesSaveState").text.indexOf("Salvo") === 0)
    check("no error or notice from notes", errorText === "" && notice.indexOf("notas") < 0)
    const editor = detailView.notesEditor
    editor.area.text = editor.area.text + "\\nconfirmar a data"
    editor.saveNow()
    check("a second save is on its way", editor.saving)
    editor.area.text = editor.area.text + " com a Ana"
    detailView.notesMode.currentIndex = 0'''),
        ('closed during a save', '!hasPending("notes-save") && !detailView.notesEditor.flush', '''
    check("what was typed during that save is sent once it answers", detailView.notesEditor.flush === null && !detailView.notesEditor.loaded)''')]),
    'processing-en': ('900x640', True, [(OPEN[0], OPEN[1], 'check("opens on Notes", tabs.currentIndex === 1)'),
        ('progress', 'detailView.notesDocument.docState === "processing" && compactLayout', '''
    check("English interface", uiLanguage === "en")
    check("progress shown while the notes are made", uxFind(window.contentItem, "notesProgress").visible)
    check("your notes stay visible meanwhile", detailView.notesDocument.myNotes.length === 2)
    check("tabs use short labels in compact layout", tabs.useShortLabels)''')]),
    'search': ('1320x820', False, [
        ('library loaded', 'items.length === 2 && features.librarySearch === true', 'search.text = "SSO integrado"'),
        ('search offered', '!!uxFind(window.contentItem, "librarySearchButton") && uxFind(window.contentItem, "librarySearchButton").visible', '''
    check("no title matches, the transcripts can be searched", filtered.length === 0)
    uxFind(window.contentItem, "librarySearchButton").clicked()'''),
        ('hits', '!!uxFind(window.contentItem, "searchHit-0")', '''
    check("hits show the passage", uxFind(window.contentItem, "searchHit-0").modelData.snippet.indexOf("SSO") >= 0)
    uxFind(window.contentItem, "searchHit-0").clicked()'''),
        ('opened at the passage', 'selected.key === "/synthetic/Recordings/daily.mkv"', '''
    check("the meeting opens on its notes and the moment waits for the media", currentView === "meeting" && pendingSeek === 42)
    selectRecording(items.find(function(item){ return item.key === "/synthetic/Recordings/one.mkv" }))'''),
        # A meeting cannot close while a transcript correction is unconfirmed: a hit then must not seek the open one.
        ('other meeting open', 'selected.key === "/synthetic/Recordings/one.mkv" && !detailLoading', '''
    const held = Object.assign({}, pending); held["999999"] = {op: "revision-save", key: ""}; pending = held
    uxFind(window.contentItem, "searchHit-0").clicked()
    check("a hit that cannot open its meeting leaves the open one alone", selected.key === "/synthetic/Recordings/one.mkv" && pendingSeek === -1 && detailView.flashIndex === -1)
    const released = Object.assign({}, pending); delete released["999999"]; pending = released''')]),
    'no-features': ('1320x820', False, [OPEN,
        ('document without features', '!!uxFind(window.contentItem, "actionCheck-' + ACTION + '")', '''
    check("my notes are not offered", !detailView.notesMode.visible)
    check("actions are read-only", !uxFind(window.contentItem, "actionCheck-''' + ACTION + '''").enabled)
    const row = uxFind(window.contentItem, "librarySearchButton"); check("no library search row", !(row && row.visible))''')]),
}
DETAIL_FOR = {'v2': 'v2', 'conflict': 'v2', 'legacy': 'legacy', 'mine': 'v2', 'processing-en': 'processing', 'search': 'v2', 'no-features': 'v2'}
FAMILY = ('notes-', 'live-', 'templates-', 'assistant-', 'recipes-', 'share-', 'actions-', 'action-', 'people-', 'person-', 'clients-', 'client-', 'meeting-client-', 'meeting-override', 'home-', 'inbox-', 'first-run-', 'media-', 'library-search', 'summary-prefs-')
MINE_TEXT = NOTES['text'] + '\nperguntar sobre o orçamento'

checks, screens = [], []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-notes-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    media = root / 'synthetic.mkv'; media.write_bytes(b'')
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (size, light, plan) in PLANS.items():
        qml = root / mode; qml.mkdir()
        width, height = size.split('x')
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        # The theme and size first (no bridge reply needed), then the steps; the snapshot follows the last one.
        steps = [(200, 'true', f'window.lightTheme = {"true" if light else "false"}; window.width = {width}; window.height = {height}')]
        steps += [step(mode, *entry) for entry in plan]
        (qml / 'Main.qml').write_text(base[:-1] + HELPERS + qml_steps(steps, 400) + '}\n'); copy_qml_siblings(qml)
        image, log = out / f'notes-{mode}.png', root / f'{mode}-requests.jsonl'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'), 'TMPDIR': str(root / 'tmp'),
               'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen', 'QT_QUICK_BACKEND': 'software', 'QT_FORCE_STDERR_LOGGING': '1',
               'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '' if mode == 'search' else '/synthetic/Recordings/daily.mkv',
               # A deadline only: the PySide6 runner snapshots as soon as the last step ran (qaSnapshotReady).
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '20000',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_REQUEST_LOG': str(log), 'FALATRACE_DETAIL': json.dumps(DETAILS[DETAIL_FOR[mode]]),
               'FALATRACE_NOTES': json.dumps(NOTES), 'FALATRACE_SYNTHETIC_MEDIA': str(media)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=60)
        (out / f'notes-{mode}.stderr').write_text(r.stderr)
        # A step that threw is already a failed check on its assertion line; anything else is a QML failure.
        problems = [line for line in r.stderr.splitlines() if 'UX_ASSERTIONS ' not in line and any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
        if not image.exists() or problems:
            raise SystemExit(f'QML failure in {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
        require_assertion_lines(r.stderr, 'UX_ASSERTIONS ', len(plan), mode)
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        def sent(op): return [q for q in requests if q['op'] == op]
        if mode == 'v2':
            sets = sent('action-set')
            checks.append({'name': 'v2: action-set sends the action and the revision it read, then undo with the new one',
                           'pass': [q['payload'] for q in sets][:2] == [{'mediaSha256': SHA, 'actionId': ACTION, 'status': 'done', 'expectedRev': 1},
                                                                        {'mediaSha256': SHA, 'actionId': ACTION, 'status': 'open', 'expectedRev': 2}]})
            checks.append({'name': 'v2: another action of the same recording is sent with the revision the last save returned',
                           'pass': [q['payload'] for q in sets][2:] == [{'mediaSha256': SHA, 'actionId': DONE_ACTION, 'status': 'open', 'expectedRev': 3}]})
        if mode == 'conflict':
            checks.append({'name': 'conflict: detail is read again after a conflicting action', 'pass': len(sent('detail')) >= 2})
        if mode == 'mine':
            reads, saves = sent('notes-read'), sent('notes-save')
            checks.append({'name': 'mine: notes-read uses the notes id', 'pass': len(reads) == 1 and reads[0]['key'] == JOB})
            checks.append({'name': 'mine: notes-save sends the whole text with the revision it read',
                           'pass': len(saves) >= 1 and saves[0]['key'] == JOB and saves[0]['payload'] == {'text': MINE_TEXT, 'expectedRev': 3}})
            checks.append({'name': 'mine: text typed while a save runs follows it, with the revision that save returned',
                           'pass': [q['key'] for q in saves] == [JOB] * 3 and [q['payload'] for q in saves[1:]] == [
                               {'text': MINE_TEXT + '\nconfirmar a data', 'expectedRev': 4}, {'text': MINE_TEXT + '\nconfirmar a data com a Ana', 'expectedRev': 5}]})
        if mode in ('legacy', 'processing-en'):
            checks.append({'name': f'{mode}: nothing saved or toggled', 'pass': not sent('notes-save') and not sent('action-set')})
        if mode == 'search':
            searches = sent('library-search')
            checks.append({'name': 'search: library-search sends the query typed', 'pass': len(searches) == 1 and searches[0]['payload'] == {'query': 'SSO integrado', 'limit': 20}})
        if mode == 'no-features':
            checks.append({'name': 'no-features: no new op family is sent without its flag', 'pass': not any(q['op'].startswith(FAMILY) for q in requests)})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'notes-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
