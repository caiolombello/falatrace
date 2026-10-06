#!/usr/bin/env python3
"""Run the Studio QML with PySide6 instead of the native Qt shell.

Mirrors src/desktop/main.cpp closely enough for offscreen UX journeys and CI:
same arguments (<qml-root> <program> [--packaged]), the same JSONL bridge
contract (ids, response validation, timeouts, bounded auto-reconnect), the same
context properties and snapshot evidence. MpvQt is replaced by an inert
RecordingVideo item: no media is decoded, so mediaReady stays false.

Requires PySide6 (pip install PySide6-Essentials). Exit 77 when it is missing.
Never use it with production media or credentials; journeys pass synthetic
HOME/XDG directories and stub or isolated bridges.
"""
import json
import os
import sys
from pathlib import Path

try:
    from PySide6.QtCore import (Property, QByteArray, QObject, QProcess, QTimer, QUrl,
                                Signal, Slot)
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlApplicationEngine, qmlRegisterType
    from PySide6.QtQuick import QQuickItem, QQuickWindow
    from PySide6.QtQuickControls2 import QQuickStyle
except ImportError:  # pragma: no cover - environment dependent
    print('PySide6 is not installed; pip install PySide6-Essentials to run the QML harness.', file=sys.stderr)
    sys.exit(77)

REPO = Path(__file__).resolve().parents[1]
MAX_OUTPUT = 32 * 1024 * 1024
MAX_LINE = 1024 * 1024


class RecordingVideo(QQuickItem):
    """Inert stand-in for MpvAbstractItem: accepts commands, never loads media."""

    ready = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._properties = {'pause': True, 'duration': 0, 'time-pos': 0, 'hwdec-current': '', 'frame-drop-count': 0}
        QTimer.singleShot(0, self.ready.emit)

    @Slot('QVariantList')
    def commandAsync(self, command):
        if command and command[0] == 'stop':
            self._properties['time-pos'] = 0

    @Slot(str, 'QVariant')
    def setPropertyAsync(self, name, value):
        self._properties[name] = value

    @Slot(str, result='QVariant')
    def getProperty(self, name):
        return self._properties.get(name)


class Bridge(QObject):
    response = Signal('QVariantMap')
    failed = Signal(str)
    availabilityChanged = Signal()

    def __init__(self, program, arguments):
        super().__init__()
        self._program = program
        self._arguments = arguments
        self._process = QProcess(self)
        self._output = QByteArray()
        self._sequence = 0
        self._generation = 0
        self._attempt = 0
        self._alive = False
        self._failing = False
        self._shutting_down = False
        self._outstanding = set()
        self._timers = {}
        self._reconnect_timer = None
        self._process.started.connect(self._started)
        self._process.readyReadStandardError.connect(self._drain_stderr)
        self._process.errorOccurred.connect(lambda _error: self._fail('Não foi possível acessar o serviço da biblioteca.'))
        self._process.finished.connect(lambda *_args: self._fail('O serviço da biblioteca encerrou.'))
        self._process.readyReadStandardOutput.connect(self._read)
        self._start()

    def _drain_stderr(self):
        data = bytes(self._process.readAllStandardError())
        if os.environ.get('FALATRACE_RUNNER_BRIDGE_STDERR') == '1' and data:
            sys.stderr.write(data.decode('utf-8', 'replace'))

    def _started(self):
        self._alive = True
        self._failing = False
        self.availabilityChanged.emit()

    def _start(self):
        self._generation += 1
        self._failing = False
        self._process.start(self._program, self._arguments)

    def _read(self):
        self._output += self._process.readAllStandardOutput()
        if self._output.size() > MAX_OUTPUT:
            self._fail('A resposta da biblioteca excedeu o limite.')
            self._process.terminate()
            return
        while self._output.contains(b'\n'):
            index = self._output.indexOf(b'\n')
            line = bytes(self._output.first(index))
            self._output.remove(0, index + 1)
            try:
                message = json.loads(line)
            except ValueError:
                message = None
            if not isinstance(message, dict):
                self._fail('O serviço da biblioteca retornou uma resposta inválida.')
                self._process.terminate()
                return
            request_id = message.get('id')
            valid = (isinstance(request_id, int) and not isinstance(request_id, bool) and request_id > 0
                     and request_id in self._outstanding and isinstance(message.get('ok'), bool)
                     and (isinstance(message.get('result'), dict) if message.get('ok') else isinstance(message.get('error'), str)))
            if not valid:
                self._fail('O serviço da biblioteca retornou uma resposta inválida.')
                if self._process.state() != QProcess.NotRunning:
                    self._process.terminate()
                return
            self._outstanding.discard(request_id)
            timer = self._timers.pop(request_id, None)
            if timer:
                timer.stop()
                timer.deleteLater()
            self.response.emit(message)

    @Slot(str, str, 'QVariantMap', result=int)
    def request(self, op, key='', payload=None):
        if not self._alive or self._process.state() != QProcess.Running or len(self._outstanding) >= 32:
            return -1
        self._sequence += 1
        request_id = self._sequence
        line = (json.dumps({'id': request_id, 'op': op, 'key': key, 'payload': payload or {}},
                           separators=(',', ':'), ensure_ascii=False) + '\n').encode()
        if len(line) > MAX_LINE:
            return -1
        self._process.write(line)
        self._outstanding.add(request_id)
        epoch = self._generation
        timer = QTimer(self)
        timer.setSingleShot(True)
        timer.setInterval(120000 if op.startswith('capture-') else 30000)

        def expired():
            if epoch == self._generation and request_id in self._outstanding:
                self._fail('A biblioteca demorou demais para responder.')
                if self._process.state() != QProcess.NotRunning:
                    self._process.terminate()
        timer.timeout.connect(expired)
        self._timers[request_id] = timer
        timer.start()
        return request_id

    @Slot()
    def reconnect(self):
        if self._alive or self._process.state() != QProcess.NotRunning:
            return
        self._attempt = 0
        self._failing = False
        if self._reconnect_timer:
            self._reconnect_timer.stop()
            self._reconnect_timer = None
        self._start()

    def _fail(self, message):
        if self._failing:
            return
        self._failing = True
        self._alive = False
        self._output = QByteArray()
        self._outstanding.clear()
        for timer in self._timers.values():
            timer.stop()
            timer.deleteLater()
        self._timers.clear()
        self.availabilityChanged.emit()
        self.failed.emit(message)
        if not self._shutting_down and self._attempt < 3:
            delay = 1000 << self._attempt
            self._attempt += 1
            self._reconnect_timer = QTimer(self)
            self._reconnect_timer.setSingleShot(True)
            self._reconnect_timer.setInterval(delay)

            def retry():
                self._reconnect_timer = None
                if not self._alive and self._process.state() == QProcess.NotRunning:
                    self._start()
            self._reconnect_timer.timeout.connect(retry)
            self._reconnect_timer.start()

    def shutdown(self):
        self._shutting_down = True
        self._process.closeWriteChannel()
        if self._process.state() != QProcess.NotRunning and not self._process.waitForFinished(500):
            self._process.terminate()
            if not self._process.waitForFinished(500):
                self._process.kill()
                self._process.waitForFinished(500)

    def _get_available(self):
        return self._alive

    available = Property(bool, _get_available, notify=availabilityChanged)


