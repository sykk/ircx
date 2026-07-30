// A denied capability is thrown, so a plugin can catch it and do less rather
// than die — the same shape the client uses for a missing IRCv3 capability.
// The refusal is an Error, so a plugin that degrades can say why it did.
ircx.command("degrader", (call) => {
  try {
    ircx.send(call.target, call.args);
    return "sent";
  } catch (refused) {
    if (!(refused instanceof Error)) {
      return "carried on, but the refusal was a " + typeof refused;
    }
    return "carried on without sending: " + refused.message;
  }
});
