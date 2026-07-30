// What a plugin can reach when its manifest grants it nothing. Returns both
// the escape hatches it found and every name the sandbox does define, because
// the permission table needs the second list as much as the first: a capability
// the runtime hands out unasked cannot be granted or withheld.
globalThis.onCommand = () => {
  const escapes = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "require",
    "process",
    "std",
    "os",
    "Deno",
    "Bun",
    "importScripts",
    "readFile",
    "print",
    "setTimeout",
  ];
  return JSON.stringify({
    reachable: escapes.filter((name) => globalThis[name] !== undefined),
    globals: Object.getOwnPropertyNames(globalThis).sort(),
  });
};