def main():
    os.environ['QT_QUICK_CONTROLS_STYLE'] = 'Basic'
    app = QGuiApplication(sys.argv)
    QQuickStyle.setStyle('Basic')
    version = json.loads((REPO / 'package.json').read_text())['version']
    app.setApplicationName('FalaTrace Studio')
    app.setApplicationVersion(version)
    app.setOrganizationName('recording-cli')
    app.setDesktopFileName('recording-studio')
    args = app.arguments()
    if len(args) < 3:
        return 2
    root = args[1]
    packaged = len(args) > 3 and args[3] == '--packaged'
    bridge = Bridge(args[2], ['desktop', 'bridge'] if packaged else [root + '/bridge.ts'])
    qmlRegisterType(RecordingVideo, 'Recording', 1, 0, 'RecordingVideo')
    engine = QQmlApplicationEngine()
    context = engine.rootContext()
    context.setContextProperty('backend', bridge)
    context.setContextProperty('studioBuildId', 'qml-runner')
    context.setContextProperty('smokeKey', os.environ.get('RECORDING_DESKTOP_SMOKE_KEY', ''))
    context.setContextProperty('smokeSoftware', 'RECORDING_DESKTOP_SOFTWARE_SMOKE' in os.environ)
    context.setContextProperty('smokeDiarization', 'RECORDING_DESKTOP_DIARIZATION_SMOKE' in os.environ)
    engine.load(QUrl.fromLocalFile(root + '/Main.qml'))
    if not engine.rootObjects():
        return 3
    window = engine.rootObjects()[0]
    snapshot = os.environ.get('RECORDING_DESKTOP_SNAPSHOT', '')
    if snapshot:
        if 'RECORDING_DESKTOP_CONTEXT_SMOKE' in os.environ:
            QTimer.singleShot(8000, lambda: window.metaObject().invokeMethod(window, 'requestMeetingContext'))
        delay = int(os.environ.get('RECORDING_DESKTOP_SNAPSHOT_MS') or 0) or 12000

        def capture():
            if not isinstance(window, QQuickWindow):
                app.exit(4)
                return
            saved = window.grabWindow().save(snapshot)

            def read(name, default=None):
                value = window.property(name)
                return default if value is None else value
            pending = window.property('pending')
            pending_count = len(pending.toVariant()) if hasattr(pending, 'toVariant') else len(pending or {})
            evidence = {
                'snapshot': saved, 'platform': QGuiApplication.platformName(), 'backendAvailable': bridge.available,
                'pendingRequests': pending_count, 'position': read('position', 0), 'duration': read('duration', 0),
                'location': read('location', ''), 'mediaReady': bool(read('mediaReady', False)),
                'error': read('errorText', ''), 'runner': 'pyside6',
            }
            Path(snapshot + '.json').write_text(json.dumps(evidence, indent=2, default=str))
            app.exit(0 if saved and evidence['mediaReady'] else 5)
        QTimer.singleShot(delay, capture)
    code = app.exec()
    bridge.shutdown()
    return code


if __name__ == '__main__':
    sys.exit(main())
