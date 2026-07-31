// A notification rule: handed each message as it arrives, answering whether it
// is worth interrupting you for. It cannot send, it cannot fetch, and there is
// nothing it can answer to make a message quiet — see docs/plugins.md for why.
const BOTS = ["buildbot", "ci", "drone"];

ircx.notify(
  (message) =>
    BOTS.includes(message.nick.toLowerCase()) && /\b(fail(ed|ing)?|broke)\b/i.test(message.text),
);
