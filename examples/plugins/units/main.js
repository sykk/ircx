// An annotator: handed each message as it arrives, answering with its own text
// or with nothing. It cannot send, it cannot fetch, and it cannot change what
// anybody said — see docs/plugins.md for why.
ircx.annotate((message) => {
  const found = /(-?\d+(?:\.\d+)?)\s?°?F\b/.exec(message.text);
  if (!found) return;
  return Math.round(((Number(found[1]) - 32) * 5) / 9) + " °C";
});
