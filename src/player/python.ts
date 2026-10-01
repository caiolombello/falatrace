// Embedded GTK3/libmpv player. Keep this script self-contained for standalone builds.
export const PLAYER_SCRIPT = String.raw`import ctypes as C
import json
import math
import os
import signal
import sys
import threading
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk, Pango

mpv = C.CDLL("libmpv.so.2")
gl = C.CDLL("libEGL.so.1")
P = C.c_void_p
class RenderParam(C.Structure):
    _fields_ = [("type", C.c_int), ("data", P)]
class OpenGLInit(C.Structure):
    _fields_ = [("get_proc_address", P), ("get_proc_address_ctx", P)]
class Fbo(C.Structure):
    _fields_ = [("fbo", C.c_int), ("w", C.c_int), ("h", C.c_int), ("internal_format", C.c_int)]
class Event(C.Structure):
    _fields_ = [("event_id", C.c_int), ("error", C.c_int), ("reply_userdata", C.c_uint64), ("data", P)]
class EndFile(C.Structure):
    _fields_ = [("reason", C.c_int), ("error", C.c_int)]
mpv.mpv_create.restype = P
mpv.mpv_set_option_string.argtypes = [P, C.c_char_p, C.c_char_p]
mpv.mpv_initialize.argtypes = [P]
mpv.mpv_initialize.restype = C.c_int
mpv.mpv_command.argtypes = [P, C.POINTER(C.c_char_p)]
mpv.mpv_command.restype = C.c_int
mpv.mpv_get_property.argtypes = [P, C.c_char_p, C.c_int, P]
mpv.mpv_get_property.restype = C.c_int
mpv.mpv_render_context_create.argtypes = [C.POINTER(P), P, C.POINTER(RenderParam)]
mpv.mpv_render_context_create.restype = C.c_int
mpv.mpv_render_context_render.argtypes = [P, C.POINTER(RenderParam)]
mpv.mpv_render_context_render.restype = C.c_int
mpv.mpv_render_context_free.argtypes = [P]
mpv.mpv_render_context_set_update_callback.argtypes = [P, P, P]
mpv.mpv_terminate_destroy.argtypes = [P]
mpv.mpv_wait_event.argtypes = [P, C.c_double]
mpv.mpv_wait_event.restype = C.POINTER(Event)
GETPROC = C.CFUNCTYPE(P, P, C.c_char_p)
UPDATE = C.CFUNCTYPE(None, P)
gl.eglGetProcAddress.argtypes = [C.c_char_p]
gl.eglGetProcAddress.restype = P
get_proc = GETPROC(lambda _ctx, name: gl.eglGetProcAddress(name))

def command(handle, *args):
    values = [C.c_char_p(x.encode()) for x in args] + [None]
    return mpv.mpv_command(handle, (C.c_char_p * len(values))(*values))

def clock(seconds):
    seconds = max(0, int(seconds))
    return "%d:%02d:%02d" % (seconds // 3600, (seconds // 60) % 60, seconds % 60)

class Player(Gtk.Window):
    def __init__(self, path, start, transcript, title):
        Gtk.Window.__init__(self, title=title or "FalaTrace · Player")
        self.set_default_size(1180, 700)
        self.path = path
        self.start = start
        self.handle = mpv.mpv_create()
        if not self.handle: raise RuntimeError("mpv_create failed")
        for key, value in (("vo", "libmpv"), ("hwdec", "auto-safe"), ("keep-open", "yes"), ("terminal", "no"), ("input-default-bindings", "no")):
            if mpv.mpv_set_option_string(self.handle, key.encode(), value.encode()) < 0: raise RuntimeError("mpv option failed")
        if start is not None and mpv.mpv_set_option_string(self.handle, b"start", str(start).encode()) < 0:
            raise RuntimeError("invalid start option")
        self.ctx = None
        self.render_ready = False
        self.file_loaded = False
        self.announced = False
        self.rendered = False
        self.segments = [(s["start"], s["end"], s["text"]) for s in transcript.get("segments", [])]
        self.plain_text = transcript.get("text", "")
        self.coarse = transcript.get("timing") == "block"
        self.active_row = None
        self.rows = []
        self.area = Gtk.GLArea()
        self.area.set_auto_render(True)
        self.area.connect("realize", self.realize_gl)
        self.area.connect("render", self.render_gl)
        self.search = Gtk.SearchEntry(placeholder_text="Buscar na transcrição")
        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.listbox.connect("row-activated", self.row_activated)
        self.status = Gtk.Label(label="Carregando vídeo…", xalign=0)
        self.position_label = Gtk.Label(label="0:00:00 / 0:00:00")
        self.pause_button = None
        self.updating_timeline = False
        self.timeline = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1, 0.01)
        self.timeline.set_draw_value(False)
        self.build_ui()
        if mpv.mpv_initialize(self.handle) < 0: raise RuntimeError("mpv_initialize failed")
        self.show_all()
        self.update_rows("")
        self.connect("key-press-event", self.key_pressed)
        self.connect("delete-event", self.close_player)
        GLib.timeout_add(100, self.poll_events)
        GLib.timeout_add(200, self.sync_transcript)

    def build_ui(self):
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        root.set_border_width(10)
        content = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        video = Gtk.Overlay()
        video.add(self.area)
        self.subtitle = Gtk.Label(xalign=0.5)
        self.subtitle.set_line_wrap(True)
        self.subtitle.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.subtitle.set_max_width_chars(65)
        self.subtitle.get_style_context().add_class("caption")
        css = Gtk.CssProvider()
        css.load_from_data(b".caption { background-color: rgba(0,0,0,0.78); color: white; padding: 6px 12px; border-radius: 4px; font-size: 18px; }")
        self.subtitle.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.subtitle.set_margin_bottom(18)
        video.add_overlay(self.subtitle)
        self.subtitle.set_halign(Gtk.Align.CENTER)
        self.subtitle.set_valign(Gtk.Align.END)
        content.pack1(video, True, False)
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        side.set_size_request(320, -1)
        side.pack_start(self.search, False, False, 0)
        self.scroll = Gtk.ScrolledWindow()
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.scroll.add(self.listbox)
        side.pack_start(self.scroll, True, True, 0)
        self.follow = Gtk.CheckButton(label="Acompanhar o trecho atual")
        self.follow.set_active(True)
        side.pack_start(self.follow, False, False, 0)
        self.captions = Gtk.CheckButton(label="Legenda sobre o vídeo")
        self.captions.set_active(bool(self.segments) and not self.coarse)
        side.pack_start(self.captions, False, False, 0)
        content.pack2(side, False, False)
        root.pack_start(content, True, True, 0)
        controls = Gtk.Box(spacing=6)
        for label, action in (("Pausar", ("cycle", "pause")), ("−5 s", ("seek", "-5", "relative")), ("+5 s", ("seek", "5", "relative"))):
            button = Gtk.Button(label=label)
            button.connect("clicked", lambda _button, values=action: command(self.handle, *values))
            controls.pack_start(button, False, False, 0)
            if label == "Pausar": self.pause_button = button
        speed = Gtk.ComboBoxText()
        for value in ("0.75", "1.0", "1.25", "1.5", "2.0"): speed.append(value, value)
        speed.set_active_id("1.0")
        speed.connect("changed", lambda combo: command(self.handle, "set", "speed", combo.get_active_id() or "1.0"))
        controls.pack_start(speed, False, False, 0)
        controls.pack_start(self.position_label, False, False, 6)
        root.pack_start(self.timeline, False, True, 0)
        controls.pack_start(self.status, True, True, 0)
        root.pack_start(controls, False, False, 0)
        self.search.connect("search-changed", lambda entry: self.update_rows(entry.get_text()))
        self.timeline.connect("value-changed", self.timeline_changed)
        self.add(root)

    def update_rows(self, query):
        for row in self.listbox.get_children(): self.listbox.remove(row)
        self.rows = []
        needle = query.casefold()
        for index, (start, end, text) in enumerate(self.segments):
            if needle and needle not in text.casefold(): continue
            label = Gtk.Label(label="[%02d:%05.2f]  %s" % (int(start // 60), start % 60, text), xalign=0)
            label.set_line_wrap(True); label.set_margin_top(5); label.set_margin_bottom(5)
            label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR); label.set_width_chars(32); label.set_max_width_chars(42)
            row = Gtk.ListBoxRow(); row.add(label); row._segment = (start, end); row._text = text
            self.listbox.add(row)
            self.rows.append(row)
        if not self.segments:
            text = self.plain_text or "Esta gravação ainda não tem transcrição."
            if not needle or needle in text.casefold():
                label = Gtk.Label(label=text, xalign=0)
                label.set_line_wrap(True); label.set_width_chars(32); label.set_max_width_chars(42)
                row = Gtk.ListBoxRow(); row.add(label); row._segment = None
                self.listbox.add(row)
        self.listbox.show_all()
        if not self.segments: self.status.set_text("Transcrição sem trechos temporizados")
        elif self.coarse: self.status.set_text("Tempos aproximados por bloco")
        else: self.status.set_text("Transcrição sincronizada por trecho")

    def fail_start(self):
        if not self.announced:
            print(json.dumps({"event": "error", "code": "PLAYER_START_FAILED", "error": "Não foi possível carregar esta gravação."}), flush=True)
        else:
            self.status.set_text("A reprodução foi interrompida. Verifique a origem do vídeo.")
        if not self.announced: self.close_player()
        return False

    def poll_events(self):
        if not self.handle: return False
        for _ in range(100):
            event = mpv.mpv_wait_event(self.handle, 0).contents
            if event.event_id == 0: break
            if event.event_id == 8: self.file_loaded = True
            if event.event_id == 7 and event.data:
                ending = C.cast(event.data, C.POINTER(EndFile)).contents
                if ending.error < 0: return self.fail_start()
        return True

    def sync_transcript(self):
        if not self.handle: return False
        position = C.c_double()
        if mpv.mpv_get_property(self.handle, b"time-pos", 5, C.byref(position)) >= 0:
            if self.file_loaded and self.rendered and not self.announced:
                self.announced = True
                print(json.dumps({"event": "ready", "position": position.value}), flush=True)
            active_text = next((text for start, end, text in self.segments if start <= position.value < end), "")
            self.subtitle.set_text(active_text[:400] if self.captions.get_active() else "")
            self.subtitle.set_visible(bool(active_text) and self.captions.get_active())
            for row in self.rows:
                start, end = row._segment
                if start <= position.value < end:
                    if self.follow.get_active() and not self.search.get_text():
                        self.listbox.select_row(row)
                        if row is not self.active_row:
                            adjustment = self.scroll.get_vadjustment()
                            adjustment.set_value(max(0, row.get_allocation().y - adjustment.get_page_size() / 3))
                    self.active_row = row
                    break
        duration = C.c_double()
        if mpv.mpv_get_property(self.handle, b"duration", 5, C.byref(duration)) >= 0 and duration.value > 0:
            self.updating_timeline = True
            self.timeline.set_range(0, duration.value)
            self.timeline.set_value(min(position.value, duration.value))
            self.updating_timeline = False
            self.position_label.set_text(clock(position.value) + " / " + clock(duration.value))
        paused = C.c_int()
        if self.pause_button and mpv.mpv_get_property(self.handle, b"pause", 3, C.byref(paused)) >= 0:
            self.pause_button.set_label("Continuar" if paused.value else "Pausar")
        return True

    def timeline_changed(self, scale):
        if not self.updating_timeline: command(self.handle, "seek", str(scale.get_value()), "absolute")

    def row_activated(self, _listbox, row):
        if row._segment: command(self.handle, "seek", str(row._segment[0]), "absolute")

    def key_pressed(self, _widget, event):
        if isinstance(self.get_focus(), (Gtk.Entry, Gtk.TextView)): return False
        if event.keyval == Gdk.KEY_space: command(self.handle, "cycle", "pause"); return True
        if event.keyval in (Gdk.KEY_Left, Gdk.KEY_Right):
            command(self.handle, "seek", "-5" if event.keyval == Gdk.KEY_Left else "5", "relative"); return True
        return False

    def realize_gl(self, area):
        area.make_current()
        if area.get_error(): return self.fail_start()
        api = C.c_char_p(b"opengl"); init = OpenGLInit(C.cast(get_proc, P), None)
        params = (RenderParam * 3)(RenderParam(1, C.cast(api, P)), RenderParam(2, C.cast(C.pointer(init), P)), RenderParam(0, None))
        self.ctx = P(); rc = mpv.mpv_render_context_create(C.byref(self.ctx), self.handle, params)
        if rc < 0: return self.fail_start()
        self.update_cb = UPDATE(lambda _ctx: GLib.idle_add(self.area.queue_render))
        mpv.mpv_render_context_set_update_callback(self.ctx, C.cast(self.update_cb, P), None)
        self.render_ready = True
        if command(self.handle, "loadfile", self.path, "replace") < 0: return self.fail_start()

    def render_gl(self, area, _context):
        if not self.render_ready: return False
        get_int = C.CFUNCTYPE(None, C.c_uint, C.POINTER(C.c_int))(get_proc(None, b"glGetIntegerv"))
        bound = C.c_int(); get_int(0x8CA6, C.byref(bound))
        scale = area.get_scale_factor()
        fbo = Fbo(bound.value, area.get_allocated_width() * scale, area.get_allocated_height() * scale, 0)
        flip = C.c_int(1)
        params = (RenderParam * 3)(RenderParam(3, C.cast(C.pointer(fbo), P)), RenderParam(4, C.cast(C.pointer(flip), P)), RenderParam(0, None))
        ok = mpv.mpv_render_context_render(self.ctx, params) >= 0
        if ok: self.rendered = True
        else: GLib.idle_add(self.fail_start)
        return ok

    def close_player(self, *_args):
        if self.ctx:
            self.area.make_current()
            mpv.mpv_render_context_set_update_callback(self.ctx, None, None)
            mpv.mpv_render_context_free(self.ctx); self.ctx = None
        if self.handle: mpv.mpv_terminate_destroy(self.handle); self.handle = None
        Gtk.main_quit()
        return False

def main():
    payload = sys.stdin.read()
    args = json.loads(payload)
    if not isinstance(args, dict) or not isinstance(args.get("path"), str):
        raise ValueError("invalid player configuration")
    player = Player(args["path"], args.get("startSeconds"), args.get("transcript", {}), args.get("title"))
    Gtk.main()

if __name__ == "__main__":
    try: main()
    except Exception:
        # stdout is a machine-readable protocol; never echo paths, signed URLs, or GTK errors.
        print(json.dumps({"event": "error", "code": "PLAYER_START_FAILED", "error": "Não foi possível iniciar o player."}), flush=True)
        sys.exit(1)
`;
