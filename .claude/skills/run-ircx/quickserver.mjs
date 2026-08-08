// An IRC server that answers registration and nothing else, for measuring what
// the client costs rather than what a server does. Libera's identd timeout is
// most of the one connect figure `docs/measurements.md` has, which is why that
// figure says so and why this exists.
//
//   node .claude/skills/run-ircx/quickserver.mjs [--port 6699]
//
// Prints `ok listening <port>` and then a line per client that registers.

import { createServer } from "node:net";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 6699);
/** Messages a second into every channel joined, for measuring a client left
 * open rather than one starting up. Off unless asked for. */
const TRAFFIC = Number(
  process.argv.includes("--traffic") ? process.argv[process.argv.indexOf("--traffic") + 1] : 0,
);
/** Minutes of traffic before the channel goes quiet, the connection staying up.
 * Zero keeps talking for the life of the run. */
const QUIET_AFTER = Number(
  process.argv.includes("--quiet-after") ? process.argv[process.argv.indexOf("--quiet-after") + 1] : 0,
);

/* One timer a channel, cleared when the socket goes, so a client that quits
 * does not leave the server talking to nothing for the rest of a soak. */
function talk(send, channel, socket) {
  const nicks = ["talker", "wanderer", "quietone", "regular"];
  let n = 0;
  const every = Math.max(1, Math.round(1000 / TRAFFIC));
  const timer = setInterval(() => {
    send(`:${nicks[n % nicks.length]}!u@h PRIVMSG ${channel} :line ${n} of a channel nobody is reading`);
    n++;
  }, every);
  socket.once("close", () => clearInterval(timer));
  /* Goes quiet without dropping the connection, which is the whole point: a
   * client that keeps climbing under load and gives nothing back when the
   * channel falls silent is holding the memory. One that returns to its floor
   * was only ever failing to collect while it was busy, and those two look the
   * same on a rising graph. */
  if (QUIET_AFTER > 0) {
    setTimeout(() => {
      clearInterval(timer);
      process.stdout.write(`ok quiet after ${n} messages\n`);
    }, QUIET_AFTER * 60_000);
  }
}

const server = createServer((socket) => {
  let nick = "*";
  let buffer = "";
  const send = (line) => socket.write(`${line}\r\n`);

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\r\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const [command, ...rest] = line.split(" ");
      switch (command.toUpperCase()) {
        case "CAP":
          // No capability this measurement needs, but a bare LS must still be
          // answered: the client waits for it before sending CAP END.
          if (rest[0]?.toUpperCase() === "LS") send(`:quick CAP * LS :`);
          break;
        case "NICK":
          nick = rest[0] ?? nick;
          break;
        case "USER":
          send(`:quick 001 ${nick} :Welcome`);
          send(`:quick 002 ${nick} :Your host is quick`);
          send(`:quick 003 ${nick} :This server was created now`);
          send(`:quick 004 ${nick} quick ircx-measure o o`);
          send(`:quick 005 ${nick} CASEMAPPING=rfc1459 :are supported`);
          send(`:quick 376 ${nick} :End of /MOTD command.`);
          /* CLOCK_MONOTONIC, which is system-wide, so the launcher can subtract
           * its own exec from this and get what registration took end to end. */
          process.stdout.write(`ok registered ${nick} ${Number(process.hrtime.bigint()) / 1e6}\n`);
          break;
        case "JOIN": {
          const channel = rest[0];
          send(`:${nick}!u@h JOIN ${channel}`);
          send(`:quick 353 ${nick} = ${channel} :${nick} talker`);
          send(`:quick 366 ${nick} ${channel} :End of /NAMES list.`);
          /* One real incoming message, so a kept profile has a row the app
           * itself wrote — which is what the seeder's column values are copied
           * from. Every one of them is JSON the store parses back. */
          if (process.argv.includes("--say")) {
            send(`:talker!u@h PRIVMSG ${channel} :a line the app archived itself`);
          }
          if (TRAFFIC > 0) talk(send, channel, socket);
          break;
        }
        case "PING":
          send(`:quick PONG quick :${rest.join(" ").replace(/^:/, "")}`);
          break;
        case "QUIT":
          socket.end();
          break;
      }
    }
  });
  socket.on("error", () => socket.destroy());
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`ok listening ${port}\n`));
