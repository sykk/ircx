import socket, time, base64, threading

class Client:
    """A line-oriented IRC socket that keeps everything it was sent."""

    def __init__(self, name, host="127.0.0.1", port=6677):
        self.name = name
        self.sock = socket.create_connection((host, port))
        self.sock.settimeout(0.2)
        self.lines = []
        self.buf = b""
        self.alive = True
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._keepalive, daemon=True).start()

    def _keepalive(self):
        """ergo pings after 90s of silence and drops the session at 150s, and a
        walk spends longer than that between bursts.  A client that dies in a
        pause looks exactly like a client that was never there."""
        while self.alive:
            time.sleep(45)
            try:
                self.send(f"PING keepalive{int(time.time())}")
            except OSError:
                return

    def _read(self):
        while self.alive:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            if not chunk:
                return
            self.buf += chunk
            while b"\r\n" in self.buf:
                line, self.buf = self.buf.split(b"\r\n", 1)
                text = line.decode("utf-8", "replace")
                self.lines.append((time.time(), text))
                if text.startswith("PING "):
                    self.send("PONG " + text.split(" ", 1)[1])

    def send(self, line):
        self.sock.sendall(line.encode("utf-8") + b"\r\n")

    def wait(self, needle, timeout=10.0, after=0):
        """The first line at or past `after` containing `needle`."""
        end = time.time() + timeout
        while time.time() < end:
            for i in range(after, len(self.lines)):
                if needle in self.lines[i][1]:
                    return i, self.lines[i][1]
            time.sleep(0.05)
        return None, None

    def dump(self, prefix=""):
        for _, line in self.lines:
            print(f"{prefix}{self.name} << {line}")

    def close(self):
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass


def register(client, nick, caps=(), account=None, password=None):
    """CAP negotiation, optional SASL PLAIN, and NICK/USER, through to 001."""
    client.send("CAP LS 302")
    if caps:
        client.send("CAP REQ :" + " ".join(caps))
    if account:
        client.send("AUTHENTICATE PLAIN")
        client.wait("AUTHENTICATE +")
        blob = f"{account}\0{account}\0{password}".encode()
        client.send("AUTHENTICATE " + base64.b64encode(blob).decode())
    client.send(f"NICK {nick}")
    client.send(f"USER {nick} 0 * :{nick}")
    client.send("CAP END")
    return client.wait(" 001 ", timeout=10)
