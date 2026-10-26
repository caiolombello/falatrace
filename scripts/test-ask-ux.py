#!/usr/bin/env python3
"""Ask (the drawer beside the page) in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode drives the Ask panel with studio_fixture.qml_steps (every step
waits, bounded, for the state the previous reply produces, never a fixed delay): a question about
the open meeting answered on this computer (no consent, a streamed answer whose paragraphs cite
moments that open the meeting there), a question to the whole library sent outside this computer
(the consent card comes first, once per conversation, and nothing starts before it), recipes with
"/" and sending an answer, an assistant that is not set up, an Ollama cloud model (outside this
computer although the server is local: consent first), stopping an answer in the compact
English layout, a question left by "Nova conversa" (its run is stopped), an earlier conversation
reopened and asked again, a plan that does not say where it goes (consent first), and a bridge
without the assistant. Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import json, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-ask-ux-'))
out.mkdir(parents=True, exist_ok=True)

JOB = '22222222-2222-4222-8222-222222222222'
OTHER = '55555555-5555-4555-8555-555555555555'
LOCAL_KEY = 'c' * 64
EXTERNAL_KEY = 'd' * 64
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a')
JOB, OTHER = os.environ['ASK_JOB'], os.environ['ASK_OTHER']
english = mode == 'stop-compact-en'
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
features = {name: (mode != 'no-assistant' or name not in ('assistant', 'recipes')) for name in names}
items = [
    {'key': '/synthetic/Recordings/daily.mkv', 'recordingId': JOB, 'jobId': JOB, 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none', 'durationSeconds': 2830},
    {'key': '/synthetic/Recordings/one.mkv', 'recordingId': OTHER, 'jobId': OTHER, 'title': '1:1 com Ana', 'hasMeetingTitle': True, 'fileName': 'one.mkv', 'modifiedAt': 1791900000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}]
segments = [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia, vamos manter o lançamento no dia 30.', 'speaker': 'Ana'},
            {'id': 's2', 'start': 42, 'end': 50, 'text': 'O SSO já está integrado.', 'speaker': 'Bruno'},
            {'id': 's3', 'start': 610, 'end': 622, 'text': 'Falta acesso ao bucket de produção.', 'speaker': 'Bruno'}]
def detail(job):
    return {'transcript': {'segments': segments, 'text': ' '.join(s['text'] for s in segments), 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []},
            'summary': '# Daily\n\n- Lançamento mantido no dia 30', 'status': 'completed', 'backup': 'none', 'jobId': job,
            'review': {'revision': {'revision': 0, 'base': {'jobId': job}}, 'canUndo': False, 'notes': [], 'derivedStale': False}}
cloud = mode == 'local-cloud-model'
external = mode == 'library-consent' or cloud
destination = {'label': 'OpenRouter · deepseek/deepseek-v4.1-flash-1017', 'kind': 'api', 'external': True} if external else {'label': 'Ollama · qwen3.5:9b', 'kind': 'local', 'external': False}
# The runner marks an Ollama cloud model external even when the server is this computer's.
if cloud: destination = {'label': 'Ollama · gpt-oss:120b-cloud', 'kind': 'local', 'external': True}
if mode == 'unsaid': destination = {'label': 'Ollama · qwen3.5:9b', 'kind': 'local'}
consent_key = os.environ['ASK_EXTERNAL_KEY'] if external else os.environ['ASK_LOCAL_KEY']
runs = {}; counter = 0
recipes = [{'id': 'follow-up-email', 'name': 'E-mail de follow-up', 'description': 'A follow-up email.', 'scope': 'meeting', 'builtIn': True, 'prompt': 'x', 'version': 1},
           {'id': 'risks', 'name': 'Riscos e mitigações', 'description': 'Risks.', 'scope': 'meeting', 'builtIn': True, 'prompt': 'x', 'version': 1},
           {'id': 'prep-next-meeting', 'name': 'Preparar a próxima reunião', 'description': 'Prep.', 'scope': 'library', 'builtIn': True, 'prompt': 'x', 'version': 1},
           {'id': 'what-did-i-promise', 'name': 'O que eu prometi', 'description': 'Promises.', 'scope': 'library', 'builtIn': True, 'prompt': 'x', 'version': 1}]
def answer(scope):
    if scope.get('kind') == 'library':
        return ('A equipe manteve o lançamento no dia 30 [1].\n\nNa 1:1 com a Ana, o SSO ficou pronto [2].',
                [{'n': 1, 'jobId': JOB, 'segmentId': 's1', 'start': 3, 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z'},
                 {'n': 2, 'jobId': OTHER, 'segmentId': 's2', 'start': 42, 'title': '1:1 com Ana', 'date': '2026-10-20T10:00:00Z'}])
    return ('A equipe manteve o lançamento no dia 30 [1].\n\nO único bloqueio é o acesso ao bucket [2].',
            [{'n': 1, 'jobId': JOB, 'segmentId': 's1', 'start': 3, 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z'},
             {'n': 2, 'jobId': JOB, 'segmentId': 's3', 'start': 610, 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z'}])
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': items}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': False, 'features': features, 'firstRun': {}}
    elif op == 'settings-read':
        values = {'studio.language': 'en' if english else 'pt-BR', 'assistant.provider': 'api' if external and not cloud else 'local', 'assistant.localModel': 'gpt-oss:120b-cloud' if cloud else 'qwen3.5:9b', 'assistant.apiPreset': 'openrouter',
                  'summary.ollamaUrl': 'http://gpu-box.lan:11434' if mode == 'not-configured' else 'http://127.0.0.1:11434'}
        v = {'revision': 'a' * 64, 'exists': True, 'values': values, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail': v = detail(OTHER if r['key'].endswith('one.mkv') else JOB)
    elif op == 'resolve': v = {'state': 'failed', 'message': 'Mídia sintética indisponível.'}
    elif op == 'home-read': v = {'upcoming': [], 'openActions': [], 'openActionsTotal': 0, 'processing': [], 'calendarConnected': True, 'reminderMode': 'on', 'refreshing': False}
    elif op == 'recipes-list' and features['recipes']: v = {'recipes': recipes, 'problems': []}
    elif op == 'assistant-plan' and features['assistant']:
        if mode == 'not-configured':
            v = {'ready': False, 'problem': 'missing-key', 'message': 'Falta a chave da API. Salve-a em Configurações › Perguntar.', 'destination': destination, 'consentKey': consent_key, 'contextCharacters': 0, 'meetings': 0, 'truncated': False}
        else:
            v = {'ready': True, 'destination': destination, 'consentKey': consent_key, 'contextCharacters': 18200 if external else 5200, 'meetings': 4 if external else 1, 'truncated': False}
    elif op == 'assistant-start' and features['assistant']:
        # Like the runner: outside this computer only with the consent key the plan gave.
        if external and p.get('consentKey') != consent_key: refuse(r, 'Confirme o envio para este destino antes de perguntar.'); continue
        counter += 1
        run_id = '6666666%d-6666-4666-8666-666666666666' % counter
        thread = p.get('threadId') or '77777777-7777-4777-8777-777777777777'
        runs[run_id] = {'polls': 0, 'thread': thread, 'scope': p['scope']}
        v = {'runId': run_id, 'threadId': thread}
    elif op == 'assistant-poll' and features['assistant']:
        run = runs.get(p['runId'])
        if not run: refuse(r, 'Esta pergunta não está mais disponível.'); continue
        run['polls'] += 1
        text, citations = answer(run['scope'])
        if mode == 'stop-compact-en' or run['polls'] < 2:
            v = {'status': 'running', 'threadId': run['thread'], 'text': text.split('\n\n')[0][:30], 'citations': []}
        else:
            v = {'status': 'done', 'threadId': run['thread'], 'text': text, 'citations': citations, 'saved': True}
    elif op == 'assistant-cancel' and features['assistant']: v = {'runId': p['runId'], 'cancelled': True}
    elif op == 'assistant-threads' and features['assistant']: v = {'threads': [{'id': '99999999-9999-4999-8999-999999999999', 'title': 'O que foi decidido?', 'updatedAt': '2026-10-21T15:00:00Z', 'messageCount': 2}]}
    elif op == 'assistant-thread' and features['assistant']:
        text, citations = answer({'kind': 'meeting'})
        v = {'id': p['threadId'], 'title': 'O que foi decidido?', 'scope': {'kind': 'meeting', 'jobId': JOB}, 'updatedAt': '2026-10-21T15:00:00Z',
             'messages': [{'role': 'user', 'text': 'O que foi decidido?', 'citations': [], 'createdAt': '2026-10-21T15:00:00Z', 'destination': 'Ollama · qwen3.5:9b'},
                          {'role': 'assistant', 'text': text, 'citations': citations, 'createdAt': '2026-10-21T15:00:05Z', 'destination': 'Ollama · qwen3.5:9b'}]}
    elif op == 'share-preview' and features['share']:
        v = {'previewId': '88888888-8888-4888-8888-888888888888', 'markdown': '# ' + p.get('title', '') + '\n\n' + p.get('text', ''), 'chars': 120, 'external': False, 'destinationLabel': 'Área de transferência', 'ready': True, 'target': 'clipboard'}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

MEETING_OPEN = ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && features.assistant === true && settingsFirstRunChecked',
                'check("Perguntar is in the meeting header", detailView.askToggle.visible); askPanel.toggle()')
ANSWERED = 'askPanel.messages.length === 2 && !askPanel.runId && !askPanel.planning'
PLANS = {
    'meeting-local': ('1320x820', False, [MEETING_OPEN,
        ('drawer open', 'askPanel.shown && askPanel.input.activeFocus', '''
    check("the scope is this meeting", uxFind(askPanel, "askScopeChip").visible && askPanel.scopeText() === "Esta reunião" && askPanel.scope.kind === "meeting")
    check("the destination is shown before asking, on this computer", uxFind(askPanel, "askDestinationChip").visible && uxFind(askPanel, "askDestinationChip").text.indexOf("Ollama") === 0 && uxFind(askPanel, "askDestinationChip").iconName === "lock")
    check("the page makes room for the drawer", detailView.width < mainArea.width - 300)
    askPanel.input.text = "O que foi decidido?"; askPanel.submit()
    check("the question goes out", askPanel.planning && askPanel.input.text === "")'''),
        ('answer streaming', '!!askPanel.live', '''
    check("this computer needs no consent", !askPanel.waiting && !uxFind(askPanel, "askConsentCard").visible)
    check("the question shows at once", askPanel.messages.length === 1 && askPanel.messages[0].text === "O que foi decidido?")'''),
        ('answer done', ANSWERED, '''
    check("the answer arrives in paragraphs", askPanel.paragraphs(askPanel.messages[1].text).length === 2)
    const first = uxFind(askPanel, "askCitation-1-1"), second = uxFind(askPanel, "askCitation-1-2")
    check("each paragraph cites its moment", !!first && !!second && askPanel.citationLabel(askPanel.messages[1].citations[1]) === "2 · 10:10")
    check("the first paragraph cites only [1]", askPanel.citationsIn(askPanel.paragraphs(askPanel.messages[1].text)[0], askPanel.messages[1].citations).length === 1)
    second.clicked()
    check("a citation of this meeting waits for the media and seeks there", pendingSeek === 610 && selected.key === "/synthetic/Recordings/daily.mkv")
    check("the drawer stays open", askPanel.shown)
    check("nothing about Ask in errorText or notice", errorText === "" && notice.indexOf("pergunt") < 0)
    uxFind(askPanel, "askCopy-1").clicked()
    check("copying the answer says so", toast.opened && toast.message === "Resposta copiada.")
    selectRecording(items[1])'''),
        ('another meeting', 'selected.key === "/synthetic/Recordings/one.mkv" && !detailLoading && !!detail.jobId', '''
    check("away from its meeting the conversation names it", askPanel.scope.jobId === "%s" && askPanel.scopeText() === "Reunião: Daily do time")''' % JOB),
        ('closing', 'true', '''
    askPanel.handleEscape()
    check("Esc closes the drawer", !askPanel.shown && !!selected.key)''')]),
    'library-consent': ('1320x820', True, [
        ('library loaded', 'items.length === 2 && features.assistant === true && settingsFirstRunChecked', 'search.text = "lançamento"'),
        ('ask from the search', '!!uxFind(window.contentItem, "askFromSearch") && uxFind(window.contentItem, "askFromSearch").visible', '''
    uxFind(window.contentItem, "askFromSearch").clicked()
    check("the search opens Ask about the whole library with the words typed", askPanel.shown && askPanel.scope.kind === "library" && askPanel.input.text === "lançamento")
    check("the destination is outside this computer before anything is sent", uxFind(askPanel, "askDestinationChip").iconName === "cloud")
    askPanel.input.text = "O que decidimos sobre o lançamento?"; askPanel.submit()'''),
        ('consent card', '!!askPanel.waiting', '''
    const card = uxFind(askPanel, "askConsentCard")
    check("a destination outside this computer asks first", card.visible && uxFind(askPanel, "askConsentText").text.indexOf("4 reuniões") >= 0 && uxFind(askPanel, "askConsentText").text.indexOf("OpenRouter") >= 0)
    check("nothing starts before the consent", !hasPending("assistant-start") && !askPanel.live && askPanel.messages.length === 0)
    uxFind(askPanel, "askConsentAccept").clicked()'''),
        ('answer done', ANSWERED, '''
    const second = askPanel.messages[1].citations[1]
    check("library citations name the meeting and the moment", askPanel.citationLabel(second) === "2 · 1:1 com Ana · 20/10 · 00:42")
    uxFind(askPanel, "askCitation-1-2").clicked()
    check("a citation of another meeting opens it at that moment", selected.key === "/synthetic/Recordings/one.mkv" && pendingSeek === 42 && askPanel.shown)'''),
        ('other meeting open', 'selected.key === "/synthetic/Recordings/one.mkv" && !detailLoading', '''
    check("the conversation keeps its scope while you navigate", askPanel.scope.kind === "library")
    askPanel.input.text = "E o bucket?"; askPanel.submit()'''),
        ('second answer', 'askPanel.messages.length === 4 && !askPanel.runId && !askPanel.planning', '''
    check("the consent is asked once per conversation", !askPanel.waiting && askPanel.messages[3].status === "done")''')]),
    'recipes': ('1320x820', False, [MEETING_OPEN,
        ('recipes loaded', 'askPanel.shown && askPanel.recipes.length === 4', '''
    askPanel.input.text = "/"
    check("/ at the start offers recipes", askPanel.recipeMode && uxFind(askPanel, "recipePicker").visible)
    check("meeting and library recipes inside a meeting", !!uxFind(askPanel, "recipeItem-follow-up-email") && !!uxFind(askPanel, "recipeItem-prep-next-meeting"))
    askPanel.input.text = "/follow"
    check("typing filters the recipes", uxFind(askPanel, "recipePicker").matches.length === 1)
    askPanel.submit()'''),
        ('recipe answered', ANSWERED, '''
    check("a recipe run shows as /name", askPanel.messages[0].text === "/E-mail de follow-up")
    uxFind(askPanel, "askShareAnswer-1").clicked()
    check("Enviar… opens the share dialog with the answer", shareDialog.visible && shareDialog.shareText === askPanel.messages[1].text && !shareDialog.jobId)'''),
        ('answer previewed', 'shareDialog.visible && !!shareDialog.preview.previewId', '''
    check("the preview shows what goes", shareDialog.previewArea.text.indexOf("lançamento") >= 0)
    check("an answer has nothing to include or exclude", !uxFind(shareDialog.contentItem, "shareInclude").visible)
    shareDialog.close()''')]),
    'not-configured': ('1320x820', False, [
        ('library loaded', 'items.length === 2 && features.assistant === true && homeView.visible', '''
    const bar = uxFind(homeView, "askBar")
    check("Início has the Ask bar", bar.visible)
    bar.clicked()
    check("the Ask bar opens the drawer about the library", askPanel.shown && askPanel.scope.kind === "library")
    check("Ollama on another computer is shown as outside this one before anything is sent", uxFind(askPanel, "askDestinationChip").iconName === "cloud" && askPanel.destinationExternal())
    askPanel.input.text = "O que eu prometi?"; askPanel.submit()'''),
        ('problem shown', 'askPanel.problem !== ""', '''
    check("an assistant that is not set up says how to fix it", uxFind(askPanel, "askProblem").visible && askPanel.problem.indexOf("chave") >= 0)
    check("nothing is started", !askPanel.live && !askPanel.messages.length && errorText === "")
    check("the question stays in the input to send again", askPanel.input.text === "O que eu prometi?")
    uxFind(askPanel, "askConfigure").clicked()'''),
        ('settings open', 'settingsDialog.visible', 'check("Configurar opens Settings on Perguntar e receitas", settingsTabs.currentIndex === 11 && errorText === "")')]),
    'local-cloud-model': ('1320x820', False, [
        ('library loaded', 'items.length === 2 && features.assistant === true && homeView.visible && studioSettings["assistant.localModel"] === "gpt-oss:120b-cloud"', '''
    uxFind(homeView, "askBar").clicked()
    check("an Ollama cloud model is outside this computer before anything is sent, though the server is local", askPanel.shown && askPanel.ollamaOnThisComputer() && askPanel.destinationExternal() && uxFind(askPanel, "askDestinationChip").iconName === "cloud")
    check("an ordinary model of that server stays here", !ollamaCloudModel("qwen3.5:9b") && ollamaCloudModel("glm-4.6:cloud"))
    askPanel.input.text = "O que eu prometi?"; askPanel.submit()'''),
        ('consent card', '!!askPanel.waiting', '''
    check("the cloud model asks first", uxFind(askPanel, "askConsentCard").visible && uxFind(askPanel, "askConsentText").text.indexOf("gpt-oss:120b-cloud") >= 0)
    check("nothing starts before the consent", !hasPending("assistant-start") && !askPanel.live && askPanel.messages.length === 0)''')]),
    'stop-compact-en': ('900x640', True, [MEETING_OPEN,
        ('drawer open', 'askPanel.shown && uiLanguage === "en"', '''
    check("English interface", askPanel.scopeText() === "This meeting")
    check("the compact drawer covers the page instead of shrinking it", detailView.width === mainArea.width && askPanel.width <= 340)
    askPanel.input.text = "What was decided?"; askPanel.submit()'''),
        ('answer streaming', '!!askPanel.runId && !!askPanel.live && askPanel.live.text !== ""', '''
    check("the send button becomes Parar", !!uxFind(askPanel, "askStop"))
    askPanel.stop()
    check("stopping keeps what arrived", askPanel.messages.length === 2 && askPanel.messages[1].status === "cancelled" && !askPanel.runId)''')]),
    'threads': ('1320x820', False, [MEETING_OPEN,
        ('drawer open', 'askPanel.shown', '''
    askPanel.start({question: "Primeira pergunta?", recipeId: "", recipeName: ""}, "%s")
    const left = askPanel.askGeneration
    uxFind(askPanel, "askNew").clicked()
    check("Nova conversa leaves the question that was starting", askPanel.askGeneration === left + 1 && !askPanel.live && !askPanel.messages.length && !askPanel.busy)''' % LOCAL_KEY),
        ('left run stopped', '!hasPending("assistant-start") && !hasPending("assistant-cancel")', '''
    check("nothing of the left question reaches the new conversation", !askPanel.live && !askPanel.messages.length && !askPanel.runId)
    uxFind(askPanel, "askThreadsButton").clicked()'''),
        ('threads listed', 'askPanel.threads.length === 1 && !askPanel.threadsLoading', '''
    askPanel.openThread(askPanel.threads[0].id)'''),
        ('thread open', 'askPanel.messages.length === 2 && !askPanel.threadsOpen', '''
    check("an earlier answer can be asked again", uxFind(askPanel, "askRetry-1").visible && askPanel.messages[1].question === "O que foi decidido?")
    askPanel.retry(1)
    check("while a question is on its way, no other conversation opens", askPanel.busy && !uxFind(askPanel, "askThreadsButton").enabled)
    askPanel.openThread(askPanel.threads[0].id)
    check("and opening one is refused", !hasPending("assistant-thread"))'''),
        ('asked again', 'askPanel.messages.length === 4 && !askPanel.runId && !askPanel.planning', '''
    check("the question is asked again in the same conversation", askPanel.messages[2].text === "O que foi decidido?" && askPanel.messages[3].status === "done" && askPanel.threadId === "99999999-9999-4999-8999-999999999999")''')]),
    'unsaid': ('1320x820', False, [MEETING_OPEN,
        ('drawer open', 'askPanel.shown', 'askPanel.input.text = "O que foi decidido?"; askPanel.submit()'),
        ('planned', '!askPanel.planning', '''
    check("a destination that does not say it stays here asks first", !!askPanel.waiting && uxFind(askPanel, "askConsentCard").visible)
    check("nothing starts before the consent", !hasPending("assistant-start") && !askPanel.live)''')]),
    'no-assistant': ('1320x820', False, [
        ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && features.assistant === false', '''
    check("no Perguntar without the assistant", !detailView.askToggle.visible)
    askPanel.toggle()
    check("Ask does not open", !askPanel.shown)
    backToLibrary()'''),
        ('home', 'homeView.visible', 'check("no Ask bar on Início", !uxFind(homeView, "askBar").visible)')]),
}
SMOKE = {'meeting-local', 'recipes', 'stop-compact-en', 'no-assistant', 'threads', 'unsaid'}


def env_for(mode):
    return {'RECORDING_DESKTOP_SMOKE_KEY': '/synthetic/Recordings/daily.mkv' if mode in SMOKE else '', 'ASK_JOB': JOB, 'ASK_OTHER': OTHER,
            'ASK_LOCAL_KEY': LOCAL_KEY, 'ASK_EXTERNAL_KEY': EXTERNAL_KEY}


checks, screens, requests = run_journey_modes(command, 'ask', out, STUB, PLANS, env_for)


def sent(mode, op):
    return [q for q in requests[mode] if q['op'] == op]


plan = sent('meeting-local', 'assistant-plan'); start = sent('meeting-local', 'assistant-start')
checks.append({'name': 'meeting-local: assistant-plan sends the meeting scope and the question',
               'pass': [q['payload'] for q in plan] == [{'scope': {'kind': 'meeting', 'jobId': JOB}, 'question': 'O que foi decidido?'}]})
checks.append({'name': 'meeting-local: assistant-start carries the plan\'s consent key and no thread yet',
               'pass': [q['payload'] for q in start] == [{'scope': {'kind': 'meeting', 'jobId': JOB}, 'question': 'O que foi decidido?', 'consentKey': LOCAL_KEY}]})
checks.append({'name': 'meeting-local: the answer is polled by run id', 'pass': len(sent('meeting-local', 'assistant-poll')) >= 2 and all(set(q['payload']) == {'runId'} for q in sent('meeting-local', 'assistant-poll'))})
starts = sent('library-consent', 'assistant-start')
checks.append({'name': 'library-consent: both questions go with the consented key, the second in the same conversation',
               'pass': len(starts) == 2 and all(q['payload'].get('consentKey') == EXTERNAL_KEY and q['payload']['scope'] == {'kind': 'library'} for q in starts)
               and 'threadId' not in starts[0]['payload'] and starts[1]['payload'].get('threadId') == '77777777-7777-4777-8777-777777777777'})
checks.append({'name': 'library-consent: the start came after the consent, never before',
               'pass': [q['op'] for q in requests['library-consent'] if q['op'].startswith('assistant-')][:2] == ['assistant-plan', 'assistant-start']})
recipe_plan = sent('recipes', 'assistant-plan')
checks.append({'name': 'recipes: a recipe is planned and started by id with no question',
               'pass': [q['payload'] for q in recipe_plan] == [{'scope': {'kind': 'meeting', 'jobId': JOB}, 'question': '', 'recipeId': 'follow-up-email'}]
               and [q['payload'].get('recipeId') for q in sent('recipes', 'assistant-start')] == ['follow-up-email']})
preview = sent('recipes', 'share-preview')
checks.append({'name': 'recipes: the answer is previewed as text, not as the meeting',
               'pass': len(preview) == 1 and preview[0]['payload']['destination'] == 'clipboard' and 'jobId' not in preview[0]['payload'] and preview[0]['payload']['title'] == 'E-mail de follow-up'})
checks.append({'name': 'not-configured: nothing is started', 'pass': not sent('not-configured', 'assistant-start')})
checks.append({'name': 'local-cloud-model: nothing is started without the consent', 'pass': len(sent('local-cloud-model', 'assistant-plan')) == 1 and not sent('local-cloud-model', 'assistant-start')})
cancels = sent('stop-compact-en', 'assistant-cancel')
checks.append({'name': 'stop-compact-en: Parar cancels the run', 'pass': len(cancels) == 1 and cancels[0]['payload']['runId'].startswith('6666666')})
thread_starts = sent('threads', 'assistant-start')
checks.append({'name': 'threads: the question left by Nova conversa has its run cancelled',
               'pass': len(thread_starts) == 2 and [q['payload']['runId'] for q in sent('threads', 'assistant-cancel')] == ['66666661-6666-4666-8666-666666666666']})
checks.append({'name': 'threads: asking again plans the question of that answer in its conversation',
               'pass': [q['payload'] for q in sent('threads', 'assistant-plan')] == [{'scope': {'kind': 'meeting', 'jobId': JOB}, 'question': 'O que foi decidido?'}]
               and thread_starts[1]['payload'].get('threadId') == '99999999-9999-4999-8999-999999999999' if len(thread_starts) == 2 else False})
checks.append({'name': 'threads: one conversation is read', 'pass': len(sent('threads', 'assistant-thread')) == 1})
checks.append({'name': 'unsaid: nothing is started without the consent', 'pass': len(sent('unsaid', 'assistant-plan')) == 1 and not sent('unsaid', 'assistant-start')})
checks.append({'name': 'no-assistant: no assistant or recipe op without the flag', 'pass': not any(q['op'].startswith(('assistant-', 'recipes-')) for q in requests['no-assistant'])})
finish_journey(command, 'ask', out, checks, screens)
