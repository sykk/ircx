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
