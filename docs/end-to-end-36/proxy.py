"""Run 35's logging pipe, taught to lie in the two ways this run needs.

Run 35 could not provoke the casemapping defect at all: `applyReaction` matched
a nick by string equality, and the only server on the socket advertises
`CASEMAPPING=ascii` and never re-cases anybody.  Both halves of that are the
server's, and both sit on this wire.

So this proxy rewrites, in one direction only — server to client:

* **`CASEMAPPING=ascii` becomes `CASEMAPPING=rfc1459` in `005`.**  Under that
  folding `[` and `{` are the same character, which is the case no amount of
  lowercasing would catch and the one `manual-verification.md` records as
  unwalked.  ergo goes on folding `ascii` underneath; the claim is this
  proxy's, and only ircx is asked to believe it.

* **The source nick of a `TAGMSG` is re-cased**, by the rules in a file the
  walk rewrites between steps.  `TAGMSG` only, so the roster still learns
  everybody from `JOIN` and `353` under the casing they really have: the
  variable under test is one line's spelling against a member list that
  disagrees with it, which is exactly what a re-casing server produces.

Everything else is passed through untouched and logged as run 35 logged it.
"""
import os
import socket
import sys
import threading
import time

LISTEN, UPSTREAM = ("127.0.0.1", 6690), ("127.0.0.1", 6677)


class Rules:
    """`from to` per line, re-read whenever the file changes underneath."""

    def __init__(self, path):
        self.path = path
        self.stamp = None
        self.map = {}

    def current(self):
        try:
            stamp = os.stat(self.path).st_mtime_ns
        except OSError:
            self.map = {}
            return self.map
        if stamp != self.stamp:
            self.stamp = stamp
            fresh = {}
            with open(self.path) as handle:
                for line in handle:
                    old, _, new = line.strip().partition(" ")
                    if old and new:
                        fresh[old.lower()] = new
            self.map = fresh
        return self.map


def split_prefix(line):
    """`(tags, prefix, rest)` — prefix without its leading colon, or None."""
    tags = ""
    if line.startswith("@"):
        tags, _, line = line.partition(" ")
        tags += " "
    if not line.startswith(":"):
        return tags, None, line
    prefix, _, rest = line[1:].partition(" ")
    return tags, prefix, rest


def recase(line, rules):
    """Re-spell the sender of a TAGMSG, leaving the rest of the line alone."""
    tags, prefix, rest = split_prefix(line)
    if prefix is None or not rest.startswith("TAGMSG"):
        return line, None
    nick, sep, host = prefix.partition("!")
    replacement = rules.get(nick.lower())
    if replacement is None:
        return line, None
    return f"{tags}:{replacement}{sep}{host} {rest}", f"{nick} -> {replacement}"


def pump(src, dst, tag, log, rules, rewrite):
    buf = b""
    while True:
        try:
            chunk = src.recv(65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        while b"\r\n" in buf:
            raw, buf = buf.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            note = None
            if rewrite:
                if "CASEMAPPING=ascii" in line:
                    line = line.replace("CASEMAPPING=ascii", "CASEMAPPING=rfc1459")
                    note = "casemapping ascii -> rfc1459"
                line, recased = recase(line, rules.current())
                note = recased or note
            log.write(f"{time.time():.3f} {tag} {line}\n")
            if note:
                log.write(f"{time.time():.3f} ** rewrote: {note}\n")
            log.flush()
            try:
                dst.sendall(line.encode("utf-8") + b"\r\n")
            except OSError:
                return
    for sock in (src, dst):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def serve(path, rulepath):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(LISTEN)
    listener.listen(4)
    log = open(path, "a", buffering=1)
    rules = Rules(rulepath)
    while True:
        client, _ = listener.accept()
        try:
            server = socket.create_connection(UPSTREAM)
        except OSError as error:
            log.write(f"{time.time():.3f} ** upstream refused: {error}\n")
            client.close()
            continue
        log.write(f"{time.time():.3f} ** connection opened\n")
        threading.Thread(
            target=pump, args=(client, server, ">>", log, rules, False), daemon=True
        ).start()
        threading.Thread(
            target=pump, args=(server, client, "<<", log, rules, True), daemon=True
        ).start()


if __name__ == "__main__":
    serve(sys.argv[1], sys.argv[2])
