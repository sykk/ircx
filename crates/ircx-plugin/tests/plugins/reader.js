ircx.command("reader", (call) =>
  call.messages.map((message) => message.nick + ": " + message.text).join("\n") ||
  "nothing to read",
);
