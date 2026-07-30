// Never settles. With a synchronous hook the host sees a Promise where it
// wanted a string; with an async hook it would wait for it forever.
globalThis.onCommand = () => new Promise(() => {});
