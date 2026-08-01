ircx.command("fetcher", (call) => {
  const response = ircx.fetch(call.args);
  return response.body;
});
