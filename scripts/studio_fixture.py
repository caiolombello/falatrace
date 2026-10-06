"""Shared helpers for the offscreen Studio UX journeys.

The journeys copy the Studio QML into a disposable folder, patch Main.qml with
assertion timers and run it against a stub or isolated bridge. The Studio is
split across several QML files, so every sibling file must be copied too.

The native shell (dist/desktop/recording-studio) is preferred. Without it, the
PySide6 runner (scripts/studio-qml-runner.py) renders the same QML; set
FALATRACE_QML_PYTHON to an interpreter that has PySide6, or run the journey
with one. FALATRACE_STUDIO_RUNNER=pyside forces the runner.
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
