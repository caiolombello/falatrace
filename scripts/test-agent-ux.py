#!/usr/bin/env python3
"""Render the Studio "Acesso para IA" dialog against a synthetic bridge.

Offline and disposable: no grant store, MCP server, assistant client or provider is
touched. The journey checks that the connection commands come from the bridge for the
active grant only, that nothing is requested for revoked grants or provider grants,
and that copying never runs anything. Exit 77 means no Studio runtime is available.
"""
from pathlib import Path
import hashlib, json, runpy, secrets, subprocess, sys, tempfile

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'scripts'))
from studio_fixture import copy_qml_siblings, qml_sources_digest, require_studio_command, runner_kind
command = require_studio_command()
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(dir='/tmp', prefix='falatrace-agent-ux-'))
out.mkdir(parents=True, exist_ok=True)
source = (repo / 'src/desktop/Main.qml').read_text()

GRANT = '123e4567-e89b-42d3-a456-426614174000'
STUB = r'''#!/usr/bin/python3
import sys, json, os
mode = os.environ['FALATRACE_TEST_MODE']; receipt = os.environ['FALATRACE_RECEIPT']
grant_id = '%s'
item = {'key':'/synthetic/Recordings/demo.mkv','recordingId':'rec-synthetic','title':'Gravação sintética','fileName':'demo.mkv','modifiedAt':'2026-10-05T12:00:00Z','location':'vaio','status':'completed','backup':'none'}
grant = {'id':grant_id,'recipient':{'kind':'agent','id':'claude-code'},'data':['context'],'scope':{'includesFuture':False,'recordingIds':['rec-synthetic']},
         'limits':{'maxFrames':2,'maxBytes':2097152,'cacheTtlMs':300000},'paused':False,'revoked':mode == 'revoked'}
line = '/home/synthetic/.local/bin/falatrace agent-context serve --grant ' + grant_id + ' --recipient claude-code'
server = 'falatrace-claude-code-' + grant_id[:8]
connection = {'grantId':grant_id,'recipientId':'claude-code','paused':False,'serverName':server,
              'claude':'claude mcp add --scope user --transport stdio ' + server + ' -- ' + line,
              'codexCommand':'codex mcp add ' + server + ' -- ' + line,
              'codexToml':'[mcp_servers.' + server + ']\ncommand = "/home/synthetic/.local/bin/falatrace"\nargs = ["agent-context","serve"]\n',
              'geminiSettings':json.dumps({'mcpServers':{server:{'command':'/home/synthetic/.local/bin/falatrace','args':['agent-context','serve']}}}, indent=2),
              'geminiSettingsPath':'~/.gemini/settings.json'}
log = []
for raw in sys.stdin:
    r = json.loads(raw); op = r['op']; p = r.get('payload', {})
    log.append({'op':op,'key':r.get('key',''),'payload':p}); open(receipt, 'w').write(json.dumps(log))
    if op in ('list', 'list-cached'): v = {'items':[item]}
    elif op == 'detail': v = {'transcript':{'segments':[],'text':'','timing':'none'},'diarization':{'state':'idle'},'status':'completed','backup':'none','recordingId':'rec-synthetic'}
    elif op == 'agent-status': v = {'grants':[grant],'budget':{'budgetLimits':{},'remainingPreviews':10,'remainingInferences':5},'capabilities':{},'providerAnalysis':{'available':False}}
    elif op == 'agent-connect': v = connection
    elif op == 'capture-status': v = {'active':False,'paused':False,'audio':{'configured':False}}
    elif op == 'jobs-list': v = {'items':[]}
    elif op == 'processing-status': v = {'waiting':[]}
    elif op == 'ux-capabilities': v = {'mockFrames':False,'realFrames':False}
    elif op == 'settings-read': v = {'revision':'a'*64,'exists':True,'values':{},'apps':[],'nullable':[],'readOnly':{},'credentials':{'details':[]}}
    else:
        print(json.dumps({'id':r['id'],'ok':False,'error':'Operação recusada no fixture.'}), flush=True); continue
    print(json.dumps({'id':r['id'],'ok':True,'result':v}), flush=True)
''' % GRANT

