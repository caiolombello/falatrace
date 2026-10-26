#!/usr/bin/env python3
"""Enviar (share) in the actual Studio QML against a synthetic bridge.

Offline and disposable. Each mode drives the share dialog with studio_fixture.qml_steps (every step
waits, bounded, for the state the previous reply produces, never a fixed delay): the preview first,
then Notion with the consent box (nothing goes before it), Obsidian and the clipboard straight away
(no consent on this computer), a destination changed after the preview (the dialog previews again),
an AI app in the compact English layout, a destination that is not set up, and a bridge without
sharing. Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import finish_journey, require_studio_command, run_journey_modes  # noqa: E402
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-share-ux-'))
out.mkdir(parents=True, exist_ok=True)

JOB = '22222222-2222-4222-8222-222222222222'
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; log = open(os.environ['FALATRACE_REQUEST_LOG'], 'a'); JOB = os.environ['SHARE_JOB']
english = mode == 'ai-compact-en'
names = ['notes', 'live', 'assistant', 'recipes', 'share', 'actions', 'people', 'clients', 'upcoming', 'openInbox', 'mediaRemoval', 'templates', 'librarySearch']
features = {name: (name != 'share' or mode != 'no-share') for name in names}
item = {'key': '/synthetic/Recordings/daily.mkv', 'recordingId': JOB, 'jobId': JOB, 'title': 'Daily do time', 'hasMeetingTitle': True, 'fileName': 'daily.mkv', 'modifiedAt': 1792000000000, 'location': 'local', 'status': 'completed', 'backup': 'none'}
destinations = {
    'clipboard': {'external': False, 'ready': True, 'destinationLabel': 'Área de transferência', 'target': 'clipboard'},
    'obsidian': {'external': False, 'ready': True, 'destinationLabel': 'Obsidian', 'target': '/home/synthetic/Vault/FalaTrace'},
    'notion': {'external': True, 'ready': True, 'destinationLabel': 'Notion', 'target': 'notion:page/0123456789abcdef0123456789abcdef'},
    'slack': {'external': True, 'ready': False, 'destinationLabel': 'Slack', 'problem': 'Configure o webhook do Slack em Configurações › Compartilhar.'},
    'ai-app': {'external': True, 'ready': True, 'destinationLabel': 'ChatGPT (web)', 'target': 'ai-app:chatgpt-web'}}
previews = {}; sends = 0; counter = 0
def markdown(p):
    head = '---\ntitle: "Daily do time"\n---\n\n' if p.get('frontmatter') else ''
    body = '# Daily do time\n\n## Resumo\n\nA equipe manteve o lançamento no dia 30.\n\n## Ações\n\n- [ ] Revisar o PR do login (Bruno, quinta)\n'
    return head + body + ('\n## Transcrição\n\n[00:03] Ana: Bom dia.\n' if p['include'] == 'full' else '')
def refuse(r, message): print(json.dumps({'id': r['id'], 'ok': False, 'error': message}), flush=True)
for line in sys.stdin:
    r = json.loads(line); op = r['op']; p = r.get('payload', {}); log.write(line.strip() + '\n'); log.flush()
    if op in ('list', 'list-cached'): v = {'items': [item]}
    elif op == 'capture-status': v = {'active': False, 'session': None, 'paused': False, 'audio': {'configured': False}}
    elif op == 'jobs-list': v = {'items': []}
    elif op == 'processing-status': v = {'waiting': []}
    elif op == 'ux-capabilities': v = {'mockFrames': False, 'realFrames': False, 'features': features, 'firstRun': {}}
    elif op == 'settings-read': v = {'revision': 'a' * 64, 'exists': True, 'values': {'studio.language': 'en' if english else 'pt-BR'}, 'apps': [], 'nullable': [], 'readOnly': {}, 'credentials': {'details': []}}
    elif op == 'detail': v = {'transcript': {'segments': [{'id': 's1', 'start': 3, 'end': 9, 'text': 'Bom dia.'}], 'text': 'Bom dia.', 'timing': 'segment'}, 'diarization': {'state': 'idle', 'turns': []}, 'summary': '# Daily\n\n- ok', 'status': 'completed', 'backup': 'none', 'jobId': JOB}
    elif op == 'resolve': v = {'state': 'failed', 'message': 'Mídia sintética indisponível.'}
    elif op == 'share-preview' and features['share']:
        counter += 1
        preview_id = '8888888%d-8888-4888-8888-888888888888' % (counter % 10)
        text = markdown(p); previews[preview_id] = p
        v = dict(destinations[p['destination']], previewId=preview_id, markdown=text, chars=len(text))
    elif op == 'share-send' and features['share']:
        sends += 1
        preview = previews.get(p['previewId'])
        if not preview: refuse(r, 'O conteúdo mudou desde a prévia; gere a prévia de novo antes de enviar.'); continue
        if mode == 'changed' and sends == 1: refuse(r, 'O conteúdo mudou desde a prévia; gere a prévia de novo antes de enviar.'); continue
        destination = preview['destination']
        if destinations[destination]['external'] and p.get('consent') is not True: refuse(r, 'Confirme o destino e o conteúdo antes de enviar.'); continue
        text = markdown(preview)
        if destination == 'clipboard': v = {'kind': 'returned', 'destination': 'clipboard', 'content': text, 'opened': False, 'warnings': []}
        elif destination == 'obsidian': v = {'kind': 'created', 'destination': 'obsidian', 'path': '/home/synthetic/Vault/FalaTrace/2026-10-21 14-00 — Daily do time.md', 'opened': False, 'warnings': []}
        elif destination == 'notion': v = {'kind': 'created', 'destination': 'notion', 'url': 'https://www.notion.so/synthetic-page', 'opened': False, 'warnings': []}
        else: v = {'kind': 'copied', 'destination': 'ai-app', 'content': text, 'opened': False, 'warnings': []}
    else:
        refuse(r, 'Operação recusada no fixture.'); continue
    print(json.dumps({'id': r['id'], 'ok': True, 'result': v}), flush=True)
'''

OPEN = ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && newBridge && settingsFirstRunChecked', '''
    check("Enviar is in the meeting header", detailView.shareButton.visible)
    detailView.shareButton.clicked()''')
PREVIEWED = 'shareDialog.visible && !!shareDialog.preview.previewId && !shareDialog.previewing'


def destination(name):
    return 'shareDialog.destination === "%s" && !!shareDialog.preview.previewId && !shareDialog.previewing' % name


PLANS = {
    'notion': ('1320x820', False, [OPEN,
        ('first preview', PREVIEWED, '''
    check("the preview comes first and Cancel has the focus", shareDialog.previewArea.text.indexOf("# Daily do time") === 0 && uxFind(shareDialog.footer, "shareCancel").activeFocus)
    check("copying is the default, on this computer", shareDialog.destination === "clipboard" && !shareDialog.external)
    uxFind(shareDialog.contentItem, "shareDestination-notion").clicked()'''),
        ('notion preview', destination('notion'), '''
    check("Notion is outside this computer: the consent box shows", uxFind(shareDialog.contentItem, "shareConsent").visible && shareDialog.external)
    check("nothing can be sent before the consent", !uxFind(shareDialog.footer, "shareSend").enabled)
    check("the button names the act", uxFind(shareDialog.footer, "shareSend").text === "Enviar para o Notion")
    shareDialog.consent.checked = true
    check("the consent enables sending", uxFind(shareDialog.footer, "shareSend").enabled)
    uxFind(shareDialog.footer, "shareSend").clicked()'''),
        ('sent', '!!shareDialog.sendResult', '''
    check("the result says where it went, with Abrir", uxFind(shareDialog.contentItem, "shareResultText").text === "Página criada no Notion." && uxFind(shareDialog.contentItem, "shareResult").visible)
    check("nothing about sharing in errorText or notice", errorText.indexOf("Notion") < 0 && notice.indexOf("Notion") < 0)''')]),
    'obsidian': ('1320x820', True, [OPEN,
        ('first preview', PREVIEWED, 'shareDialog.choose("obsidian")'),
        ('obsidian preview', destination('obsidian'), '''
    check("Obsidian stays on this computer: no consent", !uxFind(shareDialog.contentItem, "shareConsent").visible && uxFind(shareDialog.footer, "shareSend").enabled)
    check("Obsidian offers the YAML header", uxFind(shareDialog.contentItem, "shareFrontmatter").visible && shareDialog.previewArea.text.indexOf("---") === 0)
    shareDialog.frontmatter = false; shareDialog.requestPreview()'''),
        ('without header', destination('obsidian') + ' && shareDialog.previewArea.text.indexOf("---") !== 0', 'uxFind(shareDialog.footer, "shareSend").clicked()'),
        ('saved', '!!shareDialog.sendResult', 'check("the result names the file", uxFind(shareDialog.contentItem, "shareResultText").text.indexOf("Salvo em /home/synthetic/Vault/FalaTrace/") === 0)')]),
    'clipboard-full': ('1320x820', False, [OPEN,
        ('first preview', PREVIEWED, 'uxFind(shareDialog.contentItem, "shareInclude").select(2)'),
        ('full preview', PREVIEWED + ' && shareDialog.include === "full"', '''
    check("Tudo includes the transcript", shareDialog.previewArea.text.indexOf("## Transcrição") > 0)
    uxFind(shareDialog.footer, "shareSend").clicked()'''),
        ('copied', '!!shareDialog.sendResult', '''
    check("the content is copied here", shareDialog.sendResult.content.indexOf("## Transcrição") > 0 && uxFind(shareDialog.contentItem, "shareResultText").text === "Copiado. Cole onde quiser com Ctrl+V.")''')]),
    'changed': ('1320x820', False, [OPEN,
        ('first preview', PREVIEWED, 'shareDialog.choose("notion")'),
        ('notion preview', destination('notion'), 'shareDialog.consent.checked = true; shareDialog.sendNow()'),
        ('refused', '!!shareDialog.error && !hasPending("share-send")', '''
    check("a destination or content changed after the preview is said here", shareDialog.error.indexOf("prévia") >= 0 && errorText.indexOf("prévia") < 0)'''),
        ('previewed again', destination('notion'), '''
    check("the dialog previews again and asks the consent again", !shareDialog.consent.checked && !uxFind(shareDialog.footer, "shareSend").enabled)''')]),
    'ai-compact-en': ('900x640', True, [OPEN,
        ('first preview', PREVIEWED + ' && uiLanguage === "en"', 'shareDialog.choose("ai-app")'),
        ('ai preview', destination('ai-app'), '''
    check("an AI app needs the consent too", uxFind(shareDialog.contentItem, "shareConsent").visible)
    check("the button names the act, in English", uxFind(shareDialog.footer, "shareSend").text === "Copy and open ChatGPT (web)")
    check("the compact dialog fits the window", shareDialog.width <= window.width - 48 && shareDialog.height <= window.height - 48)
    shareDialog.consent.checked = true; shareDialog.sendNow()'''),
        ('copied', '!!shareDialog.sendResult', 'check("the result says how to paste", uxFind(shareDialog.contentItem, "shareResultText").text === "Copied. Paste it into ChatGPT (web) with Ctrl+V.")')]),
    'unconfigured': ('1320x820', False, [OPEN,
        ('first preview', PREVIEWED, 'shareDialog.choose("slack")'),
        ('slack preview', destination('slack'), '''
    check("a destination not set up says what is missing", uxFind(shareDialog.contentItem, "shareProblem").visible && uxFind(shareDialog.contentItem, "shareProblem").text.indexOf("Slack") >= 0)
    check("it cannot be sent", !uxFind(shareDialog.footer, "shareSend").enabled && !uxFind(shareDialog.contentItem, "shareConsent").visible)''')]),
    'no-share': ('1320x820', False, [
        ('meeting open', '!!selected.key && !detailLoading && !!detail.jobId && newBridge && features.share === false', '''
    check("no Enviar without the share feature", !detailView.shareButton.visible)
    shareDialog.openMeeting()
    check("the dialog does not open", !shareDialog.visible)''')]),
}


def env_for(mode):
    return {'RECORDING_DESKTOP_SMOKE_KEY': '/synthetic/Recordings/daily.mkv', 'SHARE_JOB': JOB}


checks, screens, requests = run_journey_modes(command, 'share', out, STUB, PLANS, env_for)


def sent(mode, op):
    return [q for q in requests[mode] if q['op'] == op]


previews = [q['payload'] for q in sent('notion', 'share-preview')]
checks.append({'name': 'notion: previews name the meeting and the destination',
               'pass': previews == [{'destination': 'clipboard', 'include': 'summary', 'jobId': JOB}, {'destination': 'notion', 'include': 'summary', 'jobId': JOB}]})
checks.append({'name': 'notion: the send carries the consent for the previewed destination',
               'pass': [set(q['payload']) for q in sent('notion', 'share-send')] == [{'previewId', 'consent'}] and sent('notion', 'share-send')[0]['payload']['consent'] is True})
checks.append({'name': 'obsidian: the YAML header choice is in the preview, and no consent goes',
               'pass': [q['payload'].get('frontmatter') for q in sent('obsidian', 'share-preview')][1:] == [True, False] and [set(q['payload']) for q in sent('obsidian', 'share-send')] == [{'previewId'}]})
checks.append({'name': 'clipboard-full: Tudo asks the full preview', 'pass': [q['payload']['include'] for q in sent('clipboard-full', 'share-preview')] == ['summary', 'full']})
checks.append({'name': 'changed: a refused send previews again', 'pass': len(sent('changed', 'share-send')) == 1 and len(sent('changed', 'share-preview')) == 3})
checks.append({'name': 'unconfigured: nothing is sent', 'pass': not sent('unconfigured', 'share-send')})
checks.append({'name': 'no-share: no share op without the flag', 'pass': not any(q['op'].startswith('share-') for q in requests['no-share'])})
finish_journey(command, 'share', out, checks, screens)
