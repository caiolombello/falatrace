#!/usr/bin/env python3
"""The notes template picker and "Gerar de novo" in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode drives the meeting page with studio_fixture.qml_steps (every step
waits, bounded, for the state the previous reply produces, never a fixed delay): the picker opened
from the template chip (the current template marked, focus in the list and back on the chip); a
template chosen, saved for the meeting and generated on this computer (the regenerate bar, no dialog,
summary-status polled until the notes are ready, the meeting read again); another language with a
destination outside this computer in the compact English layout (SummaryDialog with the plan and a
consent box); the same run through to the end; a run stopped halfway and a failed one (the bar says
so, errorText and notice untouched); and a bridge without templates. Exit 77 means no Studio runtime
is available.
"""
from pathlib import Path
import sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-templates-ux-'))
out.mkdir(parents=True, exist_ok=True)

JOB = '22222222-2222-4222-8222-222222222222'
CONSENT = 'c' * 64
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a'); JOB = os.environ['TEMPLATES_JOB']; CONSENT = os.environ['TEMPLATES_CONSENT']
english = mode == 'consent-en'
external = mode in ('consent-en', 'external')
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
features = {name: (name != 'templates' or mode != 'no-templates') for name in names}
item = {'key': '/synthetic/Recordings/daily.mkv', 'recordingId': JOB, 'jobId': JOB, 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}
segments = [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia, vamos revisar o incidente de ontem.'}, {'id': 's2', 'start': 42, 'end': 50, 'text': 'O deploy travou por falta de acesso ao bucket.'}]
templates = [
    {'id': 'standup', 'name': 'Daily', 'description': 'Ontem, hoje e bloqueios de cada pessoa.', 'builtIn': True, 'sectionTitles': ['Ontem', 'Hoje', 'Bloqueios'], 'version': 1},
    {'id': 'postmortem', 'name': 'Postmortem', 'description': 'Linha do tempo, causa, impacto e próximos passos de um incidente.', 'builtIn': True, 'sectionTitles': ['Linha do tempo', 'Causa', 'Impacto', 'Próximos passos'], 'version': 1},
    {'id': 'one-on-one', 'name': '1:1', 'description': 'Conversa entre duas pessoas: assuntos, combinados e acompanhamento.', 'builtIn': True, 'sectionTitles': ['Assuntos', 'Combinados'], 'version': 1}]
prefs = {'id': JOB, 'rev': 0}
generated = None; runs = 0; status_polls = 0
def doc():
    template = {'id': 'standup', 'name': 'Daily', 'source': 'calendar', 'reason': 'pela agenda', 'confidence': 1} if not generated else {'id': generated, 'name': 'Postmortem', 'source': 'user', 'reason': 'você escolheu', 'confidence': 1}
    return {'version': 2, 'generatedAt': '2026-10-21T15:02:00Z', 'model': {'label': 'ollama · qwen3.5:9b', 'local': True}, 'template': template, 'language': 'pt-BR', 'stale': None, 'notesDigest': 'd' * 64,
            'overview': {'text': 'O deploy travou por falta de acesso ao bucket de produção.', 'citations': [{'segmentId': 's2', 'start': 42}]},
            'sections': [{'heading': 'Causa' if generated else 'Bloqueios', 'items': [{'kind': 'text', 'origin': 'ai', 'text': 'Falta acesso ao bucket de produção.', 'uncertain': False, 'at': '00:42', 'citations': [{'segmentId': 's2', 'start': 42}], 'noteIds': []}]}],
            'unusedNotes': [], 'orphanActions': [], 'limitations': []}
def plan(p):
    where = 'OpenAI, serviço externo' if external else 'Ollama neste computador'
    template = next(({'id': t['id'], 'name': t['name'], 'mode': 'fixed', 'source': 'user', 'confidence': 1} for t in templates if t['id'] == p.get('templateId')), {'id': 'auto', 'name': 'Automático', 'mode': 'model-choice', 'source': 'ai', 'confidence': 0.8})
    return {'status': 'planned', 'jobId': JOB, 'requestId': p['requestId'], 'consentKey': CONSENT, 'snapshotSha256': 'b' * 64, 'revision': 0,
            'provider': {'provider': 'openai' if external else 'ollama', 'model': 'gpt-5-mini' if external else 'qwen3.5:9b'}, 'chunkCount': 1, 'maxRequests': p['maxRequests'], 'inputCharacters': 96,
            'inputScope': 'reviewed-transcript', 'requiresConsent': True, 'contextIncluded': False, 'notesUsed': False, 'notesCount': 0, 'acousticLabelsUsed': False,
            'external': external, 'destination': {'provider': 'openai' if external else 'ollama', 'model': 'gpt-5-mini' if external else 'qwen3.5:9b', 'where': where},
            'template': template, 'language': p.get('language', 'pt-BR'), 'cost': {'state': 'unknown', 'estimatedUsd': None, 'description': ''},
            'budget': {'scope': 'job', 'period': 'lifetime', 'requestLimit': 8, 'providerRequestsLimit': 8}}
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': [item]}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': False, 'features': features, 'firstRun': {}}
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail':
        v = {'transcript': {'segments': segments, 'text': 'Bom dia, vamos revisar o incidente de ontem. O deploy travou por falta de acesso ao bucket.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []},
             'summary': '# Daily\n\n- ok', 'notesDoc': doc(), 'status': 'completed', 'backup': 'none', 'jobId': JOB, 'diarizationId': JOB, 'subtitleId': JOB,
             'review': {'revision': {'revision': 0, 'base': {'jobId': JOB}, 'humanReviewed': False}, 'canUndo': False, 'notes': [], 'derivedStale': False, 'segmentEditUnavailable': False}}
    elif op == 'resolve': v = {'state': 'completed', 'location': 'local', 'path': os.environ['FALATRACE_SYNTHETIC_MEDIA']}
    elif op == 'templates-list' and features['templates']: v = {'templates': templates, 'default': 'auto', 'problems': []}
    elif op == 'summary-prefs-read' and features['templates']: v = prefs
    elif op == 'summary-prefs-save' and features['templates']:
        if p.get('expectedRev') != prefs['rev']: refuse(r, 'Não foi possível ler ou salvar o modelo e o idioma escolhidos para esta reunião.'); continue
        prefs = {'id': JOB, 'rev': prefs['rev'] + 1, 'templateId': p['templateId'], 'updatedAt': '2026-10-21T15:20:00Z'}; v = prefs
    elif op == 'summary-plan': v = plan(p)
    elif op == 'summary-run':
        if p.get('consent') is not True or p.get('consentKey') != CONSENT: refuse(r, 'payload inválido'); continue
        runs += 1; status_polls = 0
        v = {'jobId': JOB, 'requestId': p['requestId'], 'status': 'running'}
    elif op == 'summary-status':
        status_polls += 1
        if mode == 'stop-fail' and runs == 1: state = 'running'
        elif status_polls < 2: state = 'running'
        elif mode == 'stop-fail': state = 'failed'
        else: state = 'completed'
        v = {'jobId': JOB, 'requestId': p['requestId'], 'status': state}
        if state == 'failed': v['error'] = 'Resumo não confirmado ou cancelado. Confira modelo local, destino, limite e consentimento. Não repita uma tentativa incerta; releia antes de preparar outro plano. Original preservado.'
        if state == 'completed':
            generated = 'postmortem' if mode == 'local' else 'standup'
            v.update({'notesUsed': False, 'generatedAt': '2026-10-21T15:30:00Z'})
    elif op == 'summary-cancel': v = {'cancelled': True}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

OPEN = ('meeting open', '!!selected.key && !detailLoading && !!detail.notesDoc && !!detail.review && newBridge && settingsFirstRunChecked', '''
    check("the template chip names the template and why", uxFind(detailView.notesDocument, "templateChip").chipText === "Daily · pela agenda" || uxFind(detailView.notesDocument, "templateChip").chipText === "Daily · from the calendar")''')
PICKER = 'detailView.templatePicker.visible && !detailView.templatePicker.loading && detailView.templatePicker.templates.length === 3 && typeof detailView.templatePicker.prefs.rev === "number"'


def menu(label):
    """Open "Gerar de novo…" and trigger one of its entries (by its Portuguese text, translated)."""
    return ('\n    detailView.summaryRegenerateButton.clicked(); const m = detailView.notesDocument.regenerateMenu; '
            'check("the regenerate menu opens", m.visible); '
            'for (let i = 0; i < m.count; i++) { const entry = m.itemAt(i); if (entry && entry.text === t("%s")) { entry.action.trigger(); break } }' % label)


PLANS = {
    'picker': ('1320x820', False, [OPEN[:2] + (OPEN[2] + '''
    uxFind(detailView.notesDocument, "templateChip").clicked()''',),
        ('picker open', PICKER, '''
    const picker = detailView.templatePicker
    check("Automático first, then every template", picker.options.length === 4 && picker.options[0].id === "auto" && picker.options[2].id === "postmortem")
    check("the current template is chosen", picker.chosen === "standup" && picker.currentId === "standup")
    check("the list has the focus", uxFind(picker.contentItem, "templateOptions").activeFocus)
    check("the picker is a modal state (shortcuts off)", uxModal)
    picker.close()'''),
        ('closed', '!detailView.templatePicker.visible', '''
    check("closing returns the focus to the chip", uxFind(detailView.notesDocument, "templateChip").activeFocus)
    uxFind(detailView.notesDocument, "templateChip").clicked()'''),
        ('open again', PICKER, '''
    const picker = detailView.templatePicker
    uxFind(picker.contentItem, "templateOption-postmortem").clicked()
    check("a click chooses without applying", picker.chosen === "postmortem" && picker.visible && summaryStage === "")''')]),
    'local': ('1320x820', False, [OPEN[:2] + (OPEN[2] + '''
    uxFind(detailView.notesDocument, "templateChip").clicked()''',),
        ('picker open', PICKER, '''
    const picker = detailView.templatePicker
    uxFind(picker.contentItem, "templateOption-postmortem").clicked()
    uxFind(picker.contentItem, "templateApply").clicked()
    check("applying closes the picker and asks first", !picker.visible && summaryStage === "confirm" && !summaryDialog.visible)
    check("the bar names the template", uxFind(detailView.regenerateBar, "regenerateMessage").text.indexOf("Gerar de novo com “Postmortem”?") === 0)'''),
        ('choice saved', 'detailView.templatePicker.prefs.rev === 1', '''
    check("the saved choice reaches the picker even though the regeneration moved on", detailView.templatePicker.prefs.templateId === "postmortem")
    uxFind(detailView.regenerateBar, "regenerateConfirm").clicked()'''),
        ('running', 'summaryStage === "running" && summaryPolling', '''
    check("on this computer the click on Gerar was the consent: no dialog", !summaryDialog.visible)
    check("the bar shows progress with the template", uxFind(detailView.regenerateBar, "regenerateMessage").text === "Gerando com “Postmortem”…")
    check("the notes stay readable while they are made again", detailView.notesDocument.opacity < 1 && !!detail.notesDoc)'''),
        ('finished', 'summaryStage === "" && !detailLoading && detail.notesDoc.template.id === "postmortem"', '''
    check("the notes say they were updated, in a toast", toast.message === "Notas atualizadas com “Postmortem”." && notice === "" && errorText === "")
    check("the chip shows the new template", uxFind(detailView.notesDocument, "templateChip").chipText === "Postmortem · você escolheu")
    check("the bar is gone", !detailView.regenerateBar.visible)''')]),
    'consent-en': ('900x640', True, [OPEN[:2] + (OPEN[2] + menu('Gerar em inglês'),),
        ('confirm', 'summaryStage === "confirm"', '''
    check("the bar names the language", uxFind(detailView.regenerateBar, "regenerateMessage").text === "Generate the notes again? In English. The AI notes will be rewritten; yours stay.")
    uxFind(detailView.regenerateBar, "regenerateConfirm").clicked()'''),
        ('consent', 'summaryStage === "consent" && summaryDialog.visible && !!summaryPlan.requestId', '''
    check("a destination outside this computer asks first, with the plan", uxFind(summaryDialog.contentItem, "summaryPlanInfo").text.indexOf("OpenAI") >= 0)
    check("Cancel has the focus", uxFind(summaryDialog.footer, "summaryCancelButton").activeFocus)
    check("nothing goes before the box is ticked", !uxFind(summaryDialog.footer, "summaryRunButton").enabled)
    summaryConsent.checked = true
    check("the box enables Enviar e gerar", uxFind(summaryDialog.footer, "summaryRunButton").enabled)''')]),
    'external': ('1320x820', True, [OPEN[:2] + (OPEN[2] + menu('Gerar de novo'),),
        ('confirm', 'summaryStage === "confirm"', '''
    check("the bar asks before anything", uxFind(detailView.regenerateBar, "regenerateMessage").text === "Gerar as notas de novo? As notas da IA serão reescritas; as suas ficam.")
    uxFind(detailView.regenerateBar, "regenerateConfirm").clicked()'''),
        ('consent', 'summaryStage === "consent" && summaryDialog.visible && !!summaryPlan.requestId', '''
    summaryConsent.checked = true
    uxFind(summaryDialog.footer, "summaryRunButton").clicked()
    check("sending closes the dialog and shows progress in the bar", !summaryDialog.visible && summaryStage === "running")'''),
        ('finished', 'summaryStage === "" && !detailLoading && toast.message !== ""', '''
    check("the notes say they were updated", toast.message === "Notas atualizadas." && notice === "" && errorText === "")''')]),
    'stop-fail': ('1320x820', False, [OPEN[:2] + (OPEN[2] + menu('Gerar de novo'),),
        ('confirm', 'summaryStage === "confirm"', 'uxFind(detailView.regenerateBar, "regenerateConfirm").clicked()'),
        ('running', 'summaryStage === "running" && summaryPolling', '''
    check("the regenerate button waits while the notes are made", !detailView.summaryRegenerateButton.enabled)
    uxFind(detailView.regenerateBar, "regenerateCancel").clicked()'''),
        ('stopped', 'summaryStage === "" && toast.message !== ""', '''
    check("stopping keeps the notes there were", toast.message === "Geração cancelada. As notas anteriores continuam." && !!detail.notesDoc)
    ''' + menu('Gerar de novo')),
        ('confirm again', 'summaryStage === "confirm"', 'uxFind(detailView.regenerateBar, "regenerateConfirm").clicked()'),
        ('failed', 'summaryStage === "failed"', '''
    check("a failure is said in the bar", uxFind(detailView.regenerateBar, "regenerateMessage").text.indexOf("Não deu para gerar as notas.") === 0 && uxFind(detailView.regenerateBar, "regenerateRetry").visible)
    check("errorText and notice stay untouched", errorText === "" && notice === "")
    check("the notes there were stay", !!detail.notesDoc && detail.notesDoc.template.id === "standup")''')]),
    'no-templates': ('1320x820', False, [
        ('meeting open', OPEN[1], '''
    const chip = uxFind(detailView.notesDocument, "templateChip")
    check("without templates the chip only informs", !chip.enabled && !chip.pickable)
    chip.clicked()
    check("and opens nothing", !detailView.templatePicker.visible)
    check("Gerar de novo is still there", detailView.summaryRegenerateButton.visible && detailView.summaryRegenerateButton.enabled)''')]),
}


def env_for(mode):
    return {'RECORDING_DESKTOP_SMOKE_KEY': '/synthetic/Recordings/daily.mkv', 'TEMPLATES_JOB': JOB, 'TEMPLATES_CONSENT': CONSENT}


checks, screens, requests = run_journey_modes(command, 'templates', out, STUB, PLANS, env_for)


def sent(mode, op):
    return [q for q in requests[mode] if q['op'] == op]


def payloads(mode, op):
    return [q.get('payload', {}) for q in sent(mode, op)]


plan = payloads('local', 'summary-plan')
run = payloads('local', 'summary-run')
checks += [
    {'name': 'picker: templates and the saved choice are read once; nothing is saved or planned before applying',
     'pass': len(sent('picker', 'templates-list')) == 1 and [q['key'] for q in sent('picker', 'summary-prefs-read')] == [JOB, JOB]
     and not sent('picker', 'summary-prefs-save') and not sent('picker', 'summary-plan')},
    {'name': 'local: the choice is saved for the meeting with its revision',
     'pass': [(q['key'], q['payload']) for q in sent('local', 'summary-prefs-save')] == [(JOB, {'expectedRev': 0, 'templateId': 'postmortem'})]},
    {'name': 'local: the plan asks for the chosen template, with the request limit',
     'pass': len(plan) == 1 and set(plan[0]) == {'requestId', 'maxRequests', 'templateId'} and plan[0]['maxRequests'] == 8 and plan[0]['templateId'] == 'postmortem'},
    {'name': "local: the run carries the plan's request and consent key",
     'pass': len(run) == 1 and run[0] == {'requestId': plan[0]['requestId'], 'consent': True, 'consentKey': CONSENT} if plan else False},
    {'name': 'local: summary-status is polled for that request until the notes are ready, then the meeting is read again',
     'pass': len(sent('local', 'summary-status')) >= 2 and all(p == {'requestId': plan[0]['requestId']} for p in payloads('local', 'summary-status'))
     and len(sent('local', 'detail')) >= 2 if plan else False},
    {'name': 'consent-en: the plan asks for English and nothing runs without the consent',
     'pass': [p.get('language') for p in payloads('consent-en', 'summary-plan')] == ['en'] and not sent('consent-en', 'summary-run')},
    {'name': 'external: the run goes only after the consent box',
     'pass': len(sent('external', 'summary-run')) == 1 and payloads('external', 'summary-run')[0]['consent'] is True},
    {'name': 'stop-fail: stopping cancels that request on the bridge',
     'pass': [p['requestId'] for p in payloads('stop-fail', 'summary-cancel')][:1] == [p['requestId'] for p in payloads('stop-fail', 'summary-run')][:1]
     and len(sent('stop-fail', 'summary-run')) == 2},
    {'name': 'no-templates: no template op is sent',
     'pass': not any(q['op'] in ('templates-list', 'summary-prefs-read', 'summary-prefs-save') for q in requests['no-templates'])},
]
finish_journey(command, 'templates', out, checks, screens)
