// Minimal guest: one concatenation, so a call time is boundary cost and
// almost nothing else.
globalThis.onCommand = (arg) => "pong:" + arg;
