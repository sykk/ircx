"""A WebKitGTK view on its own display, driven from stdin.

    lab.py <url> [--size WxH] [--zoom Z] [--display :NN]

The engine the app ships on — webkit2gtk-4.1, the same library Tauri links —
with a script instead of a Rust process behind it. #602 is a paint defect, so
what it needs is the engine and a page, not a client.

Commands, one per line, one `ok`/`err` back:

    js <expr>     evaluate, print the JSON result
    ss <file>     screenshot the display
    wait <ms>
    quit

The display is set before `gi` is imported. GDK reads `WAYLAND_DISPLAY` when it
initialises and prefers it, and a window that opens on the operator's own screen
is both rude and unphotographable — the same trap `window.mjs` documents.
"""

import json
import subprocess
import sys
import os
import time

url = sys.argv[1]
size = "1200x800"
zoom = 1.0
display = ":97"
args = sys.argv[2:]
for i, a in enumerate(args):
    if a == "--size":
        size = args[i + 1]
    elif a == "--zoom":
        zoom = float(args[i + 1])
    elif a == "--display":
        display = args[i + 1]
width, height = (int(n) for n in size.split("x"))

xvfb = subprocess.Popen(
    ["Xvfb", display, "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
time.sleep(1.5)
os.environ["DISPLAY"] = display
os.environ["GDK_BACKEND"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402

window = Gtk.Window()
window.set_default_size(width, height)
# Ephemeral, so a run starts on a client that has never been launched. WebKit
# keeps local storage per data directory and the app keeps its pane layout
# there, so a shared one hands the next run the panes the last one split.
view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral())
settings = view.get_settings()
settings.set_enable_developer_extras(True)
view.set_zoom_level(zoom)
# The app's window is `transparent: true`, which is a different compositing path
# from an opaque one — and #602 is a compositing defect until something says
# otherwise. Skipped where the display has no RGBA visual to give.
visual = window.get_screen().get_rgba_visual()
if visual is not None:
    window.set_visual(visual)
    window.set_app_paintable(True)
    view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
window.add(view)
window.show_all()
view.load_uri(url)

commands = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
state = {"i": 0, "loaded": False}


def say(text):
    print(text, flush=True)


def next_command():
    if state["i"] >= len(commands):
        Gtk.main_quit()
        return False
    line = commands[state["i"]]
    state["i"] += 1
    verb, _, rest = line.partition(" ")
    if verb == "quit":
        say("ok bye")
        Gtk.main_quit()
        return False
    if verb == "wait":
        GLib.timeout_add(int(rest), next_command)
        return False
    if verb == "ss":
        subprocess.run(["import", "-display", display, "-window", "root", rest], check=False)
        say("ok " + rest)
        GLib.idle_add(next_command)
        return False
    if verb in ("wheel", "click", "move", "key", "type"):
        # Real input through XTEST, which is what `window.mjs` sends the app.
        # A wheel a script dispatches is not one: the engine has a scrolling
        # path for input it believes, and #602 is on the far side of it.
        done = subprocess.run(
            [os.path.join(os.path.dirname(os.path.abspath(__file__)), "xsend"), verb, *rest.split()],
            env={**os.environ, "DISPLAY": display},
            capture_output=True,
        )
        say("ok " + verb if done.returncode == 0 else "err " + done.stderr.decode().strip())
        GLib.idle_add(next_command)
        return False
    if verb == "js":
        view.evaluate_javascript(rest, -1, None, None, None, evaluated, None)
        return False
    say("err unknown command " + verb)
    GLib.idle_add(next_command)
    return False


def evaluated(view, result, _data):
    try:
        value = view.evaluate_javascript_finish(result)
        say("ok " + json.dumps(value.to_json(0)) if value else "ok null")
    except GLib.Error as error:
        say("err " + error.message)
    GLib.idle_add(next_command)


def load_changed(_view, event):
    if event == WebKit2.LoadEvent.FINISHED and not state["loaded"]:
        state["loaded"] = True
        say("ok ready " + url)
        GLib.timeout_add(300, next_command)


view.connect("load-changed", load_changed)
try:
    Gtk.main()
finally:
    xvfb.terminate()
