// Catastrophic backtracking. The work happens inside QuickJS's regex engine
// rather than in bytecode, which is why it is a case of its own: an interrupt
// handler checked only between bytecodes would never see it.
ircx.command("regex", () => {
  const re = /^(a+)+$/;
  return String(re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"));
});
