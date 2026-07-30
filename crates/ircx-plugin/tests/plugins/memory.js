ircx.command("memory", () => {
  const held = [];
  for (;;) {
    held.push(new Array(65536).fill(7));
  }
});
