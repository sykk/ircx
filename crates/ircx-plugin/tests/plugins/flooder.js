ircx.command("flooder", (call) => {
  for (let i = 0; i < 200; i++) {
    ircx.send(call.target, "flood " + i);
  }
  return "flooded";
});
