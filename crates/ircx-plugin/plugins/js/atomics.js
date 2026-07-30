// The one place a QuickJS plugin could block rather than spin. `Atomics.wait`
// parks the agent in C on a futex, where an interrupt handler checked between
// bytecodes never runs. Nothing will ever wake it: no other agent exists.
//
// If this ever returns `Failure::Timeout` the deadline held. If it never
// returns, hang is expressible in QuickJS and the write-up is wrong.
globalThis.onCommand = () => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  return String(Atomics.wait(shared, 0, 0));
};
