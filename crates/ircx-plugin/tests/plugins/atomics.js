// The one place a QuickJS plugin could block rather than spin. `Atomics.wait`
// parks the agent in C on a futex, where an interrupt handler checked between
// bytecodes never runs, and nothing will ever wake it: no other agent exists.
ircx.command("atomics", () => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  return String(Atomics.wait(shared, 0, 0));
});
