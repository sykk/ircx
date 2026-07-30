// What a plugin can reach. The permission table rests on the answer being
// nothing: a capability the runtime hands out unasked can be neither granted
// nor withheld. The second list is here because the first one being empty only
// means something next to what the sandbox does define.
ircx.command("reach", () => {
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
});
