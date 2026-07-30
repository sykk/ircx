globalThis.onCommand = () => {
  const held = [];
  for (;;) {
    held.push(new Array(65536).fill(7));
  }
};
