// Catastrophic backtracking. The work happens inside QuickJS's regex engine
// rather than in bytecode, which is why it is a separate case from loop.js.
globalThis.onCommand = () => {
  const re = /^(a+)+$/;
  return String(re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"));
};
