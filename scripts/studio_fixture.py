"""Shared helpers for the offscreen Studio UX journeys.

The journeys copy the Studio QML into a disposable folder, patch Main.qml with
assertion timers and run it against a stub or isolated bridge. The Studio is
split across several QML files, so every sibling file must be copied too.

The native shell (dist/desktop/recording-studio) is preferred. Without it, the
PySide6 runner (scripts/studio-qml-runner.py) renders the same QML; set
FALATRACE_QML_PYTHON to an interpreter that has PySide6, or run the journey
with one. FALATRACE_STUDIO_RUNNER=pyside forces the runner.

Timed steps never assume a bridge reply arrived after a fixed delay: qml_steps()
runs each step once the state its predecessor produces is there (bounded), and
the window then says when the snapshot can be taken.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DESKTOP = REPO / 'src/desktop'
NATIVE = REPO / 'dist/desktop/recording-studio'


def _python_with_pyside():
    candidate = os.environ.get('FALATRACE_QML_PYTHON')
    if candidate:
        return candidate if Path(candidate).is_file() else None
    if importlib.util.find_spec('PySide6') is not None:
        return sys.executable
    return None


def studio_command():
    """Command prefix that runs the Studio shell, or None when neither runtime exists."""
    if NATIVE.is_file() and os.environ.get('FALATRACE_STUDIO_RUNNER') != 'pyside':
        return [str(NATIVE)]
    python = _python_with_pyside()
    if python is None:
        return None
    return [python, str(REPO / 'scripts/studio-qml-runner.py')]


def require_studio_command():
    command = studio_command()
    if command is None:
        print('Desktop shell missing: build it with the existing SDK or install PySide6 for the QML runner.', file=sys.stderr)
        sys.exit(77)
    return command


def runner_kind(command):
    return 'native' if command and command[0] == str(NATIVE) else 'pyside6'


def copy_qml_siblings(target):
    """Copy every Studio QML file except Main.qml, which each journey patches itself."""
    target = Path(target)
    for path in sorted(DESKTOP.glob('*.qml')):
        if path.name != 'Main.qml':
            shutil.copy2(path, target / path.name)
    for path in sorted(DESKTOP.glob('*.js')):
        shutil.copy2(path, target / path.name)


def qml_sources_digest():
    import hashlib
    digest = hashlib.sha256()
    for path in sorted(DESKTOP.glob('*.qml')) + sorted(DESKTOP.glob('*.js')):
        digest.update(path.name.encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def run_studio(command, qml_folder, program, env, timeout):
    return subprocess.run([*command, str(qml_folder), str(program)], env=env, capture_output=True, text=True, timeout=timeout)


# QML that rereads the selected recording's detail exactly as Main.qml's 5 s refresh does (it runs while a
# smoke recording is selected, so a slow run can hit it between any two steps). A step that ends with it,
# followed by one that waits for `!detailLoading`, proves the state under test survives that reread.
REREAD = 'if (!detailLoading) { detailLoading = true; send("detail", selected.key) }; '


def qml_steps(steps, settle, limit=6000):
    """QML for a journey's timed steps, run strictly one after another.

    Each step is (at, ready, body) or (at, ready, body, limit). A step runs once the previous
    one ran and `ready` (a QML expression, usually the state a bridge reply produces) holds,
    never earlier than `at` ms after start nor sooner after the previous step than in the
    original schedule, and at the latest `limit` ms after that: a reply that never comes makes
    the step's assertions fail instead of hanging the journey. `settle` ms after the last step
    the window sets qaSnapshotReady; the PySide6 runner takes the snapshot then, and
    RECORDING_DESKTOP_SNAPSHOT_MS stays the deadline (the native shell has no such hook yet and
    captures at the deadline).
    """
    lines = [' property double qaStart: Date.now()', ' property int qaStep: 0', ' property double qaStepAt: 0',
             ' property bool qaSnapshotReady: false']
    previous = 0
    for index, step in enumerate(steps):
        at, ready, body = step[:3]
        bound = step[3] if len(step) > 3 else limit
        gap = max(0, at - previous)
        previous = at
        lines.append(' Timer { interval: 50; running: true; repeat: true; onTriggered: { if (qaStep !== %d) return; '
                     'const qaNow = Date.now() - qaStart, qaSince = qaNow - qaStepAt; '
                     'if (qaNow < %d || qaSince < %d || (!(%s) && qaSince < %d)) return; '
                     'stop(); qaStep = %d; qaStepAt = qaNow; { %s } } }' % (index, at, gap, ready or 'true', gap + bound, index + 1, body))
    lines.append(' Timer { interval: 50; running: true; repeat: true; onTriggered: { if (qaStep !== %d || Date.now() - qaStart - qaStepAt < %d) return; '
                 'stop(); qaSnapshotReady = true } }' % (len(steps), settle))
    return '\n' + '\n'.join(lines) + '\n'


def assertion_lines(stderr, marker):
    """How many assertion lines a run printed; fewer than its steps means the deadline cut it short."""
    return sum(1 for line in stderr.splitlines() if marker in line)


def require_assertion_lines(stderr, marker, expected, label):
    """Fail loudly when a run printed fewer assertion lines than it has assertion steps."""
    count = assertion_lines(stderr, marker)
    if count != expected:
        raise SystemExit(f'{label}: expected {expected} assertion line(s), got {count}; the run ended before every step ran')


# Window helpers for journey steps: find an item by objectName under any item, and evaluate a
# ready condition that may touch an item not built yet (false instead of a TypeError).
UX_HELPERS = '''
 function uxFind(item, name) { if (!item) return null; if (item.objectName === name) return item
  const kids = [].concat(item.children || [], item.contentItem && item.contentItem !== item ? [item.contentItem] : [])
  for (let i = 0; i < kids.length; i++) { const f = uxFind(kids[i], name); if (f) return f } return null }
 function uxTry(f) { try { return !!f() } catch (error) { return false } }
'''


def ux_step(mode, name, ready, body, limit=None):
    """A qml_steps step that waits (bounded) until `ready`, runs `body` and prints its checks as one line.

    `body` calls check(name, pass). A ready condition that never held is a failed check, so a
    missing reply cannot pass silently; a body that throws is a failed check too.
    """
    import json
    condition = 'uxTry(function(){ return %s })' % ready if ready else 'true'
    code = ('const a=[]; function check(name,pass){a.push({name:%s+name,pass:!!pass})}; ' % json.dumps(mode + ': ')
            + ('if (!(%s)) check(%s, false); ' % (condition, json.dumps('timed out waiting for ' + name)) if ready else '')
            + 'try { %s } catch (error) { check(%s + error, false) }; ' % (body, json.dumps(name + ' threw '))
            + 'console.log("UX_ASSERTIONS "+JSON.stringify(a))')
    return (0, condition, code) if limit is None else (0, condition, code, limit)


QML_FAILURES = ('ReferenceError', 'TypeError', 'failed to load component', 'Unable to assign', 'is not a type', 'unavailable')


def run_journey_modes(command, label, out, stub_source, plans, env_for, snapshot_ms=12000):
    """Run each mode of a journey against a Python stub and collect its checks and requests.

    `plans` maps a mode to (size "WxH", light theme, [(name, ready, body[, limit]), ...]); each
    entry becomes one ux_step. `env_for(mode)` adds environment (the stub reads its mode from
    FALATRACE_TEST_MODE and logs each request line to FALATRACE_REQUEST_LOG). Returns
    (checks, screens, requests) where requests[mode] is the list of request objects the stub saw.
    """
    import hashlib, json, runpy, secrets, tempfile
    out = Path(out)
    source = (DESKTOP / 'Main.qml').read_text()
    checks, screens, requests = [], [], {}
    with tempfile.TemporaryDirectory(dir='/tmp', prefix=f'falatrace-{label}-fixture-') as scratch:
        root = Path(scratch); nonce = secrets.token_hex(16)
        (root / '.falatrace-qa').write_text(nonce); (root / '.falatrace-qa').chmod(0o600)
        for name in ['home', 'runtime', 'config', 'state', 'data', 'cache', 'tmp']: (root / name).mkdir(mode=0o700)
        media = root / 'synthetic.mkv'; media.write_bytes(b'')
        stub = root / 'bridge-stub.py'; stub.write_text(stub_source); stub.chmod(0o700)
        for mode, (size, light, plan) in plans.items():
            qml = root / mode; qml.mkdir()
            width, height = size.split('x')
            base = source.replace('../../docs/assets/', (REPO / 'docs/assets').as_uri() + '/').rstrip()
            # The theme and size first (no bridge reply needed), then the steps; the snapshot follows the last one.
            steps = [(200, 'true', f'window.lightTheme = {"true" if light else "false"}; window.width = {width}; window.height = {height}')]
            steps += [ux_step(mode, *entry) for entry in plan]
            (qml / 'Main.qml').write_text(base[:-1] + UX_HELPERS + qml_steps(steps, 400) + '}\n'); copy_qml_siblings(qml)
            image, log = out / f'{label}-{mode}.png', root / f'{mode}-requests.jsonl'
            env = {'FALATRACE_QA_ISOLATED': '1', 'FALATRACE_QA_ROOT': str(root), 'FALATRACE_QA_NONCE': nonce,
                   'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state'), 'XDG_DATA_HOME': str(root / 'data'),
                   'XDG_RUNTIME_DIR': str(root / 'runtime'), 'XDG_CACHE_HOME': str(root / 'cache'), 'TMPDIR': str(root / 'tmp'),
                   'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin', 'QT_QPA_PLATFORM': 'offscreen', 'QT_QUICK_BACKEND': 'software', 'QT_FORCE_STDERR_LOGGING': '1',
                   'RECORDING_DESKTOP_SOFTWARE_SMOKE': '1', 'RECORDING_DESKTOP_SMOKE_KEY': '',
                   # A deadline only: the PySide6 runner snapshots as soon as the last step ran (qaSnapshotReady).
                   'RECORDING_DESKTOP_SNAPSHOT': str(image), 'RECORDING_DESKTOP_SNAPSHOT_MS': str(snapshot_ms),
                   'FALATRACE_TEST_MODE': mode, 'FALATRACE_REQUEST_LOG': str(log), 'FALATRACE_SYNTHETIC_MEDIA': str(media)}
            env.update(env_for(mode))
            runpy.run_path(str(REPO / 'scripts/qa-run.py'))['require_isolated'](env)
            r = run_studio(command, qml, stub, env, 60)
            (out / f'{label}-{mode}.stderr').write_text(r.stderr)
            # A step that threw is already a failed check on its assertion line; anything else is a QML failure.
            problems = [line for line in r.stderr.splitlines() if 'UX_ASSERTIONS ' not in line and any(marker in line for marker in QML_FAILURES)]
            if not image.exists() or problems:
                raise SystemExit(f'QML failure in {mode}: ' + ('\n'.join(problems) or r.stderr[-4000:]))
            require_assertion_lines(r.stderr, 'UX_ASSERTIONS ', len(plan), mode)
            for line in r.stderr.splitlines():
                if 'UX_ASSERTIONS ' in line: checks.extend(json.loads(line.split('UX_ASSERTIONS ', 1)[1]))
            requests[mode] = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            screens.append({'mode': mode, 'file': image.name, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()})
    return checks, screens, requests


def finish_journey(command, label, out, checks, screens):
    """Write the receipt, print the summary and exit 1 when a check failed (or none ran)."""
    import json
    failed = [c for c in checks if not c['pass']]
    (Path(out) / f'{label}-receipt.json').write_text(json.dumps({'actualQmlSha256': qml_sources_digest(), 'runner': runner_kind(command), 'assertions': checks,
                                                              'screens': screens, 'platform': 'Qt offscreen software', 'syntheticBackend': True}, indent=2) + '\n')
    print(json.dumps({'screens': len(screens), 'assertions': len(checks), 'failed': failed, 'output': str(out)}, ensure_ascii=False))
    if failed or not checks: sys.exit(1)
