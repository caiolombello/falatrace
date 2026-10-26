#!/usr/bin/env python3
"""Início (Home) in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode drives Home with studio_fixture.qml_steps (every step waits,
bounded, for the state the previous reply produces, never a fixed delay): the next meetings with
what was left from the last one and the Pular/Gravar choice (meeting-override; a "record" the call
monitor cannot do opens the capture confirmation instead), ticking an open action, the first-run
card and its celebration with the time to the first notes, the list read again once the background
index refresh ends, links from outside (inbox-take) that only navigate, the "Notas prontas" toast,
the English compact page without a calendar and an older bridge. Exit 77 means no Studio runtime.
"""
from pathlib import Path
import sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-home-ux-'))
out.mkdir(parents=True, exist_ok=True)

JOB = '22222222-2222-4222-8222-222222222222'
SHA = 'a' * 64
A1 = '33333333-3333-4333-8333-333333333333'
A2 = '44444444-4444-4444-8444-444444444444'
H1 = 'a1' * 32
H2 = 'b2' * 32
STUB = r'''#!/usr/bin/python3
import sys, json, os, datetime
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a')
JOB, SHA, A1, A2, H1, H2 = (os.environ[name] for name in ('HOME_JOB', 'HOME_SHA', 'HOME_A1', 'HOME_A2', 'HOME_H1', 'HOME_H2'))
english = mode == 'no-calendar-en'
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda minutes: (now + datetime.timedelta(minutes=minutes)).isoformat()
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
features = {} if mode == 'old-bridge' else {name: (name != 'upcoming' or mode != 'no-calendar-en') for name in names}
first_run = {'first-run': {'wizardOpenedAt': iso(-30)},
             'celebration': {'wizardOpenedAt': iso(-30), 'firstRecordingAt': iso(-25), 'firstSummaryAt': iso(-21), 'ttfsMs': 222000}}.get(mode, {})
item = {'key': '/synthetic/Recordings/daily.mkv', 'recordingId': JOB, 'jobId': JOB, 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}
items = [] if mode == 'old-bridge' else [item]
brief = {'title': 'Daily do time', 'startAt': iso(90), 'endAt': iso(120), 'matchedBy': ['series'], 'people': [{'name': 'Bruno'}], 'clientCodes': [],
         'recentMeetings': [{'jobId': JOB, 'date': '2026-10-21T14:00:00Z', 'title': 'Daily do time', 'matchedBy': ['series']}],
         'openActions': [{'actionId': A1, 'mediaSha256': SHA, 'jobId': JOB, 'text': 'Revisar o PR do login', 'ownerText': 'Bruno', 'dueDate': 'quinta'}],
         'recentDecisions': [{'jobId': JOB, 'text': 'O lançamento continua no dia 30.', 'citation': {'ref': 's000001', 'jobId': JOB, 'segmentId': 's1', 'start': 3, 'title': 'Daily do time'}}],
         'lines': ['Aberto: Revisar o PR do login (Bruno)']}
upcoming = [{'eventIdHash': H1, 'title': 'Daily do time', 'startAt': iso(90), 'endAt': iso(120), 'attendees': [{'name': 'Ana', 'self': False}, {'name': 'Bruno', 'self': False}, {'name': 'Eu', 'self': True}], 'recurring': True, 'plan': 'record', 'template': {'id': 'standup', 'name': 'Daily', 'source': 'calendar', 'confidence': 1}, 'brief': brief},
            {'eventIdHash': H2, 'title': '1:1 com Ana', 'startAt': iso(5), 'endAt': iso(35), 'attendees': [{'name': 'Ana', 'self': False}], 'recurring': False, 'plan': 'notify'}]
upcoming.sort(key=lambda event: event['startAt'])
actions = [{'actionId': A1, 'mediaSha256': SHA, 'jobId': JOB, 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z', 'text': 'Revisar o PR do login', 'owner': 'Bruno', 'dueDate': 'quinta', 'status': 'open', 'origin': 'model', 'segmentIds': ['s4'], 'start': 1215, 'matchState': 'current', 'rev': 3, 'ownerPersonIds': [], 'clientCodes': []},
           {'actionId': A2, 'mediaSha256': SHA, 'jobId': JOB, 'title': 'Daily do time', 'date': '2026-10-21T14:00:00Z', 'text': 'mandar convite da demo', 'owner': 'você', 'dueDate': '', 'status': 'open', 'origin': 'note', 'segmentIds': [], 'matchState': 'current', 'rev': 3, 'ownerPersonIds': [], 'clientCodes': []}]
reads = 0; inbox = 0; jobs_calls = 0; rev = 3; overrides = {}
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': items}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': {'audioSource': 'both'}}}
    elif op == 'jobs-list':
        jobs_calls += 1
        state = 'completed' if mode == 'ready-toast' and jobs_calls > 1 else 'processing'
        v = {'items': [{'id': JOB, 'state': state, 'title': 'Daily do time', 'hasMeetingTitle': True, 'createdAt': iso(-10)}] if mode == 'ready-toast' else []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities':
        v = {'mockFrames': False, 'realFrames': False}
        if features: v.update({'features': features, 'firstRun': first_run})
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail': v = {'transcript': {'segments': [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia.'}], 'text': 'Bom dia.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []}, 'summary': '# Daily\n\n- ok', 'status': 'completed', 'backup': 'none', 'jobId': JOB}
    elif op == 'resolve': v = {'state': 'failed', 'message': 'Mídia sintética indisponível.'}
    elif op == 'home-read' and features:
        reads += 1
        events = [] if mode == 'no-calendar-en' else [dict(event, plan=overrides.get(event['eventIdHash'], event['plan'])) for event in upcoming]
        v = {'upcoming': events, 'openActions': actions, 'openActionsTotal': 2, 'processing': [], 'calendarConnected': mode != 'no-calendar-en', 'reminderMode': 'on',
             'refreshing': mode == 'refresh' and reads < 2}
    elif op == 'meeting-override' and features:
        h, decision = p['eventIdHash'], p['decision']
        event = next(event for event in upcoming if event['eventIdHash'] == h)
        if decision == 'record' and h == H2: v = {'eventIdHash': h, 'decision': decision, 'saved': False, 'startCapture': True, 'title': event['title'], 'plan': 'notify'}
        else:
            plan = 'skip' if decision == 'skip' else 'record-override' if decision == 'record' else event['plan']
            if decision == 'clear': overrides.pop(h, None)
            else: overrides[h] = plan
            v = {'eventIdHash': h, 'decision': decision, 'saved': True, 'plan': plan}
    elif op == 'action-set' and features:
        if p.get('expectedRev', rev) != rev: refuse(r, 'As ações mudaram em outra janela; recarregue e tente de novo.'); continue
        rev += 1; v = {'rev': rev, 'item': {'actionId': p['actionId'], 'mediaSha256': p['mediaSha256'], 'status': p['status']}}
    elif op == 'first-run-dismiss' and features: v = {'firstRun': dict(first_run, celebrationDismissedAt=iso(0))}
    elif op == 'inbox-take' and features:
        inbox += 1
        if mode != 'links' or inbox > 3: refuse(r, 'Não foi possível ler os pedidos de abertura do Studio.'); continue
        v = {'uris': ['falatrace://recording/' + JOB] if inbox == 1 else ['falatrace://event/' + H1] if inbox == 2 else []}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

PLANS = {
    'upcoming': ('1320x820', False, [
        ('home read', 'homeView.visible && homeView.homeLoaded && homeView.upcoming.length === 2 && captureKnown', '''
    const first = uxFind(homeView, "upcomingEvent-''' + H1 + '''")
    check("the next meetings are listed", first.visible && !!uxFind(homeView, "upcomingEvent-''' + H2 + '''"))
    check("each shows its plan", homeView.planText("record") === "Será gravada" && homeView.planText("notify") === "Só aviso")
    check("the open actions are on Início", uxFind(homeView, "homeActions").visible && !!uxFind(homeView, "homeAction-''' + A1 + '''"))
    check("no stat tiles and no recents", !uxFind(homeView, "homeEmpty").visible)
    uxFind(homeView, "eventMore-''' + H1 + '''").clicked()'''),
        ('brief open', 'homeView.expanded === "' + H1 + '" && uxFind(homeView, "briefPanel-' + H1 + '").visible', '''
    const brief = uxFind(homeView, "briefPanel-''' + H1 + '''")
    check("the brief shows what was decided and what is open", brief.decisions.length === 1 && brief.actions.length === 1 && brief.meetings.length === 1)
    uxFind(homeView, "eventSkip-''' + H1 + '''").clicked()
    check("the choice is on its way", homeView.overridePending["''' + H1 + '''"] === "skip")'''),
        ('skipped', '!homeView.overridePending["' + H1 + '"] && homeView.upcoming.some(function(event){ return event.eventIdHash === "' + H1 + '" && event.plan === "skip" })', '''
    check("the meeting shows as skipped, with undo", toast.opened && toast.actionText === "Desfazer" && toast.message.indexOf("não será gravada") >= 0)
    check("nothing about Home in errorText or notice", errorText === "" && notice.indexOf("gravad") < 0)
    uxFind(homeView, "homeActionCheck-''' + A1 + '''").click()
    check("ticking is optimistic", homeView.actionStatus({actionId: "''' + A1 + '''", status: "open"}) === "done")'''),
        ('action saved', '!hasPending("action-set") && toast.message === "Ação concluída"', '''
    check("a ticked action can be undone", toast.actionText === "Desfazer")
    homeView.expanded = "''' + H2 + '''"'''),
        ('record now offered', 'uxFind(homeView, "eventRecordNow-' + H2 + '").visible', '''
    check("a meeting starting in minutes offers Gravar agora", uxFind(homeView, "eventRecord-''' + H2 + '''").visible)
    uxFind(homeView, "eventRecord-''' + H2 + '''").clicked()'''),
        ('capture asked', 'captureConsent.visible', '''
    check("a record the call monitor cannot do asks to start the capture here, with the meeting's name", captureConsent.captureTitle === "1:1 com Ana" && !hasPending("capture-start"))
    captureConsent.reject()''')]),
    'first-run': ('1320x820', True, [
        ('home read', 'homeView.visible && homeView.homeLoaded && captureKnown', '''
    check("the first-run card shows until the first notes", uxFind(homeView, "firstRunCard").visible && homeView.firstRunState === "start")
    uxFind(homeView, "firstRunRecord").clicked()
    check("the test recording asks first, in test mode", captureConsent.visible && liveView.testMode && captureConsent.captureTitle === "Conversa de teste")
    captureConsent.reject()'''),
        ('test declined', '!captureConsent.visible', '''
    check("declining the test recording leaves no test mode behind", !liveView.testMode)
    uxFind(homeView, "homeRecord").clicked()
    check("the next recording is a real one (no one-minute stop)", captureConsent.visible && !liveView.testMode && captureConsent.captureTitle === "")
    captureConsent.close()''')]),
    'celebration': ('1320x820', False, [
        ('home read', 'homeView.visible && homeView.homeLoaded && newBridge', '''
    const card = uxFind(homeView, "firstRunCelebration")
    check("the first notes are celebrated with the measured time", card.visible && homeView.firstRunState === "done" && homeView.ttfsText(firstRun.ttfsMs) === "3 min 42 s")
    uxFind(homeView, "firstRunDismiss").clicked()
    check("closing hides it at once", !uxFind(homeView, "firstRunCelebration").visible)'''),
        ('dismissed', '!hasPending("first-run-dismiss") && !!firstRun.celebrationDismissedAt', 'check("the bridge remembers it", !homeView.firstRunShown)')]),
    'refresh': ('1320x820', False, [
        ('refreshing', 'homeView.homeLoaded && homeView.home.refreshing === true', 'check("the index refresh is seen", indexRefreshing)'),
        ('refreshed', 'homeView.home.refreshing === false && !hasPending("list")', '''
    check("Início reads again until the refresh ends", !indexRefreshing)''', 9000)]),
    'links': ('1320x820', False, [
        ('meeting link', 'selected.key === "/synthetic/Recordings/daily.mkv" && !detailLoading', '''
    check("a recording link opens the meeting on its notes", tabs.currentIndex === 1 && currentView === "meeting")'''),
        ('event link', 'currentView === "home" && homeView.expanded === "' + H1 + '"', 'check("an event link goes to Início with that meeting open", !selected.key)'),
        ('inbox stopped', 'inboxPoller.stopped', 'check("one failure stops the polling", !errorText && notice.indexOf("abertura") < 0)', 9000)]),
    'ready-toast': ('1320x820', False, [
        ('processing', 'homeView.visible && jobsLoaded && homeView.processingJobs.length === 1', 'check("Gerando notas lists the job", uxFind(homeView, "homeProcessing").visible)'),
        ('ready', 'toast.opened && toast.message.indexOf("Notas prontas") === 0', '''
    check("a finished job says Notas prontas with Abrir", toast.message === "Notas prontas: Daily do time" && toast.actionText === "Abrir")
    toast.actionButton.clicked()
    check("Abrir opens the meeting", selected.key === "/synthetic/Recordings/daily.mkv")''', 9000)]),
    'no-calendar-en': ('900x640', True, [
        ('home read', 'homeView.visible && homeView.homeLoaded && uiLanguage === "en"', '''
    check("without a calendar, one line says how to connect it", uxFind(homeView, "homeNoCalendar").visible && !uxFind(homeView, "upcomingList").visible)
    check("the open actions still show", uxFind(homeView, "homeActions").visible)
    check("English", t("Ações abertas · %1") === "Open actions · %1")''')]),
    'old-bridge': ('1320x820', False, [
        ('library read', 'homeView.visible && !loading && captureKnown && settingsFirstRunChecked', '''
    check("an empty library invites the first recording", uxFind(homeView, "homeEmpty").visible)
    check("no first-run card, no upcoming, no actions without the features", !uxFind(homeView, "firstRunCard").visible && !uxFind(homeView, "upcomingList").visible && !uxFind(homeView, "homeActions").visible && !uxFind(homeView, "homeNoCalendar").visible)''')]),
}


def env_for(mode):
    return {'HOME_JOB': JOB, 'HOME_SHA': SHA, 'HOME_A1': A1, 'HOME_A2': A2, 'HOME_H1': H1, 'HOME_H2': H2}


checks, screens, requests = run_journey_modes(command, 'home', out, STUB, PLANS, env_for, snapshot_ms=24000)


def sent(mode, op):
    return [q for q in requests[mode] if q['op'] == op]


checks.append({'name': 'upcoming: meeting-override sends the event and the decision',
               'pass': [q['payload'] for q in sent('upcoming', 'meeting-override')] == [{'eventIdHash': H1, 'decision': 'skip'}, {'eventIdHash': H2, 'decision': 'record'}]})
checks.append({'name': 'upcoming: ticking an action sends the revision it read',
               'pass': [q['payload'] for q in sent('upcoming', 'action-set')] == [{'mediaSha256': SHA, 'actionId': A1, 'status': 'done', 'expectedRev': 3}]})
checks.append({'name': 'upcoming: nothing is recorded without the confirmation', 'pass': not sent('upcoming', 'capture-start')})
checks.append({'name': 'first-run: the test recording is not started without the confirmation', 'pass': not sent('first-run', 'capture-start')})
checks.append({'name': 'celebration: first-run-dismiss is sent once', 'pass': len(sent('celebration', 'first-run-dismiss')) == 1})
ops = [q['op'] for q in requests['refresh']]
reads = [index for index, op in enumerate(ops) if op == 'home-read']
checks.append({'name': 'refresh: the list is read again after the refresh ends',
               'pass': len(reads) >= 2 and 'list' in ops[reads[1]:]})
checks.append({'name': 'links: the inbox is polled until its first failure, then never again',
               'pass': len(sent('links', 'inbox-take')) == 4})
checks.append({'name': 'old-bridge: no new op family without the features',
               'pass': not any(q['op'].startswith(('home-', 'inbox-', 'first-run-', 'meeting-override', 'actions-', 'action-')) for q in requests['old-bridge'])})
finish_journey(command, 'home', out, checks, screens)
