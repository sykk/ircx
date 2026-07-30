ircx.command("storer", () => {
  const seen = Number(ircx.store.get("seen") || "0") + 1;
  ircx.store.set("seen", String(seen));
  return seen + " " + ircx.store.keys().join(",");
});
