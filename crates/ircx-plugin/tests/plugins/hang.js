// Never settles. The hook is synchronous, so the host sees a promise where it
// asked for a string and says so immediately rather than waiting for it.
ircx.command("hang", () => new Promise(() => {}));
