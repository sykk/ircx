ircx.command("sender", (call) => {
  ircx.send(call.target, call.args);
  return "sent";
});
