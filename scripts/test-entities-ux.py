#!/usr/bin/env python3
"""Ações, Pessoas and Clientes in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode drives one page with studio_fixture.qml_steps (every step waits,
bounded, for the state the previous reply produces, never a fixed delay): the actions table (tick,
dismiss with undo, the revision of the recording's actions file carried from one save to the next,
filters, "Só minhas", the orphaned group), people (merge with a preview, a recipe about a person),
clients (add and delete in the catalog), an invalid client catalog, the client of a meeting
(meeting-client-set), the compact English people page and the empty states.
Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-entities-ux-'))
out.mkdir(parents=True, exist_ok=True)

JOB = '22222222-2222-4222-8222-222222222222'
OTHER = '55555555-5555-4555-8555-555555555555'
SHA = 'a' * 64
SHA2 = 'b' * 64
A1 = '33333333-3333-4333-8333-333333333333'
A2 = '44444444-4444-4444-8444-444444444444'
A3 = '99999999-9999-4999-8999-999999999999'
A4 = '88888888-8888-4888-8888-888888888888'
ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a')
E = {name: os.environ['ENT_' + name] for name in ('JOB', 'OTHER', 'SHA', 'SHA2', 'A1', 'A2', 'A3', 'A4', 'ANA')}
english = mode == 'people-compact-en'
empty = mode == 'empty'
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
items = [{'key': '/synthetic/Recordings/daily.mkv', 'recordingId': E['JOB'], 'jobId': E['JOB'], 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none'},
         {'key': '/synthetic/Recordings/acme.mkv', 'recordingId': E['OTHER'], 'jobId': E['OTHER'], 'title': 'Discovery ACME', 'hasMeetingTitle': True, 'fileName': 'acme.mkv', 'modifiedAt': 1791900000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}]
def action(aid, sha, job, title, date, text, owner, due, origin, rev, state='current', clients=(), owners=()):
    return {'actionId': aid, 'mediaSha256': sha, 'jobId': job, 'title': title, 'date': date, 'text': text, 'owner': owner, 'dueDate': due, 'status': 'open', 'origin': origin,
            'segmentIds': ['s1'], 'start': 3, 'matchState': state, 'rev': rev, 'ownerPersonIds': list(owners), 'clientCodes': list(clients)}
actions = [action(E['A1'], E['SHA'], E['JOB'], 'Daily do time', '2026-10-21T14:00:00Z', 'Revisar o PR do login', 'Bruno', 'quinta', 'model', 3),
           action(E['A2'], E['SHA'], E['JOB'], 'Daily do time', '2026-10-21T14:00:00Z', 'mandar convite da demo', 'Caio', '', 'note', 3, owners=['name:caio']),
           action(E['A3'], E['SHA2'], E['OTHER'], 'Discovery ACME', '2026-10-20T10:00:00Z', 'Enviar proposta revisada', 'Ana Souza', 'sexta', 'model', 1, clients=['ACME'], owners=[E['ANA']]),
           action(E['A4'], E['SHA2'], E['OTHER'], 'Discovery ACME', '2026-10-20T10:00:00Z', 'Combinar a data do piloto', '', '', 'model', 1, state='orphaned', clients=['ACME'])]
done_actions = [dict(action(E['A1'], E['SHA'], E['JOB'], 'Daily do time', '2026-10-21T14:00:00Z', 'Revisar o PR do login', 'Bruno', 'quinta', 'model', 4), status='done')]
def meetings(n): return [{'jobId': E['JOB'], 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z', 'role': 'speaker'}, {'jobId': E['OTHER'], 'title': 'Discovery ACME', 'date': '2026-10-20T10:00:00Z', 'role': 'attendee'}][:n]
people = [{'id': 'name:caio', 'name': 'Caio', 'aliases': [], 'meetings': meetings(2), 'meetingCount': 5, 'lastMeetingAt': '2026-10-21T14:00:00Z', 'openActions': 1, 'self': True, 'hidden': False},
          {'id': E['ANA'], 'name': 'Ana Souza', 'aliases': ['Ana'], 'meetings': meetings(2), 'meetingCount': 12, 'lastMeetingAt': '2026-10-21T14:00:00Z', 'openActions': 2, 'self': False, 'hidden': False},
          {'id': 'name:ana s', 'name': 'Ana S.', 'aliases': [], 'meetings': meetings(1), 'meetingCount': 3, 'lastMeetingAt': '2026-10-15T14:00:00Z', 'openActions': 0, 'self': False, 'hidden': False}]
clients = [{'code': 'ACME', 'name': 'ACME Ltda', 'aliases': ['acme'], 'responsibleNames': [], 'meetings': [{'jobId': E['OTHER'], 'title': 'Discovery ACME', 'date': '2026-10-20T10:00:00Z', 'source': 'content-match', 'confidence': 0.9}], 'meetingCount': 4, 'lastMeetingAt': '2026-10-20T10:00:00Z', 'openActions': 1}]
decisions = [{'jobId': E['OTHER'], 'title': 'Discovery ACME', 'date': '2026-10-20T10:00:00Z', 'text': 'Piloto começa em novembro.', 'segmentIds': ['s2']}]
rev = {E['SHA']: 3, E['SHA2']: 1}
assigned = []
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': items}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': False, 'features': {name: True for name in names}, 'firstRun': {}}
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR', 'assistant.provider': 'local', 'assistant.localModel': 'qwen3.5:9b'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail':
        v = {'transcript': {'segments': [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia.'}], 'text': 'Bom dia.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []},
             'summary': '# Daily\n\n- ok', 'status': 'completed', 'backup': 'none', 'jobId': E['JOB'], 'clients': assigned}
    elif op == 'resolve': v = {'state': 'failed', 'message': 'Mídia sintética indisponível.'}
    elif op == 'home-read': v = {'upcoming': [], 'openActions': [], 'openActionsTotal': 0, 'processing': [], 'calendarConnected': True, 'reminderMode': 'on', 'refreshing': False}
    elif op == 'actions-list':
        listed = [] if empty else done_actions if p['status'] == 'done' else actions
        if p.get('personId'): listed = [a for a in listed if p['personId'] in a['ownerPersonIds']]
        v = {'items': listed, 'counts': {'open': 0 if empty else 3, 'done': 1, 'dismissed': 0, 'orphaned': 0 if empty else 1}, 'refreshing': False}
    elif op == 'action-set':
        if p.get('expectedRev') != rev[p['mediaSha256']]: refuse(r, 'As ações mudaram em outra janela; recarregue e tente de novo.'); continue
        rev[p['mediaSha256']] += 1; v = {'rev': rev[p['mediaSha256']], 'item': {'actionId': p['actionId'], 'mediaSha256': p['mediaSha256'], 'status': p['status']}}
    elif op == 'people-list': v = {'people': [] if empty else people, 'refreshing': False}
    elif op == 'person-detail':
        person = next((item for item in people if item['id'] == p['personId']), None)
        if not person: refuse(r, 'Pessoa não encontrada.'); continue
        v = dict(person, recentDecisions=decisions if person['id'] == E['ANA'] else [], openActionItems=[actions[2]] if person['id'] == E['ANA'] else [], mergedPeople=[])
    elif op == 'person-edit':
        if p['op'] == 'merge': people = [item for item in people if item['id'] != p['personId']]
        v = {'personId': p.get('targetId') or p['personId'], 'changed': True, 'rev': 2}
    elif op == 'clients-list':
        if mode == 'clients-invalid': v = {'clients': [], 'editable': False, 'catalogError': 'O catálogo de clientes é inválido; corrija o arquivo antes de editar.', 'refreshing': False}
        else: v = {'clients': clients, 'editable': True, 'refreshing': False}
    elif op == 'client-detail':
        client = next((item for item in clients if item['code'] == p['clientCode']), None)
        if not client: refuse(r, 'Cliente não encontrado.'); continue
        v = dict(client, recentDecisions=decisions, openActionItems=[actions[2]] if client['code'] == 'ACME' else [], people=[{'id': E['ANA'], 'name': 'Ana Souza', 'meetings': 4}])
    elif op == 'client-edit':
        if p['op'] == 'add':
            clients = clients + [{'code': 'BETA', 'name': p['name'], 'aliases': [], 'responsibleNames': [], 'meetings': [], 'meetingCount': 0, 'lastMeetingAt': None, 'openActions': 0}]
            v = {'code': 'BETA', 'client': {'code': 'BETA', 'name': p['name']}, 'revision': 'r2'}
        elif p['op'] == 'delete':
            clients = [item for item in clients if item['code'] != p['code']]; v = {'code': p['code'], 'revision': 'r3'}
        else: v = {'code': p['code'], 'revision': 'r4'}
    elif op == 'meeting-client-set':
        assigned = [{'code': code, 'name': next(item['name'] for item in clients if item['code'] == code), 'source': 'manual'} for code in p.get('clientCodes', [])]
        v = {'jobId': r['key'], 'clients': assigned}
    elif op == 'recipes-list': v = {'recipes': [], 'problems': []}
    elif op == 'assistant-plan':
        v = {'ready': False, 'problem': 'unreachable', 'message': 'O Ollama não respondeu.', 'destination': {'label': 'Ollama · qwen3.5:9b', 'kind': 'local', 'external': False}, 'consentKey': 'c' * 64, 'contextCharacters': 0, 'meetings': 0, 'truncated': False}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

READY = ('bridge ready', 'features.actions === true && settingsFirstRunChecked && items.length === 2', '')
PLANS = {
    'actions': ('1320x820', False, [
        (READY[0], READY[1], 'check("Ações is in the sidebar", uxFind(window.contentItem, "navActions").visible); navigate("actions")'),
        ('actions listed', 'actionsView.loaded && !actionsView.loading && actionsView.people.length === 3', '''
    check("the page opens on the open actions, grouped by meeting", actionsView.visible && actionsView.rows[0].kind === "group" && actionsView.rows[0].label.indexOf("Daily do time") === 0)
    check("each action has its row and checkbox", !!uxFind(actionsView, "actionRow-''' + A1 + '''") && !!uxFind(actionsView, "actionCheck-''' + A1 + '''"))
    check("actions gone from the current notes are grouped apart", !!uxFind(actionsView, "actionsOrphans") && actionsView.rows.filter(function(row){ return row.kind === "action" }).length === 3)
    check("Só minhas knows who you are", uxFind(actionsView, "actionsMine").visible && actionsView.selfId === "name:caio")
    actionsView.toggle(actionsView.rowAction(1))
    check("ticking is optimistic", actionsView.statusOf({actionId: "''' + A1 + '''", status: "open"}) === "done")'''),
        ('ticked', '!hasPending("action-set") && toast.message === "Ação concluída"', '''
    check("undo is offered", toast.actionText === "Desfazer")
    actionsView.setStatus(actionsView.rowAction(2), "dismissed")'''),
        ('dismissed', '!hasPending("action-set") && toast.message === "Ação descartada"', '''
    check("a dismissed action stays visible until the list is read again", actionsView.statusOf(actionsView.rowAction(2)) === "dismissed")
    check("nothing about actions in errorText or notice", errorText === "" && notice.indexOf("ação") < 0)
    uxFind(actionsView, "actionsFilter").select(1)'''),
        ('done listed', 'actionsView.statusFilter === "done" && actionsView.loaded && !actionsView.loading', '''
    check("Feitas lists the done actions", actionsView.actions.length === 1 && actionsView.actions[0].status === "done")
    uxFind(actionsView, "actionsMine").clicked()'''),
        ('mine listed', 'actionsView.mineOnly && !actionsView.loading', '''
    check("Só minhas lists only yours", actionsView.actions.length === 0)
    uxFind(actionsView, "actionsMine").clicked(); uxFind(actionsView, "actionsFilter").select(2)'''),
        ('all listed', 'actionsView.statusFilter === "all" && !actionsView.mineOnly && !actionsView.loading', 'check("Todas lists every action again", actionsView.rows.length > 0)')]),
    'people': ('1320x820', True, [
        (READY[0], READY[1], 'navigate("people")'),
        ('people listed', 'peopleView.loaded && !!peopleView.person', '''
    check("you come first and open by default", peopleView.shown[0].self === true && peopleView.selectedId === "name:caio")
    check("each person has a row", !!uxFind(peopleView, "personRow-''' + ANA + '''") && !!uxFind(peopleView, "personRow-name:ana s"))
    peopleView.select("name:ana s")'''),
        ('Ana S. open', '!!peopleView.person && peopleView.person.id === "name:ana s" && !peopleView.detailLoading', '''
    personDialog.openFor("merge", peopleView.person)'''),
        ('merge asked', 'personDialog.opened', '''
    check("merging asks with Cancel focused", uxFind(personDialog.footer, "personDialogCancel").activeFocus)
    personDialog.targetId = "''' + ANA + '''"
    check("the merge says who stays", uxFind(personDialog.contentItem, "personMergePreview").text === "Ana S. (3 reuniões) entra em Ana Souza (12 reuniões).")
    personDialog.confirm()'''),
        ('merged', '!personDialog.visible && !!peopleView.person && peopleView.person.id === "' + ANA + '" && !peopleView.detailLoading && !peopleView.loading', '''
    check("after the merge the person who stays is open", toast.message === "Pessoas mescladas." && !uxFind(peopleView, "personRow-name:ana s"))
    check("the stats line counts meetings and open actions", uxFind(peopleView, "personStats").text === "12 reuniões · última 21/10 · 2 ações abertas")
    check("open actions and decisions of the person show", !!uxFind(peopleView, "entityAction-''' + A3 + '''") && uxFind(peopleView, "personSections").decisions.length === 1)
    uxFind(peopleView, "personRecipe-promise").clicked()'''),
        ('recipe asked', '!askPanel.planning && askPanel.problem !== ""', '''
    check("a recipe about a person opens Ask with that scope", askPanel.shown && askPanel.scope.kind === "person" && askPanel.scopeText() === "Pessoa: Ana Souza")''')]),
    'clients': ('1320x820', False, [
        (READY[0], READY[1], 'navigate("clients")'),
        ('clients listed', 'clientsView.loaded && !!clientsView.client', '''
    check("each client has a row and opens", !!uxFind(clientsView, "clientRow-ACME") && clientsView.selectedCode === "ACME")
    check("the client page has stats, people and actions", uxFind(clientsView, "clientStats").text.indexOf("4 reuniões") >= 0 && !!uxFind(clientsView, "entityAction-''' + A3 + '''"))
    uxFind(clientsView, "clientAdd").clicked()'''),
        ('add asked', 'clientDialog.opened', '''
    check("Novo cliente asks with Cancel focused", clientDialog.mode === "add" && uxFind(clientDialog.footer, "clientDialogCancel").activeFocus)
    uxFind(clientDialog.contentItem, "clientDialogName").text = "Beta SA"
    clientDialog.confirm()'''),
        ('added', '!clientDialog.visible && clientsView.selectedCode === "BETA" && !!clientsView.client && !clientsView.detailLoading && !clientsView.loading', '''
    check("the new client is listed and open", toast.message === "Cliente cadastrado." && !!uxFind(clientsView, "clientRow-BETA"))
    clientDialog.openFor("delete", clientsView.client)'''),
        ('delete asked', 'clientDialog.opened', '''
    check("a delete asks first, Cancel focused", clientDialog.mode === "delete" && uxFind(clientDialog.footer, "clientDialogCancel").activeFocus)
    clientDialog.confirm()'''),
        ('deleted', '!clientDialog.visible && !clientsView.loading && !uxFind(clientsView, "clientRow-BETA")', 'check("the client is gone", toast.message === "Cliente excluído.")')]),
    'clients-invalid': ('900x640', True, [
        (READY[0], READY[1], 'navigate("clients")'),
        ('clients read', 'clientsView.loaded', '''
    check("an invalid catalog is said once", uxFind(clientsView, "clientCatalogError").visible)
    check("nothing can be edited", !uxFind(clientsView, "clientAdd").visible && !clientsView.editable)
    check("the page shows no clients", uxFind(clientsView, "clientsEmpty").visible && clientsView.clients.length === 0)''')]),
    'assign': ('1320x820', False, [
        ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && features.clients === true', '''
    check("a meeting without a client offers to set one", detailView.meetingClient === "" && uxFind(detailView, "clientChip").visible)
    clientDialog.openAssign()'''),
        ('catalog read', 'clientDialog.visible && !clientDialog.catalogLoading', '''
    check("the client can be automatic, none or one of the catalog", !!uxFind(clientDialog.contentItem, "clientAssignOption-auto") && !!uxFind(clientDialog.contentItem, "clientAssignOption-ACME"))
    clientDialog.choice = "ACME"; clientDialog.confirm()'''),
        ('assigned', '!clientDialog.visible && detailView.meetingClient === "ACME Ltda"', 'check("the meeting shows its client at once", toast.message === "Cliente desta reunião: ACME Ltda")')]),
    'people-compact-en': ('900x640', True, [
        (READY[0], READY[1] + ' && uiLanguage === "en"', 'navigate("people")'),
        ('people listed', 'peopleView.loaded', '''
    check("compact: the list comes first", uxFind(peopleView, "peopleList").visible && !uxFind(peopleView, "personPanel").visible)
    peopleView.select("''' + ANA + '''")'''),
        ('person open', '!!peopleView.person && !peopleView.detailLoading', '''
    check("compact: then the person, with a way back", uxFind(peopleView, "personPanel").visible && !uxFind(peopleView, "peopleList").visible)
    check("English", uxFind(peopleView, "personStats").text === "12 meetings · last Oct 21 · 2 open actions")''')]),
    'empty': ('1320x820', False, [
        (READY[0], READY[1], 'navigate("people")'),
        ('people empty', 'peopleView.loaded', '''
    check("no people says how they appear", uxFind(peopleView, "peopleEmpty").visible)
    navigate("actions")'''),
        ('actions empty', 'actionsView.loaded && !actionsView.loading', 'check("no actions says how they appear", uxFind(actionsView, "actionsEmpty").visible)')]),
}


def env_for(mode):
    env = {'ENT_' + name: value for name, value in {'JOB': JOB, 'OTHER': OTHER, 'SHA': SHA, 'SHA2': SHA2, 'A1': A1, 'A2': A2, 'A3': A3, 'A4': A4, 'ANA': ANA}.items()}
    if mode == 'assign': env['RECORDING_DESKTOP_SMOKE_KEY'] = '/synthetic/Recordings/daily.mkv'
    return env


checks, screens, requests = run_journey_modes(command, 'entities', out, STUB, PLANS, env_for)


def sent(mode, op):
    return [q for q in requests[mode] if q['op'] == op]


checks.append({'name': 'actions: each save carries the revision the previous save of the recording returned',
               'pass': [q['payload'] for q in sent('actions', 'action-set')] == [{'mediaSha256': SHA, 'actionId': A1, 'status': 'done', 'expectedRev': 3},
                                                                                {'mediaSha256': SHA, 'actionId': A2, 'status': 'dismissed', 'expectedRev': 4}]})
checks.append({'name': 'actions: the filters are sent to the bridge',
               'pass': [q['payload'] for q in sent('actions', 'actions-list')] == [{'status': 'open'}, {'status': 'done'}, {'status': 'done', 'personId': 'name:caio'}, {'status': 'done'}, {'status': 'all'}]})
checks.append({'name': 'people: the merge names the person who stays',
               'pass': [q['payload'] for q in sent('people', 'person-edit')] == [{'personId': 'name:ana s', 'op': 'merge', 'targetId': ANA}]})
checks.append({'name': 'people: the recipe goes with the person scope',
               'pass': [q['payload'] for q in sent('people', 'assistant-plan')] == [{'scope': {'kind': 'person', 'personId': ANA}, 'question': '', 'recipeId': 'what-did-i-promise'}]})
checks.append({'name': 'clients: add then delete in the catalog',
               'pass': [q['payload'] for q in sent('clients', 'client-edit')] == [{'op': 'add', 'name': 'Beta SA', 'code': ''}, {'op': 'delete', 'code': 'BETA'}]})
checks.append({'name': 'clients-invalid: nothing is edited', 'pass': not sent('clients-invalid', 'client-edit')})
assign = sent('assign', 'meeting-client-set')
checks.append({'name': 'assign: the meeting gets the chosen client', 'pass': len(assign) == 1 and assign[0]['key'] == JOB and assign[0]['payload'] == {'clientCodes': ['ACME']}})
finish_journey(command, 'entities', out, checks, screens)
