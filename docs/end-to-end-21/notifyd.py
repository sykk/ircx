#!/usr/bin/env python3
"""A notification daemon that draws nothing and writes down everything.

    notifyd.py <log>

Owns `org.freedesktop.Notifications` on whatever session bus
`DBUS_SESSION_BUS_ADDRESS` names, and appends one JSON object per `Notify` call
to <log>. It is the instrument rather than a mock: `tauri-plugin-notification`
goes through `notify-rust`, which goes through this interface, so a call
recorded here is a call the shipped client made to a real desktop.

Two things it has to get right or the walk measures the harness:

  * **Own the name before the app is launched.** notify-rust asks the bus to
    activate the service if nobody owns it, and an activation failure is
    swallowed by `notifyForEvents`'s own catch — the client would log a warning
    and carry on, and the walk would read zero notifications as the focus rule
    working.
  * **Answer `GetCapabilities` and `GetServerInformation`.** notify-rust asks
    before it sends, and a daemon that raises on either is a daemon the client
    never gets as far as notifying.

The log's `t` is seconds since this started, so a notification can be put beside
the message that provoked it and the screenshot taken between them.
"""

import json
import sys
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"


class Daemon(dbus.service.Object):
    def __init__(self, bus, log):
        super().__init__(bus, PATH)
        self.log = log
        self.started = time.monotonic()
        self.serial = 0

    def write(self, **fields):
        fields["t"] = round(time.monotonic() - self.started, 3)
        self.log.write(json.dumps(fields) + "\n")
        self.log.flush()

    @dbus.service.method(BUS_NAME, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["body"]

    @dbus.service.method(BUS_NAME, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ("notifyd.py", "ircx run 21", "1.0", "1.2")

    @dbus.service.method(BUS_NAME, in_signature="susssasa{sv}i", out_signature="u")
    def Notify(self, app_name, replaces_id, app_icon, summary, body, actions, hints, timeout):
        self.serial += 1
        self.write(
            call="notify",
            id=self.serial,
            app=str(app_name),
            summary=str(summary),
            body=str(body),
            actions=[str(a) for a in actions],
        )
        return dbus.UInt32(self.serial)

    @dbus.service.method(BUS_NAME, in_signature="u", out_signature="")
    def CloseNotification(self, notification_id):
        self.write(call="close", id=int(notification_id))


def main():
    path = sys.argv[1]
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    # Refuse to start rather than share the name: two daemons would split the
    # calls between them and the walk would count half of what was sent.
    name = dbus.service.BusName(BUS_NAME, bus=bus, do_not_queue=True)
    with open(path, "a", buffering=1) as log:
        daemon = Daemon(bus, log)
        daemon.write(call="ready", name=str(name.get_name()))
        print("owning " + BUS_NAME, flush=True)
        GLib.MainLoop().run()


if __name__ == "__main__":
    main()
