export const INDICATOR_SCRIPT = String.raw`import json
import signal
import sys
import threading
from datetime import datetime, timezone

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")

from gi.repository import AyatanaAppIndicator3, GLib, Gtk


def emit(action):
    print(json.dumps({"action": action}), flush=True)


indicator = AyatanaAppIndicator3.Indicator.new(
    "recording-cli",
    "audio-input-microphone-symbolic",
    AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS,
)
indicator.set_title("FalaTrace")

menu = Gtk.Menu()


def add_information(label):
    item = Gtk.MenuItem.new_with_label(label)
    item.set_sensitive(False)
    menu.append(item)
    return item


status_item = add_information("FalaTrace: inicializando")
recording_item = add_information("Gravação: inicializando")
duration_item = add_information("Duração: 00:00:00")
screen_item = add_information("Tela: inicializando")
audio_item = add_information("Áudio: inicializando")
automation_item = add_information("Captura automática: inicializando")
action_item = add_information("")
processing_item = add_information("Processamento: inicializando")
timesheet_item = add_information("Horas: inicializando")
menu.append(Gtk.SeparatorMenuItem())


def add_action(label, action):
    item = Gtk.MenuItem.new_with_label(label)
    item.connect("activate", lambda _item: emit(action))
    menu.append(item)
    return item


open_tui_item = add_action("Abrir biblioteca", "open-tui")
open_timesheet_item = add_action("Abrir apontamentos", "open-timesheet")
start_recording_item = add_action("Iniciar gravação manual", "start-recording")
stop_recording_item = add_action("Parar gravação", "stop-recording")
automation_paused = False
toggle_automation_item = Gtk.MenuItem.new_with_label("Suspender captura automática")
toggle_automation_item.connect(
    "activate",
    lambda _item: emit("resume-automation" if automation_paused else "pause-automation"),
)
menu.append(toggle_automation_item)
view_logs_item = add_action("Acompanhar monitor", "view-logs")
restart_monitor_item = add_action("Reiniciar monitor", "restart-monitor")
menu.append(Gtk.SeparatorMenuItem())

quit_item = Gtk.MenuItem.new_with_label("Fechar ícone")
quit_item.connect("activate", lambda _item: Gtk.main_quit())
menu.append(quit_item)

menu.show_all()
duration_item.hide()
action_item.hide()
indicator.set_menu(menu)
indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)

duration_start = None
duration_end = None


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def update_elapsed():
    if duration_start is None:
        duration_item.hide()
        return True
    end = duration_end or datetime.now(timezone.utc)
    seconds = max(0, int((end - duration_start).total_seconds()))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    duration_item.set_label(f"Duração · {hours:02d}:{minutes:02d}:{seconds:02d}")
    duration_item.show()
    return True


def apply_view(view):
    global automation_paused, duration_start, duration_end
    icon = str(view.get("icon", "dialog-warning-symbolic"))
    description = str(view.get("description", "FalaTrace"))
    indicator.set_icon_full(icon, description)
    indicator.set_label(str(view.get("label", "")), "CALL")
    indicator.set_title(str(view.get("title", "FalaTrace")))
    status_item.set_label(str(view.get("menuText", "FalaTrace")))
    recording_item.set_label(str(view.get("recordingText", "Gravação")))
    screen_item.set_label(str(view.get("screenText", "Tela")))
    audio_item.set_label(str(view.get("audioText", "Áudio")))
    automation_item.set_label(str(view.get("automationText", "Captura automática")))
    duration_start = parse_timestamp(view.get("durationStartedAt"))
    duration_end = parse_timestamp(view.get("durationEndedAt"))
    update_elapsed()
    action_text = str(view.get("actionText", ""))
    action_item.set_label(action_text)
    action_item.set_visible(bool(action_text))
    processing_item.set_label(str(view.get("processingText", "Processamento")))
    timesheet_item.set_label(str(view.get("timesheetText", "Horas")))
    automation_paused = view.get("toggleAutomationLabel") == "Retomar captura automática"
    toggle_automation_item.set_label(str(view.get("toggleAutomationLabel", "Suspender captura automática")))
    start_recording_item.set_sensitive(bool(view.get("startRecordingEnabled", False)))
    stop_recording_item.set_sensitive(bool(view.get("stopRecordingEnabled", False)))
    toggle_automation_item.set_sensitive(bool(view.get("toggleAutomationEnabled", False)))
    actions_enabled = bool(view.get("actionsEnabled", True))
    open_tui_item.set_sensitive(actions_enabled)
    open_timesheet_item.set_sensitive(actions_enabled)
    view_logs_item.set_sensitive(actions_enabled)
    quit_item.set_sensitive(actions_enabled)
    restart_monitor_item.set_sensitive(
        actions_enabled and bool(view.get("restartMonitorEnabled", True))
    )
    return False


def read_updates():
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if isinstance(message, dict) and message.get("type") == "view":
                GLib.idle_add(apply_view, message)
        except (ValueError, TypeError):
            continue
    GLib.idle_add(Gtk.main_quit)


def stop(_signum, _frame):
    GLib.idle_add(Gtk.main_quit)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
threading.Thread(target=read_updates, daemon=True).start()
GLib.timeout_add_seconds(1, update_elapsed)
print(json.dumps({"event": "ready"}), flush=True)
Gtk.main()
`;