OPEN = 'selectRecording(items[0])'
# mode: (action at 700 ms, step at 1400 ms, step at 2200 ms, step at 3000 ms)
MODES = {
    'connect': (OPEN, 'openAgentAccess()',
                'check("connect offered for an active agent grant", !!activeGrant.id && !agentDialog.connectionShown); send("agent-connect", selected.key, { grantId: activeGrant.id })',
                'check("commands shown for the active grant", agentDialog.connectionShown && agentDialog.connectionText().indexOf("claude mcp add --scope user")===0); '
                'agentDialog.connectClient.currentIndex=3; check("gemini settings selectable", agentDialog.connectionText().indexOf("mcpServers")>=0); '
                'agentDialog.connectClient.currentIndex=0'),
    'revoked': (OPEN, 'openAgentAccess()', 'check("revoked grant hides commands", !!activeGrant.id && activeGrant.revoked && !agentDialog.connectionShown)', ''),
    'provider': (OPEN, 'openAgentAccess()', 'agentDialog.agentMode.currentIndex=1', 'check("provider mode shows no agent grant", !activeGrant.id && !agentDialog.connectionShown)'),
}
ALLOWED_CONNECT = {'connect': 1}

checks = []; screens = []
with tempfile.TemporaryDirectory(dir='/tmp', prefix='falatrace-agent-fixture-') as scratch:
    root = Path(scratch); nonce = secrets.token_hex(16)
    (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
    for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
    stub = root / 'bridge-stub.py'; stub.write_text(STUB); stub.chmod(0o700)
    for mode, (action, first, second, third) in MODES.items():
        qml = root / mode; qml.mkdir()
        base = source.replace('../../docs/assets/', (repo / 'docs/assets').as_uri() + '/').rstrip()
        def timer(ms, body):
            return (f' Timer {{ interval: {ms}; running: true; repeat: false; onTriggered: {{ const a=[]; function check(name,pass){{a.push({{name:"{mode}: "+name,pass:!!pass}})}}; '
                    f'{body}; console.log("UX_ASSERTIONS "+JSON.stringify(a)) }} }}\n')
        extra = '\n' + f' Timer {{ interval: 700; running: true; repeat: false; onTriggered: {{ {action} }} }}\n' + timer(1400, first) + timer(2200, second) + timer(3000, third)
        (qml / 'Main.qml').write_text(base[:-1] + extra + '}\n'); copy_qml_siblings(qml)
        image = out / f'agent-{mode}.png'; receipt_path = root / f'{mode}-requests.json'
        env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
               'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
               'HOME': str(root / 'home'), 'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'),
               'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen',
               'QT_QUICK_BACKEND': 'software', 'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
               'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': '3500',
               'FALATRACE_TEST_MODE': mode, 'FALATRACE_RECEIPT': str(receipt_path)}
        runpy.run_path(str(repo / 'scripts/qa-run.py'))['require_isolated'](env)
        r = subprocess.run([*command, str(qml), str(stub)], env=env, capture_output=True, text=True, timeout=40)
        (out / f'agent-{mode}.stderr').write_text(r.stderr)
        problems = [line for line in r.stderr.splitlines() if any(marker in line for marker in ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable'))]
        if not image.exists() or problems:
            raise SystemExit(f'QML failure: {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
        for line in r.stderr.splitlines():
            if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
        requests = json.loads(receipt_path.read_text()) if receipt_path.exists() else []
        connects = [q for q in requests if q['op'] == 'agent-connect']
        checks.append({'name': f'{mode}: agent-connect only for the active grant', 'pass': len(connects) == ALLOWED_CONNECT.get(mode, 0) and all(q['payload'] == {'grantId': GRANT} for q in connects)})
        checks.append({'name': f'{mode}: no authorization change', 'pass': not any(q['op'] in ('agent-authorize', 'agent-revoke', 'agent-pause', 'agent-resume', 'provider-authorize', 'provider-analyze') for q in requests)})
        screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
failed = [c for c in checks if not c['pass']]
(out / 'agent-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks, 'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
if failed or not checks: sys.exit(1)
