// A denied capability is thrown, so a plugin can catch it and do less rather
// than die — the same shape the client uses for a missing IRCv3 capability.
ircx.command("degrader", (call) => {
  try {
    ircx.send(call.target, call.args);
    return "sent";
  } catch {
    return "carried on without sending";
  }
});
